// chalk-web -- the one object App.tsx talks to about sound.
//
// Holds the three pieces together: the device's prefs (prefs.ts), the
// decision about whether to make a noise at all (gate.ts), and the
// chalk-stroke pack that makes it (synth.ts). Nothing here decides *which*
// category an event is -- that's the caller's job, because it needs app
// state -- and nothing here touches app state.
//
// Deliberately not a hook and not in the reducer. The reducer is pure by
// contract, and its "message" case also runs for optimistic self-sends and
// for history loads, so a sound fired from there would play for messages
// you typed and would burst on every reload.

import { decideSound, type GateVerdict } from "./gate";
import { loadSoundPrefs, subscribeSoundPrefs } from "./prefs";
import { SoundPlayer } from "./synth";
import type { SoundCategory, SoundPrefs } from "./types";

export * from "./types";
export { decideSound, MIN_GAP_ANY_MS, MIN_GAP_CATEGORY_MS } from "./gate";
export { loadSoundPrefs, saveSoundPrefs, normalizeSoundPrefs, useSoundPrefs } from "./prefs";
export { SOUND_SPECS, type StrokeSpec } from "./synth";

// What the caller knows about the moment the sound is for. Kept to the
// two facts the suppression rules need, so that adding a category later
// doesn't mean widening this.
export interface PlayContext {
  tabVisible: boolean;
  isRelevantSurfaceOpen: boolean;
}

export class NotifySounds {
  private prefs: SoundPrefs;
  private player: SoundPlayer;
  private unsubscribe: (() => void) | null = null;
  private lastAnyAt: number | undefined;
  private lastByCategory: Partial<Record<SoundCategory, number>> = {};

  constructor() {
    this.prefs = loadSoundPrefs();
    this.player = new SoundPlayer(this.prefs.volume);
    this.unsubscribe = subscribeSoundPrefs((next) => {
      this.prefs = next;
      this.player.setVolume(next.volume);
    });
  }

  // Call from a real user gesture. Until this has run the gate returns
  // "locked" for everything, which is correct rather than merely quiet:
  // a suspended AudioContext doesn't play silently, it errors.
  unlock(): void {
    void this.player.unlock();
  }

  // play asks the gate first and only records a timestamp if the sound
  // actually happened -- a suppressed sound must not start the clock, or
  // a long run of suppressed events would keep pushing the next real one
  // out of reach.
  play(category: SoundCategory, ctx: PlayContext): GateVerdict {
    const now = Date.now();
    const verdict = decideSound({
      category,
      prefs: this.prefs,
      unlocked: this.player.unlocked,
      tabVisible: ctx.tabVisible,
      isRelevantSurfaceOpen: ctx.isRelevantSurfaceOpen,
      now,
      lastAnyAt: this.lastAnyAt,
      lastByCategory: this.lastByCategory,
    });
    if (verdict !== "play") return verdict;

    this.lastAnyAt = now;
    this.lastByCategory[category] = now;
    this.player.play(category);
    return verdict;
  }

  // preview plays a category on demand from the settings UI. It skips the
  // gate on purpose -- you are asking to hear this one, right now, while
  // looking straight at the app, which is the exact situation every
  // suppression rule exists to prevent. It does not skip the unlock,
  // because clicking the button *is* the gesture that grants it.
  preview(category: SoundCategory): void {
    void this.player.unlock().then(() => this.player.play(category));
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.player.close();
  }
}
