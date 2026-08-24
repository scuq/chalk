// chalk-desktop -- is there a newer chalk desktop?
//
// 104-4: a check, not an updater. Once after launch and then daily the shell
// asks GitHub for the latest release, and when it is newer than the running
// version it says so once (a message box) and keeps saying so quietly (a
// menu and tray entry) -- both open the release page in the system browser.
// Nothing is downloaded, nothing is executed: the one-click self-update is
// phase 105 and needs signed release sums first. Dev builds (0.0.0-dev) and
// `"checkUpdates": false` in desktop.json never ask.
//
// The pure parts -- version parsing, comparison, release parsing, the
// once-per-version rule -- are tested; the network and timers are a thin
// wrapper main.ts starts.

export interface ReleaseInfo {
  /** "0.9.1" -- the tag without its v. */
  version: string;
  /** The release page, for the browser. */
  url: string;
}

export const RELEASES_API = "https://api.github.com/repos/scuq/chalk/releases/latest";

/** How long after launch the first check runs; a cold start has better
 * things to do than talk to GitHub. */
export const FIRST_CHECK_MS = 20_000;
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

/** parseVersion reads "v1.2.3" / "1.2.3" / "1.2.3-rc1" into numbers; null
 * for anything else. A prerelease suffix is kept as a flag so a "-dev" build
 * never counts as newer than a release. */
export function parseVersion(v: string): { nums: [number, number, number]; pre: boolean } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+](.*))?$/.exec(v.trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] !== undefined };
}

/** isNewer: latest > current, comparing numbers only. A prerelease current
 * (0.9.0-rc1) counts as older than its release (0.9.0). */
export function isNewer(current: string, latest: string): boolean {
  const c = parseVersion(current);
  const l = parseVersion(latest);
  if (!c || !l) return false;
  for (let i = 0; i < 3; i++) {
    if (l.nums[i] !== c.nums[i]) return l.nums[i] > c.nums[i];
  }
  return c.pre && !l.pre;
}

/** isDevBuild: the unstamped package.json version. */
export function isDevBuild(current: string): boolean {
  return parseVersion(current)?.pre === true && /dev/.test(current);
}

/** parseLatestRelease accepts GitHub's /releases/latest JSON. Drafts and
 * prereleases are ignored (the endpoint should not return them, but a
 * check that runs unattended on every desktop must not depend on that). */
export function parseLatestRelease(json: unknown): ReleaseInfo | null {
  if (typeof json !== "object" || json === null) return null;
  const r = json as Record<string, unknown>;
  if (r.draft === true || r.prerelease === true) return null;
  if (typeof r.tag_name !== "string" || typeof r.html_url !== "string") return null;
  const v = parseVersion(r.tag_name);
  if (!v) return null;
  let url: URL;
  try {
    url = new URL(r.html_url);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.host !== "github.com") return null;
  return { version: r.tag_name.replace(/^v/, ""), url: url.toString() };
}

/** shouldAnnounce: the message box shows once per new version; the menu
 * entry stays regardless. */
export function shouldAnnounce(notifiedVersion: string | undefined, latest: string): boolean {
  return notifiedVersion !== latest;
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

/** fetchLatestRelease returns null on any failure -- an update check must
 * never be the reason the app misbehaves. */
export async function fetchLatestRelease(
  fetchFn: FetchLike,
  userAgent: string,
  api: string = RELEASES_API,
): Promise<ReleaseInfo | null> {
  try {
    const res = await fetchFn(api, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": userAgent },
    });
    if (!res.ok) return null;
    return parseLatestRelease(await res.json());
  } catch {
    return null;
  }
}
