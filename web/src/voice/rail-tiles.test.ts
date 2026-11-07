// 131-1: the call rail's tile list.

import test from "node:test";
import assert from "node:assert/strict";

import { railTiles, type RailSnap } from "./rail-tiles";
import type { SessionRemoteTile } from "./session";
import type { VoiceParticipant } from "../state/types";

type TrackSpec = { live?: boolean; enabled?: boolean };

function fakeStream(video: TrackSpec[] = [], audio = 0): MediaStream {
  const videoTracks = video.map((v) => ({
    readyState: v.live === false ? "ended" : "live",
    enabled: v.enabled !== false,
  }));
  const audioTracks = Array.from({ length: audio }, () => ({ readyState: "live" }));
  return {
    getVideoTracks: () => videoTracks,
    getAudioTracks: () => audioTracks,
  } as unknown as MediaStream;
}

function part(userID: string, deviceID = "d1", extra: Partial<VoiceParticipant> = {}): VoiceParticipant {
  return { userID, deviceID, muted: false, videoOn: false, screenOn: false, deafened: false, ...extra };
}

function remote(userID: string, deviceID = "d1", stream = fakeStream(), screen: MediaStream | null = null): SessionRemoteTile {
  return { key: userID + ":" + deviceID, userID, deviceID, stream, connState: "connected", screenStream: screen };
}

function snapOf(over: Partial<RailSnap> = {}): RailSnap {
  return { tiles: {}, localStream: null, localScreenStream: null, camOn: false, screenHidden: {}, ...over };
}

test("self comes first, even when the roster lists others before you", () => {
  const roster = [part("bob"), part("me"), part("carol")];
  const tiles = railTiles(snapOf(), roster, "me", "d1");
  assert.deepEqual(
    tiles.map((t) => t.key),
    ["me:d1", "bob:d1", "carol:d1"],
  );
  assert.equal(tiles[0].isSelf, true);
  assert.equal(tiles[0].part?.userID, "me");
});

test("roster order is kept, and a roster entry without media is connecting", () => {
  const roster = [part("me"), part("carol"), part("bob")];
  const snap = snapOf({ tiles: { "bob:d1": remote("bob") } });
  const tiles = railTiles(snap, roster, "me", "d1");
  assert.deepEqual(
    tiles.map((t) => t.key),
    ["me:d1", "carol:d1", "bob:d1"],
  );
  assert.equal(tiles[1].connState, "connecting");
  assert.equal(tiles[1].stream, null);
  assert.equal(tiles[2].connState, "connected");
});

test("media with no roster entry is appended after the roster", () => {
  const roster = [part("me"), part("bob")];
  const snap = snapOf({ tiles: { "dave:d1": remote("dave"), "bob:d1": remote("bob") } });
  const tiles = railTiles(snap, roster, "me", "d1");
  assert.deepEqual(
    tiles.map((t) => t.key),
    ["me:d1", "bob:d1", "dave:d1"],
  );
  assert.equal(tiles[2].part, undefined);
});

test("each screen share gets one tile, the local share first", () => {
  const roster = [part("me"), part("bob"), part("carol")];
  const snap = snapOf({
    localScreenStream: fakeStream([{}]),
    tiles: {
      "bob:d1": remote("bob", "d1", fakeStream(), fakeStream([{}], 1)),
      "carol:d1": remote("carol"),
    },
  });
  const tiles = railTiles(snap, roster, "me", "d1");
  assert.deepEqual(
    tiles.map((t) => t.key),
    ["me:d1", "bob:d1", "carol:d1", "me:d1:screen", "bob:d1:screen"],
  );
  const mine = tiles[3];
  assert.equal(mine.isScreen, true);
  assert.equal(mine.isSelf, true);
  assert.equal(mine.hasLiveVideo, true);
  assert.equal(mine.hasAudio, false);
  const bobs = tiles[4];
  assert.equal(bobs.hasLiveVideo, true);
  assert.equal(bobs.hasAudio, true);
});

test("a remote share hidden on this device keeps its tile and loses its video", () => {
  const roster = [part("me"), part("bob")];
  const snap = snapOf({
    tiles: { "bob:d1": remote("bob", "d1", fakeStream(), fakeStream([{}])) },
    screenHidden: { "bob:d1": true },
  });
  const tiles = railTiles(snap, roster, "me", "d1");
  const share = tiles.find((t) => t.key === "bob:d1:screen");
  assert.ok(share);
  assert.equal(share.hasLiveVideo, false);
});

test("camera off gives no live video, for self and for a peer", () => {
  const roster = [part("me"), part("bob")];
  const off = snapOf({
    localStream: fakeStream([{ live: true, enabled: false }]),
    camOn: false,
    tiles: { "bob:d1": remote("bob", "d1", fakeStream([{ live: false }])) },
  });
  let tiles = railTiles(off, roster, "me", "d1");
  assert.equal(tiles[0].hasLiveVideo, false);
  assert.equal(tiles[1].hasLiveVideo, false);

  const on = snapOf({
    localStream: fakeStream([{}]),
    camOn: true,
    tiles: { "bob:d1": remote("bob", "d1", fakeStream([{}])) },
  });
  tiles = railTiles(on, roster, "me", "d1");
  assert.equal(tiles[0].hasLiveVideo, true);
  assert.equal(tiles[1].hasLiveVideo, true);
  // camOn is the switch for self: a live track with the camera off stays dark.
  tiles = railTiles({ ...on, camOn: false }, roster, "me", "d1");
  assert.equal(tiles[0].hasLiveVideo, false);
});
