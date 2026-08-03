import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isHidden,
  normalizeHidden,
  pruneHidden,
  splitHidden,
  type HiddenChannel,
} from "./channel-hide";

// The rows both callers pass are only ever read for their id here; the
// newest-seq comes in through the callback.
function ch(id: string, lastSeq = 0) {
  return { id, lastSeq };
}
const seqOf = (c: { lastSeq: number }) => c.lastSeq;

test("isHidden: no entry means visible", () => {
  assert.equal(isHidden(undefined, 0), false);
  assert.equal(isHidden(undefined, 99), false);
});

test("isHidden: always ignores traffic", () => {
  const e: HiddenChannel = { mode: "always" };
  assert.equal(isHidden(e, 0), true);
  assert.equal(isHidden(e, 5000), true);
});

test("isHidden: untilNew holds until a message passes the watermark", () => {
  const e: HiddenChannel = { mode: "untilNew", seq: 12 };
  assert.equal(isHidden(e, 12), true);
  assert.equal(isHidden(e, 13), false);
});

test("isHidden: untilNew without a watermark shows on any message", () => {
  const e = { mode: "untilNew" } as HiddenChannel;
  assert.equal(isHidden(e, 0), true);
  assert.equal(isHidden(e, 1), false);
});

test("splitHidden keeps input order in both halves", () => {
  const channels = [ch("a", 3), ch("b", 3), ch("c", 3), ch("d", 9)];
  const { visible, hidden } = splitHidden(
    channels,
    {
      a: { mode: "always" },
      c: { mode: "untilNew", seq: 3 },
      d: { mode: "untilNew", seq: 3 }, // already passed -- back on the roster
    },
    seqOf,
  );
  assert.deepEqual(
    visible.map((c) => c.id),
    ["b", "d"],
  );
  assert.deepEqual(
    hidden.map((c) => c.id),
    ["a", "c"],
  );
});

test("pruneHidden drops left channels and expired watermarks", () => {
  const entries: Record<string, HiddenChannel> = {
    stays: { mode: "always" },
    waiting: { mode: "untilNew", seq: 7 },
    expired: { mode: "untilNew", seq: 7 },
    gone: { mode: "always" },
  };
  const next = pruneHidden(
    entries,
    [ch("stays", 40), ch("waiting", 7), ch("expired", 8)],
    seqOf,
  );
  assert.deepEqual(Object.keys(next).sort(), ["stays", "waiting"]);
  assert.deepEqual(next.waiting, { mode: "untilNew", seq: 7 });
});

test("normalizeHidden keeps sane entries and drops junk", () => {
  const got = normalizeHidden({
    a: { mode: "always" },
    b: { mode: "untilNew", seq: 4 },
    c: { mode: "untilNew" },
    d: { mode: "forever" },
    e: "always",
    f: null,
  });
  assert.deepEqual(got, {
    a: { mode: "always" },
    b: { mode: "untilNew", seq: 4 },
    c: { mode: "untilNew", seq: 0 },
  });
});

test("normalizeHidden survives a non-object blob", () => {
  assert.deepEqual(normalizeHidden(undefined), {});
  assert.deepEqual(normalizeHidden(["a"]), {});
  assert.deepEqual(normalizeHidden("nope"), {});
});
