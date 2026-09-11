// Phase 119-1: playback above 100% for one participant.
//
// The per-peer volume sliders drove HTMLMediaElement.volume, which stops at
// 1.0 -- so a quiet person could be turned down but never UP, and "I can't
// hear them" had no answer short of asking them to fix their mic. Above 1.0
// the level has to be applied before the element: the peer's stream goes
// through a Web Audio GainNode into a MediaStreamAudioDestinationNode, and
// the <audio> element plays THAT stream at volume 1. The element keeps every
// job it already had -- mute, deafen, setSinkId to the chosen output --
// because the graph only replaces what it is fed, not how it is played.
//
// The graph is built only for a boosted peer. At or under 100% nothing here
// runs and the element's own volume does the work as before, so the common
// case pays nothing and the unboosted path is the one that has always
// shipped.
//
// One AudioContext for all boosted playback, created on first use. A slider
// drag is a user gesture, so the context is running when the first boost is
// asked for; a page RELOADED with a stored boost has had no gesture yet, and
// a context born suspended would play silence for that peer. So the sink
// asks isRunning() before trusting the graph, plays the raw stream at 100%
// while it is not, and the first pointer or key anywhere resumes it (the
// same one-shot the dock uses for autoplay-blocked elements).
//
// The pure half (the ceiling, the split between element and gain) is here
// so the tests can pin it without a DOM.

/** The slider's ceiling, as a multiplier. 200% is where Discord stops too:
 * a gain past that is mostly clipping, and a person who needs more than
 * double has a microphone problem this cannot solve. */
export const MAX_PEER_VOLUME = 2;

/** clampPeerVolume: 0..MAX, defaulting to full volume for anything that is
 * not a real number -- a NaN would silence someone permanently
 * (element.volume = NaN throws). */
export function clampPeerVolume(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 1;
  return Math.min(MAX_PEER_VOLUME, Math.max(0, v));
}

/** needsBoost: does this level need the gain graph at all? */
export function needsBoost(volume: number): boolean {
  return clampPeerVolume(volume) > 1;
}

/** elementVolume: what the <audio> element is set to. Under the ceiling the
 * element carries the whole level; over it the element sits at 1 and the
 * gain carries the rest. */
export function elementVolume(volume: number): number {
  return Math.min(1, clampPeerVolume(volume));
}

/** boostGain: the GainNode's value for this level; 1 when no boost. */
export function boostGain(volume: number): number {
  const v = clampPeerVolume(volume);
  return v > 1 ? v : 1;
}

// ---- the DOM half ---------------------------------------------------------

let ctx: AudioContext | null = null;
let resumeHooked = false;

function context(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor =
    (globalThis as { AudioContext?: typeof AudioContext }).AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  return ctx;
}

/** boostAvailable: can this engine build the graph at all? */
export function boostAvailable(): boolean {
  return context() !== null;
}

/** isBoostRunning: is the shared context actually producing sound? A sink
 * must not route through a suspended context -- that is silence. */
export function isBoostRunning(): boolean {
  return ctx?.state === "running";
}

/** onBoostState calls fn whenever the shared context changes state, so a
 * sink can move between the raw stream and the graph. Returns the unhook. */
export function onBoostState(fn: () => void): () => void {
  const c = context();
  if (!c) return () => {};
  c.addEventListener("statechange", fn);
  return () => c.removeEventListener("statechange", fn);
}

/** hookBoostResume arms a one-shot resume on the next pointer or key
 * anywhere, for a context that was born suspended (a reload with a stored
 * boost). Idempotent. */
export function hookBoostResume(): void {
  if (resumeHooked || typeof window === "undefined") return;
  resumeHooked = true;
  const resume = () => {
    resumeHooked = false;
    window.removeEventListener("pointerdown", resume);
    window.removeEventListener("keydown", resume);
    if (ctx && ctx.state !== "running") void ctx.resume().catch(() => {});
  };
  window.addEventListener("pointerdown", resume);
  window.addEventListener("keydown", resume);
}

/** One peer's gain graph. */
export interface Boost {
  /** The stream the graph was built on, so a sink can spot a swap. */
  raw: MediaStream;
  /** What the <audio> element plays instead of the raw stream. */
  stream: MediaStream;
  /** Change the level without rebuilding the graph. */
  setGain(volume: number): void;
  /** Tear the graph down; the caller goes back to the raw stream. */
  release(): void;
}

/** openBoost builds source -> gain -> destination for one stream, or returns
 * null where Web Audio is missing or refuses the stream. */
export function openBoost(raw: MediaStream, volume: number): Boost | null {
  const c = context();
  if (!c) return null;
  try {
    const source = c.createMediaStreamSource(raw);
    const gain = c.createGain();
    gain.gain.value = boostGain(volume);
    const dest = c.createMediaStreamDestination();
    source.connect(gain);
    gain.connect(dest);
    return {
      raw,
      stream: dest.stream,
      setGain(v) {
        gain.gain.value = boostGain(v);
      },
      release() {
        try {
          source.disconnect();
          gain.disconnect();
        } catch {
          /* already gone */
        }
      },
    };
  } catch {
    return null;
  }
}
