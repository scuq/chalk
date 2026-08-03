// 82-8: how the members panel says where this channel's key came from.
//
// Pure, and tested, because these strings are security claims. The provenance
// itself is recorded by crypto/channel-crypto.ts at the moment of adoption
// (82-3) and persisted (82-5); this only decides how to say it.
//
// The wording rule: describe what this device KNOWS, never how safe it feels.
// "signed by alice" is a fact. "secure" would be a promise the client is not
// in a position to make -- it does not know whether alice's key is really
// alice's, only whether it recognised it.

import type { KeyProvenance } from "../crypto/idb";

export interface KeyProvenanceLine {
  /** Short label, e.g. "signed by alice". */
  text: string;
  /** true when the key's origin is unproven -- the UI dims/flags these. */
  weak: boolean;
  /** Hover detail; longer, and honest about what is not known. */
  title: string;
}

/**
 * describeKeyProvenance renders a provenance for display. `handleFor` resolves
 * a user id to a display handle; it may return null (unknown member), in which
 * case the id is not shown -- "signed by 3f2a…" tells a user nothing, and a
 * raw uuid in a security line reads as a malfunction.
 */
export function describeKeyProvenance(
  prov: KeyProvenance | null,
  handleFor: (userID: string) => string | null,
): KeyProvenanceLine | null {
  if (!prov) return null;
  switch (prov.kind) {
    case "self_minted":
      return {
        text: "created here",
        weak: false,
        title: "this device generated this channel's key, so there was nobody to trust",
      };
    case "signed": {
      const who = handleFor(prov.signerUserID);
      const by = who ? `signed by ${who}` : "signed by a member";
      switch (prov.trust) {
        case "self":
          return {
            text: "from your other device",
            weak: false,
            title: "another device signed in as you sent this key, signed with your own identity key",
          };
        case "manually_verified":
          return {
            text: `${by} (verified)`,
            weak: false,
            title: "the member who sent this key signed it, and you compared their safety number out of band",
          };
        default:
          return {
            text: by,
            weak: false,
            title: "the member who sent this key signed it with the identity key this device recognises for them -- which nobody has compared in person",
          };
      }
    }
    case "guest_link":
      return {
        text: "from your invite link",
        weak: false,
        title: "this key came with the guest link, signed by whoever created it",
      };
    case "unsigned":
      return {
        text: "unsigned",
        weak: true,
        title: "this key arrived without a signature, so this device cannot tell who sent it. Re-sharing the key replaces it with a signed one.",
      };
    case "legacy_cache":
      return {
        text: "stored before signing",
        weak: true,
        title: "this key was already on this device before chalk started recording where keys come from",
      };
  }
}
