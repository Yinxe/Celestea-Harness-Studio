/**
 * `deno desktop` entry (H) — the studio in a native window.
 *
 * Why this file exists: `deno desktop` needs an entrypoint that OWNS the
 * window, while the HTTP server stays where it already lives —
 * `startStudioServer` in `@celestea/studio`, the same bootstrap `celestea web`
 * uses (see apps/cli/src/web.ts). So this file is a THIRD caller of that
 * bootstrap, never a second implementation of it.
 *
 * Two non-obvious, load-bearing details:
 *
 *   1. STATIC ROOT. A compiled binary has no checkout: module paths are
 *      virtualized, so `defaultStaticRoot()` cannot find the frontend. The
 *      path below is the `webdist/` that `scripts/desktop/build.mjs` embeds
 *      next to this file (`--include webdist`), and it must be visible BEFORE
 *      `@celestea/studio` is imported — hence the dynamic imports below.
 *      Getting this wrong does not crash: the app starts and serves the
 *      "build the frontend first" hint page.
 *   2. PORT. The OS picks it (`port: 0`) and we read it back from
 *      `handle.listening`. A desktop app must not fight a running
 *      `celestea web` for 3777, and `deno desktop` already owns the
 *      `DENO_SERVE_ADDRESS` port for its own webview plumbing.
 *
 * CELESTEA_DESKTOP_SMOKE_MS=<n> closes the window after n ms — the hook the
 * release workflow's headless smoke test uses to prove "boots, serves, exits"
 * without a human watching a window.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { installTray } from "./tray.js";
import { compareRelease, fetchLatestRelease, fetchReleaseManifest } from "./update-check.js";

/** The embedded frontend build (see note 1 above). */
const staticRoot = join(import.meta.dirname ?? ".", "webdist");

process.env["STUDIO_STATIC_ROOT"] = staticRoot;
const env = process.env;

// Dynamic on purpose: the env override above must win before config loads.
const { celesteaHome } = await import("@celestea/core");
const { loadStudioConfig, startStudioServer } = await import("@celestea/studio");

/**
 * Same data root as the CLI (`apps/cli/src/paths.ts` is the source of truth for
 * these three file names): W880 `$CELESTEA_HOME` -> XDG -> `~/.celestea`.
 */
const home = celesteaHome({ env });
const config = loadStudioConfig({
  env,
  paths: {
    workspacesFile: join(home, "workspaces.json"),
    providersFile: join(home, "providers.json"),
    promptsFile: join(home, "prompts.json"),
  },
});

const handle = startStudioServer({ port: 0, hostname: "127.0.0.1", config, env });
const { port } = await handle.listening;
const url = `http://127.0.0.1:${port}/`;
console.log(`[celestea-desktop] serving ${url}`);
console.log(`[celestea-desktop] data root: ${home}`);
console.log(`[celestea-desktop] static root: ${staticRoot}`);

/**
 * `celestea web` prints this hint via the CLI; the desktop entry starts the
 * server directly, so without it a fresh install shows "model=unknown" in the
 * studio log and nothing that explains why a turn cannot run.
 */
if ((env[config.apiKeyEnv] ?? "").trim() === "") {
  console.log("[celestea-desktop] no model API key configured — the UI works, but a turn cannot run yet");
  console.log(`[celestea-desktop]   set ${config.apiKeyEnv}, or create ${join(home, "providers.json")}`);
}

/**
 * The version with a sane fallback: `Deno.desktopVersion` comes from the baked
 * deno.json, and the build script ALSO embeds it as `CELESTEA_DESKTOP_VERSION`
 * in the env file. Two independent sources mean a build whose config was not
 * picked up still reports its real version instead of "unknown".
 */
const envVersion = (env["CELESTEA_DESKTOP_VERSION"] ?? "").trim();
const version = Deno.desktopVersion ?? (envVersion === "" ? "dev" : envVersion);

/**
 * This build's target triple, derived from the RUNNING platform. It must match
 * the triples the build script uses, because it keys the release manifest.
 */
function targetTriple(): string {
  const os = Deno.build.os === "darwin" ? "apple-darwin" : Deno.build.os === "windows" ? "pc-windows-msvc" : "unknown-linux-gnu";
  const arch = Deno.build.arch === "aarch64" ? "aarch64" : "x86_64";
  return arch + "-" + os;
}

/** The tray needs a way to hand the URL to the user's own browser. */
function openInBrowser(target: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [target]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", target]]
        : ["xdg-open", [target]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    console.log("[celestea-desktop] could not open a browser — open " + target);
  }
}

const stop = (reason: string): void => {
  void handle.stop(reason).then(() => Deno.exit(0));
};

/**
 * The visible window, created on demand.
 *
 * `new Deno.BrowserWindow()` #1 adopts the runtime's implicit startup window;
 * every later construction opens an extra one. The window can be DESTROYED by
 * the user (see the anchor below), so it is a resource to (re)create, never a
 * singleton assumed to be alive.
 */
function openMain(): DenoBrowserWindow {
  if (main !== null && !main.isClosed()) {
    main.show();
    main.focus();
    return main;
  }
  const win = new Deno.BrowserWindow({ title: "Celestea Studio", width: 1440, height: 920 });
  win.navigate(startUrl);
  win.onclose = onMainClose;
  main = win;
  return win;
}

let main: DenoBrowserWindow | null = null;

/**
 * Close semantics — the point of a tray app: closing the WINDOW is not quitting
 * the APP. The server keeps serving, workers keep running, and the tray menu (or
 * a double click on the icon) brings the window back.
 *
 * MEASURED, and this is why the anchor window below exists: in Deno 2.9.7 the
 * close request is NOT cancelable — `event.preventDefault()` on this event is a
 * no-op and the process dies together with its last window (monitored: the HTTP
 * server stopped answering the moment the window closed). So the process keeps a
 * hidden 1×1 "anchor" window open for its whole life; the visible window is
 * created on demand. `CELESTEA_DESKTOP_CLOSE=exit` opts back into quitting.
 */
const closeBehavior = (env["CELESTEA_DESKTOP_CLOSE"] ?? "").trim().toLowerCase();
/** Assigned right after the tray exists — see the note there. */
let hideOnClose = closeBehavior === "exit";

function onMainClose(event: { preventDefault(): void }): void {
  if (!hideOnClose) {
    stop("window-closed");
    return;
  }
  // Best effort: if a future runtime honors it, the window survives as hidden.
  event.preventDefault();
  main?.hide();
  console.log("[celestea-desktop] window closed — still running in the tray; pick 显示主窗口 to reopen it");
}

/** Tray: an extra entry point (show/hide/quit). Normal window chrome is kept. */
const tray = installTray(`Celestea Studio ${version}`, {
  show: () => {
    openMain();
  },
  hide: () => main?.hide(),
  quit: () => stop("tray-quit"),
  openInBrowser: () => openInBrowser(url),
  openUrl: (target) => openInBrowser(target),
});
console.log(
  "[celestea-desktop] tray " + (tray.active ? "active" : "unavailable (continuing with the window)"),
);

/**
 * Decided AFTER the tray exists, and that order is the point: hiding with no
 * tray would leave the user unable to reach a window at all, so "no tray" means
 * close = quit (and the anchor below is not created either).
 */
hideOnClose = closeBehavior === "tray" || (closeBehavior !== "exit" && tray.active);
console.log("[celestea-desktop] close button -> " + (hideOnClose ? "hide to tray" : "quit"));

/**
 * Where the window starts. With an auth token configured, EVERY `/api/*` call
 * (except /api/health) needs the HMAC cookie, and the CLI's recipe is "open
 * /auth/token?token=… once to sign in". A desktop app cannot ask the user to
 * paste that into a browser — it navigates there itself, which sets the cookie
 * and redirects to the UI. The token is never logged.
 */
const startUrl =
  config.authToken === null ? url : `${url}auth/token?token=${encodeURIComponent(config.authToken)}`;
console.log(
  "[celestea-desktop] auth " +
    (config.authToken === null ? "open (loopback, no token)" : "token required — signing the window in"),
);

main = openMain();

/**
 * The window's URL watchdog — this is BUG2 ("the desktop app cannot reach the
 * backend") in code form.
 *
 * The desktop runtime owns an implicit startup window and navigates it ITSELF,
 * to the port it publishes as `DENO_SERVE_ADDRESS` (the contract for `Deno.serve`
 * apps). This app serves over `node:http` instead, so nothing listens on that
 * port — and when the runtime's navigation lands after ours, the user gets a
 * connection error in a window whose server is perfectly healthy. So: read the
 * webview's real URL a few times during startup and re-navigate when it drifted.
 * The log line doubles as the diagnostic when it ever happens again.
 */
/** Read back what the webview's own fetch to a PROTECTED endpoint returned. */
async function probeProtected(target: DenoBrowserWindow): Promise<string> {
  try {
    // `executeJs` cannot return a Promise ("Unsupported result type" — measured),
    // so the fetch is kicked off and its outcome parked on a global, then read
    // back in a second call. /api/workspaces is protected on purpose: /api/health
    // is exempt from the auth token, so probing it would report 200 even when
    // every real call is 401.
    await target.executeJs(
      "globalThis.__celesteaProbe = 'pending';" +
        "fetch('/api/workspaces').then((r) => { globalThis.__celesteaProbe = 'HTTP ' + r.status; }," +
        " (e) => { globalThis.__celesteaProbe = 'ERR ' + e.message; });" +
        " 'started'",
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 1200));
    const result = await target.executeJs("String(globalThis.__celesteaProbe || 'none')");
    return String(result.value);
  } catch (error) {
    return "ERR " + String(error);
  }
}

/**
 * Startup watchdog — this is BUG2 ("the desktop app cannot reach the backend").
 *
 * The desktop runtime owns an implicit startup window and navigates it itself
 * (to the port it publishes as `DENO_SERVE_ADDRESS`, the contract for
 * `Deno.serve` apps — this app serves over `node:http`). That navigation can land
 * AFTER ours, and when it does it replaces a token bootstrap page with a plain
 * GET /, so the sign-in cookie never gets set and every `/api/*` call answers
 * 401 while the server is perfectly healthy (measured: cookie-less request 401,
 * same request with the cookie 200).
 *
 * So the window is re-checked a few times: right URL, then a real request from
 * inside the webview. 401 with a token configured means the bootstrap did not
 * stick, and re-navigating to it is idempotent.
 */
async function ensureWindowReady(
  target: DenoBrowserWindow,
  expected: string,
  bootstrap: string | null,
): Promise<void> {
  for (const delay of [400, 1600, 3200, 6000]) {
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    if (target.isClosed()) return;
    const result = await target.executeJs("String(location.href)").catch(() => ({ value: "" }));
    const href = String(result.value ?? "");
    if (!href.startsWith(expected)) {
      console.log(`[celestea-desktop] window was on ${href} — navigating to ${bootstrap ?? expected}`);
      target.navigate(bootstrap ?? expected);
      continue;
    }
    const status = await probeProtected(target);
    if (status === "HTTP 200") {
      console.log(`[celestea-desktop] window ready on ${href} (/api/workspaces ${status})`);
      return;
    }
    console.log(`[celestea-desktop] window on ${href} but /api/workspaces -> ${status}`);
    if (bootstrap === null) return; // nothing to sign in with; the UI will say what it needs
    target.navigate(bootstrap);
  }
  console.log("[celestea-desktop] window readiness unconfirmed — check the window contents");
}

void ensureWindowReady(main, url, config.authToken === null ? null : startUrl);

/**
 * The anchor that keeps the process alive after the user closes the window.
 *
 * A hidden 1×1 window nobody can see or activate: it exists only so "no windows
 * are open" never becomes true, which in this runtime is what ends the process
 * (taking the tray and every running worker with it). Without a working tray we
 * do NOT do this — an invisible process the user cannot reach would be worse
 * than exiting.
 */
if (hideOnClose && tray.active) {
  const anchor = new Deno.BrowserWindow({ width: 1, height: 1, frameless: true, noActivate: true });
  anchor.hide();
  console.log("[celestea-desktop] keep-alive anchor window created (hidden)");
}

/** CI gate: boot, serve, exit cleanly. */
const smokeMs = Number.parseInt(env["CELESTEA_DESKTOP_SMOKE_MS"] ?? "", 10);
if (Number.isInteger(smokeMs) && smokeMs > 0) {
  setTimeout(() => stop("smoke"), smokeMs);
}

/**
 * Verifying close-to-tray needs a real close REQUEST (there is no way to click
 * the title bar from a script). This reports whether the process survived and
 * whether the window can be recreated, instead of leaving it to guesswork.
 */
const smokeCloseMs = Number.parseInt(env["CELESTEA_DESKTOP_SMOKE_CLOSE_MS"] ?? "", 10);
if (Number.isInteger(smokeCloseMs) && smokeCloseMs > 0) {
  setTimeout(() => {
    console.log("[celestea-desktop] smoke: requesting a window close");
    main?.close();
    setTimeout(() => {
      console.log(`[celestea-desktop] smoke: after close, closed=${main?.isClosed() ?? "gone"}`);
      const reopened = openMain();
      console.log(`[celestea-desktop] smoke: reopen ok, visible=${reopened.isVisible()}`);
    }, 2500);
  }, smokeCloseMs);
}

/**
 * Auto-update. `version` is baked at build time by scripts/desktop/build.mjs
 * (the root `version` in a generated deno.json); the feed URL is embedded as the
 * env var `CELESTEA_DESKTOP_UPDATE_URL` ONLY when a feed was configured, so a
 * local/dev build has no placeholder host to poll and never calls the API.
 *
 * The runtime compares the version against `<feed>/latest.json` and stages a
 * bsdiff patch of the runtime dylib, which the launcher swaps in on the next
 * start — rolling back automatically if that launch fails.
 *
 * The `typeof` guard is NOT defensive padding: in Deno 2.9.7 both
 * `Deno.autoUpdate` and `Deno.desktopVersion` are injected only by the desktop
 * runtime, so under `deno run` (and in any non-desktop embedding) they do not
 * exist and an unguarded call is a TypeError.
 *
 * Known upstream limits: (1) patches are staged but never applied on Windows (a
 * loaded DLL cannot be replaced in place); (2) applying one requires a WRITABLE
 * install dir — release builds therefore stay uncompressed and are distributed
 * as `.AppImage`/`.app`/`.msi` rather than as root-owned `/usr` installs.
 */
const updateUrl = (Deno.env.get("CELESTEA_DESKTOP_UPDATE_URL") ?? "").trim();
const updateRepo = (env["CELESTEA_DESKTOP_UPDATE_REPO"] ?? "").trim();
console.log(
  `[celestea-desktop] update config: feed=${updateUrl === "" ? "none" : updateUrl} ` +
    `repo=${updateRepo === "" ? "none" : updateRepo} desktopVersion=${Deno.desktopVersion ?? "none"}`,
);

/**
 * Update DETECTION from GitHub Releases, used when no static feed is configured.
 *
 * `Deno.autoUpdate()` cannot work off a Release (it refuses redirects, and asset
 * URLs 302), but a Release still answers "is there something newer?" — so the app
 * asks the Releases API, and reflects the answer in the log, the window title and
 * the tray menu. Nothing is downloaded or installed behind the user's back.
 */
async function watchGitHubReleases(): Promise<void> {
  // Preferred source: the `latest.json` our own publish step attaches to the
  // Release (single request, no API rate limit, carries the patch map).
  const logCheck = (message: string): void => console.log("[celestea-desktop] update check: " + message);
  const manifest = await fetchReleaseManifest(updateRepo, logCheck);
  const release =
    manifest === null
      ? await fetchLatestRelease(updateRepo, logCheck)
      : { tag: manifest.version, version: manifest.version, htmlUrl: `https://github.com/${updateRepo}/releases/latest` };
  if (release === null) {
    console.log(`[celestea-desktop] no GitHub release to compare against yet (${updateRepo})`);
    return;
  }
  logCheck("comparing against " + release.tag);
  if (manifest !== null) {
    const patched = manifest.platforms[targetTriple()]?.patches ?? {};
    console.log(
      `[celestea-desktop] release manifest ${manifest.version}: ` +
        (Object.keys(patched).length === 0
          ? "no patch published for " + targetTriple()
          : "patch available for " + Object.keys(patched).join(", ")),
    );
  }
  // Policy: ANY difference between the release and this build is worth telling the
  // user about ("不一致就提示"); only an identical version is silent. The wording
  // follows what the comparison can actually support, so an older or unorderable
  // release never gets advertised as an upgrade.
  const order = compareRelease(release.version, version);
  if (order === "same") {
    console.log(`[celestea-desktop] up to date (${version}; latest release ${release.tag})`);
    return;
  }
  if (order === "newer") {
    console.log(`[celestea-desktop] newer release available: ${release.tag} (this build is ${version})`);
    console.log(
      "[celestea-desktop] to update in place, point the build at a static feed " +
        "(CELESTEA_DESKTOP_UPDATE_BASE_URL) — a Release asset URL redirects, which the updater refuses",
    );
    console.log("[celestea-desktop] download: " + release.htmlUrl);
    main?.setTitle(`Celestea Studio ${version} — 有新版 ${release.tag}`);
    tray.markUpdate(release.tag, release.htmlUrl, "download");
    return;
  }
  if (order === "older") {
    console.log(`[celestea-desktop] latest release ${release.tag} is OLDER than this build (${version}) — not an upgrade`);
  } else {
    // Hash / branch / nightly style tag: no order relation exists, so the app
    // points at the release instead of claiming it is newer.
    console.log(`[celestea-desktop] latest release ${release.tag} is not comparable with ${version}`);
  }
  console.log("[celestea-desktop] see: " + release.htmlUrl);
  tray.markUpdate(release.tag, release.htmlUrl, "view");
}

if (typeof Deno.autoUpdate !== "function") {
  console.log("[celestea-desktop] auto-update off: not running under the desktop runtime");
} else if (updateUrl === "") {
  console.log(`[celestea-desktop] version ${version} — no update feed in this build`);
  if (updateRepo === "") {
    console.log("[celestea-desktop] no update feed and no release repo baked in — update checks are off");
  } else {
    void watchGitHubReleases();
    setInterval(() => void watchGitHubReleases(), 6 * 60 * 60 * 1000);
  }
} else {
  console.log(`[celestea-desktop] version ${version} (${Deno.build.os}-${Deno.build.arch})`);
  console.log("[celestea-desktop] update feed " + updateUrl);
  Deno.autoUpdate({
    url: updateUrl,
    interval: 60 * 60 * 1000,
    onUpdateReady: (next) => console.log(`[celestea-desktop] update ${next} staged — applies on next launch`),
    onRollback: (reason) => console.warn("[celestea-desktop] rolled back a failed update: " + reason),
  });
}
