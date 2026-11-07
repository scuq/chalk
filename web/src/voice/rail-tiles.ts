// 131-1: the tile list of a call, in stage order, as a pure function.
//
// The call rail and the stage show the same people in the same order:
// self first, then the roster, then media that has no roster entry yet,
// then one tile per screen share. The stage keeps its own copy of this
// list for now (VoiceCallPanel.tsx). This module can be tested without a browser.

import type { SessionRemoteTile } from "./session";
import type { VoiceParticipant } from "../state/types";

/** The part of the session snapshot the tile list reads. */
export interface RailSnap {
  tiles: Record<string, SessionRemoteTile>;
  localStream: MediaStream | null;
  localScreenStream: MediaStream | null;
  camOn: boolean;
  screenHidden: Record<string, boolean>;
}

export interface RailTile {
  key: string;
  userID: string;
  deviceID: string;
  isSelf: boolean;
  stream: MediaStream | null;
  hasLiveVideo: boolean;
  /** This tile is a screen share, keyed "<peer>:screen". */
  isScreen: boolean;
  /** A screen tile that carries program audio. Always false for a camera. */
  hasAudio: boolean;
  /** The mesh state of a remote camera tile. null for self and for shares. */
  connState: string | null;
  part?: VoiceParticipant;
}

function liveVideo(stream: MediaStream | null, requireEnabled: boolean): boolean {
  if (!stream) return false;
  return stream
    .getVideoTracks()
    .some((t) => t.readyState === "live" && (!requireEnabled || t.enabled));
}

/** railTiles returns one tile per participant and per screen share, in stage order. */
export function railTiles(
  snap: RailSnap,
  roster: VoiceParticipant[],
  selfUserID: string,
  selfDeviceID: string,
): RailTile[] {
  const selfKey = selfUserID + ":" + selfDeviceID;
  const out: RailTile[] = [];
  const seen = new Set<string>();
  const partFor = (userID: string, deviceID: string) =>
    roster.find((p) => p.userID === userID && p.deviceID === deviceID);

  out.push({
    key: selfKey,
    userID: selfUserID,
    deviceID: selfDeviceID,
    isSelf: true,
    stream: snap.localStream,
    hasLiveVideo: snap.camOn && liveVideo(snap.localStream, true),
    isScreen: false,
    hasAudio: false,
    connState: null,
    part: partFor(selfUserID, selfDeviceID),
  });
  seen.add(selfKey);

  for (const p of roster) {
    const key = p.userID + ":" + p.deviceID;
    if (seen.has(key)) continue;
    seen.add(key);
    const t = snap.tiles[key];
    out.push({
      key,
      userID: p.userID,
      deviceID: p.deviceID,
      isSelf: false,
      stream: t?.stream ?? null,
      hasLiveVideo: !!t && liveVideo(t.stream, false),
      isScreen: false,
      hasAudio: false,
      connState: t?.connState ?? "connecting",
      part: p,
    });
  }

  // Media that arrived before the roster entry. Shown, not dropped.
  for (const t of Object.values(snap.tiles)) {
    if (seen.has(t.key)) continue;
    seen.add(t.key);
    out.push({
      key: t.key,
      userID: t.userID,
      deviceID: t.deviceID,
      isSelf: false,
      stream: t.stream,
      hasLiveVideo: liveVideo(t.stream, false),
      isScreen: false,
      hasAudio: false,
      connState: t.connState,
    });
  }

  if (snap.localScreenStream) {
    out.push({
      key: selfKey + ":screen",
      userID: selfUserID,
      deviceID: selfDeviceID,
      isSelf: true,
      stream: snap.localScreenStream,
      hasLiveVideo: liveVideo(snap.localScreenStream, false),
      isScreen: true,
      hasAudio: false,
      connState: null,
    });
  }
  for (const t of Object.values(snap.tiles)) {
    if (!t.screenStream) continue;
    // A share hidden on this device keeps its tile and loses its video.
    const hidden = !!snap.screenHidden[t.key];
    out.push({
      key: t.key + ":screen",
      userID: t.userID,
      deviceID: t.deviceID,
      isSelf: false,
      stream: t.screenStream,
      hasLiveVideo: !hidden && liveVideo(t.screenStream, false),
      isScreen: true,
      hasAudio: t.screenStream.getAudioTracks().length > 0,
      connState: null,
    });
  }
  return out;
}
