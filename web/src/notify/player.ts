// chalk-web -- plays the sound theme's cues.
//
// 102-1: replaces synth.ts. The AudioContext stays, and so does everything
// built on it -- the master gain the volume slider drives, the 44-9 output
// routing through setSinkId, and the unlock model (a context is born
// suspended and only resumes inside a user gesture, which is what lets
// sounds default to on without a tab ever startling anyone). What changes
// is the source: a decoded WAV from the chosen theme instead of a noise
// graph. An <audio> element would have been simpler and would have lost
// all three.
//
// Buffers are fetched and decoded lazily, once per (theme, cue), and kept
// for the life of the context. The first play of a cue after unlock may
// therefore be late by one fetch; unlock() warms the current theme so
// that in practice it is not.

import type { SoundCategory } from "./types";
import { CUE_FOR, THEME_CUES, type SoundThemeId, type ThemeCue } from "./themes";
import { THEME_URLS } from "./theme-assets";

export class SoundPlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private volume: number;
  private theme: SoundThemeId;
  /** "" = the system default output. See setOutput. */
  private outputId = "";
  // Decoded cues, keyed "<theme>/<cue>". A pending decode is stored as its
  // promise so two plays in the same tick share one fetch.
  private buffers = new Map<string, Promise<AudioBuffer | null>>();

  constructor(volume: number, theme: SoundThemeId) {
    this.volume = volume;
    this.theme = theme;
  }

  get unlocked(): boolean {
    return this.ctx !== null && this.ctx.state === "running";
  }

  setVolume(volume: number): void {
    this.volume = volume;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.01);
    }
  }

  // setTheme switches which files play. Already-decoded cues of the old
  // theme stay cached: switching back and forth in the picker should not
  // refetch, and ten short WAVs are nothing to hold.
  setTheme(theme: SoundThemeId): void {
    if (theme === this.theme) return;
    this.theme = theme;
    if (this.unlocked) this.warm();
  }

  /**
   * setOutput routes the sounds to the chosen output device (44-9), so they
   * follow the same speakers as the call rather than always the system default.
   *
   * AudioContext.setSinkId is newer and narrower than the element-level one --
   * Chromium only, and not in every version that has the element form. The
   * remembered id is applied again on unlock(), since the context that is
   * supposed to carry it may not exist yet when the setting is changed.
   */
  setOutput(outputId: string): void {
    this.outputId = outputId;
    void this.applyOutput();
  }

  private async applyOutput(): Promise<void> {
    const ctx = this.ctx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (!ctx?.setSinkId) return;
    try {
      await ctx.setSinkId(this.outputId);
    } catch {
      /* Unplugged, or not permitted. The sounds stay on the previous device. */
    }
  }

  // Must be called from a user gesture: browsers start every AudioContext
  // suspended, and resume() only resolves inside one. Safe to call again.
  async unlock(): Promise<void> {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      void this.applyOutput();
    }
    if (this.ctx.state !== "running") {
      try {
        await this.ctx.resume();
      } catch {
        // Not a gesture after all, or the device is busy. The gate keeps
        // returning "locked" and the next gesture tries again.
      }
    }
    if (this.ctx.state === "running") this.warm();
  }

  // warm starts the fetch for every cue of the current theme, so the first
  // real notification after unlock plays on time rather than after a
  // round trip. Fire-and-forget; failures are cached as null and the cue
  // is simply silent (see load).
  private warm(): void {
    for (const cue of THEME_CUES) void this.load(this.theme, cue);
  }

  private load(theme: SoundThemeId, cue: ThemeCue): Promise<AudioBuffer | null> {
    const ctx = this.ctx;
    if (!ctx) return Promise.resolve(null);
    const key = `${theme}/${cue}`;
    let p = this.buffers.get(key);
    if (!p) {
      p = fetch(THEME_URLS[theme][cue])
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
        .then((bytes) => ctx.decodeAudioData(bytes))
        .catch(() => {
          // A missing or undecodable file must not throw out of a frame
          // handler; and it must not be retried on every message either.
          // Silence, remembered.
          return null;
        });
      this.buffers.set(key, p);
    }
    return p;
  }

  play(category: SoundCategory): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || ctx.state !== "running") return;
    const theme = this.theme;
    void this.load(theme, CUE_FOR[category]).then((buf) => {
      // The context may have been closed, or the theme changed, while the
      // decode was in flight. Both mean this play is stale.
      if (!buf || this.ctx !== ctx || ctx.state !== "running" || this.theme !== theme) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(master);
      src.start();
    });
  }

  close(): void {
    if (this.ctx) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
      this.master = null;
      this.buffers.clear();
    }
  }
}
