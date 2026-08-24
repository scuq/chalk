// chalk -- phase 83 (MSGSIG), slice 83-1: the signed sealed envelope.
//
// WHY. Message bodies are sealed (AES-256-GCM under the space key) but, pre-83,
// the plaintext inside is bare text signed by nobody: any member -- or anything
// holding a space key -- can author bytes and the server's outer frame is the
// only thing that says WHO spoke (audit finding H-01). Phase 83 makes the
// plaintext a canonical, Ed25519-signed envelope -- sign-then-seal:
//
//   body plaintext = canonical || lp(sig64)
//   sig64          = Ed25519(sender identity key, canonical)
//   object_hash    = SHA-256(canonical || lp(sig64))
//   canonical      = utf8("chalk-msg-sig.v1") || u8(objType) || fields
//
// Nothing about the sealing changes (spacekey.ts is untouched by this module);
// the envelope rides inside the existing ciphertext, so there is no wire,
// schema or migration change, and pre-83 bodies simply parse as "legacy".
//
// FROZEN CONVENTIONS (PHASE-83-MSGSIG.md D.1 -- do not change, add a new
// domain string instead):
//   * lp(x) = u32be(len(x)) || x       (spacekey.ts's lengthPrefixed)
//   * uuid16 -- strict raw 16 bytes    (canonical hyphenated string form
//                                       "xxxxxxxx-xxxx-..." in JS)
//   * h32   -- exactly 32 bytes, no prefix
//   * lists -- u32be(count) || element*
//   * absent optional uuid16/h32 is ALL-ZERO bytes; absent lp is lp("")
//   * trailing bytes are malformed; parsing is strict and total
//   * objType: 0x01 message, 0x02 edit, 0x03 reaction set
//   * caps: body_text <= 65,536 utf-8 bytes; attachments <= 10 per object;
//           emoji <= 64 per set, <= 32 utf-8 bytes each
//
// The encoding is INJECTIVE for the same reason canonicalWrapMessage is: fixed
// domain prefix, fixed-width scalars, and every variable-length field carries
// its own length, so a left-to-right parse recovers field boundaries from the
// byte string alone.
//
// IDENTITY FINGERPRINT (frozen here, used by 83-4's (user_id, ed25519_fp)
// lookup and the chalk-idgen.v1 chain):
//
//   ed25519_fp = SHA-256(raw 32-byte Ed25519 public key)
//
// No domain prefix: the fingerprint is an identifier, not a signed statement;
// every canonical that embeds it is itself domain-prefixed. The sealed
// fingerprint names WHICH identity generation signed (the R12/R13 lesson:
// without it, a legitimate key rotation destroys history verification on
// fresh devices).
//
// WHAT VERIFICATION MEANS. parse/verify here are pure: they say "these bytes
// are a well-formed envelope whose signature verifies under THIS public key".
// Deciding which key that should be -- pin lookup, the idgen chain walk of
// 83-4 -- belongs to the caller, so classifyEnvelope takes a resolver
// callback and never touches storage. Results are the typed, fail-closed set
// from D.1; content is still DISPLAYED on failure, under a warning -- that
// rendering decision is slice 83-2's, this module only ever labels.
//
// Replay identity: every object is keyed by (actor, writer_scope,
// client_msg_id), bound to the first-seen server id; the same triple under a
// different server row is a duplicate, rendered once (dedup store lands in
// 83-2). sender_ts is display-only. Server-minted id/timestamp/ordering stay
// receipt metadata outside the signature.
//
// Encoders THROW on degenerate input (programmer error, mirrors
// wrapSpaceKeySigned); parse/verify/classify never throw on attacker input.

import { bytesEqual, concat, lengthPrefixed, utf8, writeU32BE } from "./spacekey";
import { asBytes } from "./bytes";

// ---- constants -----------------------------------------------------------

const DOMAIN = utf8("chalk-msg-sig.v1"); // 16 bytes, fixed

export const OBJ_MESSAGE = 0x01;
export const OBJ_EDIT = 0x02;
export const OBJ_REACTION_SET = 0x03;

export const MAX_BODY_BYTES = 65536;
export const MAX_ATTACHMENTS = 10;
export const MAX_EMOJI_PER_SET = 64;
export const MAX_EMOJI_BYTES = 32;

const UUID_BYTES = 16;
const H32_BYTES = 32;
const SIG_BYTES = 64;

// ---- envelope field types ------------------------------------------------

/**
 * One attachment binding: ties the signed envelope to the exact ciphertext
 * blobs the message references, so the host cannot substitute an attachment
 * under an already-signed message. byteLen and ciphertextSha256 describe the
 * FULL uploaded ciphertext; encMeta/encPreview hashes are null when the
 * attachment has no encrypted metadata / preview blob (all-zero h32 on the
 * wire).
 */
export interface AttachmentBinding {
  attachmentID: string; // uuid
  attKeyVersion: number; // u32, >= 1
  byteLen: number; // u64be; ciphertext length in bytes
  ciphertextSha256: Uint8Array; // 32 bytes, required
  encMetaSha256: Uint8Array | null; // 32 bytes or null (zeros on the wire)
  encPreviewSha256: Uint8Array | null;
}

/**
 * Reply binding for OBJ_MESSAGE: the parent's replay triple plus its
 * object_hash. parentEnvHash is null when the parent is a pre-83 legacy
 * message (it has no envelope to hash) -- zeros on the wire. A non-reply
 * message has reply = null (all four fields zero on the wire).
 */
export interface ReplyBinding {
  parentSender: string; // uuid
  parentScope: string; // uuid
  parentClientMsgID: string; // uuid
  parentEnvHash: Uint8Array | null; // 32 bytes or null (legacy parent)
}

export interface MessageEnvelope {
  objType: typeof OBJ_MESSAGE;
  channelID: string; // uuid
  keyVersion: number; // u32, >= 1 -- the space-key version this seals under
  senderUserID: string; // uuid
  senderEd25519Fp: Uint8Array; // 32 bytes -- WHICH identity generation signed
  writerScope: string; // uuid
  clientMsgID: string; // uuid
  senderTs: number; // u64be epoch ms; display-only
  wseq: number; // u64be writer sequence
  reply: ReplyBinding | null;
  bodyText: string;
  attachments: AttachmentBinding[];
}

/**
 * An edit. The protocol rule "only the author edits" is structural here:
 * senderUserID must equal targetSender, enforced by both the encoder and the
 * parser (an envelope violating it is malformed, so it can never apply to its
 * target). prevRevHash is the object_hash of the original (first edit) or of
 * the previous edit -- null (zeros) only when the edited original is a pre-83
 * legacy message with no envelope to hash.
 */
export interface EditEnvelope {
  objType: typeof OBJ_EDIT;
  channelID: string;
  keyVersion: number;
  senderUserID: string;
  senderEd25519Fp: Uint8Array;
  writerScope: string;
  clientMsgID: string; // fresh per edit
  targetSender: string; // uuid -- the original's replay triple
  targetScope: string;
  targetClientMsgID: string;
  prevRevHash: Uint8Array | null;
  senderTs: number;
  bodyText: string;
  attachments: AttachmentBinding[];
}

/**
 * A reaction SET: the actor's complete current reaction state for the target,
 * replacing their previous set. A clear is a signed sealed EMPTY set (the
 * pre-83 unencrypted-clear special case is deleted in 83-3). targetEnvHash is
 * null (zeros) when the target is a legacy message; prevSetHash is null
 * (zeros) for the actor's first set on this target.
 */
export interface ReactionSetEnvelope {
  objType: typeof OBJ_REACTION_SET;
  channelID: string;
  keyVersion: number;
  actorUserID: string;
  senderEd25519Fp: Uint8Array;
  writerScope: string;
  clientMsgID: string; // fresh per set
  targetSender: string;
  targetScope: string;
  targetClientMsgID: string;
  targetEnvHash: Uint8Array | null;
  prevSetHash: Uint8Array | null;
  senderTs: number;
  emoji: string[];
}

export type Envelope = MessageEnvelope | EditEnvelope | ReactionSetEnvelope;

/** envelopeActor returns the replay-identity actor: who signed the object. */
export function envelopeActor(env: Envelope): string {
  return env.objType === OBJ_REACTION_SET ? env.actorUserID : env.senderUserID;
}

/**
 * replayIdentity returns the dedup key (actor, writer_scope, client_msg_id)
 * as a string. All three components are strict uuids, so "/" cannot occur in
 * them and the join is injective. The same triple seen under a different
 * server row id is a DUPLICATE and must render once (store lands in 83-2).
 */
export function replayIdentity(env: Envelope): string {
  return `${envelopeActor(env)}/${env.writerScope}/${env.clientMsgID}`;
}

// ---- uuid16 --------------------------------------------------------------

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * uuid16 encodes a canonical hyphenated uuid string as strict raw 16 bytes.
 * Throws on anything else -- ids reaching an envelope are chalk-minted uuids,
 * so a non-uuid here is a programmer error, not attacker input.
 */
export function uuid16(id: string): Uint8Array {
  if (!UUID_RE.test(id)) {
    throw new Error(`envelope: not a canonical uuid: ${JSON.stringify(id)}`);
  }
  const hex = id.replace(/-/g, "").toLowerCase();
  const out = new Uint8Array(UUID_BYTES);
  for (let i = 0; i < UUID_BYTES; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** uuid16ToString renders 16 raw bytes as the canonical lowercase uuid string. */
export function uuid16ToString(b: Uint8Array): string {
  if (b.length !== UUID_BYTES) {
    throw new Error(`envelope: uuid16 must be ${UUID_BYTES} bytes, got ${b.length}`);
  }
  let hex = "";
  for (const x of b) hex += x.toString(16).padStart(2, "0");
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-" +
    hex.slice(12, 16) +
    "-" +
    hex.slice(16, 20) +
    "-" +
    hex.slice(20)
  );
}

// ---- identity fingerprint ------------------------------------------------

/**
 * ed25519Fingerprint computes the frozen identity-generation fingerprint:
 * SHA-256 over the raw 32-byte Ed25519 public key. This is the value sealed
 * into every envelope as senderEd25519Fp and the lookup key of 83-4's
 * (user_id, ed25519_fp) fetch, so the server-side implementation must agree
 * byte for byte.
 */
export async function ed25519Fingerprint(ed25519Public: Uint8Array): Promise<Uint8Array> {
  if (ed25519Public.length !== 32) {
    throw new Error(`envelope: ed25519 public key must be 32 bytes, got ${ed25519Public.length}`);
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", asBytes(ed25519Public)));
}

// ---- canonical encoding --------------------------------------------------

const ZERO_UUID = new Uint8Array(UUID_BYTES);
const ZERO_H32 = new Uint8Array(H32_BYTES);

function isZero(b: Uint8Array): boolean {
  for (const x of b) if (x !== 0) return false;
  return true;
}

function join(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function u32be(n: number, what: string): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new Error(`envelope: ${what} out of u32 range: ${n}`);
  }
  const out = new Uint8Array(4);
  writeU32BE(out, 0, n);
  return out;
}

// u64be values are JS numbers capped at Number.MAX_SAFE_INTEGER (2^53-1).
// chalk's u64 fields (epoch ms, writer sequence, ciphertext length) never
// approach it, and a number keeps every caller free of BigInt plumbing. The
// parser rejects on-wire values above the cap as malformed for the same
// reason: two clients must never disagree about a field's value.
function u64be(n: number, what: string): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`envelope: ${what} out of u64 (safe-integer) range: ${n}`);
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n));
  return out;
}

function requiredUuid(id: string, what: string): Uint8Array {
  const b = uuid16(id);
  if (isZero(b)) throw new Error(`envelope: ${what} must not be the nil uuid`);
  return b;
}

function requiredH32(b: Uint8Array, what: string): Uint8Array {
  if (b.length !== H32_BYTES) {
    throw new Error(`envelope: ${what} must be ${H32_BYTES} bytes, got ${b.length}`);
  }
  if (isZero(b)) throw new Error(`envelope: ${what} must not be all zero`);
  return b;
}

function optionalH32(b: Uint8Array | null, what: string): Uint8Array {
  if (b === null) return ZERO_H32;
  return requiredH32(b, what);
}

function keyVersionField(v: number, what: string): Uint8Array {
  if (!Number.isInteger(v) || v < 1 || v > 0xffffffff) {
    throw new Error(`envelope: ${what} out of range: ${v}`);
  }
  return u32be(v, what);
}

function bodyField(text: string): Uint8Array {
  const b = utf8(text);
  if (b.length > MAX_BODY_BYTES) {
    throw new Error(`envelope: body_text exceeds ${MAX_BODY_BYTES} bytes (${b.length})`);
  }
  return lengthPrefixed(b);
}

function attachmentsField(atts: AttachmentBinding[]): Uint8Array {
  if (atts.length > MAX_ATTACHMENTS) {
    throw new Error(`envelope: more than ${MAX_ATTACHMENTS} attachments (${atts.length})`);
  }
  const parts: Uint8Array[] = [u32be(atts.length, "att_count")];
  for (const a of atts) {
    if (a.byteLen < 1) throw new Error("envelope: attachment byteLen must be >= 1");
    parts.push(
      requiredUuid(a.attachmentID, "attachment_id"),
      keyVersionField(a.attKeyVersion, "att_key_version"),
      u64be(a.byteLen, "attachment byteLen"),
      requiredH32(a.ciphertextSha256, "attachment ciphertextSha256"),
      optionalH32(a.encMetaSha256, "attachment encMetaSha256"),
      optionalH32(a.encPreviewSha256, "attachment encPreviewSha256"),
    );
  }
  return join(parts);
}

// The shared head: domain || objType || channel || key_version || actor ||
// fp || writer_scope || client_msg_id. Identical across all three types (the
// actor slot is sender_user_id for 0x01/0x02, actor_user_id for 0x03).
function headFields(
  objType: number,
  channelID: string,
  keyVersion: number,
  actorUserID: string,
  senderEd25519Fp: Uint8Array,
  writerScope: string,
  clientMsgID: string,
): Uint8Array[] {
  return [
    DOMAIN,
    Uint8Array.of(objType),
    requiredUuid(channelID, "channel_id"),
    keyVersionField(keyVersion, "key_version"),
    requiredUuid(actorUserID, "actor/sender user id"),
    requiredH32(senderEd25519Fp, "sender_ed25519_fp"),
    requiredUuid(writerScope, "writer_scope"),
    requiredUuid(clientMsgID, "client_msg_id"),
  ];
}

/**
 * encodeEnvelopeCanonical builds the exact byte string the Ed25519 signature
 * covers. Throws on any field violating the frozen format -- an envelope that
 * cannot be encoded canonically must never be signed.
 */
export function encodeEnvelopeCanonical(env: Envelope): Uint8Array {
  switch (env.objType) {
    case OBJ_MESSAGE: {
      const parts = headFields(
        OBJ_MESSAGE,
        env.channelID,
        env.keyVersion,
        env.senderUserID,
        env.senderEd25519Fp,
        env.writerScope,
        env.clientMsgID,
      );
      parts.push(u64be(env.senderTs, "sender_ts"), u64be(env.wseq, "wseq"));
      if (env.reply === null) {
        parts.push(ZERO_UUID, ZERO_UUID, ZERO_UUID, ZERO_H32);
      } else {
        parts.push(
          requiredUuid(env.reply.parentSender, "par_sender"),
          requiredUuid(env.reply.parentScope, "par_scope"),
          requiredUuid(env.reply.parentClientMsgID, "par_client_msg_id"),
          optionalH32(env.reply.parentEnvHash, "par_env_hash"),
        );
      }
      parts.push(bodyField(env.bodyText), attachmentsField(env.attachments));
      return join(parts);
    }
    case OBJ_EDIT: {
      if (env.senderUserID !== env.targetSender) {
        throw new Error("envelope: edit sender must equal target sender");
      }
      const parts = headFields(
        OBJ_EDIT,
        env.channelID,
        env.keyVersion,
        env.senderUserID,
        env.senderEd25519Fp,
        env.writerScope,
        env.clientMsgID,
      );
      parts.push(
        requiredUuid(env.targetSender, "tgt_sender"),
        requiredUuid(env.targetScope, "tgt_scope"),
        requiredUuid(env.targetClientMsgID, "tgt_client_msg_id"),
        optionalH32(env.prevRevHash, "prev_rev_hash"),
        u64be(env.senderTs, "sender_ts"),
        bodyField(env.bodyText),
        attachmentsField(env.attachments),
      );
      return join(parts);
    }
    case OBJ_REACTION_SET: {
      if (env.emoji.length > MAX_EMOJI_PER_SET) {
        throw new Error(`envelope: more than ${MAX_EMOJI_PER_SET} emoji (${env.emoji.length})`);
      }
      const parts = headFields(
        OBJ_REACTION_SET,
        env.channelID,
        env.keyVersion,
        env.actorUserID,
        env.senderEd25519Fp,
        env.writerScope,
        env.clientMsgID,
      );
      parts.push(
        requiredUuid(env.targetSender, "tgt_sender"),
        requiredUuid(env.targetScope, "tgt_scope"),
        requiredUuid(env.targetClientMsgID, "tgt_client_msg_id"),
        optionalH32(env.targetEnvHash, "tgt_env_hash"),
        optionalH32(env.prevSetHash, "prev_set_hash"),
        u64be(env.senderTs, "sender_ts"),
        u32be(env.emoji.length, "emoji_count"),
      );
      for (const e of env.emoji) {
        const b = utf8(e);
        if (b.length < 1 || b.length > MAX_EMOJI_BYTES) {
          throw new Error(`envelope: emoji must be 1..${MAX_EMOJI_BYTES} utf-8 bytes`);
        }
        parts.push(lengthPrefixed(b));
      }
      return join(parts);
    }
    default: {
      const never: never = env;
      throw new Error(`envelope: unknown objType ${(never as Envelope).objType}`);
    }
  }
}

// ---- sign / hash ---------------------------------------------------------

/**
 * signEnvelope encodes, signs and frames the envelope: the returned bytes are
 * the BODY PLAINTEXT to seal (canonical || lp(sig64)), ready for
 * encryptMessage. Throws on degenerate input, like every signing entry point.
 */
export async function signEnvelope(env: Envelope, ed25519Private: CryptoKey): Promise<Uint8Array> {
  const canonical = encodeEnvelopeCanonical(env);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, ed25519Private, asBytes(canonical)));
  if (sig.length !== SIG_BYTES) {
    throw new Error(`envelope: unexpected Ed25519 signature length ${sig.length}`);
  }
  return concat(canonical, lengthPrefixed(sig));
}

/**
 * envelopeObjectHash computes object_hash = SHA-256(canonical || lp(sig64))
 * over the full signed plaintext (exactly signEnvelope's output). This is the
 * value reply bindings, prev_rev_hash and tgt_env_hash carry.
 */
export async function envelopeObjectHash(signedEnvelope: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", asBytes(signedEnvelope)));
}

// ---- strict total parser -------------------------------------------------

/**
 * ParseResult distinguishes three shapes of decrypted body plaintext:
 *
 *   envelope  -- well-formed chalk-msg-sig.v1 envelope (signature NOT yet
 *                verified; that is classifyEnvelope's job)
 *   legacy    -- does not begin with the domain prefix: a pre-83 body,
 *                rendered uniformly as `unsigned`
 *   malformed -- begins with the domain prefix but violates the frozen
 *                format. Only the sender can produce this (the body sits
 *                inside AEAD), so it is rendered as `unsigned` too (D.4);
 *                the distinction is kept for tests and diagnostics.
 */
export type ParseResult =
  | { kind: "envelope"; env: Envelope; canonical: Uint8Array; sig: Uint8Array }
  | { kind: "legacy" }
  | { kind: "malformed" };

// Internal parse-failure sentinel: thrown by the cursor helpers, caught once
// in parseEnvelope, never escapes.
class Malformed extends Error {}

class Cursor {
  off = 0;
  constructor(private buf: Uint8Array) {}
  take(n: number): Uint8Array {
    if (n < 0 || this.off + n > this.buf.length) throw new Malformed();
    const out = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return out;
  }
  u8(): number {
    return this.take(1)[0];
  }
  u32(): number {
    const b = this.take(4);
    return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  }
  u64(): number {
    const b = this.take(8);
    const v = new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Malformed();
    return Number(v);
  }
  lp(maxLen: number): Uint8Array {
    const n = this.u32();
    if (n > maxLen) throw new Malformed();
    return this.take(n);
  }
  done(): boolean {
    return this.off === this.buf.length;
  }
}

const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });

function decodeUtf8Strict(b: Uint8Array): string {
  try {
    return UTF8_STRICT.decode(b);
  } catch {
    throw new Malformed();
  }
}

function readRequiredUuid(c: Cursor): string {
  const b = c.take(UUID_BYTES);
  if (isZero(b)) throw new Malformed();
  return uuid16ToString(b);
}

// Reads a uuid slot that may be the all-zero "absent" encoding. Returns null
// for absent.
function readOptionalUuid(c: Cursor): string | null {
  const b = c.take(UUID_BYTES);
  return isZero(b) ? null : uuid16ToString(b);
}

function readRequiredH32(c: Cursor): Uint8Array {
  const b = c.take(H32_BYTES);
  if (isZero(b)) throw new Malformed();
  return new Uint8Array(b);
}

function readOptionalH32(c: Cursor): Uint8Array | null {
  const b = c.take(H32_BYTES);
  return isZero(b) ? null : new Uint8Array(b);
}

function readKeyVersion(c: Cursor): number {
  const v = c.u32();
  if (v < 1) throw new Malformed();
  return v;
}

function readAttachments(c: Cursor): AttachmentBinding[] {
  const count = c.u32();
  if (count > MAX_ATTACHMENTS) throw new Malformed();
  const out: AttachmentBinding[] = [];
  for (let i = 0; i < count; i++) {
    const attachmentID = readRequiredUuid(c);
    const attKeyVersion = readKeyVersion(c);
    const byteLen = c.u64();
    if (byteLen < 1) throw new Malformed();
    const ciphertextSha256 = readRequiredH32(c);
    const encMetaSha256 = readOptionalH32(c);
    const encPreviewSha256 = readOptionalH32(c);
    out.push({ attachmentID, attKeyVersion, byteLen, ciphertextSha256, encMetaSha256, encPreviewSha256 });
  }
  return out;
}

/**
 * parseEnvelope strictly parses decrypted body plaintext. Total: consumes
 * every byte or rejects; never throws. Structural protocol invariants are
 * enforced here so an envelope violating them can never be classified as
 * anything but malformed: required ids non-nil, key versions >= 1, caps,
 * exact 64-byte signature, valid utf-8, edit sender == target sender, a
 * reply's parent triple all-present-or-all-absent, and no trailing bytes.
 */
export function parseEnvelope(plaintext: Uint8Array): ParseResult {
  if (plaintext.length < DOMAIN.length || !bytesEqual(plaintext.subarray(0, DOMAIN.length), DOMAIN)) {
    return { kind: "legacy" };
  }
  try {
    const c = new Cursor(plaintext);
    c.take(DOMAIN.length); // domain, already matched
    const objType = c.u8();

    const channelID = readRequiredUuid(c);
    const keyVersion = readKeyVersion(c);
    const actorUserID = readRequiredUuid(c);
    const senderEd25519Fp = readRequiredH32(c);
    const writerScope = readRequiredUuid(c);
    const clientMsgID = readRequiredUuid(c);

    let env: Envelope;
    switch (objType) {
      case OBJ_MESSAGE: {
        const senderTs = c.u64();
        const wseq = c.u64();
        const parSender = readOptionalUuid(c);
        const parScope = readOptionalUuid(c);
        const parClientMsgID = readOptionalUuid(c);
        const parEnvHash = readOptionalH32(c);
        let reply: ReplyBinding | null = null;
        if (parSender !== null || parScope !== null || parClientMsgID !== null) {
          // The parent triple is all-or-nothing; a hash without a triple is
          // meaningless too.
          if (parSender === null || parScope === null || parClientMsgID === null) throw new Malformed();
          reply = { parentSender: parSender, parentScope: parScope, parentClientMsgID: parClientMsgID, parentEnvHash: parEnvHash };
        } else if (parEnvHash !== null) {
          throw new Malformed();
        }
        const bodyText = decodeUtf8Strict(c.lp(MAX_BODY_BYTES));
        const attachments = readAttachments(c);
        env = {
          objType: OBJ_MESSAGE,
          channelID,
          keyVersion,
          senderUserID: actorUserID,
          senderEd25519Fp,
          writerScope,
          clientMsgID,
          senderTs,
          wseq,
          reply,
          bodyText,
          attachments,
        };
        break;
      }
      case OBJ_EDIT: {
        const targetSender = readRequiredUuid(c);
        const targetScope = readRequiredUuid(c);
        const targetClientMsgID = readRequiredUuid(c);
        const prevRevHash = readOptionalH32(c);
        const senderTs = c.u64();
        const bodyText = decodeUtf8Strict(c.lp(MAX_BODY_BYTES));
        const attachments = readAttachments(c);
        if (actorUserID !== targetSender) throw new Malformed(); // only the author edits
        env = {
          objType: OBJ_EDIT,
          channelID,
          keyVersion,
          senderUserID: actorUserID,
          senderEd25519Fp,
          writerScope,
          clientMsgID,
          targetSender,
          targetScope,
          targetClientMsgID,
          prevRevHash,
          senderTs,
          bodyText,
          attachments,
        };
        break;
      }
      case OBJ_REACTION_SET: {
        const targetSender = readRequiredUuid(c);
        const targetScope = readRequiredUuid(c);
        const targetClientMsgID = readRequiredUuid(c);
        const targetEnvHash = readOptionalH32(c);
        const prevSetHash = readOptionalH32(c);
        const senderTs = c.u64();
        const emojiCount = c.u32();
        if (emojiCount > MAX_EMOJI_PER_SET) throw new Malformed();
        const emoji: string[] = [];
        for (let i = 0; i < emojiCount; i++) {
          const b = c.lp(MAX_EMOJI_BYTES);
          if (b.length < 1) throw new Malformed();
          emoji.push(decodeUtf8Strict(b));
        }
        env = {
          objType: OBJ_REACTION_SET,
          channelID,
          keyVersion,
          actorUserID,
          senderEd25519Fp,
          writerScope,
          clientMsgID,
          targetSender,
          targetScope,
          targetClientMsgID,
          targetEnvHash,
          prevSetHash,
          senderTs,
          emoji,
        };
        break;
      }
      default:
        throw new Malformed();
    }

    const canonicalLen = c.off;
    const sig = c.lp(SIG_BYTES);
    if (sig.length !== SIG_BYTES) throw new Malformed();
    if (!c.done()) throw new Malformed(); // trailing bytes

    return {
      kind: "envelope",
      env,
      canonical: plaintext.subarray(0, canonicalLen),
      sig: new Uint8Array(sig),
    };
  } catch (e) {
    if (e instanceof Malformed) return { kind: "malformed" };
    // Anything else would be a bug, but this parser must be total on
    // attacker-shaped input: fail closed either way.
    return { kind: "malformed" };
  }
}

// ---- verification --------------------------------------------------------

/**
 * verifyEnvelopeSig checks the Ed25519 signature over the canonical bytes
 * against ONE public key the caller already resolved. Pure crypto; never
 * throws; false on any failure.
 */
export async function verifyEnvelopeSig(
  canonical: Uint8Array,
  sig: Uint8Array,
  ed25519Public: Uint8Array,
): Promise<boolean> {
  try {
    if (sig.length !== SIG_BYTES || ed25519Public.length !== 32) return false;
    const key = await crypto.subtle.importKey("raw", asBytes(ed25519Public), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, asBytes(sig), asBytes(canonical));
  } catch {
    return false;
  }
}

/**
 * VerifyStatus -- the typed, fail-closed result set frozen in D.1.
 *
 *   verified                   signature valid against the sender's pinned
 *                              CURRENT identity; every server-supplied outer
 *                              field matches its signed inner counterpart
 *   verified-former-identity   valid against a RETIRED generation whose idgen
 *                              chain reaches the current pin -- labelled
 *                              history, never rendered as current speech
 *   mismatch                   signature valid but the outer frame disagrees
 *                              with the signed fields -- inner wins, always
 *   forged                     invalid against our belief about the signed
 *                              generation (or the fingerprint resolves to
 *                              nothing / another user / a chain that does not
 *                              reach the pin)
 *   unpinned                   no pin for the sender and the path may not
 *                              fetch one
 *   unsigned                   legacy pre-83 body (and, per D.4, a body that
 *                              fails strict envelope parsing)
 *
 * Content is displayed even when attribution fails, under an unmistakable
 * warning -- that is 83-2's rendering rule; this function only labels.
 */
export type VerifyStatus =
  | "verified"
  | "verified-former-identity"
  | "mismatch"
  | "forged"
  | "unpinned"
  | "unsigned";

/**
 * OuterFrame -- the server-asserted fields the client received alongside the
 * ciphertext. Compared against their signed inner counterparts; disagreement
 * with a valid signature is `mismatch` and the inner values win.
 */
export interface OuterFrame {
  channelID: string;
  keyVersion: number;
  senderUserID: string; // the server's claim of who sent it
}

/**
 * SignerResolution is the caller's answer to "what do we believe about this
 * (actor, fingerprint) pair?". Resolution is a TRUST decision -- pins and the
 * 83-4 idgen chain -- so it stays outside this module:
 *
 *   current   fp is the actor's pinned current identity; pub is that key
 *   retired   fp is in the VERIFIED chain ending at the current pin
 *   unpinned  no pin exists and the path may not fetch one
 *   foreign   fp resolves to nothing, to another user, or to a chain that
 *             does not reach the pin -- treated as forged
 */
export type SignerResolution =
  | { kind: "current"; ed25519Public: Uint8Array }
  | { kind: "retired"; ed25519Public: Uint8Array }
  | { kind: "unpinned" }
  | { kind: "foreign" };

export interface ClassifiedEnvelope {
  status: VerifyStatus;
  /** Parsed envelope for rendering (inner wins), null for unsigned bodies. */
  env: Envelope | null;
}

/**
 * classifyEnvelope turns a parsed body + the server's outer frame + the
 * caller's trust resolution into the typed verdict. Fail-closed at every
 * step; never throws.
 */
export async function classifyEnvelope(
  parsed: ParseResult,
  outer: OuterFrame,
  resolve: (actorUserID: string, senderEd25519Fp: Uint8Array) => Promise<SignerResolution>,
): Promise<ClassifiedEnvelope> {
  if (parsed.kind !== "envelope") {
    return { status: "unsigned", env: null };
  }
  const { env, canonical, sig } = parsed;
  let resolution: SignerResolution;
  try {
    resolution = await resolve(envelopeActor(env), env.senderEd25519Fp);
  } catch {
    // A resolver failure is not proof of forgery, but it is not trust
    // either: without a belief to check against, the honest label is
    // unpinned ("we could not establish who this is").
    return { status: "unpinned", env };
  }
  if (resolution.kind === "unpinned") return { status: "unpinned", env };
  if (resolution.kind === "foreign") return { status: "forged", env };

  const ok = await verifyEnvelopeSig(canonical, sig, resolution.ed25519Public);
  if (!ok) return { status: "forged", env };

  // Signature is valid; now hold the server's outer frame against the signed
  // truth. Any disagreement is mismatch -- inner wins, always.
  if (
    outer.channelID !== env.channelID ||
    outer.keyVersion !== env.keyVersion ||
    outer.senderUserID !== envelopeActor(env)
  ) {
    return { status: "mismatch", env };
  }

  return { status: resolution.kind === "retired" ? "verified-former-identity" : "verified", env };
}
