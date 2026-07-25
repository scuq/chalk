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

import type { SoundCategory, SoundPrefs } from "./types";

// Rate limits. Two of them, because one isn't enough: the global floor
// stops a busy channel turning into a rattle, and the per-category floor
// stops one repeated event type (a flapping connection, a friend whose
// presence oscillates) from eating the global budget and masking
// everything else.
export const MIN_GAP_ANY_MS = 2000;
export const MIN_GAP_CATEGORY_MS = 5000;

export interface GateInput {
  category: SoundCategory;
  prefs: SoundPrefs;
  // The AudioContext is suspended until the user has interacted with the
  // page. Before that, playing is not quiet -- it's an error.
  unlocked: boolean;
  tabVisible: boolean;
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
  if (!prefs.categories[category]) return "category_off";

  // Rule 1. You are looking at the thing. Note this applies to every
  // category including connect/disconnect/error -- if the window is in
  // front of you, the status bar has already said it.
  if (input.tabVisible && input.isRelevantSurfaceOpen) return "already_watching";

  // Rule 2.
  if (prefs.dnd) return "dnd";

  // Rule 3.
  const any = input.lastAnyAt;
  if (any !== undefined && input.now - any < MIN_GAP_ANY_MS) return "rate_any";
  const last = input.lastByCategory[category];
  if (last !== undefined && input.now - last < MIN_GAP_CATEGORY_MS) return "rate_category";

  // Rule 4. Last, so that a locked context still consumes no budget and
  // the first sound after the user clicks is immediate.
  if (!input.unlocked) return "locked";

  return "play";
}
