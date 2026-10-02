#!/usr/bin/env node
/**
 * scripts/desktop/publish.mjs (H) — ONE command that ships a desktop release: generate
 * the auto-update feed and create the GitHub Release. The workflow calls exactly
 * this command, so CI and a laptop cannot drift apart.
 *
 * DEFAULT: GitHub Release only (installers + feed files + the runtime dylibs the
 * next release diffs against). Uploading the feed to R2 is OPT-IN via `--r2`,
 * because a feed host has to serve 200 without redirects — see the note in
 * .github/workflows/desktop-release.yml — and because it needs credentials the
 * release itself does not.
 *
 * Credentials come from the ENVIRONMENT ONLY and are never printed or passed as
 * arguments (an argv secret is visible in `ps` and in CI logs):
 *   GH_TOKEN (or an already-authenticated `gh`)
 *   --r2 additionally needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 *
 * Usage:
 *   node scripts/desktop/publish.mjs [--artifacts dir] [--feed dir] [--version v]
 *                                    [--previous dir | --previous-release latest]
 *                                    [--r2] [--no-release] [--no-stage] [--dry-run]
 *   node scripts/desktop/publish.mjs --publish-staged <整理好的目录>   # 只上传（CI 的 release job）
 *
 * The two-flag split mirrors the CI jobs: the BUILD job runs the default path with
 * `--no-release` (generate the feed + stage into `release/`), and the RELEASE job
 * runs `--publish-staged` against what that produced, so latest.json is generated
 * where the build artifacts actually live.
 *
 * `--dry-run` needs no credentials and prints every command it would run — the
 * way to check the plan before a release.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHELL = process.platform === "win32";
const TRIPLES = [
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
];
/** Everything a user downloads; the sibling unpacked directories are inputs, not deliverables. */
const INSTALLER_GLOBS = ["*.AppImage", "*.deb", "*.rpm", "*.dmg", "*.msi"];

/**
 * Artifact names carry human labels (`linux-x64`), NOT the `--target` triple
 * (whose vendor segment is a literal "unknown"). So "do we have artifacts for
 * this triple?" is answered through this map, not by substring-matching the
 * triple — matching the triple would silently skip every platform.
 */
const LABELS = {
  "x86_64-unknown-linux-gnu": "linux-x64",
  "aarch64-unknown-linux-gnu": "linux-arm64",
  "x86_64-apple-darwin": "macos-x64",
  "aarch64-apple-darwin": "macos-arm64",
  "x86_64-pc-windows-msvc": "windows-x64",
};

function labelFor(triple) {
  const label = LABELS[triple];
  if (label === undefined) fail("unknown triple " + triple, ["expected one of: " + Object.keys(LABELS).join(", ")]);
  return label;
}

function fail(message, hints = []) {
  console.error("[desktop-publish] " + message);
  for (const hint of hints) console.error("[desktop-publish]   " + hint);
  process.exit(1);
}

function flagValue(argv, name, fallback) {
  const eq = argv.find((a) => a.startsWith(name + "="));
  if (eq !== undefined) return eq.slice(name.length + 1);
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : fallback;
}

const dryRun = process.argv.includes("--dry-run");

/** Every external command goes through here, so --dry-run is honest by construction. */
function run(cmd, args) {
  if (dryRun) {
    console.log("[desktop-publish] would run: " + cmd + " " + args.join(" "));
    return "";
  }
  return execFileSync(cmd, args, { cwd: REPO, encoding: "utf8", stdio: "inherit", shell: SHELL });
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

/** The previous release's runtime dylibs, without which no patch can be built. */
function fetchPrevious(argv, version) {
  const explicit = flagValue(argv, "--previous");
  if (explicit !== undefined) return resolve(process.cwd(), explicit);
  const release = flagValue(argv, "--previous-release");
  if (release === undefined) return undefined;
  const dir = join(REPO, "scripts", "desktop", "dist", "previous");
  mkdirSync(dir, { recursive: true });
  const tag = release === "latest" ? "$(gh release list --limit 1 --exclude-drafts --json tagName --jq '.[0].tagName')" : release;
  if (dryRun) {
    console.log(`[desktop-publish] would run: gh release download ${tag} --pattern runtime-* --dir ${dir}`);
    return dir;
  }
  if (release === "latest") {
    const found = execFileSync(
      "gh",
      ["release", "list", "--limit", "1", "--exclude-drafts", "--json", "tagName", "--jq", ".[0].tagName"],
      { cwd: REPO, encoding: "utf8", shell: SHELL },
    ).trim();
    if (found === "" || found === "null") {
      console.log("[desktop-publish] no previous release — the feed will announce a version with no patches");
      return dir;
    }
    console.log("[desktop-publish] previous release: " + found + " (this release is " + version + ")");
    execFileSync("gh", ["release", "download", found, "--pattern", "runtime-*", "--dir", dir], {
      cwd: REPO,
      stdio: "inherit",
      shell: SHELL,
    });
    return dir;
  }
  execFileSync("gh", ["release", "download", release, "--pattern", "runtime-*", "--dir", dir], {
    cwd: REPO,
    stdio: "inherit",
    shell: SHELL,
  });
  return dir;
}

/**
 * The installers to publish. Filtered by the release version as well as by
 * extension, so a stray local build (`urlcheck.AppImage`) can never end up in a
 * public Release; the deb/rpm names carry no version by design (their Package
 * name must stay clean), hence the second accepted shape.
 */
function installersIn(artifacts, version) {
  return readdirSync(artifacts)
    .filter((name) => INSTALLER_GLOBS.some((glob) => name.endsWith(glob.slice(1))))
    .filter((name) => name.startsWith("celestea-studio-") || name.includes("-" + version + "-"))
    .sort();
}

function buildFeed({ artifacts, feed, version, previous, triples }) {
  const present = readdirSync(artifacts);
  let built = 0;
  for (const triple of triples) {
    // A triple with no artifact in this run is skipped loudly: publishing an
    // empty manifest for it would tell those users "no patch available".
    if (!present.some((name) => name.includes(labelFor(triple)))) {
      console.warn("[desktop-publish] no artifacts for " + triple + " (" + labelFor(triple) + ") — skipped");
      continue;
    }
    const args = [
      join("scripts", "desktop", "update.mjs"),
      "--triple",
      triple,
      "--version",
      version,
      "--artifacts",
      artifacts,
      "--out",
      feed,
    ];
    if (previous !== undefined) args.push("--previous", previous);
    // The new dylib may be given explicitly (CI: a flat artifact set with no app
    // directory to scan) — `runtime/runtime-<version>-<triple>.*`.
    const baseline = readdirSync(artifacts).find(
      (name) => name.startsWith("runtime-" + version + "-" + triple),
    );
    if (baseline !== undefined) args.push("--dylib", join(artifacts, baseline));
    run("node", args);
    built += 1;
  }
  if (built === 0) fail("none of the five triples had artifacts to publish", ["did the build step run?"]);
  return built;
}

function requireEnv(names, flag) {
  const missing = names.filter((name) => (process.env[name] ?? "").trim() === "");
  if (missing.length > 0) {
    fail("missing credentials for " + flag + ": " + missing.join(", "), [
      "set them as GitHub Actions secrets (or export them locally) — never in a file in the repo",
    ]);
  }
}

function r2Sync(feed, releaseDir) {
  // A dry run must be usable before the secrets exist — that is the whole point
  // of checking the plan first.
  if (!dryRun) {
    requireEnv(["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"], "--r2");
  }
  // Placeholders keep `--dry-run` readable when the credentials are (correctly)
  // not in the environment yet.
  const endpoint = "https://" + (process.env["R2_ACCOUNT_ID"] ?? "<R2_ACCOUNT_ID>") + ".r2.cloudflarestorage.com";
  const bucket = "s3://" + (process.env["R2_BUCKET"] ?? "<R2_BUCKET>");
  // The feed: `<triple>/latest.json` + patches. `runtime/*` stays out — those
  // ~85 MB dylibs exist only for the next release's patch job and ship as
  // Release assets instead.
  run("aws", ["s3", "sync", feed + "/", bucket + "/", "--endpoint-url", endpoint, "--exclude", "runtime/*"]);
  // The installers users download, under /downloads — taken from the STAGED set.
  const include = [...INSTALLER_GLOBS, "latest.json"].flatMap((glob) => ["--include", glob]);
  run("aws", [
    "s3",
    "sync",
    releaseDir + "/",
    bucket + "/downloads/",
    "--endpoint-url",
    endpoint,
    "--exclude",
    "*",
    ...include,
  ]);
}

/**
 * Upload the STAGED release directory, not the build output.
 *
 * `scripts/desktop/stage.mjs` turns the working directory into a flat, human-readable
 * distribution set (including the macOS `.app` as a ZIP, which the old glob-based
 * publish silently dropped) and writes SHA256SUMS + release.json. Publishing the
 * staged set means "what a user downloads" and "what we verified" are the same
 * files by construction.
 */
function githubRelease(version, releaseDir) {
  const tag = "v" + version;
  if (!existsSync(releaseDir)) fail("no staged release directory at " + releaseDir + " — run scripts/desktop/stage.mjs");
  const top = readdirSync(releaseDir)
    .filter((name) => statSync(join(releaseDir, name)).isFile())
    .map((name) => join(releaseDir, name));
  const runtimeDir = join(releaseDir, "runtime");
  const dylibs = existsSync(runtimeDir) ? readdirSync(runtimeDir).map((name) => join(runtimeDir, name)) : [];
  const installers = top.filter((file) => INSTALLER_GLOBS.some((glob) => file.endsWith(glob.slice(1))));
  if (installers.length === 0) fail("no installers in " + releaseDir);
  console.log(`[desktop-publish] release assets: ${top.length} file(s) + ${dylibs.length} runtime dylib(s)`);
  run("gh", [
    "release",
    "create",
    tag,
    "--title",
    "Celestea Studio " + version,
    "--generate-notes",
    ...top,
    ...dylibs,
  ]);
}

function main() {
  const argv = process.argv.slice(2);
  const stagedOnly = flagValue(argv, "--publish-staged");
  const artifacts = resolve(process.cwd(), flagValue(argv, "--artifacts", join("scripts", "desktop", "dist")));
  const feed = resolve(process.cwd(), flagValue(argv, "--feed", join(artifacts, "feed")));
  if (stagedOnly === undefined && !existsSync(artifacts)) fail("artifacts directory not found: " + artifacts);

  const version = resolveVersion(argv);
  if (stagedOnly !== undefined) {
    // Upload-only path: the feed and the staged directory were produced by the
    // build job, so nothing is regenerated here.
    const releaseDir = resolve(process.cwd(), stagedOnly);
    if (!existsSync(releaseDir)) fail("staged release directory not found: " + releaseDir);
    console.log(`[desktop-publish] publishing the staged set at ${releaseDir}`);
    if (argv.includes("--r2")) r2Sync(feed, releaseDir);
    if (!argv.includes("--no-release")) githubRelease(version, releaseDir);
    console.log("[desktop-publish] done: GitHub Release updated from the staged set");
    return;
  }
  const triples = (flagValue(argv, "--triples") ?? "").trim() === ""
    ? TRIPLES
    : (flagValue(argv, "--triples") ?? "").split(",").map((t) => t.trim());
  console.log(`[desktop-publish] version ${version}, ${triples.length} triple(s), feed ${feed}`);

  const previous = fetchPrevious(argv, version);
  if (previous !== undefined && !existsSync(previous)) {
    console.warn("[desktop-publish] previous dylib dir does not exist: " + previous + " — starting with no patches");
  }
  const releaseDir = join(artifacts, "release");
  const built = buildFeed({
    artifacts,
    feed,
    version,
    previous: previous !== undefined && existsSync(previous) ? previous : undefined,
    triples,
  });
  console.log(`[desktop-publish] feed built for ${built} triple(s)`);

  // Stage first: one flat, checksummed directory is what everything downstream uses.
  if (!argv.includes("--no-stage")) {
    run("node", [
      join("scripts", "desktop", "stage.mjs"),
      "--artifacts", artifacts,
      "--feed", feed,
      "--version", version,
    ]);
  }
  // Release by default; R2 only when asked (it also needs its own credentials).
  if (argv.includes("--r2")) r2Sync(feed, releaseDir);
  if (!argv.includes("--no-release")) githubRelease(version, releaseDir);

  console.log(
    "[desktop-publish] done: " +
      (dryRun ? "(dry run — nothing was executed)" : "GitHub Release updated" + (argv.includes("--r2") ? " + R2" : "")),
  );
}

main();
