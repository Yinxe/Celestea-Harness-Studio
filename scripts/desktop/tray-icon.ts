/**
 * The tray icon, inlined as base64 PNG (generated, then committed as an asset).
 *
 * Why inline bytes instead of a file path: a compiled app runs with the user's
 * CWD, and `Deno.Tray.setIcon` wants PNG bytes, not a path. Reading a bundled
 * file would need `--include` plus a read permission for something that never
 * changes; 200-odd bytes of base64 remove both concerns.
 *
 * Shape: a 22x22 anti-aliased "C" ring, black on transparent — the silhouette
 * style platform tray/menu bars expect (macOS template image, Windows/Linux
 * status icon). Regenerate with the same drawing code if the mark changes.
 */
const TRAY_ICON_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAAaklEQVR42mNgGCBQD8T7gfg/Et4PFSfbwP9EYJIs2E+kocg+INvQeiRMsuHYNNnjUGtPSrAQayg+wwm61p7I+LBHCyZ7QmFLNUB2Ehp+BtMsjGmWKmiWjmma82hWVtC0dKNpeUzTGmTwAgDv0ZLRtOOYPwAAAABJRU5ErkJggg==";

/** PNG bytes for `Deno.Tray.setIcon`. */
export const TRAY_ICON_PNG: Uint8Array = Uint8Array.from(atob(TRAY_ICON_BASE64), (c) => c.charCodeAt(0));
