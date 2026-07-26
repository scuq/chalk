// 48-4: boot-time capability probe for the WebCrypto curve support the
// whole E2E layer stands on (X25519 key agreement, Ed25519 signatures).
// Browsers without it (Safari < 17, Firefox < 132, older Chromium and
// WebViews) used to fall through to the identity-setup screen, where a
// perfectly correct 24-word phrase then failed with a generic error --
// users concluded their phrase was wrong. Probe once, up front, and let
// the app show an honest "this browser can't run chalk" screen instead.

let probe: Promise<boolean> | null = null;

export function cryptoSupported(): Promise<boolean> {
  if (!probe) {
    probe = (async () => {
      // crypto.subtle is absent entirely on insecure origins; localhost
      // and https are secure, a plain-http LAN IP is not.
      if (typeof crypto === "undefined" || !crypto.subtle) return false;
      try {
        // Firefox shipped Ed25519 (129) before X25519 (132), so both
        // curves are probed; either one missing throws NotSupportedError.
        await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign"]);
        await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
        return true;
      } catch {
        return false;
      }
    })();
  }
  return probe;
}
