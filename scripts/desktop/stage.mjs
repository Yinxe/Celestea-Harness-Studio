#!/usr/bin/env node
/**
 * scripts/desktop/stage.mjs (H) — collect everything that will be DISTRIBUTED into one
 * directory (`scripts/desktop/dist/release/`) before anything is uploaded.
 *
 * Why this step exists at all: the build output is a WORKING directory (app
 * directories, intermediate bundles, per-target files), while a release is a flat
 * list of files. Publishing straight from the build output also silently dropped
 * macOS entirely — `.app` is a DIRECTORY and matched no file glob, so it never
 * reached a Release (measured: the asset list had Linux and Windows only).
 *
 * What lands in `release/`:
 *   · every installer, flat and named for humans
 *   · macOS `.app` and the Windows portable directory as ZIPs (a directory cannot
 *     be a Release asset)
 *   · `latest.json` (the aggregate update manifest the app fetches)
 *   · `runtime/` — the runtime dylibs the NEXT release diffs against for patches
 *   · `SHA256SUMS` + `release.json` (the same files, checksummed and indexed)
 *
 * Usage:
 *   node scripts/desktop/stage.mjs [--artifacts dist] [--out dist/release]
 *                                  [--feed dist/feed] [--version x.y.z]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHELL = process.platform === "win32";

/** The five targets and the label their artifact names carry (see scripts/desktop/build.mjs). */
const LABELS = {
  linux: { x86_64: "linux-x64", aarch64: "linux-arm64" },
  macos: { x86_64: "macos-x64", aarch64: "macos-arm64" },
  windows: { x86_64: "windows-x64" },
};
const INSTALLER_EXT = [".AppImage", ".deb", ".rpm", ".dmg", ".msi"];
/**
 * deb/rpm names carry the DISTRO arch spelling, not the platform label
 * (`celestea-studio-amd64.deb`, `celestea-studio-x86_64.rpm`), so matching on the
 * label alone silently dropped every Linux package manager artifact — measured:
 * the staged set had AppImages but no .deb/.rpm at all.
 */
const ARCH_TOKENS = { x86_64: ["x86_64", "amd64"], aarch64: ["aarch64", "arm64"] };

/** Directories are only zipped where the directory IS the deliverable. */
const ZIP_DIRECTORY = { linux: false, macos: true, windows: true };

function fail(message) {
  console.error("[desktop-stage] " + message);
  process.exit(1);
}

function flagValue(argv, name, fallback) {
  const eq = argv.find((a) => a.startsWith(name + "="));
  if (eq !== undefined) return eq.slice(name.length + 1);
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : fallback;
}

function resolveVersion(argv) {
  const explicit = flagValue(argv, "--version", (process.env["CELESTEA_DESKTOP_VERSION"] ?? "").trim());
  if (explicit !== "") return explicit;
  const stdout = execFileSync("node", [join("scripts", "version.mjs"), "--json"], {
    cwd: REPO,
    encoding: "utf8",
    shell: SHELL,
  });
  return JSON.parse(stdout).version;
}

/** Streamed, so an 85 MB dylib never lands in memory in one piece. */
function sha256(path) {
  return new Promise((ok, bad) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", bad)
      .on("end", () => ok(hash.digest("hex")));
  });
}

/** Zip a directory — a directory cannot be a Release asset. */
function zipDirectory(sourceDir, outFile) {
  try {
    execFileSync("zip", ["--version"], { stdio: "ignore" });
  } catch {
    fail("`zip` is required to package bundle directories (macOS .app, Windows portable)");
  }
  rmSync(outFile, { force: true });
  // `-y` keeps symlinks as symlinks (macOS bundles contain them), and running
  // with cwd = the parent is what puts the bundle directory at the archive root.
  // `basename`, not `split("/")`: on Windows the separator is `\` and the split
  // form silently zips nothing.
  execFileSync("zip", ["-r", "-q", "-y", outFile, basename(sourceDir)], {
    cwd: dirname(sourceDir),
    stdio: "inherit",
    shell: SHELL,
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const artifacts = resolve(process.cwd(), flagValue(argv, "--artifacts", join("scripts", "desktop", "dist")));
  const out = resolve(process.cwd(), flagValue(argv, "--out", join(artifacts, "release")));
  const feed = resolve(process.cwd(), flagValue(argv, "--feed", join(artifacts, "feed")));
  const version = resolveVersion(argv);
  if (!existsSync(artifacts)) fail("artifacts directory not found: " + artifacts);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "runtime"), { recursive: true });

  const index = [];
  const record = async (platform, arch, file) => {
    const entry = { platform, arch, name: file.split("/").pop(), size: statSync(file).size, sha256: await sha256(file) };
    index.push(entry);
    console.log(
      `[desktop-stage] ${platform}/${arch}  ${entry.name}  (${(entry.size / 1048576).toFixed(1)} MB)`,
    );
  };

  const present = readdirSync(artifacts);
  for (const platform of Object.keys(LABELS)) {
    for (const arch of Object.keys(LABELS[platform])) {
      const label = LABELS[platform][arch];
      const matches = (name) =>
        name.includes(label) ||
        (platform === "linux" && ARCH_TOKENS[arch].some((token) => name.includes(token)));
      for (const name of present) {
        const path = join(artifacts, name);
        if (statSync(path).isDirectory()) {
          if (!ZIP_DIRECTORY[platform] || !matches(name)) continue;
          // macOS `.app` / Windows portable directory → ZIP (a directory cannot
          // be a Release asset; Linux users get AppImage/deb/rpm instead).
          const zipName = "CelesteaStudio-" + version + "-" + label + ".zip";
          zipDirectory(path, join(out, zipName));
          await record(platform, arch, join(out, zipName));
          continue;
        }
        if (!matches(name)) continue;
        if (!INSTALLER_EXT.some((ext) => name.endsWith(ext))) continue;
        copyFileSync(path, join(out, name));
        await record(platform, arch, join(out, name));
      }
    }
  }

  const manifest = join(feed, "latest.json");
  if (existsSync(manifest)) {
    copyFileSync(manifest, join(out, "latest.json"));
    await record("all", "all", join(out, "latest.json"));
  } else {
    console.warn("[desktop-stage] no aggregate latest.json — run the feed step first if the app should self-detect");
  }
  const runtimeDir = join(feed, "runtime");
  if (existsSync(runtimeDir)) {
    for (const name of readdirSync(runtimeDir)) {
      copyFileSync(join(runtimeDir, name), join(out, "runtime", name));
      await record("runtime", name, join(out, "runtime", name));
    }
  }

  if (index.length === 0) fail("nothing to stage — did the build run?");
  const sums = index
    .filter((entry) => entry.platform !== "runtime")
    .map((entry) => entry.sha256 + "  " + entry.name)
    .sort()
    .join("\n");
  writeFileSync(join(out, "SHA256SUMS"), sums + "\n");
  writeFileSync(
    join(out, "release.json"),
    JSON.stringify({ version, generatedAt: new Date().toISOString(), files: index }, null, 2) + "\n",
  );
  console.log(`[desktop-stage] ${index.length} file(s) staged in ${out}`);
  console.log("[desktop-stage] SHA256SUMS + release.json written");
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
