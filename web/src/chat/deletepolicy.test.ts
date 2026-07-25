import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteActionFor, deleteLabelFor } from "./deletepolicy";

const ME = "user-me";
const PEER = "user-peer";

const dm = { isDM: true, governanceMode: "dictator", createdBy: PEER };
const dmIOpened = { isDM: true, governanceMode: "dictator", createdBy: ME };
const myGroup = { isDM: false, governanceMode: "dictator", createdBy: ME };
const theirGroup = { isDM: false, governanceMode: "dictator", createdBy: PEER };
const democratic = { isDM: false, governanceMode: "democratic", createdBy: PEER };

test("your own message is yours to delete, everywhere", () => {
  assert.equal(deleteActionFor(dm, ME, ME), "own");
  assert.equal(deleteActionFor(myGroup, ME, ME), "own");
  assert.equal(deleteActionFor(theirGroup, ME, ME), "own");
  // Even in democratic mode: retracting your own words needs no vote.
  assert.equal(deleteActionFor(democratic, ME, ME), "own");
});

test("DM: the peer's message is untouchable, whoever opened the DM", () => {
  assert.equal(deleteActionFor(dm, PEER, ME), "none");
  assert.equal(deleteActionFor(dmIOpened, PEER, ME), "none");
});

test("group dictator: only the owner may delete another member's message", () => {
  assert.equal(deleteActionFor(myGroup, PEER, ME), "unilateral");
  assert.equal(deleteActionFor(theirGroup, PEER, ME), "none");
});

test("group democratic: any member may propose deleting another's message", () => {
  assert.equal(deleteActionFor(democratic, PEER, ME), "proposal");
});

test("no channel or no session, no delete", () => {
  assert.equal(deleteActionFor(undefined, ME, ME), "none");
  assert.equal(deleteActionFor(myGroup, ME, null), "none");
  // A message whose sender was purged is nobody's "own".
  assert.equal(deleteActionFor(dm, undefined, ME), "none");
});

test("only the democratic path is labelled as a proposal", () => {
  assert.equal(deleteLabelFor("proposal"), "propose deletion");
  assert.equal(deleteLabelFor("own"), "delete");
  assert.equal(deleteLabelFor("unilateral"), "delete");
});
