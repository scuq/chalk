// chalk-web -- the one object App.tsx talks to about sound.
//
// Holds the three pieces together: the device's prefs (prefs.ts), the
// decision about whether to make a noise at all (gate.ts), and the
// theme player that makes it (player.ts, themes.ts). Nothing here decides
// *which* category an event is -- that's the caller's job, because it needs
// app state -- and nothing here touches app state.
//
// Deliberately not a hook and not in the reducer. The reducer is pure by
// contract, and its "message" case also runs for optimistic self-sends and
// for history loads, so a sound fired from there would play for messages
// you typed and would burst on every reload.

import { decideSound, type GateVerdict } from "./gate";
import { loadSoundPrefs, subscribeSoundPrefs } from "./prefs";
import { SoundPlayer } from "./player";
import { loadDevicePrefs, subscribeDevicePrefs } from "../voice/device-prefs";
import { isCallCategory, type CallCategory, type SoundCategory, type SoundPrefs } from "./types";
import type { SoundThemeId } from "./themes";

export * from "./types";
export { decideSound, MIN_GAP_ANY_MS, MIN_GAP_CALL_MS, MIN_GAP_CATEGORY_MS } from "./gate";
export { loadSoundPrefs, saveSoundPrefs, normalizeSoundPrefs, useSoundPrefs } from "./prefs";
export {
  SOUND_THEMES,
  DEFAULT_SOUND_THEME,
  CUE_FOR,
  isSoundThemeId,
  type SoundThemeId,
  type ThemeCue,
} from "./themes";

// What the caller knows about the moment the sound is for. Kept to the
// facts the suppression rules need, so that adding a category later
// doesn't mean widening this.
export interface PlayContext {
  tabVisible: boolean;
  // Whether the viewer has actually been at the machine lately (presence/idle).
  userIdle: boolean;
  isRelevantSurfaceOpen: boolean;
}

export class NotifySounds {
  private prefs: SoundPrefs;
  private player: SoundPlayer;
  private unsubscribe: (() => void) | null = null;
  private unsubscribeDevices: (() => void) | null = null;
  private lastAnyAt: number | undefined;
  private lastByCategory: Partial<Record<SoundCategory, number>> = {};

  constructor() {
    this.prefs = loadSoundPrefs();
    this.player = new SoundPlayer(this.prefs.volume, this.prefs.theme);
    this.unsubscribe = subscribeSoundPrefs((next) => {
      this.prefs = next;
      this.player.setVolume(next.volume);
      this.player.setTheme(next.theme);
    });
    // 44-9: the chosen output device is a machine setting, so the sounds
    // follow the same speakers the call does.
    this.player.setOutput(loadDevicePrefs().outputId);
    this.unsubscribeDevices = subscribeDevicePrefs((p) => this.player.setOutput(p.outputId));
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
      userIdle: ctx.userIdle,
      isRelevantSurfaceOpen: ctx.isRelevantSurfaceOpen,
      now,
      lastAnyAt: this.lastAnyAt,
      lastByCategory: this.lastByCategory,
    });
    if (verdict !== "play") return verdict;

    // 71-1: a call sound spends none of the shared budget -- someone
    // walking into the room must not silence the mention that lands a
    // second later.
    if (!isCallCategory(category)) this.lastAnyAt = now;
    this.lastByCategory[category] = now;
    this.player.play(category);
    return verdict;
  }

  // playCall is the voice session's path in. It fills the context in
  // rather than asking for it, because there is nothing to fill: a call
  // has no surface you could be "already watching" -- the stage and the
  // dock both show it, and hearing who just arrived is the point even when
  // you are looking straight at their tile. Everything else still applies,
  // so the master switch, the per-category toggle and DND all silence it.
  playCall(category: CallCategory): GateVerdict {
    return this.play(category, {
      tabVisible: false,
      userIdle: false,
      isRelevantSurfaceOpen: false,
    });
  }

  // preview plays a category on demand from the settings UI. It skips the
  // gate on purpose -- you are asking to hear this one, right now, while
  // looking straight at the app, which is the exact situation every
  // suppression rule exists to prevent. It does not skip the unlock,
  // because clicking the button *is* the gesture that grants it.
  //
  // 102-1: the theme picker passes the theme it has just chosen, because
  // the pref write it made lands in this object through a Preact state
  // updater -- possibly after this call. Saying it outright is simpler
  // than reasoning about that ordering.
  preview(category: SoundCategory, theme?: SoundThemeId): void {
    if (theme) this.player.setTheme(theme);
    void this.player.unlock().then(() => this.player.play(category));
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeDevices?.();
    this.unsubscribeDevices = null;
    this.player.close();
  }
}

// One instance per page. It has to be shared: the frame handlers play
// sounds and the profile panel previews them, and two instances would
// mean two AudioContexts with independent unlock state -- previewing in
// the profile would leave the real sounds still locked.
let shared: NotifySounds | null = null;

export function notifySounds(): NotifySounds {
  if (!shared) shared = new NotifySounds();
  return shared;
}
