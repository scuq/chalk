// chalk-web -- the sound themes.
//
// 102-1: chalk used to synthesize every notification as a chalk stroke
// (phase 40's noise-and-bandpass pack, extended by 71). That pack is gone;
// a notification is now a recorded cue from one of a few themes, chosen
// per device in the profile panel. The synth's whole design problem --
// making friction noise not screech -- disappears with it, and so does its
// listening bench: a theme is tuned in a DAW, not in a table of numbers.
//
// A theme is ten files, one per *cue*. That is fewer than chalk has sound
// categories: the eight rules-routed event types (mention, dm, thread
// reply, ...) all share the "new message" cue, because the themes were
// authored for the ten events a listener can actually tell apart, and a
// mention is told from a plain message by the banner and the badge rather
// than by a different noise. CUE_FOR is that mapping and is the one place
// it lives; a theme that later grows a distinct mention cue changes the
// row here, nothing else.
//
// This module is pure -- ids, labels, the mapping -- so it can be tested
// under node. The WAV imports live in theme-assets.ts, next door.

import type { SoundCategory } from "./types";

export type SoundThemeId = "chalk" | "gamegirl" | "runestone" | "empir";

// The ten cues every theme ships. The names are the file stems the theme
// folders use, so a folder listing and this list can be checked against
// each other by eye.
export type ThemeCue =
  | "01_friend_online"
  | "02_you_join_call"
  | "03_you_leave_call"
  | "04_someone_joins"
  | "05_someone_leaves"
  | "06_connected"
  | "07_disconnected"
  | "08_send_confirmed"
  | "09_error"
  | "10_new_message";

export const THEME_CUES: ThemeCue[] = [
  "01_friend_online",
  "02_you_join_call",
  "03_you_leave_call",
  "04_someone_joins",
  "05_someone_leaves",
  "06_connected",
  "07_disconnected",
  "08_send_confirmed",
  "09_error",
  "10_new_message",
];

// Which cue each sound category plays. Exhaustive: the test holds every
// category to a row, so a new category cannot silently play nothing.
export const CUE_FOR: Record<SoundCategory, ThemeCue> = {
  mention: "10_new_message",
  dm: "10_new_message",
  thread_reply: "10_new_message",
  message: "10_new_message",
  voice: "10_new_message",
  channel_added: "10_new_message",
  friend_request: "10_new_message",
  governance: "10_new_message",
  presence: "01_friend_online",
  call_join: "02_you_join_call",
  call_leave: "03_you_leave_call",
  peer_join: "04_someone_joins",
  peer_leave: "05_someone_leaves",
  connect: "06_connected",
  disconnect: "07_disconnected",
  send_confirm: "08_send_confirmed",
  error: "09_error",
};

export interface SoundThemeInfo {
  id: SoundThemeId;
  label: string;
  // One line for the picker, from the theme's own MANIFEST.md.
  desc: string;
}

// Order is the picker's order. chalk first because it is the default: the
// app is called chalk, and these are chalk on a board -- scrapes, taps and
// dust, the same grammar the synth had (up = arrival, down = departure).
export const SOUND_THEMES: SoundThemeInfo[] = [
  { id: "chalk", label: "chalk", desc: "chalk on a board — scrapes, taps and dust" },
  { id: "gamegirl", label: "gamegirl", desc: "classic-handheld bleeps, pulse waves and hard gates" },
  { id: "runestone", label: "runestone", desc: "fantasy UI — horns, bells, parchment and portals" },
  // 102-2. The id is "empir" -- scuq's name for it, not a typo of the
  // source folder's "empire".
  { id: "empir", label: "empir", desc: "medieval RTS — horns, timber, blacksmith metal and drums" },
];

export const DEFAULT_SOUND_THEME: SoundThemeId = "chalk";

export function isSoundThemeId(v: unknown): v is SoundThemeId {
  return typeof v === "string" && SOUND_THEMES.some((t) => t.id === v);
}
