#!/usr/bin/env node
/**
 * scripts/desktop/build.mjs (H) — ONE command that turns this checkout into a desktop app.
 *
 * Why a wrapper instead of raw `deno desktop` lines in package.json:
 *   · the frontend must be embedded (`--include webdist`) and readable at
 *     `import.meta.dirname + "/webdist"` inside the binary, which only holds
 *     when the compile runs with cwd == scripts/desktop (the entry's own
 *     directory). Getting this wrong does not crash: the app boots and serves
 *     the "build the frontend first" hint page;
 *   · `@celestea/*` and the studio's npm imports must be mapped EXPLICITLY for
 *     Deno (a generated, absolute import map — see writeImportMap), because a
 *     deno.json in scope (required to bake the auto-update version) switches
 *     Deno to managed-npm resolution, which cannot read pnpm's workspace:/peer
 *     layout;
 *   · the version and the auto-update feed URL have to be BAKED into the binary
 *     (deno.json `version` + `desktop.release.baseUrl`) — there is no CLI flag
 *     for either, and a wrong/absent version makes Deno.autoUpdate() a no-op;
 *   · a fresh `pnpm build` has to happen first, or you ship last week's studio.
 *
 * Modes:
 *   --dev       run with HMR (backend modules hot-replace; the Vite frontend is
 *               a prebuilt static bundle, so UI iteration still uses
 *               `pnpm --dir apps/web dev` in a browser)
 *   --inspect   --dev plus the inspector (Deno runtime AND renderer DevTools)
 *   (default)   build the app for distribution
 *
 * Everything else is forwarded verbatim to `deno desktop`, e.g.
 *   pnpm desktop:build -- --compress --target aarch64-apple-darwin
 *   pnpm desktop:build -- --output scripts/desktop/dist/x.AppImage
 * `--all-targets` is handled HERE (six explicit invocations, one per triple)
 * rather than by Deno: it keeps every artifact inside dist/ with a predictable
 * name, and each target still gets its own baked version + feed URL.
 *
 * Env:
 *   CELESTEA_SKIP_BUILD=1               skip `pnpm build` (you own dist freshness)
 *   CELESTEA_DESKTOP_OUT=d              output directory (default scripts/desktop/dist)
 *   CELESTEA_DESKTOP_VERSION=x.y.z      override the version baked into the app
 *   CELESTEA_DESKTOP_UPDATE_BASE_URL=u  auto-update feed root (https). The target
 *                                       triple is appended, so the app polls
 *                                       <u>/<triple>/latest.json. Unset = the
 *                                       build has no feed and stays dormant.
 *
 * Artifacts land in `scripts/desktop/dist/` on purpose: the repo's bare `dist/`
 * ignore rule covers it at ANY depth, and that same directory name is what
 * ESLint ("dist") and dependency-cruiser ("dist", "webdist") already skip. One
 * name, three gates, no second .gitignore line. A differently named directory
 * would be committed by `git add -A`, linted, and cruised.
 */
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, utimesSync, watch, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_DIR = join(REPO, "scripts", "desktop");
const ENTRY = join(APP_DIR, "main.ts");
const STAGED_WEB = join(APP_DIR, "webdist");
const WEB_SOURCE = join(REPO, "apps", "studio", "webdist");
const VENDOR = join(APP_DIR, "vendor");
const OUT_DIR = resolve(process.env["CELESTEA_DESKTOP_OUT"] ?? join(APP_DIR, "dist"));
const IMPORT_MAP = join(OUT_DIR, "import-map.json");

/**
 * The studio's bare npm dependencies, copied OUT of node_modules before the
 * compile. Two Deno facts force this:
 *   · a path inside node_modules is never embedded into a compiled binary
 *     ("path not found (entry missing)" at STARTUP, not at build time), so the
 *     import map cannot point there;
 *   · letting Deno resolve npm itself (managed mode) breaks on pnpm's
 *     `workspace:*` + isolated peer layout the moment a deno.json is in scope —
 *     which auto-update requires, since the version only comes from there.
 * A plain copy next to the entry keeps both worlds deterministic, and the
 * version range still has ONE source of truth: apps/studio/package.json.
 */
const VENDORED = ["hono", "@hono/node-server"];

/**
 * Every triple `deno desktop` builds, taken from its own `--all-targets` list.
 * `aarch64-pc-windows-msvc` exists in the 2.9.7 binary but is NOT in that list
 * and its backend archive is unverified, so it is deliberately absent.
 */
const ALL_TRIPLES = [
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
];

/** Host → triple, so a local build bakes the same feed path CI publishes to. */
const HOST_TRIPLES = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};

/** Windows needs the shell for pnpm/deno `.cmd` shims — execFileSync ignores PATHEXT. */
const SHELL = process.platform === "win32";
const run = (cmd, args, cwd = REPO) => execFileSync(cmd, args, { cwd, stdio: "inherit", shell: SHELL });

function fail(message) {
  console.error("[desktop] " + message);
  process.exit(1);
}

/** `--name value` and `--name=value` both work; undefined when absent. */
function flagValue(argv, name) {
  const eq = argv.find((a) => a.startsWith(name + "="));
  if (eq !== undefined) return eq.slice(name.length + 1);
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

/**
 * Remove a flag (and its separate value) from the passthrough list.
 *
 * Why this exists: `deno desktop` takes the LAST occurrence of a repeated flag,
 * so passing a caller's relative `--output` through after our own absolute one
 * silently redirected output to `<cwd>/<relative path>` — measured as artifacts
 * landing in `scripts/desktop/scripts/desktop/dist/...` while the wrapper
 * cheerfully printed the path it intended.
 */
function stripFlag(argv, names) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (names.includes(arg)) {
      i++; // also drop the flag's value
      continue;
    }
    if (names.some((name) => arg.startsWith(name + "="))) continue;
    out.push(arg);
  }
  return out;
}

/** `--dev` / `--inspect` are ours; the rest belongs to `deno desktop`. */
function parseArgv(argv) {
  const mode = argv.includes("--inspect") ? "inspect" : argv.includes("--dev") ? "dev" : "build";
  const forwarded = argv.filter((a) => a !== "--dev" && a !== "--inspect");
  return { mode, forwarded };
}

function resolveTriple(forwarded) {
  const explicit = flagValue(forwarded, "--target");
  if (explicit !== undefined) return explicit;
  return HOST_TRIPLES[process.platform + "-" + process.arch] ?? null;
}

/**
 * The standard installer set per target OS.
 *
 * Two measured rules decide the list:
 *   · `""` (a bare stem) means "let `deno desktop` pick the bundle format" — and
 *     that only matches the target when the HOST is that same OS. Cross-building
 *     a macOS target from Linux with no extension produced a LINUX-style
 *     directory (launcher + `.so`), not an `.app`, so macOS bundles are simply
 *     not offered off-macOS. `.dmg` additionally shells out to hdiutil.
 *   · `.deb`/`.rpm`/`.msi`/`.AppImage` are explicit extensions and cross-compile
 *     from anywhere (verified: aarch64 deb+rpm built on an x86_64 host).
 * Windows keeps its directory form on a Windows host: that directory holds the
 * runtime DLL the patch job needs.
 */
function hostFamily() {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "apple";
  return "linux";
}

function targetFamily(triple) {
  if (triple.includes("linux")) return "linux";
  if (triple.includes("apple")) return "apple";
  return "windows";
}

function formatsFor(triple) {
  const family = targetFamily(triple);
  if (family === "linux") return [".AppImage", ".deb", ".rpm"];
  // `.app` cross-builds fine from any host (measured: `--output <stem>` on Linux
  // yields `<stem>.app/Contents/…`); `.dmg` shells out to hdiutil, so macOS only.
  if (family === "apple") return hostFamily() === "apple" ? ["", ".dmg"] : [""];
  return hostFamily() === "windows" ? ["", ".msi"] : [".msi"];
}

/**
 * Debian/RPM package names in the conventional arch spelling. Why it matters:
 * `deno desktop` derives the Package field from the OUTPUT FILE STEM, so
 * `CelesteaStudio-x86_64-unknown-linux-gnu.deb` installs as
 * `celesteastudio-x86-64-unknown-linux-gnu` — a name no `apt` user recognizes.
 * The version deliberately stays OUT of these stems for the same reason (it
 * lives in the package metadata), while the other artifacts carry it.
 */
const DEB_ARCH = { aarch64: "arm64", x86_64: "amd64" };
const RPM_ARCH = { aarch64: "aarch64", x86_64: "x86_64" };

/** Human-readable labels for artifacts: a `--target` triple's vendor segment (the literal "unknown") never belongs in a filename. */
function osArchLabel(triple) {
  const os = triple.includes("linux") ? "linux" : triple.includes("apple") ? "macos" : "windows";
  const arch = triple.includes("aarch64") ? "arm64" : "x64";
  return os + "-" + arch;
}

function outputName(version, triple, format) {
  const arch = triple.includes("aarch64") ? "aarch64" : "x86_64";
  if (format === ".deb") return "celestea-studio-" + DEB_ARCH[arch] + ".deb";
  if (format === ".rpm") return "celestea-studio-" + RPM_ARCH[arch] + ".rpm";
  return "CelesteaStudio-" + version + "-" + osArchLabel(triple) + format;
}

function defaultOutput(mode, triple, format, version) {
  if (mode !== "build") return join(OUT_DIR, "dev");
  if (triple === null) return join(OUT_DIR, "CelesteaStudio" + format);
  return join(OUT_DIR, outputName(version, triple, format));
}

/** The version baked into the app: the repo's single source of truth (`git describe`). */
function resolveVersion() {
  const explicit = (process.env["CELESTEA_DESKTOP_VERSION"] ?? "").trim();
  if (explicit !== "") return explicit;
  const stdout = execFileSync("node", [join("scripts", "version.mjs"), "--json"], {
    cwd: REPO,
    encoding: "utf8",
    shell: SHELL,
  });
  return JSON.parse(stdout).version;
}

/** Fresh `dist/` for every package: the entry imports built JS, not TS. */
function buildWorkspace() {
  if (process.env["CELESTEA_SKIP_BUILD"] === "1") {
    console.log("[desktop] CELESTEA_SKIP_BUILD=1 — reusing existing dist/ and webdist/");
    return;
  }
  console.log("[desktop] pnpm build (fresh dist/ + apps/studio/webdist)");
  run("pnpm", ["build"]);
}

/**
 * Stage the frontend build NEXT TO the entry, where `--include webdist` expects it.
 * A dev run tolerates a missing one (it prints the "build the frontend first"
 * hint page) so that UI-less backend iteration needs no vite run at all.
 */
function stageFrontend(required = true) {
  if (!existsSync(join(WEB_SOURCE, "index.html"))) {
    if (required) fail("no frontend build at " + WEB_SOURCE + " — run `pnpm build` (or drop CELESTEA_SKIP_BUILD=1)");
    console.warn("[desktop] no frontend build yet — run `pnpm build:web` once for the real UI");
    return;
  }
  rmSync(STAGED_WEB, { recursive: true, force: true });
  cpSync(WEB_SOURCE, STAGED_WEB, { recursive: true });
  console.log("[desktop] staged " + WEB_SOURCE + " -> " + STAGED_WEB);
}

function assertDeno() {
  try {
    execFileSync("deno", ["--version"], { stdio: "pipe", shell: SHELL });
  } catch {
    fail("`deno` is not on PATH — install Deno >= 2.9 (https://deno.com) for `deno desktop`");
  }
}

/**
 * The real directory of a dependency, as installed for the studio app.
 *
 * The node_modules entry is preferred over module resolution on purpose:
 * packages like hono ship nested `package.json` markers (dist/cjs/package.json),
 * so walking up from a resolved entry lands on the wrong directory.
 */
function packageRoot(name) {
  const linked = join(REPO, "apps", "studio", "node_modules", name);
  if (existsSync(join(linked, "package.json"))) return realpathSync(linked);
  const require = createRequire(join(REPO, "apps", "studio", "package.json"));
  let dir = dirname(require.resolve(name));
  while (dir !== dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name) return dir;
    dir = dirname(dir);
  }
  return fail("cannot locate the installed package root for " + name);
}

/** See VENDORED: node_modules paths cannot be embedded, so copy them out. */
function stageVendor() {
  rmSync(VENDOR, { recursive: true, force: true });
  for (const name of VENDORED) {
    const root = packageRoot(name);
    const from = join(root, "dist");
    const to = join(VENDOR, name, "dist");
    if (!existsSync(from)) fail("cannot vendor " + name + ": no dist/ under " + root);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
    console.log("[desktop] vendored " + name + " -> " + to);
  }
}

/**
 * The import map, generated with ABSOLUTE file:// URLs.
 *
 * Why absolute, and why generated instead of committed: with a relative map
 * `deno desktop --hmr` resolved the entries against the process CWD instead of
 * the map's location, so `../../packages/core/dist/index.js` became
 * `<cwd>/packages/core/dist/index.js` and the backend died with "Module not
 * found" — a dev-only failure, invisible in packaging builds. Absolute URLs
 * cannot be reinterpreted, and a map that carries this machine's paths must not
 * be committed.
 *
 * Every bare specifier the studio's module graph uses is listed here; nothing is
 * left to Deno's npm resolver, which is what broke on pnpm's `workspace:*` +
 * isolated peer layout as soon as a deno.json (auto-update's `version`) existed.
 */
function writeImportMap(mode) {
  const abs = (rel) => pathToFileURL(join(REPO, rel)).href;
  const vendored = (rel) => pathToFileURL(join(VENDOR, rel)).href;
  // Dev maps to the TypeScript SOURCES and Deno compiles them itself (with
  // --sloppy-imports turning tsc's `.js` specifiers into the real `.ts` files).
  // That is the difference between `desktop:dev` starting in seconds and it
  // running tsc + vite across the workspace on every single invocation.
  const pkg = (name) => (mode === "build" ? `packages/${name}/dist/index.js` : `packages/${name}/src/index.ts`);
  const imports = {
    "@celestea/core": abs(pkg("core")),
    "@celestea/session": abs(pkg("session")),
    "@celestea/llm": abs(pkg("llm")),
    "@celestea/tools": abs(pkg("tools")),
    "@celestea/agent-loop": abs(pkg("agent-loop")),
    "@celestea/workers": abs(pkg("workers")),
    "@celestea/runtime": abs(pkg("runtime")),
    "@celestea/studio": abs(mode === "build" ? "apps/studio/dist/index.js" : "apps/studio/src/index.ts"),
    hono: vendored("hono/dist/index.js"),
    "hono/streaming": vendored("hono/dist/helper/streaming/index.js"),
    "hono/ws": vendored("hono/dist/helper/websocket/index.js"),
    "hono/utils/mime": vendored("hono/dist/utils/mime.js"),
    "@hono/node-server": vendored("@hono/node-server/dist/index.mjs"),
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(IMPORT_MAP, JSON.stringify({ imports }, null, 2) + "\n");
  return IMPORT_MAP;
}

/**
 * deno.json is the ONLY way to bake the version (no flag exists for it), and a
 * version is what makes `Deno.autoUpdate()` do anything at all. It is written
 * NEXT TO THE ENTRY and auto-discovered, not passed as `--config` from dist/:
 * a config file makes its own directory the project root, and that decides which
 * package.json the module graph is checked against (measured: a config in dist/
 * turned the working build into "Import @celestea/runtime not a dependency").
 *
 * The update FEED is deliberately NOT baked here — see writeUpdateEnv.
 */
function writeBuildConfig(version) {
  const config = {
    version,
    desktop: {
      app: { name: "CelesteaStudio", identifier: "com.celestea.studio" },
      backend: "webview",
    },
  };
  const path = join(APP_DIR, "deno.json");
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  console.log("[desktop] baked version " + version);
  return path;
}

/**
 * The update feed URL, embedded as an ENV FILE (`--env-file=`, verified to be
 * baked into the compiled binary) rather than as `desktop.release.baseUrl`.
 *
 * Why: `Deno.autoUpdate()` has no runtime "is a feed configured?" flag, so a
 * baked-but-unset baseUrl must be *some* URL — and a reserved non-resolving one
 * still emits "check failed: fetch failed" on every poll. Embedding the URL
 * only when a feed exists lets the entry skip the call entirely for local/dev
 * builds, so there is no placeholder host anywhere in the product.
 */
function writeUpdateEnv(triple, version) {
  const raw = (process.env["CELESTEA_DESKTOP_UPDATE_BASE_URL"] ?? "").trim();
  const path = join(OUT_DIR, "desktop.env");
  mkdirSync(OUT_DIR, { recursive: true });
  // The version rides along as a SECOND source: if the generated deno.json is
  // ever not picked up, `Deno.desktopVersion` is null and the app would report
  // "unknown" while still being a perfectly good build.
  const lines = ["CELESTEA_DESKTOP_VERSION=" + version];
  // The GitHub Release check needs to know which repo to ask, and this script is
  // deliberately NOT guessing it: deriving from `git remote get-url origin` would
  // silently point a FORK's builds at that fork's releases, and a hard-coded name
  // would point every fork at one project. It is an explicit knob; when it is not
  // set, Release-based update detection stays off and the app says so.
  const repo = (process.env["CELESTEA_DESKTOP_UPDATE_REPO"] ?? "").trim();
  if (repo !== "") {
    lines.push("CELESTEA_DESKTOP_UPDATE_REPO=" + repo);
    console.log("[desktop] release update checks against " + repo);
  } else {
    console.log("[desktop] no CELESTEA_DESKTOP_UPDATE_REPO — Release-based update checks stay off");
  }
  if (raw === "") {
    lines.push("# this build has no update feed (local/dev build)");
    console.log("[desktop] no update feed configured — auto-update stays off");
  } else {
    const feed = raw.replace(/\/+$/, "") + "/" + (triple ?? "unknown");
    lines.push("CELESTEA_DESKTOP_UPDATE_URL=" + feed);
    console.log("[desktop] update feed " + feed);
  }
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

/** One `deno desktop` invocation: one target, one output format. */
function buildOne({ mode, forwarded, triple, version, format }) {
  const explicitOutput = flagValue(forwarded, "--output") ?? flagValue(forwarded, "-o");
  // The config is auto-discovered from the entry's directory (see writeBuildConfig).
  writeBuildConfig(version);
  const args = [
    "desktop",
    "-A",
    "--no-check",
    "--node-modules-dir=manual",
    // tsc (module: NodeNext) requires TS files to be imported with a `.js`
    // specifier; Deno requires the REAL extension or this flag. Without it the
    // entry's own modules cannot be resolved at all:
    //   error: Module not found ".../tray.js". Maybe change the extension to '.ts'
    "--sloppy-imports",
    // `=` matters: the optional value of --env-file is only consumed in that
    // form, otherwise the path becomes the ENTRY file (measured: the compile
    // then aborts with "envfile is not defined" at the .env path).
    "--env-file=" + writeUpdateEnv(triple, version),
    "--import-map",
    writeImportMap(mode),
    "--include",
    "webdist",
    // The frozen contracts are DATA the startup gate reads (packages/core/src/repo.ts
    // walks up from its own module to `<pkg>/contracts`). Without this the very first
    // thing the app does — verifyContractsAtStartup — dies with "repository root not
    // found": a lean build embeds the module graph only, not the checkout.
    "--include",
    join("..", "..", "packages", "core", "contracts"),
  ];
  if (mode !== "build") args.push("--hmr");
  if (mode === "inspect") args.push("--inspect");
  // The target MUST be passed every time: without it `deno desktop` builds the
  // HOST binary while we happily name the output after the requested triple —
  // i.e. an aarch64-labelled file that is really x86_64 (measured: this is what
  // made `--all-targets` produce "all platforms" that were all the same one).
  if (triple !== null) args.push("--target", triple);

  const out =
    explicitOutput === undefined ? defaultOutput(mode, triple, format ?? "", version) : resolve(process.cwd(), explicitOutput);
  // Resolve against the CALLER's cwd (CI passes repo-relative paths) and hand Deno
  // an absolute path: `deno desktop` runs with cwd == the entry's dir and does not
  // create missing parents, so a relative path would either nest or fail opaquely.
  mkdirSync(dirname(out), { recursive: true });
  args.push("--output", out);
  // The caller's own --output/--target must NOT be forwarded: a repeated flag is
  // resolved by its LAST occurrence (see stripFlag).
  args.push(...stripFlag(forwarded, ["--output", "-o", "--target"]), ENTRY);

  console.log("[desktop] deno " + args.join(" ") + "\n[desktop] cwd " + APP_DIR);
  if (mode !== "build") {
    // cwd MUST be the entry's directory: `--include` paths resolve against it.
    startDev(args, [join(REPO, "packages"), join(REPO, "apps", "studio", "src")]);
    return out;
  }
  // cwd MUST be the entry's directory: `--include` paths resolve against it.
  run("deno", args, APP_DIR);
  return out;
}


/**
 * Dev's reload loop: watch the SOURCES and restart the app on change.
 *
 * Why not rely on `--hmr` alone: it watches only the entry's own directory (it
 * prints `watching <scripts/desktop>`) and it decides by CONTENT hash, so edits
 * in a package source (`packages/<pkg>/src`) neither trigger it nor can be nudged by touching a file
 * (measured: entry mtime changes produced no reload). Restarting the child is
 * the honest mechanism, and it is cheap because dev runs the TypeScript sources
 * directly — no tsc, no vite, ~4 s from launch to a serving app.
 *
 * The entry's own directory is NOT watched: restarting rewrites nothing, but
 * watching APP_DIR would make the restart loop forever.
 */
function startDev(args, sources) {
  /** "run" = normal, "restart" = reload requested, "stop" = shut down for good. */
  let state = "run";
  let child = null;
  let pending = null;
  const watchers = [];
  const cleanup = () => {
    for (const w of watchers) w.close();
  };
  const spawnApp = () => {
    console.log("[desktop] starting the app" + (child === null ? "" : " (reload)"));
    child = spawn("deno", args, { cwd: APP_DIR, stdio: "inherit", shell: SHELL });
    child.on("exit", (code) => {
      if (state === "restart") {
        state = "run";
        spawnApp();
        return;
      }
      cleanup();
      process.exit(code ?? 0);
    });
  };
  for (const dir of sources) {
    if (!existsSync(dir)) continue;
    try {
      watchers.push(
        watch(dir, { recursive: true }, (_event, file) => {
          if (file !== null && !/\.[cm]?[jt]sx?$/.test(String(file))) return;
          if (pending !== null) clearTimeout(pending);
          pending = setTimeout(() => {
            console.log("[desktop] change under " + dir + " — restarting");
            state = "restart";
            child?.kill("SIGTERM");
          }, 250);
        }),
      );
    } catch (error) {
      console.warn("[desktop] cannot watch " + dir + ": " + String(error));
    }
  }
  console.log("[desktop] watching for source changes: " + sources.join(", "));
  const shutdown = () => {
    state = "stop";
    cleanup();
    child?.kill("SIGTERM");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  spawnApp();
}

function main() {
  const { mode, forwarded } = parseArgv(process.argv.slice(2));
  const allTargets = forwarded.includes("--all-targets");
  const rest = forwarded.filter((a) => a !== "--all-targets");
  const explicitOutput = flagValue(rest, "--output") ?? flagValue(rest, "-o");

  assertDeno();
  if (mode === "build") {
    buildWorkspace();
    stageFrontend();
  } else {
    // Sources + the last frontend build: no tsc, no vite. Deno's HMR then swaps
    // edited modules in the running app.
    console.log("[desktop] dev mode: TypeScript sources + existing webdist (no pnpm build)");
    stageFrontend(false);
  }
  stageVendor();

  const version = resolveVersion();
  const triples = allTargets ? ALL_TRIPLES : [resolveTriple(rest)];
  const built = [];
  for (const triple of triples) {
    // An explicit --output means "one artifact, exactly here"; otherwise build the
    // standard installer set for the target (a dev run has a single output).
    const formats = mode === "build" && explicitOutput === undefined ? formatsFor(triple) : [""];
    if (formats.length === 0) {
      console.warn("[desktop] skip " + triple + ": that bundle needs a " + targetFamily(triple) + " build host — run it there or in CI");
      continue;
    }
    for (const format of formats) {
      console.log("[desktop] === " + (triple ?? "host default") + " " + (format || "(bundle)") + " ===");
      built.push(buildOne({ mode, forwarded: rest, triple, version, format }));
    }
  }
  console.log("[desktop] built:\n  " + built.join("\n  "));
}

main();
