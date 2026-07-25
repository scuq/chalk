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
//
// The machine noises stay off. They report on chalk itself rather than on
// anything a person did, and a flapping connection would otherwise chatter
// away on its own.
export const DEFAULT_CATEGORIES: Record<SoundCategory, boolean> = {
  mention: true,
  dm: true,
  thread_reply: true,
  message: true,
  presence: false,
  connect: false,
  disconnect: false,
  send_confirm: false,
  error: true,
};

// On out of the box, including every message. Volume sits low to match:
// the pack is audible at 0.4 without being the loudest thing on the
// desktop, and the suppression rules already keep it quiet for whatever
// channel the user is actually reading.
//
// Nothing can actually sound until the user has interacted with the page
// (see SoundPlayer.unlock), so this cannot startle someone who has merely
// left a tab open.
export const DEFAULT_SOUND_PREFS: SoundPrefs = {
  master: true,
  volume: 0.4,
  dnd: false,
  categories: { ...DEFAULT_CATEGORIES },
};
