// 82-8: the roster must not grow silently.
//
// Membership is asserted by the server -- nothing signs it until phase 83 --
// and any key holder auto-reshares the channel key to whoever appears in the
// roster. So "a member appeared" is the observable half of "the server could
// have just been handed the key". These assert that the reducer records that
// event and that dismissing it is per-channel.

import { test } from "node:test";
import assert from "node:assert/strict";
import { reducer } from "./reducer.ts";
import { initialState, type AppState, type ChannelSummary } from "./types.ts";

const CH = "chan-1";
const OTHER = "chan-2";

function channel(id: string, memberIDs: string[]): ChannelSummary {
  return {
    id,
    name: id,
    isDM: false,
    createdBy: "user-me",
    createdAt: new Date(0),
    memberIDs,
    members: memberIDs.map((u) => ({ userID: u, handle: u })),
    currentKeyVersion: 1,
    rotationPending: false,
    governanceMode: "dictator",
    channelType: "text",
    groupName: "General",
    lastSeq: 0,
    lastReadSeq: 0,
  };
}

function baseState(): AppState {
  return {
    ...initialState,
    parked: false,
    activeChannelID: CH,
    user: { id: "user-me", device: "dev-me", handle: "me" },
    channels: { [CH]: channel(CH, ["user-me"]), [OTHER]: channel(OTHER, ["user-me"]) },
  };
}

const added = (channelID: string, userID: string, handle: string) =>
  ({ kind: "channel_member_added", channelID, userID, handle }) as const;

test("a member joining is recorded so the channel can say so", () => {
  const s = reducer(baseState(), added(CH, "user-alice", "alice"));
  assert.deepEqual(s.recentJoins[CH], [{ userID: "user-alice", handle: "alice" }]);
  // and the roster itself still updates
  assert.ok(s.channels[CH].memberIDs.includes("user-alice"));
});

test("several joins accumulate, each named", () => {
  let s = reducer(baseState(), added(CH, "user-alice", "alice"));
  s = reducer(s, added(CH, "user-bob", "bob"));
  assert.deepEqual(s.recentJoins[CH]?.map((j) => j.handle), ["alice", "bob"]);
});

// The idempotency guard sits before the record, so a duplicate push must not
// announce a second join for the same person.
test("a repeated add for an existing member announces nothing", () => {
  let s = reducer(baseState(), added(CH, "user-alice", "alice"));
  s = reducer(s, added(CH, "user-alice", "alice"));
  assert.equal(s.recentJoins[CH]?.length, 1);
});

test("dismissing clears one channel's notice and leaves the others", () => {
  let s = reducer(baseState(), added(CH, "user-alice", "alice"));
  s = reducer(s, added(OTHER, "user-bob", "bob"));
  s = reducer(s, { kind: "joins_dismissed", channelID: CH });
  assert.equal(s.recentJoins[CH], undefined);
  assert.deepEqual(s.recentJoins[OTHER]?.map((j) => j.handle), ["bob"]);
});

test("dismissing a channel with no notice is a no-op", () => {
  const s = baseState();
  assert.equal(reducer(s, { kind: "joins_dismissed", channelID: CH }), s);
});

// Dismissal must not be permanent: if the same server adds ANOTHER principal
// later, that is a fresh event and has to be said again.
test("a join after a dismissal is announced again", () => {
  let s = reducer(baseState(), added(CH, "user-alice", "alice"));
  s = reducer(s, { kind: "joins_dismissed", channelID: CH });
  s = reducer(s, added(CH, "user-mallory", "mallory"));
  assert.deepEqual(s.recentJoins[CH], [{ userID: "user-mallory", handle: "mallory" }]);
});
