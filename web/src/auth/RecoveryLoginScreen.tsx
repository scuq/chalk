// RecoveryLoginScreen: the "I lost my passkey" entry point. Phase 09b
// sub-step 6.
//
// Inputs:
//   - username (required, normal shape constraints)
//   - phrase (required, 24 words separated by whitespace)
//
// On submit:
//   1. Normalize the phrase to an array of 24 lowercase words.
//   2. POST /api/auth/recovery {username, words}. Server validates
//      the argon2id hash, marks the code as USED, mints a session,
//      and Set-Cookies chalk_session.
//   3. Dispatch auth_recovered → state machine moves to
//      regenerate-after-recovery → RegenerateScreen renders.
//
// Errors (all rendered as a banner above the form):
//   - bad_username      → username shape invalid (server)
//   - unknown_user      → no such account, or no recovery code on file
//   - code_used         → the user's recovery code was already used
//   - invalid_words     → wrong count, bad characters, or hash mismatch
//   - network_failure   → couldn't reach the server
//
// The phrase field is a textarea so users can paste a multi-line
// version (e.g. "01. word\n02. word\n..."). Normalization strips
// numbering, lowercases, and splits on whitespace; non-alpha chars
// are dropped. This matches the server's NormalizeRecoveryWords.

import type { RecoveryLoginForm, RecoveryLoginResult } from "./types";
import { recoveryLogin, ApiError } from "./api";

interface Props {
  form: RecoveryLoginForm;
  onFieldChange: (field: keyof RecoveryLoginForm, value: string) => void;
  onSubmitStart: () => void;
  onSubmitError: (code: string, message: string) => void;
  onRecovered: (result: RecoveryLoginResult) => void;
  onGoLogin: () => void;
}

// normalizePhrase splits the user's textarea content into an array
// of clean words. Mirror of the server's NormalizeRecoveryWords:
//   - lowercase
//   - strip leading "NN. " or "NN) " prefixes
//   - drop non-alphabetic characters (digits, punctuation)
//   - split on whitespace, filter empties
function normalizePhrase(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/[\s,;]+/)
    .map((w) => w.replace(/^\d+[.)]?$/, "").replace(/[^a-z]/g, ""))
    .filter((w) => w.length > 0);
}

function errorMessageFor(code: string | null, message: string | null): string {
  if (!code) return "";
  switch (code) {
    case "bad_username":
      return "username must be 3-32 characters: lowercase letters, digits, and underscore";
    case "unknown_user":
      return "that account doesn't exist, or has no recovery code on file";
    case "code_used":
      return "that recovery code was already used. Contact the admin if you're locked out.";
    case "invalid_words":
      return "the recovery words don't match this account (or aren't 24 valid words)";
    case "bad_json":
    case "bad_request":
      return "the form didn't submit correctly; refresh and try again";
    case "network_failure":
      return `cannot reach server: ${message ?? "unknown error"}`;
    default:
      return message ?? "something went wrong; please try again";
  }
}

export function RecoveryLoginScreen({
  form,
  onFieldChange,
  onSubmitStart,
  onSubmitError,
  onRecovered,
  onGoLogin,
}: Props) {
  const errorText = errorMessageFor(form.errorCode, form.errorMessage);
  const words = normalizePhrase(form.phrase);
  const wordCount = words.length;
  const wordCountOK = wordCount === 24;
  const canSubmit = !form.busy && form.username.trim().length >= 3 && wordCountOK;

  async function handleSubmit(e: Event) {
    e.preventDefault();
    const username = form.username.trim().toLowerCase();
    if (username.length < 3) {
      onSubmitError("bad_username", "username too short");
      return;
    }
    if (words.length !== 24) {
      onSubmitError("invalid_words",
        `expected 24 words; got ${words.length}`);
      return;
    }
    onSubmitStart();
    try {
      const result = await recoveryLogin(username, words);
      onRecovered(result);
    } catch (e) {
      if (e instanceof ApiError) {
        onSubmitError(e.code, e.message);
        return;
      }
      console.error("recovery login failed:", e);
      onSubmitError("unknown",
        e instanceof Error ? e.message : "unknown error");
    }
  }

  return (
    <div class="chalk-auth">
      <div class="chalk-auth-card chalk-auth-card--wide">
        <header class="chalk-auth-header">
          <h2>recover with your recovery code</h2>
          <p class="chalk-auth-subtitle">
            use this if you've lost your passkey. Your old recovery code
            will be consumed; you'll get a fresh one immediately.
          </p>
        </header>

        {errorText && (
          <div class="chalk-auth-error" data-testid="recovery-login-error">
            {errorText}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div class="chalk-field">
            <label class="chalk-field-label" for="recovery-login-username">
              username
            </label>
            <input
              id="recovery-login-username"
              class="chalk-field-input"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellcheck={false}
              maxLength={32}
              minLength={3}
              value={form.username}
              disabled={form.busy}
              onInput={(e) => onFieldChange("username", (e.target as HTMLInputElement).value)}
              data-testid="recovery-login-username"
            />
            <span class="chalk-field-hint">
              the username you registered with
            </span>
          </div>

          <div class="chalk-field">
            <label class="chalk-field-label" for="recovery-login-phrase">
              recovery words
            </label>
            <textarea
              id="recovery-login-phrase"
              class="chalk-field-input chalk-field-input--textarea"
              rows={6}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellcheck={false}
              value={form.phrase}
              disabled={form.busy}
              onInput={(e) => onFieldChange("phrase", (e.target as HTMLTextAreaElement).value)}
              data-testid="recovery-login-phrase"
              placeholder="paste your 24 recovery words here"
            />
            <span class={`chalk-field-hint ${wordCountOK || wordCount === 0 ? "" : "chalk-field-hint--warn"}`}>
              {wordCount === 0
                ? "24 words separated by spaces or newlines"
                : wordCountOK
                  ? "24 words detected — ready to submit"
                  : `${wordCount} word${wordCount === 1 ? "" : "s"} detected — need 24`}
            </span>
          </div>

          <button
            type="submit"
            class="chalk-button chalk-button--primary"
            disabled={!canSubmit}
            data-testid="recovery-login-submit"
          >
            {form.busy ? "verifying..." : "recover account"}
          </button>
        </form>

        <div class="chalk-auth-alt">
          remembered your passkey?{" "}
          <button
            type="button"
            class="chalk-auth-link"
            onClick={onGoLogin}
            disabled={form.busy}
            data-testid="recovery-login-go-login"
          >
            log in
          </button>
        </div>
      </div>
    </div>
  );
}
