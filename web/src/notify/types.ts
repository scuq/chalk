// chalk-web -- notification sound categories and per-device preferences.
//
// See docs/notification-sounds.md. Two things there are deliberately not
// implemented here:
//
//   dnd_schedule  a time-window scheduler is its own slice; shipping a
//                 dead field is worse than omitting it
//   pack          there is exactly one pack, and a discriminator with one
//                 value is an abstraction with nothing to discriminate
//
// Prefs are per-device (localStorage), not server-synced like theme. The
// doc claims they live in "the encrypted settings blob", which was never
// true -- user_preferences is plaintext JSONB the server reads. Keeping
// them local is the only way to honour the promise, and volume is a
// property of the machine anyway: what's right in headphones at a desk is
// wrong on a phone in a room with other people.

export type SoundCategory =
  | "mention"
  | "dm"
  | "message"
  | "thread_reply"
  | "presence"
  | "connect"
  | "disconnect"
  | "send_confirm"
  | "error";

// Order matters: this is the order the settings UI lists them in, and the
// order tests iterate. Loud, personal things first; machine noises last.
export const SOUND_CATEGORIES: SoundCategory[] = [
  "mention",
  "dm",
  "thread_reply",
  "message",
  "presence",
  "connect",
  "disconnect",
  "send_confirm",
  "error",
];

export const CATEGORY_LABELS: Record<SoundCategory, { label: string; desc: string }> = {
  mention: { label: "mentions", desc: "someone writes your handle" },
  dm: { label: "direct messages", desc: "a 1:1 message" },
  thread_reply: { label: "thread replies", desc: "a reply in a thread you're in" },
  message: { label: "every message", desc: "any new message in any channel" },
  presence: { label: "friend comes online", desc: "" },
  connect: { label: "connected", desc: "your own connection came back" },
  disconnect: { label: "disconnected", desc: "your own connection dropped" },
  send_confirm: { label: "send confirmed", desc: "the server took your message" },
  error: { label: "errors", desc: "a send or a request failed" },
};

export interface SoundPrefs {
  master: boolean;
  volume: number; // 0..1
  dnd: boolean;
  categories: Record<SoundCategory, boolean>;
}

export const MIN_VOLUME = 0;
export const MAX_VOLUME = 1;

// Per-category defaults, applied only once the master switch is on.
// "message" is off on purpose: in a busy channel it is the difference
// between a notification and a metronome.
export const DEFAULT_CATEGORIES: Record<SoundCategory, boolean> = {
  mention: true,
  dm: true,
  thread_reply: true,
  message: false,
  presence: false,
  connect: false,
  disconnect: false,
  send_confirm: false,
  error: true,
};

// Master off: a build that suddenly starts making noise is a bug report,
// not a feature. The user turns it on in their profile.
export const DEFAULT_SOUND_PREFS: SoundPrefs = {
  master: false,
  volume: 0.4,
  dnd: false,
  categories: { ...DEFAULT_CATEGORIES },
};
