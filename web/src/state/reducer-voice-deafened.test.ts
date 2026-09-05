// 109-1: the deafened flag through the voice-roster reducer cases.
//
// Deafening used to be invisible to everyone but the deafened person. Now it
// rides the same three paths the other media flags do -- the roster ack, the
// joined push, the state push -- and the properties worth pinning are the two
// that would be silently wrong: a joiner must start NOT deafened (the push
// carries no flags, so the default is the whole answer), and a state push
// must be able to clear the flag as well as set it, since un-deafening is a
// state push like any other.

import { test } from "node:test";
import assert from "node:assert/strict";
import { reducer } from "./reducer.ts";
import { initialState, type AppState, type VoiceParticipant } from "./types.ts";

const ROOM = "voice-1";

function participant(over: Partial<VoiceParticipant> = {}): VoiceParticipant {
  return {
    userID: "user-1",
    deviceID: "dev-1",
    muted: false,
    videoOn: false,
    screenOn: false,
    deafened: false,
    ...over,
  };
}

function roomWith(...roster: VoiceParticipant[]): AppState {
  return { ...initialState, voiceRosters: { [ROOM]: roster } };
}

function only(state: AppState): VoiceParticipant {
  const roster = state.voiceRosters[ROOM] ?? [];
  assert.equal(roster.length, 1, "expected exactly one occupant");
  return roster[0];
}

test("a roster ack carries the deafened flag", () => {
  const next = reducer(initialState, {
    kind: "voice_roster_set",
    channelID: ROOM,
    roster: [participant({ muted: true, deafened: true })],
  });
  assert.equal(only(next).deafened, true);
});

test("a joiner is not deafened until they say so", () => {
  // The joined push carries no media flags at all, so this default is the
  // only thing standing between a fresh occupant and somebody else's state.
  const next = reducer(initialState, {
    kind: "voice_participant_joined",
    channelID: ROOM,
    userID: "user-1",
    deviceID: "dev-1",
  });
  assert.equal(only(next).deafened, false);
  assert.equal(only(next).muted, false);
});

test("a state push sets the flag, and clears it again", () => {
  const deafened = reducer(roomWith(participant()), {
    kind: "voice_participant_state",
    channelID: ROOM,
    participant: participant({ muted: true, deafened: true }),
  });
  assert.equal(only(deafened).deafened, true);
  assert.equal(only(deafened).muted, true);

  // Un-deafening restores whatever mute you had before, which for this one is
  // none: both flags have to come back down together.
  const heard = reducer(deafened, {
    kind: "voice_participant_state",
    channelID: ROOM,
    participant: participant({ muted: false, deafened: false }),
  });
  assert.equal(only(heard).deafened, false);
  assert.equal(only(heard).muted, false);
});

test("a state push for an unseen participant upserts with its flags", () => {
  // The reconnect gap: the joined push was missed, so the state push is the
  // first this client hears of them. Dropping it would leave the tile with no
  // occupant to draw a flag from.
  const next = reducer(initialState, {
    kind: "voice_participant_state",
    channelID: ROOM,
    participant: participant({ userID: "user-2", deviceID: "dev-2", muted: true, deafened: true }),
  });
  assert.equal(only(next).userID, "user-2");
  assert.equal(only(next).deafened, true);
});

test("one occupant's deafen does not touch another's", () => {
  const before = roomWith(
    participant({ userID: "user-1", deviceID: "dev-1" }),
    participant({ userID: "user-2", deviceID: "dev-2", videoOn: true }),
  );
  const next = reducer(before, {
    kind: "voice_participant_state",
    channelID: ROOM,
    participant: participant({ userID: "user-1", deviceID: "dev-1", muted: true, deafened: true }),
  });
  const roster = next.voiceRosters[ROOM] ?? [];
  assert.equal(roster.length, 2);
  assert.equal(roster.find((p) => p.userID === "user-1")?.deafened, true);
  assert.equal(roster.find((p) => p.userID === "user-2")?.deafened, false);
  assert.equal(roster.find((p) => p.userID === "user-2")?.videoOn, true);
});
