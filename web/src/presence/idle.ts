// chalk-web -- is the person actually there?
//
// "away" used to mean "the tab is hidden", which left two holes a user could
// see: chalk open side-by-side while you work in another app reported you
// online forever, and so did chalk sitting in front of a locked screen.
//
// What a web page can and cannot know, because it bounds everything below:
// there is no way to observe input that happens outside the page. Three layers
// exist and this module stacks all three --
//
//   in-page input + focus   everywhere       "not interacting with chalk"
//   IdleDetector            Chromium only    "no input to ANY app" + screen lock
//   server TTL demotion     already shipped  "the machine is gone"
//
// so the answer is best-effort, not reliable, and that is the right trade for a
// cosmetic dot. Being an installed PWA grants nothing extra here; it only makes
// the idle-detection grant sticky and background timers less clamped.
//
// The decision is a pure function with the clock passed in, for the same reason
// notify/gate.ts is: these rules are the part that can be wrong in a way people
// notice (a dot that flickers, a dot stuck on away), and pure is the only
// version of them testable without a browser.

/** How long a hidden tab has to stay hidden. Alt-tabbing for a few seconds is
 * not away -- demoting on the visibilitychange itself made the dot flicker for
 * everyone watching and wrote a presence transition per tab flip. */
export const AWAY_AFTER_HIDDEN_MS = 60_000;

/** Visible but not focused: chalk is on screen somewhere while you work
 * elsewhere. Short, because another window having focus is real evidence. */
export const IDLE_AFTER_UNFOCUSED_MS = 120_000;

/** Visible AND focused AND untouched. Long, because a focused window in front
 * of you is weak evidence of absence -- you may just be reading. Only reachable
 * without IdleDetector; with it, rule 4 answers this case properly. */
export const IDLE_AFTER_FOCUSED_MS = 600_000;

/** How often the verdict is recomputed while nothing happens. */
export const EVALUATE_INTERVAL_MS = 15_000;

/** pointermove fires at pointer rate; one stamp a second is plenty. */
const MOVE_STAMP_GAP_MS = 1000;

export interface IdleInput {
  now: number;
  /** Last in-page input, focus gain, or tab reveal. */
  lastActivityAt: number;
  tabVisible: boolean;
  windowFocused: boolean;
  /** When the tab went hidden; undefined while visible. */
  hiddenSince: number | undefined;
  /** IdleDetector's userState. undefined = unavailable, ungranted, or off. */
  systemIdle: boolean | undefined;
  /** IdleDetector's screenState. undefined for the same reasons. */
  screenLocked: boolean | undefined;
  awayAfterHiddenMs: number;
  idleAfterUnfocusedMs: number;
  idleAfterFocusedMs: number;
}

export type IdleReason =
  | "screen_locked"
  | "system_idle"
  | "hidden"
  | "system_active"
  | "unfocused_idle"
  | "no_input"
  | "active";

export interface IdleVerdict {
  idle: boolean;
  reason: IdleReason;
}

/**
 * decideIdle returns why, not just whether -- what makes the tests readable,
 * and what makes "why has chalk decided I am away" answerable from a console
 * log instead of by guesswork.
 *
 * Total by construction: every field is consumed, nothing throws, and an
 * unknown system state (undefined) is a distinct case from a known-active one.
 */
export function decideIdle(i: IdleInput): IdleVerdict {
  // 1. A locked screen is the one unambiguous signal available. No grace
  //    period: nobody reads chalk through a lock screen.
  if (i.screenLocked === true) return { idle: true, reason: "screen_locked" };

  // 2. The API's own threshold is already at least 60s of no input anywhere,
  //    so there is nothing left for us to wait out.
  if (i.systemIdle === true) return { idle: true, reason: "system_idle" };

  // 3. Today's rule, kept intact for the hidden case.
  if (!i.tabVisible && i.hiddenSince !== undefined) {
    if (i.now - i.hiddenSince >= i.awayAfterHiddenMs) {
      return { idle: true, reason: "hidden" };
    }
  }

  // 4. The upgrade: the OS says input is happening somewhere, so no in-page
  //    timeout applies. This is what stops "reading a long thread without
  //    touching the mouse" from being reported as away.
  if (i.systemIdle === false) return { idle: false, reason: "system_active" };

  const quietFor = i.now - i.lastActivityAt;
  if (!i.windowFocused && quietFor >= i.idleAfterUnfocusedMs) {
    return { idle: true, reason: "unfocused_idle" };
  }
  if (quietFor >= i.idleAfterFocusedMs) {
    return { idle: true, reason: "no_input" };
  }
  return { idle: false, reason: "active" };
}

// ---- browser wiring --------------------------------------------------------

export interface IdleWatch {
  /** Push document visibility in. App.tsx already owns the visibilitychange
   * listener and several other things depend on its state; a second listener
   * here would be a second source of truth for the same fact. */
  setVisible(visible: boolean): void;
  /** Push IdleDetector's view in. undefined for either field means "unknown",
   * which is what every non-Chromium browser and every ungranted session
   * reports, and is deliberately not the same as false. */
  setSystem(state: { idle?: boolean; locked?: boolean }): void;
  /** The current verdict, for reading from a ref inside an event handler. */
  verdict(): IdleVerdict;
  stop(): void;
}

/**
 * installIdleWatch attaches the activity listeners and starts recomputing.
 * onChange fires on transitions only, so presence stays edge-driven: one DB
 * write and one NOTIFY per real change, not per mouse move.
 */
export function installIdleWatch(
  onChange: (verdict: IdleVerdict) => void,
): IdleWatch {
  const hasDOM = typeof window !== "undefined" && typeof document !== "undefined";

  let lastActivityAt = Date.now();
  let tabVisible = hasDOM ? !document.hidden : true;
  let windowFocused = hasDOM ? document.hasFocus() : true;
  let hiddenSince: number | undefined = tabVisible ? undefined : Date.now();
  let systemIdle: boolean | undefined;
  let screenLocked: boolean | undefined;
  let current: IdleVerdict = { idle: false, reason: "active" };

  const evaluate = () => {
    const next = decideIdle({
      now: Date.now(),
      lastActivityAt,
      tabVisible,
      windowFocused,
      hiddenSince,
      systemIdle,
      screenLocked,
      awayAfterHiddenMs: AWAY_AFTER_HIDDEN_MS,
      idleAfterUnfocusedMs: IDLE_AFTER_UNFOCUSED_MS,
      idleAfterFocusedMs: IDLE_AFTER_FOCUSED_MS,
    });
    const changed = next.idle !== current.idle;
    current = next;
    if (changed) onChange(next);
  };

  // Stamping then evaluating immediately is what makes coming back instant.
  // Going idle can lag by up to one interval, which nobody can perceive.
  const stamp = () => {
    lastActivityAt = Date.now();
    evaluate();
  };

  const onMove = () => {
    if (Date.now() - lastActivityAt < MOVE_STAMP_GAP_MS) return;
    stamp();
  };

  const onFocus = () => {
    windowFocused = true;
    stamp();
  };
  const onBlur = () => {
    windowFocused = false;
    evaluate();
  };

  // Capture phase so a handler that stops propagation -- the composer, the
  // emoji picker, a modal -- cannot make the user look absent while they type.
  const opts: AddEventListenerOptions = { passive: true, capture: true };
  const stampEvents = ["pointerdown", "keydown", "wheel", "touchstart", "scroll"];

  let timer: ReturnType<typeof setInterval> | undefined;
  if (hasDOM) {
    for (const name of stampEvents) window.addEventListener(name, stamp, opts);
    window.addEventListener("pointermove", onMove, opts);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    // Recomputed from Date.now() deltas rather than by counting ticks, because
    // a hidden tab's timers are clamped to about one a minute and a frozen or
    // slept one stops firing altogether. Deltas make all three resolve
    // correctly the moment the tab comes back -- and catch laptop sleep free.
    timer = setInterval(evaluate, EVALUATE_INTERVAL_MS);
  }

  return {
    setVisible(visible: boolean) {
      if (visible === tabVisible) return;
      tabVisible = visible;
      if (visible) {
        hiddenSince = undefined;
        // Revealing a tab is a deliberate act. Without this stamp, a tab
        // hidden for an hour would still read idle on return until the user
        // happened to move the mouse.
        stamp();
        return;
      }
      hiddenSince = Date.now();
      evaluate();
    },
    setSystem(state) {
      systemIdle = state.idle;
      screenLocked = state.locked;
      evaluate();
    },
    verdict() {
      return current;
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      if (!hasDOM) return;
      for (const name of stampEvents) window.removeEventListener(name, stamp, opts);
      window.removeEventListener("pointermove", onMove, opts);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    },
  };
}
