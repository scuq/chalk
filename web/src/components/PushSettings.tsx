// 65-8: the push part of Settings > notifications.
// It shows a switch for push on this device and a select for the scope, which
// is direct messages or all messages. It reads the state of this session over
// the sealed WebSocket. It renders nothing when the server has push off.
// Each change goes through enablePush or disablePush in notify/push.ts.

import { useEffect, useState } from "preact/hooks";
import { TypePushState, type PushStatePayload } from "../proto";
import {
  disablePush,
  enablePush,
  pushAvailability,
  pushErrorText,
  pushSupported,
  type PushClient,
  type PushScope,
} from "../notify/push";
import { isAppleMobile } from "../voice/phone-call";

interface Props {
  /** The push_enabled value from /api/auth/config. False hides the whole part. */
  serverEnabled: boolean;
  /** Returns the live connection, or null if the connection does not exist yet. */
  client: () => PushClient | null;
  /** True while the connection is open and runs the sealed inner channel. */
  sealed: boolean;
}

// standalone reports whether chalk runs as an installed app, not in a browser tab.
function standalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia?.("(display-mode: standalone)").matches === true;
}

// permission returns the notification permission, or null if the browser has no Notification API.
function permission(): NotificationPermission | null {
  return typeof Notification === "undefined" ? null : Notification.permission;
}

/**
 * PushSettings renders the push switch and the scope select for this device.
 * It renders a hint instead of the controls when the device cannot use push.
 */
export function PushSettings({ serverEnabled, client, sealed }: Props) {
  const [state, setState] = useState<PushStatePayload | null>(null);
  const [scope, setScope] = useState<PushScope>("dms");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [perm, setPerm] = useState(permission());

  const avail = pushAvailability({
    serverEnabled,
    supported: pushSupported(),
    sealed,
    appleMobile: isAppleMobile(navigator.userAgent, navigator.platform, navigator.maxTouchPoints ?? 0),
    standalone: standalone(),
    permission: perm,
  });

  useEffect(() => {
    if (avail !== "ready" && avail !== "denied") return;
    const c = client();
    if (!c) return;
    let live = true;
    c.request<undefined, PushStatePayload>(TypePushState)
      .then((s) => {
        if (!live) return;
        setState(s);
        if (s.scope) setScope(s.scope);
      })
      .catch((err) => live && setError(pushErrorText(err)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avail]);

  if (avail === "server-off") return null;

  const on = !!state?.subscribed;

  const run = async (f: (c: PushClient) => Promise<PushStatePayload>) => {
    const c = client();
    if (!c) return;
    setBusy(true);
    setError(null);
    try {
      const s = await f(c);
      setState(s);
      if (s.scope) setScope(s.scope);
    } catch (err) {
      setError(pushErrorText(err));
    } finally {
      setPerm(permission());
      setBusy(false);
    }
  };

  const toggle = (want: boolean) => {
    // enablePush asks for permission, so it must run inside this click handler.
    void run((c) => (want ? enablePush(c, scope) : disablePush(c)));
  };

  const changeScope = (next: PushScope) => {
    setScope(next);
    if (on) void run((c) => enablePush(c, next));
  };

  return (
    <div class="chalk-profile-field chalk-profile-push" data-testid="notify-push">
      {avail === "ios-home-screen" && (
        <p class="chalk-profile-hint" data-testid="notify-push-ios">
          push on an iPhone or iPad needs chalk on the Home Screen. in Safari, tap Share, then Add to Home Screen, and
          open chalk from there.
        </p>
      )}
      {avail === "unsupported" && (
        <p class="chalk-profile-hint" data-testid="notify-push-unsupported">
          this browser cannot receive push.
        </p>
      )}
      {avail === "unsealed" && (
        <p class="chalk-profile-hint" data-testid="notify-push-unsealed">
          push needs a sealed connection to this server. this connection is not sealed.
        </p>
      )}
      {(avail === "ready" || avail === "denied") && (
        <>
          <label class="chalk-profile-checkbox-label">
            <input
              type="checkbox"
              checked={on}
              disabled={busy || state === null || avail === "denied"}
              onChange={(e) => toggle((e.target as HTMLInputElement).checked)}
              data-testid="notify-push-toggle"
            />
            <span>
              push notifications on this device
              <span class="chalk-profile-desc">
                a notice when you are away or offline in chalk. it names the sender, and the channel if the message
                is in one, never the message text.
              </span>
            </span>
          </label>
          <label class="chalk-profile-label" for="notify-push-scope">
            push for
          </label>
          <select
            id="notify-push-scope"
            class="chalk-profile-select"
            value={scope}
            disabled={busy || avail === "denied"}
            onChange={(e) => changeScope((e.target as HTMLSelectElement).value === "all" ? "all" : "dms")}
            data-testid="notify-push-scope"
          >
            <option value="dms">direct messages</option>
            <option value="all">all messages</option>
          </select>
          {avail === "denied" && (
            <p class="chalk-profile-hint" data-testid="notify-push-denied">
              notifications are blocked for chalk in this browser. allow them in the site settings, then reload.
            </p>
          )}
        </>
      )}
      {error && (
        <p class="chalk-profile-hint" role="alert" data-testid="notify-push-error">
          {error}
        </p>
      )}
    </div>
  );
}
