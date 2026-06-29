// ProfilePanel: in-chat modal for managing the user's own profile.
// Phase 09c-2.
//
// Three sections:
//
//   1. Identity (read-only): username, display name, email,
//      session expiry.
//
//   2. Change email: form for starting the email-change flow.
//      On submit, the server sends a verify link to the new
//      address and a notification to the old. The user must click
//      the link in the new inbox to finalize. After submit, this
//      panel shows a "verification email sent" summary until
//      dismissed or the panel is closed.
//
//   3. Rotate recovery code: button that calls /api/auth/recovery/
//      regenerate, displays the new 24-word phrase in a confirm-
//      and-continue gate (RecoveryScreen intent="regenerated").
//      A user might do this if they suspect their old phrase
//      was compromised, or just for periodic hygiene.
//
// All three live in the same modal. Section 3 is heavy enough that
// when active it takes over the modal body (the identity + change-
// email sections fade out, the recovery view fades in). A back
// button returns to the main panel without rotating, in case the
// user clicked it by accident.

import { useEffect, useState } from "preact/hooks";
import type { EmailChangeState, MeResponse } from "../auth/types";
import {
  regenerateRecovery,
  ApiError,
  listPasskeys,
  addPasskeyBegin,
  addPasskeyFinish,
  type PasskeyInfo,
} from "../auth/api";
import { performRegistration, WebAuthnError } from "../webauthn";
import { RecoveryScreen } from "../auth/RecoveryScreen";

interface Props {
  me: MeResponse;
  emailChange: EmailChangeState;
  onClose: () => void;
  onEmailChangeDraft: (value: string) => void;
  onEmailChangeSubmit: () => void;
  onEmailChangeDismiss: () => void;
  // Refresh re-fetches /api/auth/me so identity fields stay current
  // (e.g. if you verified an email change in another tab). Optional —
  // if the parent doesn't wire it, the refresh button doesn't render.
  onRefresh?: () => void;
  refreshing?: boolean;
  // Phase 9.7b: theme picker.
  theme?: string;
  onSetTheme?: (theme: string) => void;
  // Phase 9.7d: chat display prefs.
  chatPrefs?: {
    showTimestamps: boolean;
    timestampFormat: "hms" | "hm" | "relative";
    compactMode: boolean;
    // Phase 9.7e:
    userColors: { handle: string; color: string; scope: "all" | "dm" }[];
  };
  onSetChatPref?: <K extends "showTimestamps" | "timestampFormat" | "compactMode">(
    key: K,
    value: K extends "timestampFormat" ? "hms" | "hm" | "relative" : boolean,
  ) => void;
  // Phase 9.7e: replace the entire userColors list. We send the full
  // array on every change because JSONB || is a shallow merge so a
  // partial update would clobber the rest of chat prefs anyway.
  onSetUserColors?: (rules: { handle: string; color: string; scope: "all" | "dm" }[]) => void;
  // att-2: clear the cached attachment ciphertext (the "clear cached images"
  // guardrail). Optional -- only rendered when the parent wires it.
  onClearImageCache?: () => void | Promise<void>;
  // att-4b: Giphy consent (tri-state). giphyPref is the current resolved
  // value; onSetGiphyPref sets it directly (used for the "disable" path);
  // onRequestEnableGiphy opens the app-level consent modal (the "enable"
  // path, so the leak is explained before the pref flips to "enabled").
  giphyPref?: "unset" | "enabled" | "disabled";
  onSetGiphyPref?: (v: "enabled" | "disabled") => void;
  onRequestEnableGiphy?: () => void;
}

export function ProfilePanel({
  me,
  emailChange,
  theme,
  onSetTheme,
  chatPrefs,
  onSetChatPref,
  onSetUserColors,
  onClearImageCache,
  giphyPref,
  onSetGiphyPref,
  onRequestEnableGiphy,
  onClose,
  onEmailChangeDraft,
  onEmailChangeSubmit,
  onEmailChangeDismiss,
  onRefresh,
  refreshing,
}: Props) {
  // Local UI state: are we in the rotate-recovery sub-view?
  // Local because no other component cares.
  const [rotateView, setRotateView] = useState<"idle" | "loading" | "showing" | "error">("idle");
  const [rotatedWords, setRotatedWords] = useState<string[] | null>(null);
  const [rotateError, setRotateError] = useState<string>("");
  // att-2: transient "cleared" confirmation for the image cache control.
  const [imageCacheCleared, setImageCacheCleared] = useState(false);

  // md-4-2: passkey management. The list loads on mount; addState gates
  // the add button while the browser ceremony runs. null list = not yet
  // loaded.
  const [passkeys, setPasskeys] = useState<PasskeyInfo[] | null>(null);
  const [passkeysError, setPasskeysError] = useState<string>("");
  const [addState, setAddState] = useState<"idle" | "running">("idle");
  const [addError, setAddError] = useState<string>("");
  const [newPasskeyName, setNewPasskeyName] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await listPasskeys();
        if (!cancelled) {
          setPasskeys(list);
          setPasskeysError("");
        }
      } catch (e) {
        if (!cancelled) {
          setPasskeys([]);
          setPasskeysError(e instanceof ApiError ? e.message : "couldn't load passkeys");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onAddPasskey = async () => {
    setAddError("");
    setAddState("running");
    try {
      const options = await addPasskeyBegin();
      const att = await performRegistration(options);
      const created = await addPasskeyFinish(att, newPasskeyName.trim());
      setPasskeys((prev) => (prev ? [...prev, created] : [created]));
      setNewPasskeyName("");
    } catch (e) {
      if (e instanceof WebAuthnError) {
        setAddError(
          e.kind === "user_cancelled"
            ? "passkey creation was cancelled."
            : e.kind === "constraint"
              ? "this device has no authenticator that meets the requirements."
              : e.message,
        );
      } else if (e instanceof ApiError) {
        setAddError(friendlyAddPasskeyError(e.code, e.message));
      } else {
        console.error("add passkey failed:", e);
        setAddError("couldn't add a passkey; see browser console.");
      }
    } finally {
      setAddState("idle");
    }
  };

  // Close on Escape (only when not in rotate-showing state; we
  // don't want a stray keypress to lose the new recovery words).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (rotateView === "showing") return;
      onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, rotateView]);

  const startRotate = async () => {
    setRotateView("loading");
    setRotateError("");
    try {
      const words = await regenerateRecovery();
      if (words.length !== 24) {
        setRotateView("error");
        setRotateError(`server returned ${words.length} words; expected 24`);
        return;
      }
      setRotatedWords(words);
      setRotateView("showing");
    } catch (e) {
      console.error("rotate recovery failed:", e);
      setRotateView("error");
      setRotateError(e instanceof ApiError
        ? `${e.code}: ${e.message}`
        : e instanceof Error ? e.message : "unknown error");
    }
  };

  const finishRotate = () => {
    setRotatedWords(null);
    setRotateView("idle");
  };

  // ---- rotate-showing view (full-modal takeover) ----------------------

  if (rotateView === "showing" && rotatedWords) {
    return (
      <div class="chalk-modal-backdrop" data-testid="profile-panel-rotate-backdrop">
        <div class="chalk-modal chalk-modal--wide" data-testid="profile-panel-rotate" role="dialog">
          <RecoveryScreen
            username={me.username}
            userID={me.userID}
            recoveryWords={rotatedWords}
            intent="regenerated"
            onConfirmed={finishRotate}
          />
        </div>
      </div>
    );
  }

  // ---- main view -------------------------------------------------------

  const submitEmailDisabled =
    emailChange.busy ||
    !emailChange.draft.trim() ||
    emailChange.draft.trim().toLowerCase() === me.email.toLowerCase();

  const emailBannerError = emailChange.errorCode && emailChange.errorMessage
    ? friendlyEmailChangeError(emailChange.errorCode, emailChange.errorMessage)
    : null;

  return (
    <div
      class="chalk-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="profile-panel-backdrop"
    >
      <div class="chalk-modal" data-testid="profile-panel" role="dialog" aria-label="profile">
        <header class="chalk-modal-header">
          <h2>profile</h2>
          <div class="chalk-modal-header-actions">
            {onRefresh && (
              <button
                type="button"
                class={`chalk-modal-refresh${refreshing ? " chalk-modal-refresh--spinning" : ""}`}
                onClick={onRefresh}
                disabled={refreshing}
                aria-label="refresh"
                title="refresh"
                data-testid="profile-panel-refresh"
              >
                ↻
              </button>
            )}
            <button
              type="button"
              class="chalk-modal-close"
              onClick={onClose}
              aria-label="close"
              data-testid="profile-panel-close"
            >
              ×
            </button>
          </div>
        </header>

        <div class="chalk-modal-body">
          {/* Identity section */}
          <section class="chalk-profile-identity">
            <h3>identity</h3>
            <dl class="chalk-profile-fields">
              <dt>username</dt>
              <dd data-testid="profile-username">@{me.username}</dd>

              <dt>display name</dt>
              <dd>{me.displayName || <em>(none set)</em>}</dd>

              <dt>email</dt>
              <dd data-testid="profile-email">{me.email}</dd>

              <dt>role</dt>
              <dd>{me.role}</dd>

              <dt>session</dt>
              <dd>expires {formatTimestamp(me.sessionExpiresAt)}</dd>
            </dl>
          </section>

          {onSetTheme && (
            <section class="chalk-profile-appearance">
              <h3>appearance</h3>
              <div class="chalk-profile-field">
                <label class="chalk-profile-label" for="theme-picker">theme</label>
                <div class="chalk-profile-theme-picker" id="theme-picker" role="radiogroup" aria-label="theme">
                  {(["green", "light", "cyberpunk", "solarized-dark"] as const).map((t) => (
                    <label
                      key={t}
                      class={`chalk-profile-theme-option ${(theme ?? "green") === t ? "chalk-profile-theme-option--active" : ""}`}
                    >
                      <input
                        type="radio"
                        name="theme"
                        value={t}
                        checked={(theme ?? "green") === t}
                        onChange={() => onSetTheme(t)}
                        data-testid={`theme-option-${t}`}
                      />
                      <span class="chalk-profile-theme-swatch">
                        <span class={`chalk-profile-theme-swatch-preview chalk-profile-theme-swatch-preview--${t}`} aria-hidden="true" />
                        <span class="chalk-profile-theme-name">{t}</span>
                        <span class="chalk-profile-theme-desc">
                          {
                            t === "green" ? "default terminal" :
                            t === "light" ? "warm cream" :
                            t === "cyberpunk" ? "neon violet-black" :
                            "solarized dark"
                          }
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
                <p class="chalk-profile-hint">
                  the theme follows you across devices.
                </p>
              </div>
            </section>
          )}

          {onSetChatPref && chatPrefs && (
            <section class="chalk-profile-chat">
              <h3>chat</h3>
              <div class="chalk-profile-field">
                <label class="chalk-profile-checkbox-label">
                  <input
                    type="checkbox"
                    checked={chatPrefs.showTimestamps}
                    onChange={(e) =>
                      onSetChatPref("showTimestamps", (e.target as HTMLInputElement).checked)
                    }
                    data-testid="chat-show-timestamps"
                  />
                  <span>show timestamps</span>
                </label>
              </div>
              <div class="chalk-profile-field">
                <label class="chalk-profile-label" for="timestamp-format">timestamp format</label>
                <select
                  id="timestamp-format"
                  class="chalk-profile-select"
                  value={chatPrefs.timestampFormat}
                  disabled={!chatPrefs.showTimestamps}
                  onChange={(e) =>
                    onSetChatPref(
                      "timestampFormat",
                      (e.target as HTMLSelectElement).value as "hms" | "hm" | "relative",
                    )
                  }
                  data-testid="chat-timestamp-format"
                >
                  <option value="hms">22:53:01 (hh:mm:ss)</option>
                  <option value="hm">22:53 (hh:mm)</option>
                  <option value="relative">5m ago (relative)</option>
                </select>
              </div>
              <div class="chalk-profile-field">
                <label class="chalk-profile-checkbox-label">
                  <input
                    type="checkbox"
                    checked={chatPrefs.compactMode}
                    onChange={(e) =>
                      onSetChatPref("compactMode", (e.target as HTMLInputElement).checked)
                    }
                    data-testid="chat-compact-mode"
                  />
                  <span>compact mode <span class="chalk-profile-theme-desc">(tighter row spacing)</span></span>
                </label>
              </div>
              {onSetUserColors && (
                <div class="chalk-profile-field">
                  <div class="chalk-profile-label">username colors</div>
                  <p class="chalk-profile-hint" style={{ marginTop: 0 }}>
                    custom display color for specific users in the chat
                    feed (sender label only, not the roster).
                  </p>
                  <div class="chalk-user-colors">
                    {chatPrefs.userColors.length === 0 && (
                      <div class="chalk-user-colors-empty">
                        no rules yet.
                      </div>
                    )}
                    {chatPrefs.userColors.map((rule, idx) => (
                      <div class="chalk-user-colors-row" key={idx}>
                        <input
                          type="text"
                          class="chalk-user-colors-handle"
                          placeholder="username"
                          value={rule.handle}
                          onInput={(e) => {
                            const next = chatPrefs.userColors.slice();
                            next[idx] = { ...rule, handle: (e.target as HTMLInputElement).value };
                            onSetUserColors(next);
                          }}
                          data-testid={`user-color-handle-${idx}`}
                        />
                        <input
                          type="color"
                          class="chalk-user-colors-color"
                          value={rule.color || "#888888"}
                          onChange={(e) => {
                            const next = chatPrefs.userColors.slice();
                            next[idx] = { ...rule, color: (e.target as HTMLInputElement).value };
                            onSetUserColors(next);
                          }}
                          data-testid={`user-color-color-${idx}`}
                        />
                        <select
                          class="chalk-profile-select chalk-user-colors-scope"
                          value={rule.scope}
                          onChange={(e) => {
                            const next = chatPrefs.userColors.slice();
                            next[idx] = { ...rule, scope: (e.target as HTMLSelectElement).value as "all" | "dm" };
                            onSetUserColors(next);
                          }}
                          data-testid={`user-color-scope-${idx}`}
                        >
                          <option value="all">all channels</option>
                          <option value="dm">DMs only</option>
                        </select>
                        <button
                          type="button"
                          class="chalk-user-colors-delete"
                          onClick={() => {
                            const next = chatPrefs.userColors.filter((_, i) => i !== idx);
                            onSetUserColors(next);
                          }}
                          title="delete rule"
                          data-testid={`user-color-delete-${idx}`}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    class="chalk-user-colors-add"
                    onClick={() => {
                      const next = chatPrefs.userColors.slice();
                      next.push({ handle: "", color: "#88ccff", scope: "all" });
                      onSetUserColors(next);
                    }}
                    data-testid="user-color-add"
                  >
                    + add color
                  </button>
                </div>
              )}
            </section>
          )}

          {/* att-2: storage -- clear the cached attachment ciphertext. */}
          {onClearImageCache && (
            <section class="chalk-profile-storage">
              <h3>storage</h3>
              <div class="chalk-profile-field">
                <button
                  type="button"
                  class="chalk-profile-clear-cache"
                  onClick={() => {
                    void Promise.resolve(onClearImageCache()).then(() => {
                      setImageCacheCleared(true);
                      setTimeout(() => setImageCacheCleared(false), 3000);
                    });
                  }}
                  data-testid="clear-image-cache"
                >
                  clear cached images
                </button>
                <p class="chalk-profile-hint" style={{ marginTop: "0.5rem" }}>
                  {imageCacheCleared
                    ? "cached images cleared."
                    : "removes locally cached attachment data from this device. images re-download from the server on next view."}
                </p>
              </div>
            </section>
          )}

          {/* att-4b: Giphy consent. Enabling routes through the app-level
              consent modal (onRequestEnableGiphy) so the privacy tradeoff is
              explained first; disabling is direct. Per-device, default off. */}
          {onSetGiphyPref && (
            <section class="chalk-profile-storage" data-testid="giphy-settings">
              <h3>giphy</h3>
              <div class="chalk-profile-field">
                <label class="chalk-profile-checkbox-label">
                  <input
                    type="checkbox"
                    checked={giphyPref === "enabled"}
                    onChange={(e) => {
                      const on = (e.target as HTMLInputElement).checked;
                      if (on) {
                        if (onRequestEnableGiphy) onRequestEnableGiphy();
                        else onSetGiphyPref("enabled");
                      } else {
                        onSetGiphyPref("disabled");
                      }
                    }}
                    data-testid="giphy-toggle"
                  />
                  enable Giphy GIFs
                </label>
                <p class="chalk-profile-hint" style={{ marginTop: "0.5rem" }}>
                  {giphyPref === "enabled"
                    ? "on: Giphy messages render as GIFs, fetched from Giphy's CDN. Your IP and the GIF you view are visible to Giphy. Per-device; affects only you."
                    : giphyPref === "disabled"
                      ? "off: Giphy messages show as plain links and are never fetched. Nothing reaches Giphy."
                      : "not set: Giphy messages show as plain links until you opt in. Enabling lets your browser fetch GIFs from Giphy's CDN, revealing your IP to Giphy."}
                </p>
              </div>
            </section>
          )}

          {/* Email change section */}
          <section class="chalk-profile-email-change">
            <h3>change email</h3>
            {emailChange.pendingSummary ? (
              <div class="chalk-profile-pending" data-testid="profile-email-pending">
                <p>
                  we sent a verification email to{" "}
                  <strong>{emailChange.pendingSummary.newEmail}</strong>.
                </p>
                <p class="chalk-auth-subtitle">
                  click the link in that email to complete the change.
                  it expires on {formatTimestamp(emailChange.pendingSummary.expiresAt)}.
                </p>
                <p class="chalk-auth-subtitle">
                  we also notified your current email address as a
                  security heads-up.
                </p>
                <button
                  type="button"
                  class="chalk-button chalk-button--secondary"
                  onClick={onEmailChangeDismiss}
                  data-testid="profile-email-pending-dismiss"
                >
                  ok
                </button>
              </div>
            ) : (
              <form
                class="chalk-auth-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (submitEmailDisabled) return;
                  onEmailChangeSubmit();
                }}
                data-testid="profile-email-form"
              >
                {emailBannerError && (
                  <div class="chalk-auth-error" data-testid="profile-email-error">
                    {emailBannerError}
                  </div>
                )}
                <div class="chalk-field">
                  <label class="chalk-field-label" for="profile-email-new">
                    new email
                  </label>
                  <input
                    id="profile-email-new"
                    class="chalk-field-input"
                    type="email"
                    autoComplete="email"
                    autoCapitalize="none"
                    required
                    value={emailChange.draft}
                    disabled={emailChange.busy}
                    onInput={(e) => onEmailChangeDraft((e.target as HTMLInputElement).value)}
                    data-testid="profile-email-input"
                  />
                  <span class="chalk-field-hint">
                    a verification link will be sent to this address;
                    the change isn't final until you click it
                  </span>
                </div>
                <button
                  type="submit"
                  class="chalk-button chalk-button--primary"
                  disabled={submitEmailDisabled}
                  data-testid="profile-email-submit"
                >
                  {emailChange.busy ? "sending..." : "send verification email"}
                </button>
              </form>
            )}
          </section>

          {/* Rotate recovery section */}
          <section class="chalk-profile-rotate">
            <h3>recovery code</h3>
            <p class="chalk-auth-subtitle">
              if you suspect your recovery phrase has been seen by
              someone else, you can rotate it now. doing so consumes
              the existing phrase; you'll be shown a fresh one
              immediately.
            </p>
            {rotateView === "error" && (
              <div class="chalk-auth-error" data-testid="profile-rotate-error">
                {rotateError}
              </div>
            )}
            <button
              type="button"
              class="chalk-button chalk-button--secondary"
              onClick={startRotate}
              disabled={rotateView === "loading"}
              data-testid="profile-rotate-button"
            >
              {rotateView === "loading" ? "rotating..." : "rotate recovery code"}
            </button>
          </section>

          {/* md-4-2: passkeys. Account access is per-device; add a passkey
              on each device you use so you don't have to fall back to the
              one-time recovery code. Distinct from the 24-word decryption
              phrase, which is client-only and unlocks message history. */}
          <section class="chalk-profile-passkeys" data-testid="profile-passkeys">
            <h3>passkeys</h3>
            <p class="chalk-auth-subtitle">
              passkeys are how you sign in to this account. add one on each
              device you use, so you don't have to fall back to your recovery
              code. this is account sign-in only — it's separate from your
              24-word decryption phrase, which unlocks your message history.
            </p>
            {passkeysError && (
              <div class="chalk-auth-error" data-testid="passkeys-load-error">{passkeysError}</div>
            )}
            {passkeys === null ? (
              <p class="chalk-profile-hint">loading…</p>
            ) : passkeys.length === 0 ? (
              <p class="chalk-profile-hint" data-testid="passkeys-empty">
                no passkeys on this account yet.
              </p>
            ) : (
              <ul class="chalk-profile-passkey-list" data-testid="passkey-list" style={{ listStyle: "none", padding: 0, margin: "0 0 0.75rem 0" }}>
                {passkeys.map((pk) => (
                  <li key={pk.id} class="chalk-profile-passkey" style={{ padding: "0.35rem 0", borderBottom: "1px solid var(--chalk-border, rgba(255,255,255,0.08))" }}>
                    <div>{pk.name || "unnamed passkey"}</div>
                    <div class="chalk-profile-hint" style={{ marginTop: 0 }}>
                      added {formatMillis(pk.createdAt)}
                      {pk.lastUsedAt ? ` · last used ${formatMillis(pk.lastUsedAt)}` : " · never used"}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {addError && (
              <div class="chalk-auth-error" data-testid="add-passkey-error">{addError}</div>
            )}
            <div class="chalk-profile-field">
              <label class="chalk-profile-label" for="new-passkey-name">name (optional)</label>
              <input
                id="new-passkey-name"
                class="chalk-field-input"
                type="text"
                maxLength={64}
                placeholder="e.g. work laptop"
                autoComplete="off"
                value={newPasskeyName}
                onInput={(e) => setNewPasskeyName((e.target as HTMLInputElement).value)}
                disabled={addState === "running"}
                data-testid="new-passkey-name"
              />
            </div>
            <button
              type="button"
              class="chalk-button chalk-button--secondary"
              onClick={onAddPasskey}
              disabled={addState === "running"}
              data-testid="add-passkey-button"
            >
              {addState === "running" ? "follow your browser's prompt…" : "add a passkey to this device"}
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}

function friendlyAddPasskeyError(code: string, message: string): string {
  switch (code) {
    case "ceremony_validation_failed":
      return "that passkey couldn't be verified. please try again.";
    case "ceremony_expired":
      return "the request timed out. please try again.";
    case "ceremony_not_found":
      return "the request couldn't be matched. please try again.";
    case "persist_failed":
      return "couldn't save the passkey — it may already be registered on this device.";
    case "ceremony_user_mismatch":
    case "no_session":
    case "invalid_session":
      return "your session expired. please log in again.";
    default:
      return message || "couldn't add a passkey; see browser console.";
  }
}

function formatMillis(ms: number): string {
  try {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

function friendlyEmailChangeError(code: string, message: string): string {
  switch (code) {
    case "bad_email":
      return "that doesn't look like a valid email address.";
    case "same_email":
      return "the new email is the same as your current one.";
    case "email_blacklisted":
      return "that email cannot be used.";
    case "email_taken":
      return "that email is already in use by another account.";
    case "email_pending_elsewhere":
      return "that email has a pending change for another account.";
    default:
      return message || "couldn't start email change; see browser console.";
  }
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
