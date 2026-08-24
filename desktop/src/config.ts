// chalk-desktop -- the shell's own state: which servers this machine knows,
// which one it opened last, where the window was.
//
// 104-1: a chalk server is an origin. The page it serves is hard-wired to
// same-origin (relative /api, location.host for the socket, connect-src
// 'self'), so the only thing the shell may vary is the origin it loads --
// never a path, never a query. normalizeServerURL enforces that.
//
// The pure functions here are tested (config.test.ts); the file I/O is a
// thin wrapper the main process calls.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ServerEntry {
  /** Origin plus a trailing slash, e.g. "https://chat.example.org/". */
  url: string;
}

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export interface DesktopConfig {
  servers: ServerEntry[];
  /** The server to open on launch; always one of `servers`. */
  last?: string;
  bounds?: WindowBounds;
}

export const DEFAULT_BOUNDS: WindowBounds = { width: 1280, height: 820 };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * normalizeServerURL turns what a person typed into the one origin the shell
 * will load, or null when it cannot be a chalk server.
 *
 * - no scheme → https
 * - http is accepted only for loopback hosts (the dev stack) or when the
 *   caller explicitly allows it (`--insecure`, for a LAN test box); the
 *   session cookie is Secure everywhere else, so a plain-http server would
 *   log in and immediately forget it
 * - path, query and fragment are dropped: the page owns the namespace
 */
export function normalizeServerURL(input: string, allowInsecure = false): string | null {
  let text = input.trim();
  if (text === "") return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (u.protocol === "http:") {
    if (!allowInsecure && !LOOPBACK.has(u.hostname)) return null;
  } else if (u.protocol !== "https:") {
    return null;
  }
  if (u.username || u.password) return null;
  return `${u.origin}/`;
}

/** hostLabel is what the window title shows for a server. */
export function hostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * rememberServer moves `url` to the front of the list (adding it when new)
 * and makes it the one to open next time. Returns a new config; the input is
 * not mutated.
 */
export function rememberServer(cfg: DesktopConfig, url: string): DesktopConfig {
  const rest = cfg.servers.filter((s) => s.url !== url);
  return { ...cfg, servers: [{ url }, ...rest], last: url };
}

/** forgetServer drops `url`; if it was `last`, the next entry takes over. */
export function forgetServer(cfg: DesktopConfig, url: string): DesktopConfig {
  const servers = cfg.servers.filter((s) => s.url !== url);
  const next: DesktopConfig = { ...cfg, servers };
  if (cfg.last === url) {
    if (servers.length > 0) next.last = servers[0].url;
    else delete next.last;
  }
  return next;
}

export function emptyConfig(): DesktopConfig {
  return { servers: [] };
}

/**
 * parseConfig accepts whatever is on disk and returns something usable. A
 * corrupt or foreign file yields the empty config rather than a crash on
 * launch; entries that are not valid origins are dropped.
 */
export function parseConfig(text: string): DesktopConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyConfig();
  }
  if (typeof raw !== "object" || raw === null) return emptyConfig();
  const r = raw as Record<string, unknown>;
  const servers: ServerEntry[] = [];
  if (Array.isArray(r.servers)) {
    for (const s of r.servers) {
      const url = typeof s === "object" && s !== null ? (s as { url?: unknown }).url : undefined;
      if (typeof url !== "string") continue;
      const norm = normalizeServerURL(url, true);
      if (norm && !servers.some((e) => e.url === norm)) servers.push({ url: norm });
    }
  }
  const cfg: DesktopConfig = { servers };
  if (typeof r.last === "string") {
    const norm = normalizeServerURL(r.last, true);
    if (norm && servers.some((e) => e.url === norm)) cfg.last = norm;
  }
  const b = r.bounds as Partial<WindowBounds> | undefined;
  if (
    typeof b === "object" &&
    b !== null &&
    typeof b.width === "number" &&
    typeof b.height === "number" &&
    b.width >= 320 &&
    b.height >= 240
  ) {
    cfg.bounds = { width: Math.round(b.width), height: Math.round(b.height) };
    if (typeof b.x === "number" && typeof b.y === "number") {
      cfg.bounds.x = Math.round(b.x);
      cfg.bounds.y = Math.round(b.y);
    }
  }
  return cfg;
}

export function loadConfig(path: string): DesktopConfig {
  try {
    return parseConfig(readFileSync(path, "utf8"));
  } catch {
    return emptyConfig();
  }
}

export function saveConfig(path: string, cfg: DesktopConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
}
