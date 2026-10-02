#!/usr/bin/env node
/**
 * scripts/desktop/update.mjs (H) — build the auto-update feed for ONE target triple.
 *
 * What it writes (see docs/deno-auto-update.md for the runtime contract):
 *   <out>/<triple>/latest.json                     { version, patches: { "<from>": { name, sha256 } } }
 *   <out>/<triple>/patch-<from>-to-<to>.bin        bsdiff of the runtime dylib
 *   <out>/runtime/runtime-<version>-<triple><ext>  the new dylib VERBATIM, so the next
 *                                                  release can diff against it
 *
 * Three things this file exists to get right, because getting them wrong is silent:
 *
 *   1. WHAT IS PATCHED is the app's RUNTIME DYLIB, not the installer. The name is
 *      per-platform and NOT what the Deno docs say in the general case — measured
 *      from real artifacts:
 *        linux   <appdir>/<name>.so                 (85 MB on the lean build)
 *        windows <appdir>/<name>.dll
 *        macOS   <app>.app/Contents/MacOS/libruntime.dylib
 *   2. The patch must be PLAIN bsdiff 4.x. Deno's desktop updater calls
 *      qbsdiff::Bspatch directly — it does NOT sniff zstd, so the repo's own
 *      zstd-wrapped `bsdiff_helper` output (used by `deno upgrade`) is rejected.
 *   3. A patch only applies to the byte-identical old dylib, so the previous
 *      release's dylib must be kept. That is what `<out>/runtime/` is for.
 *
 * The script is deliberately CREDENTIAL-FREE and offline: it only reads local
 * files and runs the bsdiff binary. Uploading the feed to R2 is a separate,
 * visible step in the release workflow (`aws s3 sync`), so no key ever reaches
 * this process or the repository.
 *
 * Usage:
 *   node scripts/desktop/update.mjs --triple <t> --version <v> --artifacts <dir> --out <dir>
 *                                   [--dylib <path>] [--previous <dir>] [--keep 3] [--bsdiff-cmd bsdiff]
 *
 * `--dylib` exists for the CI split: the release job receives a flat artifact set
 * (installers + `runtime/runtime-<version>-<triple>.<ext>`) with no app directory
 * to scan, so the dylib is named explicitly instead of discovered.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHELL = process.platform === "win32";

/** Windows needs the shell for `.cmd` shims; execFileSync ignores PATHEXT. */
const run = (cmd, args, cwd = REPO) => execFileSync(cmd, args, { cwd, stdio: "inherit", shell: SHELL });

function fail(message) {
  console.error("[desktop-update] " + message);
  process.exit(1);
}

/** `--name value` and `--name=value`. */
function flagValue(argv, name, fallback) {
  const eq = argv.find((a) => a.startsWith(name + "="));
  if (eq !== undefined) return eq.slice(name.length + 1);
  const at = argv.indexOf(name);
  if (at >= 0) return argv[at + 1];
  return fallback;
}

/** Files that could be the runtime dylib, biggest first (the runtime is by far the largest). */
function dylibCandidates(appDir) {
  const roots = [appDir, join(appDir, "Contents", "MacOS")];
  const found = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      if (!/\.(so|dll|dylib)$/i.test(entry)) continue;
      const path = join(root, entry);
      found.push({ path, size: statSync(path).size });
    }
  }
  return found.sort((a, b) => b.size - a.size);
}

/**
 * The artifact-name label for a triple. Required, not cosmetic: artifacts are
 * named `CelesteaStudio-2.8.1-linux-x64.AppImage`, so matching on the raw triple
 * finds NOTHING (measured: the generator died with "no runtime dylib for
 * x86_64-unknown-linux-gnu" while the file was sitting right there).
 */
const LABELS = {
  "x86_64-unknown-linux-gnu": "linux-x64",
  "aarch64-unknown-linux-gnu": "linux-arm64",
  "x86_64-apple-darwin": "macos-x64",
  "aarch64-apple-darwin": "macos-arm64",
  "x86_64-pc-windows-msvc": "windows-x64",
};

/**
 * Locate the built app directory for `triple` inside the artifacts dir, then the
 * runtime dylib in it. Single-file artifacts (.AppImage/.dmg/.msi) are accepted
 * via their sibling directory, which `deno desktop` always leaves behind.
 */
function findNewDylib(artifactsDir, triple) {
  const markers = [triple, LABELS[triple]].filter((m) => typeof m === "string");
  const mentionsTriple = (name) => markers.some((marker) => name.includes(marker));
  for (const entry of readdirSync(artifactsDir)) {
    if (!mentionsTriple(entry)) continue;
    const path = join(artifactsDir, entry);
    const dirs = statSync(path).isDirectory() ? [path] : [join(artifactsDir, basename(entry, extname(entry)))];
    for (const dir of dirs) {
      if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
      const [best] = dylibCandidates(dir);
      if (best !== undefined) return best;
    }
  }
  return null;
}

/** Newest-first list of `runtime-<version>-<triple>*` files in the previous dir. */
function findPrevious(previousDir, triple) {
  if (previousDir === undefined || !existsSync(previousDir)) return [];
  const out = [];
  for (const entry of readdirSync(previousDir)) {
    if (!entry.includes(triple) || !entry.startsWith("runtime-")) continue;
    const version = entry.slice("runtime-".length, entry.length - triple.length - 1);
    if (version === "") continue;
    out.push({ version, path: join(previousDir, entry) });
  }
  // Version order, not mtime: the feed must keep the newest N by VERSION.
  return out.sort((a, b) => (releaseOrder(b.version, a.version) === "newer" ? 1 : -1));
}

/**
 * Ordering of two version strings: `newer` | `same` | `older` | `unknown`.
 *
 * Mirrors scripts/desktop/update-check.ts on purpose — the generator must refuse
 * to build a DOWNGRADE patch, and only an ordering that admits "I cannot tell"
 * can do that for tags like `nightly` or a bare commit hash.
 */
function releaseOrder(candidate, current) {
  const left = String(candidate).replace(/^v/i, "");
  const right = String(current).replace(/^v/i, "");
  if (left === right) return "same";
  const a = left.split(".");
  const b = right.split(".");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = Number.parseInt(a[i] ?? "0", 10);
    const y = Number.parseInt(b[i] ?? "0", 10);
    if (Number.isNaN(x) || Number.isNaN(y)) return "unknown";
    if (x !== y) return x > y ? "newer" : "older";
  }
  return "same";
}

function sha256(path) {
  // Streamed: the dylib is ~85 MB and patches are not much smaller.
  const hash = createHash("sha256");
  return new Promise((ok, bad) => {
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", bad)
      .on("end", () => ok(hash.digest("hex")));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const triple = flagValue(argv, "--triple");
  const version = flagValue(argv, "--version");
  const artifacts = flagValue(argv, "--artifacts");
  const outDir = resolve(flagValue(argv, "--out", join(REPO, "scripts", "desktop", "dist", "feed")));
  const previousDir = flagValue(argv, "--previous");
  const keep = Number.parseInt(flagValue(argv, "--keep", "3"), 10);
  const bsdiff = flagValue(argv, "--bsdiff-cmd", "bsdiff");
  const dylibOnly = argv.includes("--dylib-only");

  if (triple === undefined || version === undefined || artifacts === undefined) {
    fail("--triple, --version and --artifacts are required");
  }
  if (!existsSync(artifacts)) fail("artifacts dir not found: " + artifacts);

  const explicitDylib = flagValue(argv, "--dylib");
  const explicitPath = explicitDylib === undefined ? null : resolve(process.cwd(), explicitDylib);
  if (explicitPath !== null && !existsSync(explicitPath)) {
    fail("--dylib path does not exist: " + explicitPath);
  }
  const dylib =
    explicitPath === null
      ? findNewDylib(resolve(artifacts), triple)
      : { path: explicitPath, size: statSync(explicitPath).size };
  if (dylib === null) fail("no runtime dylib for " + triple + " under " + artifacts);
  console.log(`[desktop-update] ${triple} new dylib ${dylib.path} (${Math.round(dylib.size / 1048576)} MB)`);

  const feedDir = join(outDir, triple);
  const runtimeDir = join(outDir, "runtime");
  const patchDir = join(feedDir, "patches");
  mkdirSync(runtimeDir, { recursive: true });

  // Keep the new dylib verbatim for the NEXT release's --previous input.
  const dylibName = "runtime-" + version + "-" + triple + extname(dylib.path);
  copyFileSync(dylib.path, join(runtimeDir, dylibName));
  if (dylibOnly) {
    // Used by the BUILD job: it only needs to publish this dylib alongside the
    // installers, so the next release can diff against exact bytes.
    console.log("[desktop-update] wrote " + join(runtimeDir, dylibName));
    return;
  }

  mkdirSync(patchDir, { recursive: true });
  const patches = {};
  for (const previous of findPrevious(previousDir, triple).slice(0, keep)) {
    // The runtime compares versions by EXACT EQUALITY (no ordering at all), so a
    // manifest that points backwards WOULD be applied as a downgrade. Refusing to
    // build such a patch is the only place this can be caught.
    const order = releaseOrder(version, previous.version);
    if (order !== "newer") {
      const what = order === "older" ? "a downgrade" : order === "same" ? "the same version" : "an unorderable version";
      console.warn(
        "[desktop-update] refusing to patch " + previous.version + " -> " + version + " (" + what + ")",
      );
      continue;
    }
    const patchName = "patches/patch-" + previous.version + "-to-" + version + ".bin";
    const patchPath = join(feedDir, patchName);
    console.log(`[desktop-update] bsdiff ${previous.version} -> ${version}`);
    try {
      run(bsdiff, [previous.path, dylib.path, patchPath]);
    } catch {
      console.warn("[desktop-update] bsdiff failed for " + previous.version + " — that version will be skipped");
      continue;
    }
    patches[previous.version] = { name: patchName, sha256: await sha256(patchPath) };
  }

  const manifest = { version, patches };
  const manifestPath = join(feedDir, "latest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  // Aggregate manifest: the ONE file the app reads from the Release to detect an
  // update. The per-target manifests cannot be attached to a Release at all (both
  // are called `latest.json`), and this one also tells the app whether a patch
  // exists for its own triple. Merged across the per-target invocations.
  const aggregatePath = join(outDir, "latest.json");
  let aggregate = { version, platforms: {} };
  if (existsSync(aggregatePath)) {
    try {
      const previous = JSON.parse(readFileSync(aggregatePath, "utf8"));
      if (previous.version === version) aggregate = { version, platforms: previous.platforms ?? {} };
    } catch {
      // unreadable/partial file: rewrite it from scratch
    }
  }
  aggregate.platforms[triple] = { manifest: triple + "/latest.json", patches };
  writeFileSync(aggregatePath, JSON.stringify(aggregate, null, 2) + "\n");
  console.log("[desktop-update] aggregate manifest: " + aggregatePath);

  console.log("[desktop-update] wrote " + manifestPath);
  console.log("[desktop-update] patches: " + (Object.keys(patches).join(", ") || "(none — no previous dylibs supplied)"));
  console.log("[desktop-update] dylib for the next release: " + join(runtimeDir, dylibName));
  if (Object.keys(patches).length === 0) {
    console.log(
      "[desktop-update] NOTE: a manifest without patches still ANNOUNCES the version; clients log\n" +
        "'no patch available for <current>' and stay put. Generate patches by passing --previous\n" +
        "with the previous release's runtime-<version>-<triple> file(s).",
    );
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
