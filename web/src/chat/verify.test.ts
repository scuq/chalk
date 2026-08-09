// Tests for chat/verify.ts -- 83-2 verdict-into-row merge and label copy.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { applyOpened, sigValid, verifyLabel, verifyTitle, hexToBytes, bytesToHex } from "./verify";
import type { Message } from "../state/types";
import type { OpenedMessage } from "../crypto/channel-crypto";
import { OBJ_MESSAGE, OBJ_EDIT, type MessageEnvelope } from "../crypto/envelope";

const ALICE = "aaaaaaaa-0000-0000-0000-000000000001";
const EVE = "eeeeeeee-0000-0000-0000-000000000001";
const SCOPE = "dddddddd-0000-0000-0000-000000000001";
const CMID = "cccccccc-0000-0000-0000-000000000001";

function row(): Message {
  return {
    id: "m1",
    channelID: "ch",
    seq: 1,
    sender: "dev",
    senderUserID: EVE, // the server's (possibly lying) claim
    ts: new Date(0),
    body: "ciphertext",
  };
}

function env(): MessageEnvelope {
  return {
    objType: OBJ_MESSAGE,
    channelID: "ch",
    keyVersion: 1,
    senderUserID: ALICE,
    senderEd25519Fp: new Uint8Array(32).fill(1),
    writerScope: SCOPE,
    clientMsgID: CMID,
    senderTs: 5,
    wseq: 1,
    reply: null,
    bodyText: "hello",
    attachments: [],
  };
}

test("applyOpened: signature-valid verdicts adopt the signed sender (inner wins)", () => {
  for (const verify of ["verified", "verified-former-identity", "mismatch"] as const) {
    const opened: OpenedMessage = { text: "hello", verify, env: env(), objectHashHex: "ab" };
    const m = applyOpened(row(), opened);
    assert.equal(m.senderUserID, ALICE, verify);
    assert.equal(m.body, "hello");
    assert.equal(m.verify, verify);
    assert.equal(m.sigActor, ALICE);
    assert.equal(m.sigScope, SCOPE);
    assert.equal(m.sigClientMsgID, CMID);
    assert.equal(m.sigObjectHash, "ab");
  }
});

test("applyOpened: forged/unpinned keep the server frame's sender claim", () => {
  for (const verify of ["forged", "unpinned"] as const) {
    const opened: OpenedMessage = { text: "hello", verify, env: env(), objectHashHex: "ab" };
    const m = applyOpened(row(), opened);
    assert.equal(m.senderUserID, EVE, verify); // rendered under the warning label
    assert.equal(m.verify, verify);
  }
});

test("83-3: applyOpened on an edit envelope anchors the ORIGINAL's triple, not the edit's", () => {
  const editEnv = {
    objType: OBJ_EDIT,
    channelID: "ch",
    keyVersion: 1,
    senderUserID: ALICE,
    senderEd25519Fp: new Uint8Array(32).fill(1),
    writerScope: "11111111-0000-0000-0000-000000000011", // the EDIT's own scope
    clientMsgID: "22222222-0000-0000-0000-000000000022", // fresh per edit
    targetSender: ALICE,
    targetScope: SCOPE, // the original's triple
    targetClientMsgID: CMID,
    prevRevHash: new Uint8Array(32).fill(4),
    senderTs: 9,
    bodyText: "edited",
    attachments: [],
  } as const;
  const m = applyOpened(row(), {
    text: "edited",
    verify: "verified",
    env: editEnv as unknown as import("../crypto/envelope").EditEnvelope,
    objectHashHex: "1234",
  });
  assert.equal(m.sigActor, ALICE);
  assert.equal(m.sigScope, SCOPE); // original's, not the edit's writer scope
  assert.equal(m.sigClientMsgID, CMID);
  assert.equal(m.sigObjectHash, undefined); // original's hash unknown until the chain verifies
  assert.equal(m.editHeadHash, "1234"); // the edit envelope's own hash is the chain head
  assert.equal(m.editPrevRevHash, "04".repeat(32));
  assert.equal(m.editAncestry, "unknown"); // honest default until verified
  assert.equal(m.senderUserID, ALICE); // inner wins
});

test("applyOpened: unsigned legacy body carries no sig fields", () => {
  const m = applyOpened(row(), { text: "old text", verify: "unsigned" });
  assert.equal(m.body, "old text");
  assert.equal(m.verify, "unsigned");
  assert.equal(m.sigActor, undefined);
});

test("sigValid matches exactly the three signature-valid verdicts", () => {
  assert.equal(sigValid("verified"), true);
  assert.equal(sigValid("verified-former-identity"), true);
  assert.equal(sigValid("mismatch"), true);
  assert.equal(sigValid("forged"), false);
  assert.equal(sigValid("unpinned"), false);
  assert.equal(sigValid("unsigned"), false);
  assert.equal(sigValid(undefined), false);
});

test("labels: quiet for verified/none, present for every degraded state", () => {
  assert.equal(verifyLabel("verified"), "");
  assert.equal(verifyLabel(undefined), "");
  for (const v of ["unsigned", "unpinned", "verified-former-identity", "mismatch", "forged"] as const) {
    assert.notEqual(verifyLabel(v), "", v);
    assert.notEqual(verifyTitle(v), "", v);
  }
});

test("hex round trip", () => {
  const b = new Uint8Array([0, 1, 0xab, 0xff]);
  assert.equal(bytesToHex(b), "0001abff");
  assert.deepEqual([...hexToBytes("0001abff")], [...b]);
});
