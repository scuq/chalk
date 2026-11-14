import { test } from "node:test";
import assert from "node:assert/strict";
import { resumeAction } from "./resume";

test("a resume probes an open socket, skips a backoff wait, and leaves a dial or a stop alone", () => {
  assert.equal(resumeAction({ state: "open", stopped: false, reconnectPending: false }), "probe");
  assert.equal(resumeAction({ state: "closed", stopped: false, reconnectPending: true }), "reconnect-now");
  assert.equal(resumeAction({ state: "connecting", stopped: false, reconnectPending: false }), "wait");
  assert.equal(resumeAction({ state: "closed", stopped: true, reconnectPending: true }), "none");
  assert.equal(resumeAction({ state: "error", stopped: false, reconnectPending: false }), "none");
});
