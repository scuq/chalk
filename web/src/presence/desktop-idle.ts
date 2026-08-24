// chalk-web -- 104-3: the system idle clock, when chalk runs in its own shell.
//
// The desktop app (desktop/, phase 104) asks the OS how long since anyone
// touched the machine and whether the screen is locked, and hands the page
// both over window.chalkDesktop.idle. That is the middle layer idle.ts
// describes -- the one a web page cannot see -- on every platform the shell
// runs on, with no permission prompt, no CSP hole and no pairing (compare
// planned phase 90, which builds the same thing for browsers with a local
// agent).
//
// Same contract as system-idle.ts's startSystemIdle: a start function, an
// onChange with {idle, locked}, a stop. The threshold is system-idle.ts's
// THRESHOLD_MS, applied here rather than in the shell, so the away policy
// keeps living in one place. App.tsx picks exactly one source -- the shell
// when present, else IdleDetector -- because two opinions of one fact into
// idleWatch.setSystem would fight.
//
// Types are declared locally rather than imported from desktop/: the page is
// served by chalkd to any shell version, and a structural check at the
// boundary is what keeps an older or newer shell from breaking it.

import { THRESHOLD_MS } from "./system-idle";
import type { SystemIdleState } from "./system-idle";

interface DesktopIdleRaw {
  idleMs: number;
  locked: boolean;
}

interface DesktopIdleBridge {
  get(): Promise<DesktopIdleRaw | null>;
  subscribe(cb: (state: DesktopIdleRaw) => void): () => void;
}

function bridge(): DesktopIdleBridge | null {
  if (typeof window === "undefined") return null;
  const d = (window as unknown as { chalkDesktop?: { idle?: unknown } }).chalkDesktop;
  const idle = d?.idle as Partial<DesktopIdleBridge> | undefined;
  if (!idle || typeof idle.get !== "function" || typeof idle.subscribe !== "function") {
    return null;
  }
  return idle as DesktopIdleBridge;
}

/** desktopIdlePresent is true only inside the desktop shell. It decides the
 * source in App.tsx and whether the settings panel shows the away toggle. */
export function desktopIdlePresent(): boolean {
  return bridge() !== null;
}

/** toState applies the threshold. Exported for the test; total: a shell that
 * sends garbage reads as active-and-unlocked rather than throwing. */
export function toState(raw: DesktopIdleRaw, thresholdMs: number = THRESHOLD_MS): SystemIdleState {
  const idleMs = typeof raw.idleMs === "number" && Number.isFinite(raw.idleMs) ? raw.idleMs : 0;
  return { idle: idleMs >= thresholdMs, locked: raw.locked === true };
}

/**
 * startDesktopIdle subscribes to the shell's clock and publishes the opening
 * state at once (a machine already idle when the page loads must read idle
 * without waiting for a transition -- the same rule system-idle.ts follows).
 * Returns null when the bridge is absent.
 */
export function startDesktopIdle(
  onChange: (state: SystemIdleState) => void,
  thresholdMs: number = THRESHOLD_MS,
): { stop: () => void } | null {
  const b = bridge();
  if (!b) return null;
  let stopped = false;
  let last: string | null = null;
  const publish = (raw: DesktopIdleRaw) => {
    if (stopped) return;
    const s = toState(raw, thresholdMs);
    // Edges only: the shell ticks every 15 s and idleWatch re-evaluates on
    // every setSystem, so an unchanged state would be a no-op anyway, but
    // keeping the log quiet is worth the compare.
    const key = `${s.idle}:${s.locked}`;
    if (key === last) return;
    last = key;
    onChange(s);
  };
  const unsubscribe = b.subscribe(publish);
  void b.get().then(
    (raw) => {
      if (raw) publish(raw);
    },
    () => {
      // No opening value; the first tick will bring one.
    },
  );
  return {
    stop: () => {
      stopped = true;
      unsubscribe();
    },
  };
}
