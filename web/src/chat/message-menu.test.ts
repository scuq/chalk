import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QUICK_REACTIONS,
  buildMessageMenu,
  showsQuickReactions,
  clampMenuPosition,
  type MessageMenuOpts,
} from "./message-menu.ts";

function opts(over: Partial<MessageMenuOpts> = {}): MessageMenuOpts {
  return {
    deleted: false,
    canReact: true,
    canReply: true,
    canQuote: true,
    hasText: true,
    canEdit: true,
    canDelete: true,
    ...over,
  };
}

const kinds = (o: Partial<MessageMenuOpts>) => buildMessageMenu(opts(o)).map((i) => i.kind);

test("full menu is in display order", () => {
  assert.deepEqual(kinds({}), ["react", "reply", "quote", "copy", "edit", "delete"]);
});

test("a deleted message offers nothing at all", () => {
  // The server scrubs the body, so every action would be a no-op.
  assert.deepEqual(buildMessageMenu(opts({ deleted: true })), []);
  assert.deepEqual(
    buildMessageMenu(opts({ deleted: true, canReact: false, canReply: false })),
    [],
  );
});

test("the thread panel drops reply and keeps the rest", () => {
  assert.deepEqual(kinds({ canReply: false }), ["react", "quote", "copy", "edit", "delete"]);
});

test("someone else's message offers neither edit nor delete", () => {
  assert.deepEqual(kinds({ canEdit: false, canDelete: false }), [
    "react",
    "reply",
    "quote",
    "copy",
  ]);
});

test("a body-less row (attachment or gif only) offers no copy", () => {
  assert.deepEqual(kinds({ hasText: false }), ["react", "reply", "quote", "edit", "delete"]);
});

test("a row with nothing said on it offers no quote", () => {
  // 99-3: a gif has a body but no speech, so copy (which takes the URL) is
  // still worth offering where quote is not.
  assert.deepEqual(kinds({ canQuote: false }), ["react", "reply", "copy", "edit", "delete"]);
});

test("the delete label passes through, defaulting to 'delete'", () => {
  const dem = buildMessageMenu(opts({ deleteLabel: "propose deletion" }));
  assert.deepEqual(dem.at(-1), { kind: "delete", label: "propose deletion" });
  assert.deepEqual(buildMessageMenu(opts()).at(-1), { kind: "delete", label: "delete" });
});

test("a caller with no callbacks wired gets an empty menu", () => {
  assert.deepEqual(
    buildMessageMenu(
      opts({
        canReact: false,
        canReply: false,
        canQuote: false,
        hasText: false,
        canEdit: false,
        canDelete: false,
      }),
    ),
    [],
  );
});

test("quick reactions ride along with the react item", () => {
  assert.equal(showsQuickReactions(buildMessageMenu(opts())), true);
  assert.equal(showsQuickReactions(buildMessageMenu(opts({ canReact: false }))), false);
  assert.ok(QUICK_REACTIONS.length > 0);
  assert.equal(new Set(QUICK_REACTIONS).size, QUICK_REACTIONS.length, "no duplicates");
});

const VP = { w: 1000, h: 800 };
const SZ = { w: 200, h: 240 };

test("a menu that fits opens exactly at the pointer", () => {
  assert.deepEqual(clampMenuPosition({ x: 300, y: 300 }, SZ, VP), { left: 300, top: 300 });
});

test("near the bottom it flips above the pointer", () => {
  // 700 + 240 would overflow 800, so it opens upward from the anchor.
  assert.deepEqual(clampMenuPosition({ x: 300, y: 700 }, SZ, VP), { left: 300, top: 460 });
});

test("near the right edge it slides back inside", () => {
  assert.deepEqual(clampMenuPosition({ x: 950, y: 100 }, SZ, VP), { left: 792, top: 100 });
});

test("a corner anchor is folded on both axes", () => {
  assert.deepEqual(clampMenuPosition({ x: 990, y: 790 }, SZ, VP), { left: 792, top: 550 });
});

test("a menu larger than the viewport still starts on screen", () => {
  const huge = { w: 2000, h: 2000 };
  assert.deepEqual(clampMenuPosition({ x: 500, y: 500 }, huge, VP), { left: 8, top: 8 });
});

test("a pointer at the origin never yields a negative offset", () => {
  const { left, top } = clampMenuPosition({ x: 0, y: 0 }, SZ, VP);
  assert.ok(left >= 8 && top >= 8);
});
