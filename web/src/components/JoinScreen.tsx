// JoinScreen (80-13): the guest's front door, docs/PHASE-80-EPHEMERAL.md.
//
// Mounted by index.tsx for /join/<lookup> paths INSTEAD of the App -- a
// guest never touches the session/identity machinery real users boot
// through. The flow:
//
//   1. Read the #fragment (the link secret) and IMMEDIATELY strip it from
//      the URL: it must not survive into history, bookmarks or referers.
//      The secret lives only in this component's memory from here on.
//   2. Derive the identity from the secret (crypto/guest-link.ts -- the
//      same derivation the creator ran at mint time).
//   3. Name entry, with the honest warning the plan requires: whoever
//      holds the link IS the guest.
//   4. GET the challenge, sign it with the derived Ed25519 key, POST the
//      redemption. The response carries the room, the parked key wrap and
//      the guest session cookie.
//   5. Unwrap the space key with the derived X25519 key and hand
//      everything to GuestRoom.

import { useEffect, useMemo, useState } from "preact/hooks";
import {
  deriveGuestLink,
  parseJoinFragment,
  bytesToBase64,
  type GuestLinkMaterial,
} from "../crypto/guest-link";
import { unwrapSpaceKey } from "../crypto/spacekey";
import { GuestRoom, type GuestContext } from "./GuestRoom";

interface RedeemResponse {
  guest_user_id: string;
  display_name: string;
  channel_id: string;
  channel_name: string;
  channel_expires_at: number;
  key_version: number;
  wrap_suite: number;
  wrap_blob: string; // b64 std
  session_expires_at: number;
}

type Stage =
  | { kind: "bad_link"; why: string }
  | { kind: "name"; material: GuestLinkMaterial; lookupHex: string }
  | { kind: "joining"; material: GuestLinkMaterial; lookupHex: string }
  | { kind: "room"; ctx: GuestContext }
  | { kind: "gone"; why: string };

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function JoinScreen() {
  const [stage, setStage] = useState<Stage | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  // The path's lookup must match the secret-derived one -- a mismatched
  // pair is a mangled link, better said now than as a 403 later.
  const pathLookup = useMemo(() => {
    const m = window.location.pathname.match(/^\/join\/([0-9a-f]{32})$/);
    return m ? m[1] : null;
  }, []);

  useEffect(() => {
    const secret = parseJoinFragment(window.location.hash);
    // Strip the fragment BEFORE any async work; the path (lookup) stays so
    // a reload can say "link already used here" instead of 404ing.
    window.history.replaceState({}, "", window.location.pathname);
    if (!pathLookup) {
      setStage({ kind: "bad_link", why: "this join link is malformed." });
      return;
    }
    if (!secret) {
      setStage({
        kind: "bad_link",
        why: "this join link is incomplete — the part after # is missing. Ask for the link again and open it exactly as sent.",
      });
      return;
    }
    void deriveGuestLink(secret).then(
      (material) => {
        if (material.lookupHex !== pathLookup) {
          setStage({ kind: "bad_link", why: "this join link is corrupted (its two halves do not match)." });
          return;
        }
        setStage({ kind: "name", material, lookupHex: material.lookupHex });
      },
      () => setStage({ kind: "bad_link", why: "this join link could not be read." }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const join = async (material: GuestLinkMaterial, lookupHex: string) => {
    const displayName = name.trim();
    if (displayName.length < 1 || displayName.length > 32) {
      setError("pick a name between 1 and 32 characters");
      return;
    }
    setError(null);
    setStage({ kind: "joining", material, lookupHex });
    try {
      const chResp = await fetch(`/api/join/${lookupHex}`);
      if (!chResp.ok) throw new Error(chResp.status === 404 ? "this server has no guest access." : "could not reach the server.");
      const { challenge } = (await chResp.json()) as { challenge: string };
      const sig = new Uint8Array(
        await crypto.subtle.sign({ name: "Ed25519" }, material.identity.ed25519Private, b64ToBytes(challenge)),
      );
      const redeemResp = await fetch(`/api/join/${lookupHex}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          challenge,
          signature: bytesToBase64(sig),
          display_name: displayName,
        }),
      });
      if (redeemResp.status === 410) {
        setStage({ kind: "gone", why: "this link has expired or was revoked. Ask for a new one." });
        return;
      }
      if (!redeemResp.ok) {
        throw new Error("the server refused this link.");
      }
      const r = (await redeemResp.json()) as RedeemResponse;

      const spaceKey = await unwrapSpaceKey(
        { suite: r.wrap_suite, blob: b64ToBytes(r.wrap_blob) },
        material.identity.x25519Private,
        r.channel_id,
        r.key_version,
        r.guest_user_id,
      );
      if (!spaceKey) {
        setStage({ kind: "gone", why: "this link cannot decrypt the room (it may have been re-keyed). Ask for a new one." });
        return;
      }
      setStage({
        kind: "room",
        ctx: {
          guestUserID: r.guest_user_id,
          displayName: r.display_name,
          channelID: r.channel_id,
          channelName: r.channel_name,
          channelExpiresAt: r.channel_expires_at,
          keyVersion: r.key_version,
          spaceKey,
          identity: material.identity,
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "joining failed — try again.");
      setStage({ kind: "name", material, lookupHex });
    }
  };

  if (stage === null) {
    return (
      <div class="chalk-auth" data-testid="join-loading">
        <div class="chalk-auth-card">
          <p class="chalk-auth-subtitle">reading your invite…</p>
        </div>
      </div>
    );
  }

  if (stage.kind === "room") {
    return <GuestRoom ctx={stage.ctx} />;
  }

  if (stage.kind === "bad_link" || stage.kind === "gone") {
    return (
      <div class="chalk-auth" data-testid="join-dead">
        <div class="chalk-auth-card">
          <header class="chalk-auth-header">
            <h1>chalk</h1>
          </header>
          <p class="chalk-auth-subtitle">{stage.why}</p>
        </div>
      </div>
    );
  }

  const joining = stage.kind === "joining";
  return (
    <div class="chalk-auth" data-testid="join-screen">
      <div class="chalk-auth-card">
        <header class="chalk-auth-header">
          <h1>chalk</h1>
        </header>
        <p class="chalk-auth-subtitle">
          you were invited to a voice room. Pick a name and join — no account
          needed.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!joining) void join(stage.material, stage.lookupHex);
          }}
        >
          <label class="chalk-field">
            <span class="chalk-field-label">your name</span>
            <input
              type="text"
              class="chalk-field-input"
              data-testid="join-name"
              value={name}
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
              maxLength={32}
              autoFocus
              placeholder="Bob"
            />
          </label>
          {error && <div class="chalk-modal-error">{error}</div>}
          <button
            type="submit"
            class="chalk-button chalk-button--primary"
            data-testid="join-submit"
            disabled={joining}
          >
            {joining ? "joining…" : "join the room"}
          </button>
        </form>
        <p class="chalk-field-hint">
          anyone who has this link can join as this guest — treat it like a
          key. The room and everything said in it are deleted when it
          expires.
        </p>
      </div>
    </div>
  );
}
