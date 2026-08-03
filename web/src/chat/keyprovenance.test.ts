// Tests for chat/keyprovenance.ts (82-8). These strings are security claims
// shown in the members panel, so the properties worth asserting are that the
// unproven origins are FLAGGED as such, and that a signer is only named when
// there is a real name to give.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { describeKeyProvenance } from "./keyprovenance";

const handles: Record<string, string> = { "user-alice": "alice" };
const handleFor = (id: string) => handles[id] ?? null;

test("no key held renders nothing at all", () => {
  assert.equal(describeKeyProvenance(null, handleFor), null);
});

test("only the unproven origins are flagged weak", () => {
  const weak = [
    describeKeyProvenance({ kind: "unsigned" }, handleFor),
    describeKeyProvenance({ kind: "legacy_cache" }, handleFor),
  ];
  for (const l of weak) assert.equal(l!.weak, true);

  const strong = [
    describeKeyProvenance({ kind: "self_minted" }, handleFor),
    describeKeyProvenance({ kind: "guest_link" }, handleFor),
    describeKeyProvenance({ kind: "signed", signerUserID: "user-alice", trust: "pinned" }, handleFor),
    describeKeyProvenance({ kind: "signed", signerUserID: "user-alice", trust: "manually_verified" }, handleFor),
    describeKeyProvenance({ kind: "signed", signerUserID: "user-alice", trust: "self" }, handleFor),
  ];
  for (const l of strong) assert.equal(l!.weak, false);
});

test("a signer is named when known, and never shown as a raw id", () => {
  const known = describeKeyProvenance(
    { kind: "signed", signerUserID: "user-alice", trust: "pinned" },
    handleFor,
  );
  assert.equal(known!.text, "signed by alice");

  const unknown = describeKeyProvenance(
    { kind: "signed", signerUserID: "user-nobody", trust: "pinned" },
    handleFor,
  );
  assert.equal(unknown!.text, "signed by a member");
  assert.equal(unknown!.text.includes("user-nobody"), false);
});

test("out-of-band verification is distinguished from mere recognition", () => {
  const pinned = describeKeyProvenance(
    { kind: "signed", signerUserID: "user-alice", trust: "pinned" },
    handleFor,
  );
  const verified = describeKeyProvenance(
    { kind: "signed", signerUserID: "user-alice", trust: "manually_verified" },
    handleFor,
  );
  assert.notEqual(pinned!.text, verified!.text);
  assert.match(verified!.text, /verified/);
  // The weaker one must not imply a check that never happened.
  assert.equal(/verified/.test(pinned!.text), false);
});

test("every provenance kind produces a line (no silent gap in the switch)", () => {
  const all = [
    { kind: "self_minted" },
    { kind: "signed", signerUserID: "user-alice", trust: "pinned" },
    { kind: "unsigned" },
    { kind: "guest_link" },
    { kind: "legacy_cache" },
  ] as const;
  for (const p of all) {
    const line = describeKeyProvenance(p, handleFor);
    assert.ok(line, `${p.kind} produced no line`);
    assert.ok(line!.text.length > 0);
    assert.ok(line!.title.length > 0);
  }
});
