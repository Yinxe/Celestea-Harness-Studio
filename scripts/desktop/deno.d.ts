/**
 * The Deno runtime surface this desktop entry uses — declared LOCALLY.
 *
 * Why hand-written instead of `@types/deno` / `deno.ns`:
 *   · the repo type-checks everything under `scripts/**` with `tsc` and only
 *     depends on `@types/node` (see tsconfig.base.json `types: ["node"]`);
 *   · `deno desktop` runs this entry with `--no-check`, so Deno's own type lib
 *     is never consulted at build time — the repo's `pnpm typecheck` is the
 *     only type gate this file passes through, and it needs exactly the
 *     globals below.
 *
 * Anything the entry uses that is NOT declared here fails `pnpm typecheck`
 * instead of silently becoming `any` — that is the point of listing them.
 * Reference: docs.deno.com/runtime/desktop (windows / auto-update).
 */

/** Window creation options (`new Deno.BrowserWindow({...})`). */
interface DenoBrowserWindowOptions {
  title?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  resizable?: boolean;
  alwaysOnTop?: boolean;
  frameless?: boolean;
  noActivate?: boolean;
  transparentTitlebar?: boolean;
}

interface DenoBrowserWindow {
  readonly windowId: number;
  /**
   * Fires when the user asks to close the window (assignable, EventTarget-style).
   * `preventDefault()` is what keeps a tray app alive on close — see main.ts.
   */
  onclose: ((event: { preventDefault(): void }) => void) | null;
  navigate(url: string): void;
  reload(): void;
  show(): void;
  hide(): void;
  focus(): void;
  setTitle(title: string): void;
  openDevtools(options?: { deno?: boolean; renderer?: boolean }): void;
  close(): void;
  isClosed(): boolean;
  isVisible(): boolean;
  getSize(): [number, number];
  getPosition(): [number, number];
  setSize(width: number, height: number): void;
  setPosition(x: number, y: number): void;
  executeJs<T = unknown>(code: string): Promise<{ ok: boolean; value?: T; error?: string }>;
}

/** One entry of a native menu (`Deno.Tray.setMenu` / `Deno.dock.setMenu`). */
type DenoMenuEntry =
  | "separator"
  | {
      item: {
        label: string;
        id?: string;
        accelerator?: string;
        /** Required by the API — omitting it is a type error, not a default. */
        enabled: boolean;
        checked?: boolean;
        tooltip?: string;
      };
    }
  | { submenu: { label: string; items: DenoMenuEntry[] } }
  | { role: { role: string } };

interface DenoTrayMenuEvent {
  readonly detail: { readonly id: string };
}

interface DenoTray {
  /** `0` when the backend could not create a tray; every later call is a no-op. */
  readonly trayId: number;
  setIcon(png: Uint8Array): void;
  setIconDark(png: Uint8Array | null): void;
  setTooltip(text: string | null): void;
  setMenu(menu: DenoMenuEntry[] | null): void;
  addEventListener(type: "menuclick", listener: (event: DenoTrayMenuEvent) => void): void;
  addEventListener(type: "click" | "dblclick", listener: (event: unknown) => void): void;
  destroy(): void;
}

interface DenoDock {
  /** macOS dock / Windows taskbar badge; on Linux it prefixes the window title. */
  setBadge(text: string | null): void;
  setVisible(visible: boolean): void;
  setMenu(menu: DenoMenuEntry[] | null): void;
}

/**
 * Auto-update options — exactly the documented surface of `Deno.autoUpdate()`.
 * The feed URL is normally NOT passed here: it comes from the `desktop.release
 * .baseUrl` baked into the binary by scripts/desktop/build.mjs.
 */
interface DenoAutoUpdateOptions {
  /** Overrides the baked feed root. Polling only happens over https. */
  url?: string;
  /** Poll interval in ms; omitted = a single check at startup. */
  interval?: number;
  /** A patch was applied and staged; it takes effect on the next launch. */
  onUpdateReady?: (version: string) => void;
  /** The previous launch failed after an update; the runtime rolled it back. */
  onRollback?: (reason: string) => void;
  /** Base64 Ed25519 public key: when set, the manifest must be signed. */
  publicKey?: string;
}

declare const Deno: {
  readonly args: readonly string[];
  readonly env: {
    get(name: string): string | undefined;
    set(name: string, value: string): void;
    toObject(): Record<string, string>;
  };
  /** `"<os>-<arch>"` pieces of the RUNNING binary (linux/darwin/windows). */
  readonly build: { os: string; arch: string };
  /**
   * The root `version` baked at build time. ABSENT (not just null) outside the
   * desktop runtime — Deno 2.9.7 injects it only into compiled desktop apps, so
   * every read must be guarded like `Deno.autoUpdate` below.
   */
  readonly desktopVersion?: string | null;
  statSync(path: string | URL): { isDirectory: boolean; isFile: boolean };
  exit(code?: number): never;
  readonly BrowserWindow: new (options?: DenoBrowserWindowOptions) => DenoBrowserWindow;
  /** Also absent outside the desktop runtime; guard with `typeof`. */
  autoUpdate?: (options?: DenoAutoUpdateOptions | string) => void;
  /** Absent outside the desktop runtime (guard with `typeof`). */
  Tray?: new () => DenoTray;
  /** Singleton dock/taskbar control; absent outside the desktop runtime. */
  dock?: DenoDock;
};
