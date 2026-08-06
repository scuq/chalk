import { test } from "node:test";
import assert from "node:assert/strict";

import { SignupApiError, parseAuthResponse } from "./signup-v2-api";

// 81-7: this decoder is the one place the auth surface turns a 4xx into a code
// a screen can branch on. Four copies of it used to read a FLAT {code, message}
// while the server has always written {"error":{...}}, so every failure across
// login, signup, migration, the security panel and the recovery reset arrived
// as "http_error" / "HTTP 401" and every branch downstream was dead. These
// tests exist so that cannot happen again quietly.

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

test("parseAuthResponse reads the server's nested error shape", async () => {
  const resp = jsonResponse(401, {
    error: { code: "recovery_failed", message: "that username and phrase don't match" },
  });
  await assert.rejects(
    () => parseAuthResponse(resp),
    (e: unknown) => {
      assert.ok(e instanceof SignupApiError);
      assert.equal(e.status, 401);
      assert.equal(e.code, "recovery_failed");
      assert.equal(e.message, "that username and phrase don't match");
      return true;
    },
  );
});

test("parseAuthResponse falls back when the body is not JSON", async () => {
  const resp = {
    ok: false,
    status: 404,
    json: async () => {
      throw new Error("not json");
    },
  } as unknown as Response;
  await assert.rejects(
    () => parseAuthResponse(resp),
    (e: unknown) => {
      assert.ok(e instanceof SignupApiError);
      assert.equal(e.code, "http_error");
      assert.equal(e.message, "HTTP 404");
      return true;
    },
  );
});

test("parseAuthResponse falls back when the error object is missing", async () => {
  // A flat {code} body is exactly what the old decoder expected. Nothing
  // writes one, so reading it must NOT be how a code gets through.
  await assert.rejects(
    () => parseAuthResponse(jsonResponse(400, { code: "bad_username" })),
    (e: unknown) => (e as SignupApiError).code === "http_error",
  );
});

test("parseAuthResponse returns the body on success", async () => {
  const got = await parseAuthResponse<{ stored: boolean }>(jsonResponse(200, { stored: true }));
  assert.deepEqual(got, { stored: true });
});
