import { test } from "node:test";
import assert from "node:assert/strict";

import { buildStepUp, deriveStepUpProof } from "./stepup";
import { deriveAuth, toB64 } from "../crypto/authkdf";

// 81-2: the step-up proof is what stands between a stolen session and a
// permanent account takeover, so the two things worth pinning are that the
// proof really is the login-path derivation (a different one would never
// verify) and that a blank code is OMITTED rather than sent as "" -- the
// server reads an empty code as "no second factor offered" and must be given
// the chance to say totp_required.

// Deliberately weak KDF params: the derivation is the same code path either
// way, and the real floor would make this test take seconds.
const FAST_PARAMS = {
  kdf_alg: 1,
  kdf_mem_kib: 512,
  kdf_iters: 1,
  kdf_par: 1,
  salt_b64: toB64(new Uint8Array(16).fill(9)),
};

function withFetch(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
  run: () => Promise<void>,
): Promise<void> {
  const orig = globalThis.fetch;
  globalThis.fetch = impl as unknown as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = orig;
  });
}

function preloginStub(): (url: string) => Promise<Response> {
  return async (url: string) => {
    assert.equal(url, "/api/auth/login/prelogin");
    return { ok: true, status: 200, json: async () => FAST_PARAMS } as unknown as Response;
  };
}

test("deriveStepUpProof reproduces the login-path authProof", async () => {
  await withFetch(preloginStub(), async () => {
    const got = await deriveStepUpProof("alice", "correct horse battery staple");
    const { authProof } = await deriveAuth("correct horse battery staple", {
      alg: FAST_PARAMS.kdf_alg,
      memKiB: FAST_PARAMS.kdf_mem_kib,
      iters: FAST_PARAMS.kdf_iters,
      par: FAST_PARAMS.kdf_par,
      salt: new Uint8Array(16).fill(9),
    });
    assert.equal(got, toB64(authProof));
  });
});

test("buildStepUp omits a blank code and trims a real one", async () => {
  await withFetch(preloginStub(), async () => {
    const blank = await buildStepUp("alice", "pw", "   ");
    assert.equal("totp_code" in blank, false);
    assert.ok(blank.auth_proof_b64.length > 0);

    const coded = await buildStepUp("alice", "pw", "  123456 ");
    assert.equal(coded.totp_code, "123456");
  });
});
