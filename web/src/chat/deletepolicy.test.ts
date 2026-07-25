import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteModeFor, canDeleteMessage } from "./deletepolicy";

const ME = "user-me";
const PEER = "user-peer";

const dm = { isDM: true, governanceMode: "dictator", createdBy: PEER };
const dmIOpened = { isDM: true, governanceMode: "dictator", createdBy: ME };
const group = { isDM: false, governanceMode: "dictator", createdBy: ME };
const groupNotMine = { isDM: false, governanceMode: "dictator", createdBy: PEER };
const democratic = { isDM: false, governanceMode: "democratic", createdBy: PEER };

test("deleteModeFor: DM is always own-only, whoever opened it", () => {
  assert.equal(deleteModeFor(dm), "own");
  assert.equal(deleteModeFor(dmIOpened), "own");
});

test("deleteModeFor: group follows governance mode", () => {
  assert.equal(deleteModeFor(group), "unilateral");
  assert.equal(deleteModeFor(democratic), "proposal");
  assert.equal(deleteModeFor(undefined), "unilateral");
});

test("DM: only your own messages, never the peer's", () => {
  assert.equal(canDeleteMessage(dm, ME, ME), true);
  assert.equal(canDeleteMessage(dm, PEER, ME), false);
  // Opening the DM buys no authority over the other member's messages.
  assert.equal(canDeleteMessage(dmIOpened, PEER, ME), false);
});

test("group dictator: owner only, but over anyone's message", () => {
  assert.equal(canDeleteMessage(group, PEER, ME), true);
  assert.equal(canDeleteMessage(group, ME, ME), true);
  assert.equal(canDeleteMessage(groupNotMine, ME, ME), false);
});

test("group democratic: any member may propose, owner or not", () => {
  assert.equal(canDeleteMessage(democratic, PEER, ME), true);
  assert.equal(canDeleteMessage(democratic, ME, ME), true);
});

test("no session, no delete", () => {
  assert.equal(canDeleteMessage(group, ME, null), false);
  assert.equal(canDeleteMessage(undefined, ME, ME), false);
});
