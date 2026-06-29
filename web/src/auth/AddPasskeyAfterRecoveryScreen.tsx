// AddPasskeyAfterRecoveryScreen (md-6): offered right after a recovery
// login. The user signed in with their one-time recovery code because
// this device had no passkey; this lets them enroll one immediately so
// the next sign-in uses the passkey directly instead of consuming another
// recovery code. The offer is skippable, and a passkey can also be added
// later from Profile.
//
// The add-passkey endpoints (md-4-1) are session-gated, and the recovery
// ceremony already set the chalk_session cookie, so the ceremony works
// here before the WS opens. Reuses the md-4-2 client primitives.

import { useState } from "preact/hooks";

import { addPasskeyBegin, addPasskeyFinish, ApiError } from "./api";
import { performRegistration, WebAuthnError } from "../webauthn";

interface Props {
  // Signaled when the user has either enrolled a passkey or chosen to
  // skip; the reducer then flips authStage to "authed".
  onDone: () => void;
}

export function AddPasskeyAfterRecoveryScreen({ onDone }: Props) {
  const [phase, setPhase] = useState<"offer" | "running" | "added">("offer");
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  const onAdd = async () => {
    setError("");
    setPhase("running");
    try {
      const options = await addPasskeyBegin();
      const att = await performRegistration(options);
      await addPasskeyFinish(att, name.trim());
      setPhase("added");
    } catch (e) {
      if (e instanceof WebAuthnError) {
        setError(
          e.kind === "user_cancelled"
            ? "passkey creation was cancelled."
            : e.kind === "constraint"
              ? "this device has no authenticator that meets the requirements."
              : e.message,
        );
      } else if (e instanceof ApiError) {
        setError(
          e.code === "no_session" || e.code === "invalid_session"
            ? "your session expired. please sign in again."
            : e.message || "couldn't add a passkey; please try again.",
        );
      } else {
        console.error("add passkey after recovery failed:", e);
        setError("couldn't add a passkey; see browser console.");
      }
      setPhase("offer");
    }
  };

  if (phase === "added") {
    return (
      <div class="chalk-auth" data-testid="recovery-passkey-added">
        <div class="chalk-auth-card">
          <header class="chalk-auth-header">
            <h1>passkey added</h1>
            <p class="chalk-auth-subtitle">
              this device now has its own passkey. next time you can sign in
              directly — no recovery code needed.
            </p>
          </header>
          <button
            class="chalk-button chalk-button--primary"
            onClick={onDone}
            data-testid="recovery-passkey-continue"
          >
            continue
          </button>
        </div>
      </div>
    );
  }

  return (
    <div class="chalk-auth" data-testid="recovery-passkey-offer">
      <div class="chalk-auth-card">
        <header class="chalk-auth-header">
          <h1>add a passkey to this device</h1>
          <p class="chalk-auth-subtitle">
            you signed in with your recovery code because this device had no
            passkey. add one now and you'll sign in directly next time, without
            using a recovery code. this is account sign-in only — separate from
            your 24-word decryption phrase.
          </p>
        </header>
        {error && (
          <div class="chalk-auth-error" data-testid="recovery-passkey-error">{error}</div>
        )}
        <div class="chalk-field">
          <label class="chalk-field-label" for="recovery-passkey-name">
            name (optional)
          </label>
          <input
            id="recovery-passkey-name"
            class="chalk-field-input"
            type="text"
            maxLength={64}
            placeholder="e.g. work laptop"
            autoComplete="off"
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
            disabled={phase === "running"}
            data-testid="recovery-passkey-name"
          />
        </div>
        <button
          class="chalk-button chalk-button--primary"
          onClick={onAdd}
          disabled={phase === "running"}
          data-testid="recovery-passkey-add"
        >
          {phase === "running" ? "follow your browser's prompt…" : "add a passkey to this device"}
        </button>
        <button
          class="chalk-button chalk-button--secondary"
          onClick={onDone}
          disabled={phase === "running"}
          data-testid="recovery-passkey-skip"
        >
          skip for now
        </button>
        <p class="chalk-field-hint">
          you can add a passkey later from your profile.
        </p>
      </div>
    </div>
  );
}
