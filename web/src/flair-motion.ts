// 115-9: flair at rest. An endless CSS animation makes Chrome produce a
// frame at every display refresh, and each frame also goes through the GPU
// process and the window manager (53-6 measured this for the parking drift).
// CSS cannot lower the frame rate of an animation. Only a paused animation
// costs less. This module sets the data-flair-rest attribute on <html>, and
// a rule in theme.css pauses every endless flair animation while it is set.
//
// The cycle: a burst of motion for FLAIR_MOVE_MS, then rest for
// FLAIR_REST_MS, and again, starting with a burst. While the window is
// hidden or not focused, flair rests all the time and no timer is pending.
// Focus, or a visible window, starts a burst at once. The cycle runs also
// when flair is off: no rule matches without the data-flair-* attributes,
// so a change of the preference at run time needs no wiring.

// How long flair moves in each burst, in milliseconds.
export const FLAIR_MOVE_MS = 5000;
// How long flair rests between bursts, in milliseconds.
export const FLAIR_REST_MS = 120000;

// The attribute on <html> that pauses the flair animations.
export const FLAIR_REST_ATTR = "data-flair-rest";

// FlairMotionEnv is what startFlairMotion needs from the browser. A test
// gives it a fake clock and a fake target.
export interface FlairMotionEnv {
  target: { setAttribute(name: string, value: string): void; removeAttribute(name: string): void };
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  isAway(): boolean;
  // Subscribes to the window and document events that change isAway().
  // Returns the function that removes the subscription.
  onAwayChange(fn: () => void): () => void;
}

function browserEnv(): FlairMotionEnv | null {
  if (typeof document === "undefined" || typeof window === "undefined") return null;
  return {
    target: document.documentElement,
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id),
    isAway: () => document.hidden || !document.hasFocus(),
    onAwayChange(fn) {
      window.addEventListener("focus", fn);
      window.addEventListener("blur", fn);
      document.addEventListener("visibilitychange", fn);
      return () => {
        window.removeEventListener("focus", fn);
        window.removeEventListener("blur", fn);
        document.removeEventListener("visibilitychange", fn);
      };
    },
  };
}

// startFlairMotion starts the burst and rest cycle on env.target and returns
// a function that stops it. The stop function removes the event listener and
// the pending timer. It does not change the attribute. If env is null (no
// document), nothing runs and the returned function does nothing.
export function startFlairMotion(env: FlairMotionEnv | null = browserEnv()): () => void {
  if (!env) return () => {};
  const e = env;
  let timer: number | null = null;
  let away = false;

  function clear(): void {
    if (timer !== null) e.clearTimeout(timer);
    timer = null;
  }
  function move(): void {
    clear();
    e.target.removeAttribute(FLAIR_REST_ATTR);
    timer = e.setTimeout(rest, FLAIR_MOVE_MS);
  }
  function rest(): void {
    clear();
    e.target.setAttribute(FLAIR_REST_ATTR, "");
    timer = e.setTimeout(move, FLAIR_REST_MS);
  }
  function park(): void {
    clear();
    e.target.setAttribute(FLAIR_REST_ATTR, "");
  }
  function onChange(): void {
    const now = e.isAway();
    if (now === away) return;
    away = now;
    if (away) park();
    else move();
  }

  away = e.isAway();
  if (away) park();
  else move();
  const unsubscribe = e.onAwayChange(onChange);

  return () => {
    unsubscribe();
    clear();
  };
}
