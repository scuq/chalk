// 83-9: the server identity, readable at a calm moment.
//
// The pin ceremony only works if users can FIND their fingerprint outside
// the wall: the operator announces one fingerprint, the user compares it
// here, character for character, in the same grouped-hex rendering
// `chalkctl serverkey show` prints. This card shows what this device
// pinned, HOW it was pinned (a registration pin, a first-login adoption and
// an explicit re-pin are different assurances -- say which), and whether
// the current connection actually proved it.
//
// Deliberately NO unpin/edit control: re-pinning stays exclusively the
// wall's explicit compare-and-trust flow. A casual pin-management surface
// would turn the trust anchor into a setting people fiddle with -- and a
// social-engineering target ("go to settings and clear your server pin").

import { useEffect, useState } from "preact/hooks";
import { loadServerPin, type ServerPinRecord } from "../crypto/idb";

interface Props {
  /** Whether the current WS connection runs the sealed channel (WSClient.isSealed). */
  sealed: boolean;
}

/** sourceLabel says how the pin came to be, honestly ranked. */
export function sourceLabel(source: ServerPinRecord["source"]): string {
  switch (source) {
    case "registration":
      return "pinned when this account was created";
    case "tofu":
      return "adopted at the first sign-in after the server gained an identity";
    case "repin":
      return "re-pinned by you after comparing fingerprints at the warning screen";
  }
}

export function ServerIdentityCard({ sealed }: Props) {
  const [pin, setPin] = useState<ServerPinRecord | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void loadServerPin(window.location.origin)
      .then((rec) => {
        if (!cancelled) setPin(rec);
      })
      .catch(() => {
        if (!cancelled) setPin(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (pin === undefined) return null; // still loading; no flash

  return (
    <section class="chalk-profile-security chalk-server-identity" data-testid="server-identity">
      <h3>server identity</h3>
      {pin ? (
        <>
          <p class="chalk-server-identity-fp">
            <code data-testid="server-identity-fp">{pin.fingerprint}</code>
          </p>
          <p class="chalk-profile-hint" data-testid="server-identity-source">
            {sourceLabel(pin.source)} —{" "}
            {new Date(pin.pinnedAt).toLocaleDateString()}
          </p>
          <p class="chalk-profile-hint" data-testid="server-identity-status">
            {sealed
              ? "this connection proved the pinned identity — the stream is sealed end to end"
              : "not currently connected over the sealed channel"}
          </p>
          <p class="chalk-profile-hint chalk-server-identity-explain">
            Your server's operator can print this fingerprint with{" "}
            <code>chalkctl serverkey show</code> — it should match exactly. If the
            server ever presents a different key, chalk stops with a full-screen
            warning showing both fingerprints; only continue there if the operator
            announced the change.
          </p>
        </>
      ) : (
        <p class="chalk-profile-hint" data-testid="server-identity-none">
          No server identity is pinned on this device. This server hasn't
          published one (development setups often don't) — connections fall
          back to ordinary TLS without the pinned inner channel.
        </p>
      )}
    </section>
  );
}
