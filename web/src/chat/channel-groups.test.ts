import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_GROUP,
  canonicalizeGroup,
  effectiveGroup,
  groupRoster,
  knownGroups,
  loadCollapsedGroups,
  splitVoice,
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

test("groupRoster puts the default group first, rest alphabetical", () => {
  const got = groupRoster([
    channel({ id: "a", groupName: "zeta" }),
    channel({ id: "b", groupName: "Alpha" }),
    channel({ id: "c", groupName: DEFAULT_GROUP }),
  ]);
  assert.deepEqual(
    got.map((g) => g.name),
    [DEFAULT_GROUP, "Alpha", "zeta"]
  );
});

test("groupRoster merges case-insensitively and keeps first-seen casing", () => {
  const got = groupRoster([
    channel({ id: "a", groupName: "Dev" }),
    channel({ id: "b", groupName: "dev" }),
  ]);
  assert.equal(got.length, 1);
  assert.equal(got[0].name, "Dev");
  assert.equal(got[0].key, "dev");
  assert.deepEqual(
    got[0].channels.map((c) => c.id),
    ["a", "b"]
  );
});

test("groupRoster keeps input order within a group", () => {
  const got = groupRoster([
    channel({ id: "newest", groupName: "Ops" }),
    channel({ id: "older", groupName: "Ops" }),
  ]);
  assert.deepEqual(
    got[0].channels.map((c) => c.id),
    ["newest", "older"]
  );
});

test("groupRoster files blank groups under the default", () => {
  const got = groupRoster([channel({ id: "a", groupName: "  " })]);
  assert.equal(got.length, 1);
  assert.equal(got[0].name, DEFAULT_GROUP);
});

test("groupRoster of nothing is nothing", () => {
  assert.deepEqual(groupRoster([]), []);
});

test("effectiveGroup prefers the override, falls back to the suggestion", () => {
  const ch = channel({ id: "a", groupName: "Dev" });
  assert.equal(effectiveGroup(ch), "Dev");
  assert.equal(effectiveGroup(ch, { a: "Ops" }), "Ops");
  assert.equal(effectiveGroup(ch, { other: "Ops" }), "Dev");
  assert.equal(effectiveGroup(channel({ id: "b", groupName: "" }), {}), DEFAULT_GROUP);
});

test("groupRoster applies overrides when partitioning", () => {
  const got = groupRoster(
    [
      channel({ id: "a", groupName: "Dev" }),
      channel({ id: "b", groupName: "Dev" }),
    ],
    { b: "Ops" }
  );
  assert.deepEqual(
    got.map((g) => [g.name, g.channels.map((c) => c.id)]),
    [
      ["Dev", ["a"]],
      ["Ops", ["b"]],
    ]
  );
});

test("knownGroups sees the roster through overrides", () => {
  const got = knownGroups(
    [channel({ id: "a", groupName: "Dev" })],
    { a: "Ops" }
  );
  assert.deepEqual(got, [DEFAULT_GROUP, "Ops"]);
});

test("splitVoice partitions by kind, keeps order within each half", () => {
  const got = splitVoice([
    channel({ id: "t1" }),
    channel({ id: "v1", channelType: "voice" }),
    channel({ id: "t2" }),
    channel({ id: "v2", channelType: "voice" }),
  ]);
  assert.deepEqual(got.voice.map((c) => c.id), ["v1", "v2"]);
  assert.deepEqual(got.text.map((c) => c.id), ["t1", "t2"]);
});

test("splitVoice files the blank default kind under text", () => {
  const got = splitVoice([channel({ id: "a", channelType: "" })]);
  assert.deepEqual(got.voice, []);
  assert.deepEqual(got.text.map((c) => c.id), ["a"]);
});

test("splitVoice of nothing is two empty halves", () => {
  assert.deepEqual(splitVoice([]), { voice: [], text: [] });
});

test("loadCollapsedGroups without a window is an empty set", () => {
  // node has no localStorage; the helper must fail closed (all expanded).
  assert.deepEqual(loadCollapsedGroups(), new Set());
});
