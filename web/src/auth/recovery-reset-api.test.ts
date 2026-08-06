import { test } from "node:test";
import assert from "node:assert/strict";

import { resetErrorMessage } from "./recovery-reset-api";
import { SignupApiError } from "./signup-v2-api";

// 81-7: the server now answers every pre-verify failure with one code, so the
// screen's job is to say something useful without knowing which of them
// happened. What must not regress is that the merged sentence still points a
// genuinely locked-out user somewhere.

const err = (code: string, message = "raw server text") =>
  new SignupApiError(401, code, message);

test("the merged failure names the spent-phrase case and the admin", () => {
  const msg = resetErrorMessage(err("recovery_failed"));
  assert.match(msg, /username and recovery phrase/i);
  assert.match(msg, /already/i, "must name a spent phrase as a possibility");
  assert.match(msg, /admin/i, "must point at someone who can help");
});

test("a bad phrase shape is about what was typed, not the account", () => {
  const msg = resetErrorMessage(err("bad_phrase", "recovery: expected 24 words"));
  assert.match(msg, /24-word recovery phrase/i);
  assert.doesNotMatch(msg, /account/i);
});

test("the post-verify codes still speak plainly", () => {
  assert.match(resetErrorMessage(err("code_used")), /already been used/i);
  assert.match(resetErrorMessage(err("user_blocked")), /blocked/i);
  assert.match(resetErrorMessage(err("user_deleted")), /deleted/i);
  assert.match(resetErrorMessage(err("totp_required")), /two-factor/i);
});

test("rate limiting has a sentence of its own", () => {
  assert.match(resetErrorMessage(err("rate_limited")), /wait a minute/i);
});

test("the retired codes no longer have handlers", () => {
  // unknown_user and invalid_words were merged into recovery_failed. If the
  // server ever sends one again, the raw message shows rather than a stale
  // sentence claiming to know which failure it was.
  assert.equal(resetErrorMessage(err("unknown_user", "raw")), "raw");
  assert.equal(resetErrorMessage(err("invalid_words", "raw")), "raw");
});

test("an unrecognised code falls through to the server's own message", () => {
  assert.equal(resetErrorMessage(err("something_new", "the server said this")), "the server said this");
});
