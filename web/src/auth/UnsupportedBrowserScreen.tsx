// 48-4: shown when the boot-time probe (crypto/support.ts) finds no
// WebCrypto X25519/Ed25519. Nothing here is interactive on purpose --
// there is no degraded mode; chalk's encryption either runs or it doesn't.
export function UnsupportedBrowserScreen() {
  const insecure = typeof isSecureContext !== "undefined" && !isSecureContext;
  return (
    <div class="chalk-auth" data-testid="auth-unsupported-browser">
      <div class="chalk-auth-card">
        <h1>This browser can't run chalk</h1>
        <p>
          chalk encrypts everything end-to-end in your browser, and that
          needs WebCrypto support for the X25519 and Ed25519 curves, which
          this browser doesn't provide.
        </p>
        {insecure ? (
          <p>
            This page was loaded over plain <code>http://</code>, where
            browsers disable WebCrypto entirely. Open chalk over{" "}
            <code>https://</code> and this will work.
          </p>
        ) : (
          <p>
            Any current browser works: Safari 17 or newer, Firefox 132 or
            newer, Chrome or Edge 137 or newer.
          </p>
        )}
      </div>
    </div>
  );
}
