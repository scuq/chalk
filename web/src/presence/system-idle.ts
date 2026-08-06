// chalk-web -- the Idle Detection API, where it exists.
//
// This is the only web API that can see input the page did not receive, and it
// is the reason chalk can tell "reading a long thread" from "gone for coffee".
// It reports two independent facts: userState, which goes "idle" after a
// threshold of no input to ANY application (see THRESHOLD_MS), and screenState,
// which reports the lock.
//
// Availability is the catch, and it is not going to improve: Chromium has
// shipped it since 94, while both Mozilla and WebKit have filed negative
// standards positions, so Firefox and Safari have it and want it not at all.
// Everything here therefore has to be optional, and the caller has to keep
// working when it returns nothing. Installing chalk as a PWA does not unlock
// it -- it only makes the grant stick.
//
// Types are declared locally rather than pulled from a @types package: it is
// one constructor and two string fields, and a dependency for that would be
// exactly the kind of trivial one the project rules rule out.

interface IdleDetectorLike extends EventTarget {
  readonly userState: "active" | "idle" | null;
  readonly screenState: "locked" | "unlocked" | null;
  start(opts: { threshold: number; signal?: AbortSignal }): Promise<void>;
}

interface IdleDetectorCtor {
  new (): IdleDetectorLike;
  requestPermission(): Promise<PermissionState>;
}

/**
 * How long the OS has to see no input anywhere before this reports idle.
 *
 * 60s is the API's *floor* -- start() throws RangeError below it -- not its
 * value, and running at the floor is what made away arrive far too fast: one
 * minute without touching anything and the dot flipped, while the in-page rules
 * next door wait minutes for a hidden tab and far longer for an unfocused one.
 * The system signal is the strongest evidence of absence chalk has, but a minute
 * of it is evidence of reading, not of leaving.
 *
 * Ten minutes sits below IDLE_AFTER_UNFOCUSED_MS deliberately: this signal knows
 * about input to every app, so it can be trusted sooner than a rule that can
 * only see the page. Nothing else needs damping alongside it: the return edge
 * is instant
 * (userState goes active on the first input anywhere), and a locked screen
 * still reports immediately through screenState, which is the one signal that
 * deserves no grace at all.
 */
const THRESHOLD_MS = 600_000;

export interface SystemIdleState {
  idle: boolean;
  locked: boolean;
}

export type SystemIdlePermission = "granted" | "prompt" | "denied" | "unsupported";

export type SystemIdleStart =
  | { ok: true; stop: () => void }
  | { ok: false; permission: Exclude<SystemIdlePermission, "granted"> };

function ctor(): IdleDetectorCtor | null {
  if (typeof window === "undefined") return null;
  const c = (window as unknown as { IdleDetector?: IdleDetectorCtor }).IdleDetector;
  return typeof c === "function" ? c : null;
}

/** systemIdleSupported gates the settings toggle: on a browser without the API
 * there is nothing to offer and a dead switch would be worse than no switch. */
export function systemIdleSupported(): boolean {
  return ctor() !== null;
}

/**
 * systemIdlePermission reports where we stand without prompting.
 *
 * Wrapped because permissions.query() throws TypeError on a name the browser
 * doesn't know -- which is every browser that lacks the API, i.e. exactly the
 * ones where an unguarded call would break the settings panel.
 */
export async function systemIdlePermission(): Promise<SystemIdlePermission> {
  if (!systemIdleSupported()) return "unsupported";
  try {
    const status = await navigator.permissions.query({
      name: "idle-detection" as PermissionName,
    });
    return status.state;
  } catch {
    // The API is there but the permission name isn't queryable. Treat it as
    // askable: requestPermission() is still the real gate.
    return "prompt";
  }
}

/**
 * startSystemIdle begins watching and returns a stop function.
 *
 * requestPermission() needs transient user activation, so this must be called
 * from a real gesture *unless* the grant is already in place -- which is why
 * the already-granted path skips it entirely rather than asking again. Getting
 * that wrong is a NotAllowedError on every cold load.
 */
export async function startSystemIdle(
  onChange: (state: SystemIdleState) => void,
): Promise<SystemIdleStart> {
  const IdleDetector = ctor();
  if (!IdleDetector) return { ok: false, permission: "unsupported" };

  try {
    if ((await systemIdlePermission()) !== "granted") {
      if ((await IdleDetector.requestPermission()) !== "granted") {
        return { ok: false, permission: "denied" };
      }
    }

    const detector = new IdleDetector();
    const abort = new AbortController();
    const publish = () =>
      onChange({
        idle: detector.userState === "idle",
        locked: detector.screenState === "locked",
      });
    detector.addEventListener("change", publish);
    await detector.start({ threshold: THRESHOLD_MS, signal: abort.signal });
    // The first change event only arrives on a transition, so without this the
    // detector would report nothing at all to someone who was already idle
    // when the page loaded.
    publish();
    return { ok: true, stop: () => abort.abort() };
  } catch {
    // A revoked grant, a permissions-policy header, or a detached iframe.
    // Presence just falls back to the in-page signal.
    return { ok: false, permission: "denied" };
  }
}
