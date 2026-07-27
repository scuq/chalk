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
// Phase 50 split the categories in two. The notification event types
// (rules.ts) go through the rules engine, which decides per event
// whether they sound at all -- they have no on/off toggle here anymore.
// What stays in prefs is the machine noises: sounds about chalk itself
// rather than about anything a person did, which no rule should ever
// route to a banner.
//
// Prefs are per-device (localStorage), not server-synced like theme. The
// doc claims they live in "the encrypted settings blob", which was never
// true -- user_preferences is plaintext JSONB the server reads. Keeping
// them local is the only way to honour the promise, and volume is a
// property of the machine anyway: what's right in headphones at a desk is
// wrong on a phone in a room with other people.

import { EVENT_TYPE_LABELS, NOTIFY_EVENT_TYPES, type NotifyEventType } from "./rules";

export type MachineCategory = "presence" | "connect" | "disconnect" | "send_confirm" | "error";

// Everything the synth can play: the rules-routed event types plus the
// machine noises.
export type SoundCategory = NotifyEventType | MachineCategory;

export const MACHINE_CATEGORIES: MachineCategory[] = [
  "presence",
  "connect",
  "disconnect",
  "send_confirm",
  "error",
];

// Order matters: this is the order preview lists iterate. Loud, personal
// things first; machine noises last.
export const SOUND_CATEGORIES: SoundCategory[] = [...NOTIFY_EVENT_TYPES, ...MACHINE_CATEGORIES];

export function isMachineCategory(c: SoundCategory): c is MachineCategory {
  return (MACHINE_CATEGORIES as string[]).includes(c);
}

export const CATEGORY_LABELS: Record<SoundCategory, { label: string; desc: string }> = {
  ...EVENT_TYPE_LABELS,
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
  categories: Record<MachineCategory, boolean>;
}

export const MIN_VOLUME = 0;
export const MAX_VOLUME = 1;

// Per-category defaults, applied only once the master switch is on.
//
// The machine noises stay off except errors. They report on chalk itself
// rather than on anything a person did, and a flapping connection would
// otherwise chatter away on its own.
export const DEFAULT_CATEGORIES: Record<MachineCategory, boolean> = {
  presence: false,
  connect: false,
  disconnect: false,
  send_confirm: false,
  error: true,
};

// On out of the box. Volume sits low: the pack is audible at 0.4 without
// being the loudest thing on the desktop, and the suppression rules
// already keep it quiet for whatever channel the user is actually
// reading.
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
