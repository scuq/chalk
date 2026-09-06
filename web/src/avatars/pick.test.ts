// 112-4: which copy of a picture a channel-less surface should draw.

import test from "node:test";
import assert from "node:assert/strict";
import { pickAvatar } from "./pick";

const AVATARS = {
  "ch-1": { "u-1": "att-1a", "u-2": "att-2a" },
  "ch-2": { "u-1": "att-1b" },
};

test("with no preference, any channel that has one will do", () => {
  const got = pickAvatar(AVATARS, "u-1");
  assert.ok(got);
  assert.ok(["ch-1", "ch-2"].includes(got.channelID));
  // Whichever it picked, the id must be that channel's copy -- the pair has
  // to match or the decrypt is attempted with the wrong channel's key.
  assert.equal(got.attachmentID, AVATARS[got.channelID as "ch-1"]["u-1"]);
});

test("the preferred channel wins when it has one", () => {
  assert.deepEqual(pickAvatar(AVATARS, "u-1", "ch-2"), {
    channelID: "ch-2",
    attachmentID: "att-1b",
  });
});

test("a preference that has no picture falls back rather than giving up", () => {
  const got = pickAvatar(AVATARS, "u-2", "ch-2");
  assert.deepEqual(got, { channelID: "ch-1", attachmentID: "att-2a" });
});

test("someone with no picture anywhere is null, like someone who never set one", () => {
  assert.equal(pickAvatar(AVATARS, "u-9"), null);
  assert.equal(pickAvatar({}, "u-1"), null);
  assert.equal(pickAvatar(AVATARS, ""), null);
});
