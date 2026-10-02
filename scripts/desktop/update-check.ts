/**
 * Update DETECTION from GitHub Releases — the path used when no static update
 * feed is configured.
 *
 * Why two paths exist at all: the built-in updater applies bsdiff patches of the
 * runtime dylib, but it fetches with `{ redirect: "error" }`, so a GitHub Release
 * asset URL (which answers 302 to objects.githubusercontent.com) can never serve
 * it. A Release still IS the natural source of truth for "is there a newer
 * version?" — this module asks the Releases API directly (its answer is a plain
 * 200 JSON response), compares versions, and reports. It downloads nothing and
 * installs nothing: the user gets told, and the installers are one click away.
 *
 * The repo is baked at build time (`CELESTEA_DESKTOP_UPDATE_REPO`), so a build
 * knows where to look without hard-coding anything here.
 *
 * FIRST CHOICE is the `latest.json` we attach to the Release: one request, no
 * anonymous API rate limit, and it carries the per-platform patch map, so the app
 * can tell "a patch exists for my arch" from "manual download only". The Releases
 * API is the FALLBACK (older Releases, or an asset that was never uploaded) — its
 * redirect is fine here because this is OUR fetch, not the updater's.
 */

const API_ROOT = "https://api.github.com/repos/";

/**
 * Every request is bounded. Measured the hard way: an unreachable host makes
 * `fetch` hang far longer than any user will wait, and an update check that never
 * returns leaves the feature permanently silent (the log showed nothing at all).
 */
const DEFAULT_TIMEOUT_MS = 8000;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The Release asset our publish step uploads (`scripts/desktop/publish.mjs`). */
export function releaseManifestUrl(repo: string): string {
  return "https://github.com/" + repo + "/releases/latest/download/latest.json";
}

export interface ReleaseManifest {
  version: string;
  /** Triple → its patch map, exactly as the per-target manifests carry it. */
  platforms: Record<string, { patches?: Record<string, { name?: string; sha256?: string }> }>;
}

/**
 * The aggregate manifest from the latest Release, or `null` when it is absent
 * (no Release yet, no asset, offline). Never throws.
 */
export async function fetchReleaseManifest(
  repo: string,
  log: (message: string) => void = () => undefined,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ReleaseManifest | null> {
  try {
    const response = await fetch(releaseManifestUrl(repo), {
      headers: { accept: "application/json", "user-agent": "celestea-desktop" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const doc = (await response.json()) as { version?: unknown; platforms?: unknown };
    if (typeof doc.version !== "string" || doc.version.trim() === "") return null;
    const platforms =
      typeof doc.platforms === "object" && doc.platforms !== null
        ? (doc.platforms as ReleaseManifest["platforms"])
        : {};
    return { version: doc.version, platforms };
  } catch (error) {
    log("release manifest fetch failed: " + describe(error));
    return null;
  }
}

export interface ReleaseInfo {
  /** Raw tag, e.g. `v2.9.0`. */
  tag: string;
  /** Tag without a leading `v`. */
  version: string;
  htmlUrl: string;
}

/** `v2.9.0` / `2.9.0` / ` 2.9.0 ` all normalize to `2.9.0`. */
export function normalizeVersion(raw: string): string {
  return raw.trim().replace(/^v/i, "");
}

/**
 * Ordering of a release tag against the running version.
 *
 * `unknown` is a first-class answer, not a failure: a tag like `nightly`,
 * `abc1234` or `release-2026-10` cannot be ordered against `2.8.1`, and saying
 * "newer" for those would be a claim the data does not support. The UI wording
 * follows this value (see main.ts): only `newer` offers a download.
 *
 * Parsing is deliberately simple and total:
 *   · `v` prefix ignored, compared segment by segment as numbers
 *   · a non-numeric segment somewhere ⇒ `unknown` (unless both sides are equal)
 *   · a partial numeric segment (`2.9.0-rc1` → 0) is read as its numeric head,
 *     which is what makes `2.8.1-rc1` compare equal to `2.8.1`
 */
export type ReleaseOrder = "newer" | "same" | "older" | "unknown";

export function compareRelease(candidate: string, current: string): ReleaseOrder {
  const left = normalizeVersion(candidate);
  const right = normalizeVersion(current);
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

/** Convenience wrapper: only a strictly newer, comparable version counts. */
export function isNewer(candidate: string, current: string): boolean {
  return compareRelease(candidate, current) === "newer";
}

/**
 * The latest release, or `null` when there is none / the API says no (404 for a
 * repo without releases, 403 for rate limiting, offline). Never throws: an
 * update check must not be able to break the app.
 */
export async function fetchLatestRelease(
  repo: string,
  log: (message: string) => void = () => undefined,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ReleaseInfo | null> {
  try {
    const response = await fetch(API_ROOT + repo + "/releases/latest", {
      headers: { accept: "application/vnd.github+json", "user-agent": "celestea-desktop" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const doc = (await response.json()) as { tag_name?: unknown; html_url?: unknown };
    if (typeof doc.tag_name !== "string" || doc.tag_name.trim() === "") return null;
    return {
      tag: doc.tag_name,
      version: normalizeVersion(doc.tag_name),
      htmlUrl:
        typeof doc.html_url === "string" ? doc.html_url : "https://github.com/" + repo + "/releases/latest",
    };
  } catch (error) {
    log("releases API failed: " + describe(error));
    return null;
  }
}
