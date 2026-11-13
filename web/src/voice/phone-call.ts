// 135-5: the phone call view, as pure functions: which tiles go where, the
// grid sizes, the line under the room name in the call bar, and whether the
// browser can share a screen. PhoneCallSheet.tsx and PhoneCallBar.tsx draw
// what these return.

import type { RailTile } from "./rail-tiles";

/** Where each tile of the call goes. */
export interface CallLayout {
  /** "audio" when no other person shows video, else "video". */
  mode: "audio" | "video";
  /** audio: one card per tile. video: the videos that fill the view. */
  stage: RailTile[];
  /** video only: everybody else, as small chips under the stage. */
  strip: RailTile[];
  /** video only: your own camera, as a preview in the corner. */
  corner: RailTile | null;
}

/** callLayout sorts the tiles of a call into the phone layout. focusKey is
 * the tile the user asked to show large, if any. */
export function callLayout(tiles: RailTile[], focusKey: string | null): CallLayout {
  // Your own screen share is not shown back to you: the share button says
  // that you share.
  const shown = tiles.filter((t) => !(t.isSelf && t.isScreen));
  const videos = shown.filter((t) => !t.isSelf && t.hasLiveVideo);
  if (videos.length === 0) return { mode: "audio", stage: shown, strip: [], corner: null };
  const focus = focusKey ? videos.find((t) => t.key === focusKey) : undefined;
  const stage = focus ? [focus] : videos.slice(0, 4);
  const selfCam = shown.find((t) => t.isSelf && t.hasLiveVideo) ?? null;
  const strip = shown.filter((t) => !stage.includes(t) && t !== selfCam);
  return { mode: "video", stage, strip, corner: selfCam };
}

/** stageGrid returns the grid for n videos: one fills the view, two stack,
 * three or four make a 2 by 2 grid. */
export function stageGrid(n: number): { cols: number; rows: number } {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 1, rows: 2 };
  return { cols: 2, rows: 2 };
}

/** cardColumns returns the columns of the audio cards: one column of large
 * cards for one or two people, two columns from three people. */
export function cardColumns(n: number): 1 | 2 {
  return n <= 2 ? 1 : 2;
}

/** What the call bar line reads. */
export interface BarState {
  phase: "idle" | "joining" | "in-call";
  muted: boolean;
  audioBlocked: boolean;
  /** The names of the other people who speak now. */
  speaking: string[];
}

/** barLine returns the second line of the call bar. */
export function barLine(s: BarState): string {
  if (s.audioBlocked) return "tap anywhere to turn on the sound";
  if (s.phase !== "in-call") return "joining…";
  if (s.speaking.length === 1) return `${s.speaking[0]} is speaking`;
  if (s.speaking.length === 2) return `${s.speaking[0]} and ${s.speaking[1]} are speaking`;
  if (s.speaking.length > 2) return `${s.speaking.length} people are speaking`;
  return s.muted ? "you are muted" : "in the call";
}

/** canShareScreen reports whether the browser can share a screen. iOS
 * Safari has no getDisplayMedia. */
export function canShareScreen(mediaDevices: unknown): boolean {
  return !!mediaDevices && typeof (mediaDevices as { getDisplayMedia?: unknown }).getDisplayMedia === "function";
}
