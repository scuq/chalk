// chalk-web -- should this sound actually play?
//
// Every reason not to make a noise lives here, as one pure function with
// the clock passed in. That's deliberate: the rules are the part of this
// feature that can be wrong in a way the user notices (a burst on
// reload, a sound for the channel they're already reading, a rattle
// during a fast conversation), and a pure function is the only version of
// them that can be tested without a browser.
//
// The rules are docs/notification-sounds.md "Suppression rules", plus the
// two pref checks that precede them.

import { isCallCategory, isMachineCategory, type SoundCategory, type SoundPrefs } from "./types";

// Rate limits. Two of them, because one isn't enough: the global floor
// stops a busy channel turning into a rattle, and the per-category floor
// stops one repeated event type (a flapping connection, a friend whose
// presence oscillates) from eating the global budget and masking
// everything else.
export const MIN_GAP_ANY_MS = 2000;
export const MIN_GAP_CATEGORY_MS = 5000;

// 71-1: the call roster gets its own, much shorter floor and spends none
// of the shared budget. Two people arriving inside the same two seconds is
// an ordinary start to a meeting rather than a rattle, and under the
// floors above the second of them -- and your own join a moment before --
// would simply be dropped. Still long enough that a peer flapping through
// a reconnect can't stutter.
export const MIN_GAP_CALL_MS = 400;

export interface GateInput {
  category: SoundCategory;
  prefs: SoundPrefs;
  // The AudioContext is suspended until the user has interacted with the
  // page. Before that, playing is not quiet -- it's an error.
  unlocked: boolean;
  tabVisible: boolean;
  // 45-3: on screen is not the same as being read. Without this, walking away
  // from a desk with the channel open makes chalk silent for exactly the
  // stretch you most needed it to speak up.
  userIdle: boolean;
  // Is the thing this sound is about already on screen? For a message,
  // "its channel is the active one". For events with no surface of their
  // own (connect, error) the caller passes false.
  isRelevantSurfaceOpen: boolean;
  now: number;
  // Both are undefined for "nothing has played yet", never 0. A zero
  // would be a real timestamp under a performance.now() clock and would
  // silence the first two seconds after load.
  lastAnyAt: number | undefined;
  lastByCategory: Partial<Record<SoundCategory, number>>;
}

export type GateVerdict =
  | "play"
  | "master_off"
  | "category_off"
  | "already_watching"
  | "dnd"
  | "rate_any"
  | "rate_category"
  | "locked";

// decideSound returns why, not just whether. The caller only cares about
// "play", but a named reason is what makes the tests readable and what
// makes this debuggable from a console log when someone reports that
// their sounds "randomly" don't fire.
export function decideSound(input: GateInput): GateVerdict {
  const { prefs, category } = input;

  if (!prefs.master) return "master_off";
  // Only the machine noises have an on/off toggle here. The notification
  // event types were already routed by the rules engine before this gate
  // was asked -- a muted one never reaches it.
  if (isMachineCategory(category) && !prefs.categories[category]) return "category_off";

  // Rule 1. You are looking at the thing -- which needs you to be there, not
  // just the window to be up. Applies to every category including
  // connect/disconnect/error: if the window is in front of you, the status bar
  // has already said it.
  if (input.tabVisible && !input.userIdle && input.isRelevantSurfaceOpen) {
    return "already_watching";
  }

  // Rule 2.
  if (prefs.dnd) return "dnd";

  // Rule 3. Call sounds are rate-limited against themselves only -- in
  // both directions: they don't consume the shared budget (NotifySounds
  // doesn't record one for them) and they don't read it, so a peer
  // arriving neither silences nor is silenced by the chat.
  if (isCallCategory(category)) {
    const lastCall = input.lastByCategory[category];
    if (lastCall !== undefined && input.now - lastCall < MIN_GAP_CALL_MS) return "rate_category";
  } else {
    const any = input.lastAnyAt;
    if (any !== undefined && input.now - any < MIN_GAP_ANY_MS) return "rate_any";
    const last = input.lastByCategory[category];
    if (last !== undefined && input.now - last < MIN_GAP_CATEGORY_MS) return "rate_category";
  }

  // Rule 4. Last, so that a locked context still consumes no budget and
  // the first sound after the user clicks is immediate.
  if (!input.unlocked) return "locked";

  return "play";
}

// --- 50-3: the same idea for OS banners --------------------------------
//
// Deliberately no rate limit and no unlock: banners collapse through the
// OS tag mechanism (one banner per tag, newer replaces older), and the
// Notification API needs a granted permission rather than a gesture.
// Whether a banner is wanted at all was already the rules engine's call;
// this only decides whether this moment is one to interrupt.

export interface BannerGateInput {
  // The constructor probe: false where page-context Notifications don't
  // exist or are known to throw (Android Chrome without a service worker).
  supported: boolean;
  permission: "default" | "denied" | "granted";
  dnd: boolean;
  tabVisible: boolean;
  userIdle: boolean;
  isRelevantSurfaceOpen: boolean;
}

export type BannerVerdict =
  | "show"
  | "unsupported"
  | "no_permission"
  | "already_watching"
  | "dnd";

export function decideBanner(input: BannerGateInput): BannerVerdict {
  if (!input.supported) return "unsupported";
  if (input.permission !== "granted") return "no_permission";
  // Same as sound rule 1: you are looking at the thing, and you're there.
  if (input.tabVisible && !input.userIdle && input.isRelevantSurfaceOpen) {
    return "already_watching";
  }
  if (input.dnd) return "dnd";
  return "show";
}
