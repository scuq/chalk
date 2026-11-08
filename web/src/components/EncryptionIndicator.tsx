import type { ChannelKeyStatus } from "../crypto/channel-crypto";
import { CURRENT_KEY_VERSION } from "../crypto/channel-crypto";
import { describeSuites } from "../crypto/spacekey";
import { LockIcon } from "./icons";

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
export function EncryptionIndicator({
  status,
  onClick,
}: {
  status?: ChannelKeyStatus;
  onClick?: () => void;
}) {
  const ready = status === "ready";
  const suites = describeSuites();
  const headline = ready ? "Encrypted -- key ready" : "Securing -- key not here yet";
  const ariaLabel = ready ? "Encrypted" : "Securing -- waiting for encryption key";

  return (
    <span
      class={"chalk-enc-indicator" + (ready ? " chalk-enc-ready" : " chalk-enc-pending")}
      role={onClick ? "button" : "img"}
      aria-label={onClick ? ariaLabel + " -- view members" : ariaLabel}
      data-testid="encryption-indicator"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (onClick && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick();
        }
      }}
      style={onClick ? "cursor: pointer" : undefined}
    >
      <LockIcon open={!ready} />

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
          <span class="chalk-enc-pop-k">wrap signature</span>
          <span class="chalk-enc-pop-v">{suites.keyAuth}</span>
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
