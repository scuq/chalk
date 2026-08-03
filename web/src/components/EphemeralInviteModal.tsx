// EphemeralInviteModal (80-12): the owner's guest-link surface for one
// ephemeral voice room. Mint a link, copy it, see what's outstanding,
// revoke.
//
// THE LINK IS SHOWN EXACTLY ONCE. The secret exists only in the URL
// fragment the creator just derived -- it is never stored, never sent to
// the server, and cannot be re-shown later (the list only knows the
// lookup). Closing the modal without copying wastes the slot; revoke frees
// it.

import { useEffect, useState } from "preact/hooks";
import type { EphemeralInviteInfoWire } from "../proto";

interface Props {
  channelName: string;
  listInvites: () => Promise<{ invites: EphemeralInviteInfoWire[]; maxGuests: number }>;
  // Resolves to the full join URL (built from the freshly derived secret).
  // Rejects with an Error whose message is user-facing.
  mintInvite: (label: string) => Promise<{ url: string; expiresAt: number }>;
  revokeInvite: (lookup: string) => Promise<void>;
  onClose: () => void;
}

function inviteStatus(inv: EphemeralInviteInfoWire, now: number): string {
  if (inv.revoked_at) return "revoked";
  if (inv.expires_at <= now) return inv.redeemed_at ? "joined (link expired)" : "expired";
  if (inv.redeemed_at) return "joined";
  return "waiting";
}

export function EphemeralInviteModal({ channelName, listInvites, mintInvite, revokeInvite, onClose }: Props) {
  const [invites, setInvites] = useState<EphemeralInviteInfoWire[] | null>(null);
  const [maxGuests, setMaxGuests] = useState(0);
  const [label, setLabel] = useState("");
  const [minting, setMinting] = useState(false);
  const [freshURL, setFreshURL] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    listInvites()
      .then(({ invites, maxGuests }) => {
        setInvites(invites);
        setMaxGuests(maxGuests);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "could not load invites"));
  };
  useEffect(refresh, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const mint = () => {
    setError(null);
    setFreshURL(null);
    setCopied(false);
    setMinting(true);
    mintInvite(label.trim())
      .then(({ url }) => {
        setFreshURL(url);
        setLabel("");
        refresh();
      })
      .catch((e) => setError(e instanceof Error ? e.message : "mint failed"))
      .finally(() => setMinting(false));
  };

  const copy = () => {
    if (!freshURL) return;
    void navigator.clipboard.writeText(freshURL).then(() => setCopied(true));
  };

  const revoke = (lookup: string) => {
    setError(null);
    revokeInvite(lookup)
      .then(refresh)
      .catch((e) => setError(e instanceof Error ? e.message : "revoke failed"));
  };

  const now = Date.now();
  const live = (invites ?? []).filter((i) => !i.revoked_at).length;
  const atCap = maxGuests > 0 && live >= maxGuests;

  return (
    <div class="chalk-modal-backdrop" onClick={onClose} data-testid="ephemeral-invite-modal">
      <div
        class="chalk-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="ephemeral-invite-title"
      >
        <header class="chalk-modal-header">
          <h2 id="ephemeral-invite-title">guest links — {channelName}</h2>
          <button class="chalk-modal-close" type="button" onClick={onClose} aria-label="close">
            ×
          </button>
        </header>

        <div class="chalk-modal-body">
          <div class="chalk-field-hint">
            a guest link lets someone join this room's call and scratchpad
            with no account — whoever holds the link IS the guest, so share
            it like a key, not like an address.
          </div>

          <div class="chalk-field">
            <span class="chalk-field-label">
              new link{maxGuests > 0 ? ` (${live} of ${maxGuests} slots used)` : ""}
            </span>
            <div class="chalk-field-row">
              <input
                type="text"
                class="chalk-field-input"
                data-testid="ephemeral-invite-label"
                value={label}
                onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
                maxLength={80}
                placeholder="who is this for? (only you see this)"
              />
              <button
                type="button"
                class="chalk-button chalk-button--primary"
                data-testid="ephemeral-invite-mint"
                onClick={mint}
                disabled={minting || atCap}
              >
                {minting ? "minting…" : "mint link"}
              </button>
            </div>
            {atCap && <div class="chalk-field-hint">guest limit reached — revoke a link to free a slot.</div>}
          </div>

          {freshURL && (
            <div class="chalk-field" data-testid="ephemeral-invite-fresh">
              <span class="chalk-field-label">link minted — copy it NOW; it cannot be shown again</span>
              <div class="chalk-field-row">
                <input type="text" class="chalk-field-input" readOnly value={freshURL} onFocus={(e) => (e.target as HTMLInputElement).select()} />
                <button
                  type="button"
                  class="chalk-button chalk-button--primary"
                  data-testid="ephemeral-invite-copy"
                  onClick={copy}
                >
                  {copied ? "copied ✓" : "copy"}
                </button>
              </div>
            </div>
          )}

          <div class="chalk-field">
            <span class="chalk-field-label">outstanding links</span>
            {invites === null ? (
              <div class="chalk-field-hint">loading…</div>
            ) : invites.length === 0 ? (
              <div class="chalk-field-hint">none yet.</div>
            ) : (
              <ul class="chalk-plain-list" data-testid="ephemeral-invite-list">
                {invites.map((inv) => (
                  <li key={inv.lookup} class="chalk-plain-list-row">
                    <span>
                      {inv.label || "(unlabelled)"} — {inviteStatus(inv, now)}
                    </span>
                    {!inv.revoked_at && (
                      <button
                        type="button"
                        class="chalk-button chalk-button--secondary"
                        onClick={() => revoke(inv.lookup)}
                      >
                        revoke
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {error && <div class="chalk-modal-error">{error}</div>}
        </div>

        <footer class="chalk-modal-footer">
          <button type="button" class="chalk-button chalk-button--secondary" onClick={onClose}>
            close
          </button>
        </footer>
      </div>
    </div>
  );
}
