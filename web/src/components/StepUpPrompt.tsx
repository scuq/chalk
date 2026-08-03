// chalk-web -- 81-2 "confirm it's you" form.
//
// The shared front end for every step-up-gated action: rotating the recovery
// phrase, replacing the authenticator, adding or removing a passkey. Each of
// those changes who can get back into the account, so the session cookie is
// not accepted on its own -- see internal/auth/stepup.go.
//
// The password is derived to an authProof here and handed to the caller; the
// password itself never leaves the browser and is dropped as soon as the
// action completes.

import { useState } from "preact/hooks";

import { buildStepUp, type StepUpProof } from "../auth/stepup";

interface Props {
  username: string;
  /** What the confirmation authorizes, e.g. "rotate your recovery phrase". */
  action: string;
  /** False for accounts with no confirmed authenticator (initial enrollment). */
  needsCode?: boolean;
  busy?: boolean;
  onConfirm: (proof: StepUpProof) => void | Promise<void>;
  onCancel: () => void;
  testid?: string;
}

export function StepUpPrompt({
  username,
  action,
  needsCode = true,
  busy = false,
  onConfirm,
  onCancel,
  testid = "stepup",
}: Props) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [deriving, setDeriving] = useState(false);
  const [err, setErr] = useState("");

  const working = busy || deriving;
  const ready = password.length > 0 && (!needsCode || code.trim().length === 6);

  const submit = async () => {
    setErr("");
    setDeriving(true);
    try {
      const proof = await buildStepUp(username, password, code);
      setPassword("");
      setCode("");
      await onConfirm(proof);
    } catch (e) {
      console.error("step-up:", e);
      setErr("Couldn't confirm your password. Please try again.");
    } finally {
      setDeriving(false);
    }
  };

  return (
    <div class="chalk-stepup" data-testid={testid}>
      <p class="chalk-auth-subtitle">
        Confirm it's you to {action}.
      </p>
      {err && <p class="chalk-auth-error" data-testid={`${testid}-error`}>{err}</p>}
      <label class="chalk-auth-label">
        password
        <input
          class="chalk-auth-input"
          type="password"
          value={password}
          onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
          autocomplete="current-password"
          data-testid={`${testid}-password`}
        />
      </label>
      {needsCode && (
        <label class="chalk-auth-label">
          6-digit code
          <input
            class="chalk-auth-input"
            inputMode="numeric"
            maxLength={6}
            value={code}
            onInput={(e) => setCode((e.target as HTMLInputElement).value)}
            autocomplete="one-time-code"
            data-testid={`${testid}-code`}
          />
        </label>
      )}
      <button
        class="chalk-auth-button"
        type="button"
        disabled={working || !ready}
        onClick={submit}
        data-testid={`${testid}-submit`}
      >
        {working ? "confirming..." : "Confirm"}
      </button>
      <button class="chalk-auth-link" type="button" onClick={onCancel} disabled={working}>
        cancel
      </button>
    </div>
  );
}
