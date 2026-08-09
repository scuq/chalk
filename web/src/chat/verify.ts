// chalk -- 83-2: envelope verification glue between crypto and rendering.
//
// Two pure pieces the App and the feed share:
//
//   * applyOpened folds an OpenedMessage (crypto/channel-crypto.ts) into the
//     Message row: display text, the typed verdict, the signed replay triple
//     + object hash, and -- for every SIGNATURE-VALID verdict -- the signed
//     sender replacing the server frame's claim ("inner wins, always",
//     PHASE-83-MSGSIG.md D.1). For forged/unpinned/unsigned there is no
//     verified inner truth, so the server's claim stands (under its warning).
//
//   * verifyLabel / verifyTitle are the one place the verdict vocabulary
//     turns into UI copy, so the feed and any future surface (thread panel,
//     search) say the same words.

import type { OpenedMessage } from "../crypto/channel-crypto";
import type { VerifyStatus } from "../crypto/envelope";
import type { Message } from "../state/types";

/** sigValid reports whether a verdict means "the signature checked out". */
export function sigValid(v: VerifyStatus | undefined): boolean {
  return v === "verified" || v === "verified-former-identity" || v === "mismatch";
}

/**
 * applyOpened merges one opened body into its message row. Pure -- the
 * caller dispatches the result.
 */
export function applyOpened(m: Message, opened: OpenedMessage): Message {
  const next: Message = { ...m, body: opened.text, verify: opened.verify };
  if (opened.env) {
    next.sigActor = opened.env.senderUserID;
    next.sigScope = opened.env.writerScope;
    next.sigClientMsgID = opened.env.clientMsgID;
    next.sigObjectHash = opened.objectHashHex;
    if (sigValid(opened.verify)) {
      // Inner wins: the signed sender is the truth this row renders under.
      next.senderUserID = opened.env.senderUserID;
    }
  }
  return next;
}

/**
 * verifyLabel is the short inline marker beside the message body. Empty for
 * "verified" (the healthy state carries no chrome) and for rows with no
 * verdict (placeholders, tombstones).
 */
export function verifyLabel(v: VerifyStatus | undefined): string {
  switch (v) {
    case "unsigned":
      return "(unsigned)";
    case "unpinned":
      return "(sender not verified)";
    case "verified-former-identity":
      return "(signed by an earlier key)";
    case "mismatch":
      return "⚠ sender mismatch";
    case "forged":
      return "⚠ signature invalid";
    default:
      return "";
  }
}

/** verifyTitle is the hover explanation behind the label. */
export function verifyTitle(v: VerifyStatus | undefined): string {
  switch (v) {
    case "unsigned":
      return "Sent before message signing existed; authorship is asserted by the server, not proven.";
    case "unpinned":
      return "No trusted identity key is pinned for this sender yet, so the signature could not be checked.";
    case "verified-former-identity":
      return "Valid signature from an earlier identity key of this sender.";
    case "mismatch":
      return "The signature is valid but the server's framing disagrees with what was signed. The signed values are shown.";
    case "forged":
      return "The signature does not verify against this sender's trusted identity key. Treat with suspicion.";
    default:
      return "";
  }
}

/** hexToBytes / bytesToHex for the sigObjectHash round trip (reply binding). */
export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
