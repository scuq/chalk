// chalk -- 83-3: revision-chain verification.
//
// An edited message's current body is its latest 0x02 edit envelope, whose
// prev_rev_hash names the object hash of what it displaced; the displaced
// bodies live server-side in message_revisions and come back oldest-first
// via fetch_revisions (rev 1 = the original 0x01 envelope). This module
// walks that chain: every link hash must match, every envelope must target
// the same original, and every signature must verify under the sender's
// resolved key -- server-supplied ancestry is DATA to check, never truth to
// adopt.
//
// What a verified chain proves: the body now displayed extends, through
// exclusively author-signed edits, the exact original the author signed --
// and it recovers the ORIGINAL envelope's object hash, the stable anchor
// replies bind to. What a failed walk means is deliberately coarse
// ("unverified recency", not an accusation): the server may be withholding
// revisions, a revision may predate signing (legacy), or the chain may
// genuinely be forged -- the client cannot distinguish these and must not
// pretend to.

import {
  OBJ_MESSAGE,
  OBJ_EDIT,
  parseEnvelope,
  verifyEnvelopeSig,
  envelopeObjectHash,
  type EditEnvelope,
  type MessageEnvelope,
} from "./envelope";

/**
 * The ancestry verdict a message row carries (83-3):
 *
 *   verified  the full chain original -> ... -> current body checked out
 *   forked    a signature-valid edit whose prev_rev_hash does not extend
 *             the head this client already verified (sibling fork / stale)
 *   unknown   ancestry not (or not yet) verifiable -- revisions withheld,
 *             unreadable, or pre-signing. Rendered as unverified recency.
 */
export type EditAncestry = "verified" | "forked" | "unknown";

export interface ChainResult {
  ok: boolean;
  /** hex object hash of the verified ORIGINAL envelope (replies bind here). */
  originalHashHex?: string;
  /** the verified original, for callers that want its fields (sender_ts …). */
  originalEnv?: MessageEnvelope;
}

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function sameTarget(edit: EditEnvelope, sender: string, scope: string, cmid: string): boolean {
  return edit.targetSender === sender && edit.targetScope === scope && edit.targetClientMsgID === cmid;
}

/**
 * verifyRevisionChain checks decrypted revision bodies (oldest first, as
 * fetch_revisions returns them) against the decrypted current body.
 * `senderEd25519Public` is the resolved key of the target's author -- the
 * caller already classified the current body's envelope against it, and
 * every revision must verify under the same key (rotation mid-chain lands
 * with 83-4's chain walk; until then it honestly reads unverified).
 *
 * Never throws; {ok: false} on any failure.
 */
export async function verifyRevisionChain(
  revisions: Uint8Array[],
  currentBody: Uint8Array,
  senderEd25519Public: Uint8Array,
): Promise<ChainResult> {
  try {
    const cur = parseEnvelope(currentBody);
    if (cur.kind !== "envelope" || cur.env.objType !== OBJ_EDIT) return { ok: false };
    const curEnv = cur.env;
    if (curEnv.prevRevHash === null) return { ok: false }; // legacy-original edit: nothing to walk
    if (revisions.length === 0) return { ok: false }; // ancestry withheld

    // rev 1: the original message envelope, the anchor everything targets.
    const first = parseEnvelope(revisions[0]);
    if (first.kind !== "envelope" || first.env.objType !== OBJ_MESSAGE) return { ok: false };
    const orig = first.env;
    if (!sameTarget(curEnv, orig.senderUserID, orig.writerScope, orig.clientMsgID)) return { ok: false };
    if (orig.channelID !== curEnv.channelID) return { ok: false };
    if (!(await verifyEnvelopeSig(first.canonical, first.sig, senderEd25519Public))) return { ok: false };
    let prevHash = await envelopeObjectHash(revisions[0]);
    const originalHashHex = hex(prevHash);

    // rev 2..n: earlier edits, each displacing its predecessor.
    for (const bytes of revisions.slice(1)) {
      const p = parseEnvelope(bytes);
      if (p.kind !== "envelope" || p.env.objType !== OBJ_EDIT) return { ok: false };
      const e = p.env;
      if (!sameTarget(e, orig.senderUserID, orig.writerScope, orig.clientMsgID)) return { ok: false };
      if (e.channelID !== curEnv.channelID) return { ok: false };
      if (e.prevRevHash === null || hex(e.prevRevHash) !== hex(prevHash)) return { ok: false };
      if (!(await verifyEnvelopeSig(p.canonical, p.sig, senderEd25519Public))) return { ok: false };
      prevHash = await envelopeObjectHash(bytes);
    }

    // the current body must extend the last displaced revision.
    if (hex(curEnv.prevRevHash) !== hex(prevHash)) return { ok: false };
    return { ok: true, originalHashHex, originalEnv: orig };
  } catch {
    return { ok: false };
  }
}

/**
 * classifyLiveEdit answers the cheap, no-fetch case: a message_edited push
 * arriving while this client already holds the row's verified head hash.
 * `prevRevHashHex` is the incoming edit's link; `headHashHex` the hash of
 * the envelope currently displayed (the original's, or the last verified
 * edit's).
 */
export function classifyLiveEdit(
  prevRevHashHex: string | null,
  headHashHex: string | undefined,
): EditAncestry {
  if (!prevRevHashHex || !headHashHex) return "unknown";
  return prevRevHashHex === headHashHex ? "verified" : "forked";
}
