import { test } from "node:test";
import assert from "node:assert/strict";

import { submitWhen } from "./form";

function fakeEvent() {
  let prevented = false;
  return {
    preventDefault() {
      prevented = true;
    },
    get prevented() {
      return prevented;
    },
  } as unknown as Event & { prevented: boolean };
}

test("submitWhen always cancels the browser's own submit", () => {
  let runs = 0;
  const e = fakeEvent();
  submitWhen(false, () => runs++)(e);
  assert.equal(e.prevented, true);
  assert.equal(runs, 0);
});

test("submitWhen runs the handler only when the guard holds", () => {
  let runs = 0;
  const e = fakeEvent();
  submitWhen(true, () => runs++)(e);
  assert.equal(e.prevented, true);
  assert.equal(runs, 1);
});

test("submitWhen swallows a rejected async handler's promise", async () => {
  const e = fakeEvent();
  let unhandled = false;
  const onUnhandled = () => {
    unhandled = true;
  };
  process.once("unhandledRejection", onUnhandled);
  submitWhen(true, async () => undefined)(e);
  await new Promise((r) => setImmediate(r));
  process.off("unhandledRejection", onUnhandled);
  assert.equal(unhandled, false);
});
