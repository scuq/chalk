// The event classifiers: one subtle rule each, pinned.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  channelEventNotifies,
  friendEventNotifies,
  governanceEventNotifies,
  voiceCallStarted,
} from "./events.ts";

test("a call starts when someone else joins an empty room", () => {
  assert.equal(voiceCallStarted({ joinerUserID: "u1", meID: "me", priorRosterSize: 0 }), true);
});

test("joining an ongoing call is not a new call", () => {
  assert.equal(voiceCallStarted({ joinerUserID: "u1", meID: "me", priorRosterSize: 1 }), false);
});

test("your own join is never news", () => {
  // Including from another of your own devices, and including when it is
  // the join that starts the call.
  assert.equal(voiceCallStarted({ joinerUserID: "me", meID: "me", priorRosterSize: 0 }), false);
});

test("only a received friend request notifies", () => {
  assert.equal(friendEventNotifies("request_received"), true);
  for (const kind of ["accepted", "declined", "removed", "", "bogus"]) {
    assert.equal(friendEventNotifies(kind), false, kind || "(empty)");
  }
});

test("only being added to a channel notifies", () => {
  assert.equal(channelEventNotifies("added"), true);
  for (const kind of ["removed", "member_added", "key_rotated", "rotate_needed", ""]) {
    assert.equal(channelEventNotifies(kind), false, kind || "(empty)");
  }
});

test("proposals notify on open and resolve, never your own", () => {
  const me = "me";
  assert.equal(governanceEventNotifies({ kind: "proposal_opened", createdBy: "u1", meID: me }), true);
  assert.equal(
    governanceEventNotifies({ kind: "proposal_resolved", createdBy: "u1", meID: me }),
    true,
  );
  assert.equal(governanceEventNotifies({ kind: "proposal_opened", createdBy: me, meID: me }), false);
  for (const kind of ["proposal_updated", "mode_changed", ""]) {
    assert.equal(governanceEventNotifies({ kind, createdBy: "u1", meID: me }), false, kind);
  }
});

test("a proposal with no author still notifies", () => {
  // A malformed push shouldn't be silently dropped just because
  // created_by is missing -- only a positive self-match stays quiet.
  assert.equal(
    governanceEventNotifies({ kind: "proposal_opened", createdBy: undefined, meID: "me" }),
    true,
  );
});
