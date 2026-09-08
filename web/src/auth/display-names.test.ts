// 115-6: one directory fetch fills both maps, and a reset empties both.
//
// The hooks need a render and are not tested here; the cache they read is.

import { test } from "node:test";
import assert from "node:assert/strict";

import { avatarFrameFor, refreshDirectory, resetDisplayNames } from "./display-names";

function stubDirectory(users: unknown[]) {
  const prev = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ users }),
    }) as unknown as Response) as typeof fetch;
  return () => {
    globalThis.fetch = prev;
  };
}

test("a frame is unknown until the directory arrives, then read off it", async () => {
  resetDisplayNames();
  const restore = stubDirectory([
    { user_id: "u1", username: "alice", display_name: "Alice", avatar_frame: "ember" },
    { user_id: "u2", username: "bob", display_name: "" },
    { user_id: "", username: "ghost", display_name: "", avatar_frame: "pulse" },
  ]);
  try {
    assert.equal(avatarFrameFor("u1"), "");
    await refreshDirectory();
    assert.equal(avatarFrameFor("u1"), "ember");
    // A pre-115 server sends no field: none, not undefined.
    assert.equal(avatarFrameFor("u2"), "");
    assert.equal(avatarFrameFor("nobody"), "");
    assert.equal(avatarFrameFor(undefined), "");
    resetDisplayNames();
    assert.equal(avatarFrameFor("u1"), "", "reset forgets the previous account's directory");
  } finally {
    restore();
    resetDisplayNames();
  }
});

test("a failed fetch leaves the cache empty rather than throwing", async () => {
  resetDisplayNames();
  const prev = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  const warn = console.warn;
  console.warn = () => {};
  try {
    await refreshDirectory();
    assert.equal(avatarFrameFor("u1"), "");
  } finally {
    console.warn = warn;
    globalThis.fetch = prev;
    resetDisplayNames();
  }
});
