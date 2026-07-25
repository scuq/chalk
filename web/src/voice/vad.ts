// chalk-web -- transmit modes and the voice-activity gate (Phase 30 Addendum A4).
//
// Four mutually exclusive ways your mic can decide to be open:
//
//   continuous  always transmitting -- what chalk did before this existed
//   vad         open while you are speaking, by level
//   ptt         open only while the hold key is down (push to talk)
//   ptm         open unless the hold key is down (push to mute)
//
// The decision is a pure function of (previous state, level, key, now), which
// is the whole reason it lives here rather than inside the audio graph: gate
// logic is where this kind of feature goes wrong -- a mic stuck open, a clipped
// word-tail, a gate that chatters mid-sentence -- and none of that is
// observable by hand-testing a call. Here it is a table of cases.
//
// The VAD scheme is Mumble's two thresholds (A4):
//
//   level >= vadOpen    definitely speech    -> open, and arm the hold timer
//   level <= vadClose   definitely silence   -> closed, once the hold expires
//   in between          ambiguous            -> keep doing whatever you were
//
// That middle band IS the hysteresis. Without it a voice hovering around a
// single threshold opens and closes the gate every few milliseconds, which
// sounds considerably worse than either state on its own.

export type TransmitMode = "continuous" | "vad" | "ptt" | "ptm";

// Order matters: this is the order the settings UI lists them in.
export const TRANSMIT_MODES: TransmitMode[] = ["continuous", "vad", "ptt", "ptm"];

export const TRANSMIT_LABELS: Record<TransmitMode, { label: string; desc: string }> = {
  continuous: { label: "always on", desc: "transmit everything, the room included" },
  vad: { label: "when i speak", desc: "open the mic above a level you set" },
  ptt: { label: "push to talk", desc: "open only while you hold a key" },
  ptm: { label: "push to mute", desc: "open until you hold a key" },
};

export function isTransmitMode(v: unknown): v is TransmitMode {
  return TRANSMIT_MODES.includes(v as TransmitMode);
}

export interface GateConfig {
  mode: TransmitMode;
  /** Speech-above threshold, 0..1. At or over this the gate opens. */
  vadOpen: number;
  /** Silence-below threshold, 0..1. At or under this the hold timer runs out. */
  vadClose: number;
  /** Keep transmitting this long after the reason to transmit goes away. */
  holdMs: number;
}

export interface GateInput {
  /** Post-gain RMS, 0..1 -- the same number the level meter draws. */
  level: number;
  keyHeld: boolean;
  now: number;
}

export interface GateState {
  open: boolean;
  /** Timestamp until which the gate stays open regardless of level. */
  holdUntil: number;
}

export const GATE_CLOSED: GateState = { open: false, holdUntil: 0 };

/**
 * nextGate computes the gate state for this instant.
 *
 * Push-to-MUTE deliberately ignores the hold timer. The timer exists so
 * word-tails are not clipped, but someone who just hit the mute key wants to be
 * silent NOW, not 300 ms from now -- whatever they are about to say is usually
 * the reason they pressed it.
 */
export function nextGate(prev: GateState, cfg: GateConfig, inp: GateInput): GateState {
  const { level, keyHeld, now } = inp;

  switch (cfg.mode) {
    case "continuous":
      return { open: true, holdUntil: 0 };

    case "ptm":
      return { open: !keyHeld, holdUntil: 0 };

    case "ptt":
      // Held: open, and keep it open briefly after release.
      if (keyHeld) return { open: true, holdUntil: now + cfg.holdMs };
      return holdOver(prev, now);

    case "vad": {
      if (level >= cfg.vadOpen) return { open: true, holdUntil: now + cfg.holdMs };
      if (level <= cfg.vadClose) return holdOver(prev, now);
      // The ambiguous band: keep the current state, and do NOT re-arm the hold.
      // Re-arming here would let a steady hum just above the silence floor hold
      // the gate open forever.
      return prev;
    }
  }
}

/** holdOver keeps a gate open until its hold timer expires, then closes it. */
function holdOver(prev: GateState, now: number): GateState {
  if (prev.open && now < prev.holdUntil) return prev;
  return GATE_CLOSED;
}
