import type { ChannelKeyStatus } from "../crypto/channel-crypto";
import { CURRENT_KEY_VERSION } from "../crypto/channel-crypto";
import { describeSuites } from "../crypto/spacekey";

/**
 * EncryptionIndicator -- a small inline lock in the channel header, with a
 * hover popover that shows the TRUTHFUL crypto details for the channel
 * (sourced from the suite registry via describeSuites(), so it can't drift
 * from what's actually used). Phase 23g; the richer per-member view is 23e.
 *
 *   ready    -> closed padlock, accent. "Encrypted -- key ready".
 *   waiting  -> open padlock, muted + pulse. "Securing -- key not here yet";
 *               messages are blocked until the key arrives.
 *
 * Always fail-closed: this never indicates "plaintext".
 */
export function EncryptionIndicator({ status }: { status?: ChannelKeyStatus }) {
  const ready = status === "ready";
  const suites = describeSuites();
  const headline = ready ? "Encrypted -- key ready" : "Securing -- key not here yet";
  const ariaLabel = ready ? "Encrypted" : "Securing -- waiting for encryption key";

  return (
    <span
      class={"chalk-enc-indicator" + (ready ? " chalk-enc-ready" : " chalk-enc-pending")}
      role="img"
      aria-label={ariaLabel}
      data-testid="encryption-indicator"
      tabIndex={0}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        {ready ? (
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        ) : (
          <path d="M7 11V7a5 5 0 0 1 9.9-1" />
        )}
      </svg>

      <span class="chalk-enc-popover" role="tooltip">
        <span class="chalk-enc-pop-head">{headline}</span>
        <span class="chalk-enc-pop-row">
          <span class="chalk-enc-pop-k">cipher</span>
          <span class="chalk-enc-pop-v">{suites.cipher}</span>
        </span>
        <span class="chalk-enc-pop-row">
          <span class="chalk-enc-pop-k">key exchange</span>
          <span class="chalk-enc-pop-v">{suites.keyExchange}</span>
        </span>
        <span class="chalk-enc-pop-row">
          <span class="chalk-enc-pop-k">channel key</span>
          <span class="chalk-enc-pop-v">
            {suites.keyBits}-bit &middot; v{CURRENT_KEY_VERSION}
          </span>
        </span>
        {!ready && (
          <span class="chalk-enc-pop-note">
            messages are blocked until your key arrives
          </span>
        )}
      </span>
    </span>
  );
}
