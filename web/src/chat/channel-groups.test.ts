import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_GROUP,
  canonicalizeGroup,
  knownGroups,
} from "./channel-groups";
import type { ChannelSummary } from "../state/types";

function channel(over: Partial<ChannelSummary> = {}): ChannelSummary {
  return {
    id: "ch-1",
    name: "chan",
    isDM: false,
    createdBy: "u-1",
    createdAt: new Date(0),
    memberIDs: [],
    members: [],
    currentKeyVersion: 1,
    rotationPending: false,
    governanceMode: "dictator",
    channelType: "text",
    groupName: DEFAULT_GROUP,
    lastSeq: 0,
    lastReadSeq: 0,
    ...over,
  };
}

test("knownGroups always contains the default, first", () => {
  assert.deepEqual(knownGroups([]), [DEFAULT_GROUP]);
  const got = knownGroups([channel({ groupName: "Alpha" })]);
  assert.deepEqual(got, [DEFAULT_GROUP, "Alpha"]);
});

test("knownGroups dedupes case-insensitively, keeps first-seen casing", () => {
  const got = knownGroups([
    channel({ id: "a", groupName: "Dev" }),
    channel({ id: "b", groupName: "dev" }),
    channel({ id: "c", groupName: "Ops" }),
  ]);
  assert.deepEqual(got, [DEFAULT_GROUP, "Dev", "Ops"]);
});

test("knownGroups skips DMs and blank groups", () => {
  const got = knownGroups([
    channel({ id: "a", groupName: "Secret", isDM: true }),
    channel({ id: "b", groupName: "   " }),
  ]);
  assert.deepEqual(got, [DEFAULT_GROUP]);
});

test("knownGroups sorts alphabetically after the default", () => {
  const got = knownGroups([
    channel({ id: "a", groupName: "zeta" }),
    channel({ id: "b", groupName: "Alpha" }),
  ]);
  assert.deepEqual(got, [DEFAULT_GROUP, "Alpha", "zeta"]);
});

test("canonicalizeGroup: empty and whitespace mean the default", () => {
  assert.equal(canonicalizeGroup("", []), DEFAULT_GROUP);
  assert.equal(canonicalizeGroup("   ", []), DEFAULT_GROUP);
});

test("canonicalizeGroup adopts existing casing on a case-insensitive hit", () => {
  const known = [DEFAULT_GROUP, "Dev-Backend"];
  assert.equal(canonicalizeGroup("dev-backend", known), "Dev-Backend");
  assert.equal(canonicalizeGroup("general", known), DEFAULT_GROUP);
});

test("canonicalizeGroup passes a genuinely new name through trimmed", () => {
  assert.equal(canonicalizeGroup("  Gaming  ", [DEFAULT_GROUP]), "Gaming");
});
