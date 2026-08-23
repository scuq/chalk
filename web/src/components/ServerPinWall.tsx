// 83-6: the server-identity wall.
//
// Shown when the home server proves an Ed25519 identity other than the one
// this device pinned. Two things produce that: an operator rotated the key
// (they announce the new fingerprint out of band, the user compares and
// trusts it), or a MITM is answering for the server (the fingerprints will
// not match what the operator announced -- the user bails). The wall never
// resolves silently: trusting is an explicit action, exactly the property
// the pin exists to give.

interface Props {
  wall: { seenFingerprint: string; pinnedFingerprint: string };
  onTrust: () => void;
}

export function ServerPinWall({ wall, onTrust }: Props) {
  return (
    <div class="chalk-pinwall" data-testid="server-pin-wall">
      <div class="chalk-pinwall-card">
        <h1>This server’s identity changed</h1>
        <p>
          chalk pinned this server’s identity when you registered, and the key it is
          presenting now is different. This is expected only if your server’s operator
          told you they rotated it — otherwise someone may be intercepting your
          connection.
        </p>
        <dl class="chalk-pinwall-fps">
          <dt>Key you trusted</dt>
          <dd>
            <code>{wall.pinnedFingerprint}</code>
          </dd>
          <dt>Key being presented</dt>
          <dd>
            <code data-testid="pinwall-seen">{wall.seenFingerprint}</code>
          </dd>
        </dl>
        <p class="chalk-pinwall-guidance">
          Only continue if the presented fingerprint matches the one your operator
          announced. If it doesn’t, close this tab and reach your operator another way.
        </p>
        <button type="button" class="chalk-pinwall-trust" onClick={onTrust} data-testid="pinwall-trust">
          The fingerprint matches — trust this key
        </button>
      </div>
    </div>
  );
}
