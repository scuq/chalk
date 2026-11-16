import { test } from "node:test";
import assert from "node:assert/strict";

import { passwordLoginOutcome } from "./login-v2-api";

// 139-1: the password step of login has two answers. A normal server sends a
// totp_pending token. A review instance sends the session.

test("a totp_pending token means the TOTP step comes next", () => {
  assert.deepEqual(
    passwordLoginOutcome({ totp_pending: "tok", expires_at: "2026-11-16T10:00:00Z" }),
    { kind: "totp", totpPending: "tok" },
  );
});

test("a session answer from a review instance skips the TOTP step", () => {
  assert.deepEqual(
    passwordLoginOutcome({
      user_id: "u1",
      username: "alice",
      display_name: "Alice",
      role: "user",
      session_expires_at: "2026-12-16T10:00:00Z",
    }),
    {
      kind: "session",
      result: {
        userID: "u1",
        username: "alice",
        displayName: "Alice",
        role: "user",
        sessionExpiresAt: "2026-12-16T10:00:00Z",
      },
    },
  );
});

test("a token wins over a user_id, so a normal server never skips the TOTP step", () => {
  const out = passwordLoginOutcome({ totp_pending: "tok", user_id: "u1" });
  assert.equal(out.kind, "totp");
});

test("an answer with neither field throws", () => {
  assert.throws(() => passwordLoginOutcome({}));
  assert.throws(() => passwordLoginOutcome({ totp_pending: "" }));
});
