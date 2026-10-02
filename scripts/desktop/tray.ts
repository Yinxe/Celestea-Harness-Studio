/**
 * System tray (`Deno.Tray`) — the icon/menu half of "this runs like a desktop app".
 *
 * Three facts from the 2.9.7 desktop runtime shape this file:
 *   1. `Deno.Tray` exists ONLY in the desktop runtime (like `autoUpdate`), so the
 *      `typeof` guard is load-bearing, not defensive padding.
 *   2. A backend that cannot create a tray (some minimal Linux desktops have no
 *      StatusNotifier host) reports `trayId === 0` and then silently no-ops every
 *      later call — so we must check it and fall back, never assume it worked.
 *   3. The window's `close` event is NOT cancelable in 2.9.7
 *      (`dispatchEvent(new Event("close"))`), so a real "close to tray" would
 *      require a frameless window plus `hide()`. This app keeps normal window
 *      chrome: the tray is an ADDITIONAL entry point (show/hide/quit), never the
 *      only way back to a hidden window.
 *
 * The tray is native chrome, so its labels are not part of the web i18n dict.
 */
import { TRAY_ICON_PNG } from "./tray-icon.js";

export interface TrayHooks {
  show(): void;
  hide(): void;
  quit(): void;
  openInBrowser(): void;
  /** Opens an arbitrary https URL in the user's browser (the release page). */
  openUrl(url: string): void;
}

export interface TrayHandle {
  /** `false` when the runtime or the desktop backend cannot provide a tray. */
  readonly active: boolean;
  /**
   * Adds an update entry to the menu. `kind` says what the entry promises:
   * `download` when the version compared strictly newer, `view` when the tag
   * could not be ordered against this build (see update-check.ts).
   */
  markUpdate(version: string, url: string, kind: "download" | "view"): void;
  destroy(): void;
}

const INERT: TrayHandle = { active: false, markUpdate: () => undefined, destroy: () => undefined };

export function installTray(label: string, hooks: TrayHooks): TrayHandle {
  if (typeof Deno.Tray !== "function") return INERT;
  const tray = new Deno.Tray();
  if (tray.trayId === 0) return INERT;

  tray.setIcon(TRAY_ICON_PNG);
  tray.setTooltip(label);

  let update: { version: string; url: string; kind: "download" | "view" } | null = null;
  /** `enabled` is required on every item in this API — omitting it is a type error. */
  const renderMenu = (): void => {
    tray.setMenu([
      { item: { id: "show", label: "显示主窗口", enabled: true } },
      { item: { id: "hide", label: "隐藏窗口", enabled: true } },
      { item: { id: "browser", label: "在浏览器中打开", enabled: true } },
      ...(update === null
        ? []
        : ([
            {
              item: {
                id: "download",
                label: (update.kind === "download" ? "下载新版 " : "查看发行版 ") + update.version,
                enabled: true,
              },
            },
          ] as DenoMenuEntry[])),
      "separator",
      { item: { id: "quit", label: "退出", enabled: true } },
    ]);
  };
  renderMenu();

  tray.addEventListener("menuclick", (event) => {
    switch (event.detail.id) {
      case "show":
        return hooks.show();
      case "hide":
        return hooks.hide();
      case "browser":
        return hooks.openInBrowser();
      case "download":
        return update === null ? undefined : hooks.openUrl(update.url);
      case "quit":
        return hooks.quit();
      default:
        return undefined;
    }
  });
  tray.addEventListener("dblclick", () => hooks.show());

  return {
    active: true,
    markUpdate: (version, url, kind) => {
      update = { version, url, kind };
      tray.setTooltip(label + (kind === "download" ? " — 有新版 " + version : " — 有新版发行版 " + version));
      renderMenu();
    },
    destroy: () => tray.destroy(),
  };
}

/** A short activity signal on the macOS dock / Windows taskbar (no progress API exists). */
export function setDockBadge(text: string | null): void {
  Deno.dock?.setBadge(text);
}
