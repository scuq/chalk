// chalk-web -- phase31-slice31-13 recovery-driven account reset.
//
// Supersedes RecoveryLoginScreen (phase 09b), which signed the user in on the
// recovery phrase alone. That left them stranded: auth v2 has no way to set a
// password you don't already know, so "I forgot my password" ended in a chat
// shell with no route back to a working account.
//
// This screen makes the phrase do what the user came for -- reset access:
//
//   1. form   username + 24 recovery words + a new password. Second factor:
//             a live TOTP code, unless the authenticator is what was lost, in
//             which case "reset two-factor" clears it for re-enrollment.
//             POST /recovery/reset-auth installs the password, mints a
//             session, and returns fresh recovery words.
//   2. words  the new recovery phrase (the submitted one is consumed).
//   3. totp   only when two-factor was reset: enroll + confirm a new secret,
//             using the session from step 1. Not skippable -- login requires
//             TOTP, so leaving here early would lock the account out.
//
// The new password's KEK is stashed (kek-holder) before we hand off. The reset
// purges the server-side seed wraps -- they were sealed under the OLD KEK and
// can never be opened again -- so the identity gate will ask for the 24-word
// ENCRYPTION phrase, and maybeUploadSeedWrap re-creates the wrap under the new
// password. Nothing else re-links it.

import { useMemo, useState } from "preact/hooks";
import qrcode from "qrcode-generator";
import type { MeResponse } from "./types";
import {
  deriveAuth,
  newAuthSalt,
  toB64,
  checkPasswordPolicy,
  estimateStrength,
  DEFAULT_KDF,
  PASSWORD_MIN_LENGTH,
} from "../crypto/authkdf";
import { resetAuthViaRecovery } from "./recovery-reset-api";
import { SignupApiError } from "./signup-v2-api";
import { totpEnroll, totpConfirm } from "./security-api";
import { setKEK } from "./kek-holder";
import { fetchMe } from "./api";
import { RecoveryScreen } from "./RecoveryScreen";

interface Props {
  initialUsername?: string;
  onDone: (me: MeResponse) => void;
  onFailedAfterReset: () => void;
  onGoLogin: () => void;
}

type Step = "form" | "words" | "totp";

const POLICY_LABELS: Record<string, string> = {
  length: `at least ${PASSWORD_MIN_LENGTH} characters`,
  upper: "an UPPERCASE letter",
  lower: "a lowercase letter",
  digit: "a digit",
  special: "a special character (spaces count)",
};
const STRENGTH_LABELS = ["", "weak", "okay", "good", "excellent"] as const;

// normalizePhrase mirrors the server's NormalizeRecoveryWords: lowercase,
// strip list numbering and punctuation, split on whitespace.
function normalizePhrase(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/[\s,;]+/)
    .map((w) => w.replace(/^\d+[.)]?$/, "").replace(/[^a-z]/g, ""))
    .filter((w) => w.length > 0);
}

function messageFor(e: SignupApiError): string {
  switch (e.code) {
    case "bad_username":
      return "username must be 3-32 characters: lowercase letters, digits, and underscore";
    case "unknown_user":
      return "that account doesn't exist, or has no recovery code on file";
    case "code_used":
      return "that recovery code was already used. Contact the admin if you're locked out.";
    case "invalid_words":
      return "the recovery words don't match this account (or aren't 24 valid words)";
    case "totp_required":
      return "this account has two-factor enabled: enter a code, or tick the box below to reset it";
    case "invalid_totp":
      return "that authenticator code didn't match. Wait for the next code and try again.";
    case "totp_locked":
      return "too many incorrect codes. Try again in a few minutes.";
    case "kdf_params_too_weak":
      return "this browser derived weaker key parameters than the server accepts; please report this";
    default:
      return e.message;
  }
}

export function RecoveryResetScreen({ initialUsername, onDone, onFailedAfterReset, onGoLogin }: Props) {
  const [step, setStep] = useState<Step>("form");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const [username, setUsername] = useState(initialUsername ?? "");
  const [phrase, setPhrase] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [lostAuthenticator, setLostAuthenticator] = useState(false);
  const [totpCode, setTotpCode] = useState("");

  // Populated by the reset; the phrase is shown once and never again.
  const [newWords, setNewWords] = useState<string[]>([]);
  const [userID, setUserID] = useState("");
  // 81-2: the new password's proof, carried from the reset to the TOTP
  // re-enrollment that follows it in this same screen's flow.
  const [resetProof, setResetProof] = useState("");

  // TOTP re-enrollment (step 3).
  const [provisioningURI, setProvisioningURI] = useState("");
  const [secretB32, setSecretB32] = useState("");
  const [enrollCode, setEnrollCode] = useState("");

  const words = useMemo(() => normalizePhrase(phrase), [phrase]);
  const policy = useMemo(() => checkPasswordPolicy(newPw), [newPw]);
  const strength = useMemo(() => estimateStrength(newPw), [newPw]);
  const confirmMatches = confirmPw.length > 0 && confirmPw === newPw;
  const usernameOK = /^[a-z0-9_]{3,32}$/.test(username.trim().toLowerCase());
  const codeOK = lostAuthenticator || totpCode.trim().length === 6;

  const qrDataURL = useMemo(() => {
    if (!provisioningURI) return "";
    const qr = qrcode(0, "M");
    qr.addData(provisioningURI);
    qr.make();
    return qr.createDataURL(4, 8);
  }, [provisioningURI]);

  const canSubmit =
    !busy && usernameOK && words.length === 24 && policy.ok && confirmMatches && codeOK;

  const onSubmitReset = async () => {
    setErr("");
    setBusy(true);
    try {
      const salt = newAuthSalt();
      const { authProof, kek } = await deriveAuth(newPw, { ...DEFAULT_KDF, salt });
      const authProofB64 = toB64(authProof);
      const result = await resetAuthViaRecovery({
        username: username.trim().toLowerCase(),
        words,
        auth_proof_b64: authProofB64,
        salt_b64: toB64(salt),
        kdf_alg: DEFAULT_KDF.alg,
        kdf_mem_kib: DEFAULT_KDF.memKiB,
        kdf_iters: DEFAULT_KDF.iters,
        kdf_par: DEFAULT_KDF.par,
        reset_totp: lostAuthenticator,
        totp_code: lostAuthenticator ? undefined : totpCode.trim(),
      });
      // The password is live now; hold the KEK for the seed-wrap re-upload at
      // the identity gate. Clear the credentials we no longer need.
      setKEK(kek);
      // 81-2: the TOTP re-enrollment two screens on is step-up gated. The
      // password is live as of this call, so keep its proof for that hop
      // rather than asking the user to retype what they just set.
      setResetProof(authProofB64);
      setPhrase("");
      setNewPw("");
      setConfirmPw("");
      setTotpCode("");
      setNewWords(result.recovery_words);
      setUserID(result.user_id);
      setStep("words");
    } catch (e) {
      if (e instanceof SignupApiError) setErr(messageFor(e));
      else {
        console.error("recovery reset:", e);
        setErr("Something went wrong. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  // Words acknowledged. Either re-enroll TOTP or hand off to the app.
  const onWordsConfirmed = async () => {
    setNewWords([]);
    if (!lostAuthenticator) {
      await finish();
      return;
    }
    setStep("totp");
    await startEnroll();
  };

  const startEnroll = async () => {
    setErr("");
    setBusy(true);
    try {
      const res = await totpEnroll({ auth_proof_b64: resetProof });
      setProvisioningURI(res.provisioning_uri);
      setSecretB32(res.secret_b32);
    } catch (e) {
      console.error("totp enroll after reset:", e);
      setErr(
        "Could not start two-factor setup. Your password is already reset," +
          " so you can continue and finish enrolling from account security" +
          " in your profile.",
      );
    } finally {
      setBusy(false);
    }
  };

  const onConfirmTOTP = async () => {
    setErr("");
    setBusy(true);
    try {
      await totpConfirm(enrollCode.trim());
      await finish();
    } catch (e) {
      if (e instanceof SignupApiError && e.code === "invalid_totp") {
        setErr("That code didn't match. Wait for the next code and try again.");
      } else {
        console.error("totp confirm after reset:", e);
        setErr("Something went wrong. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  // The session was minted by the reset; resolve the identity for the app.
  const finish = async () => {
    try {
      const me = await fetchMe();
      if (me) {
        onDone(me);
        return;
      }
    } catch (e) {
      console.error("post-reset /me failed:", e);
    }
    onFailedAfterReset();
  };

  if (step === "words") {
    return (
      <RecoveryScreen
        username={username.trim().toLowerCase()}
        userID={userID}
        recoveryWords={newWords}
        intent="regenerated"
        onConfirmed={() => void onWordsConfirmed()}
      />
    );
  }

  if (step === "totp") {
    return (
      <div class="chalk-auth" data-testid="recovery-reset-totp">
        <div class="chalk-auth-card">
          <h1 class="chalk-auth-title">set up two-factor again</h1>
          {err && <p class="chalk-auth-error" data-testid="recovery-reset-error">{err}</p>}
          <p class="chalk-auth-subtitle">
            Your old authenticator no longer works. Scan this with a new one,
            then confirm with a live code. Signing in requires it, so finish
            this now.
          </p>
          {provisioningURI ? (
            <>
              {qrDataURL && (
                <img class="chalk-auth-qr" src={qrDataURL} alt="TOTP setup QR code" width={192} height={192} />
              )}
              {secretB32 && <div class="chalk-auth-secret"><code>{secretB32}</code></div>}
              <label class="chalk-auth-label">
                6-digit code
                <input
                  class="chalk-auth-input"
                  inputMode="numeric"
                  maxLength={6}
                  value={enrollCode}
                  onInput={(e) => setEnrollCode((e.target as HTMLInputElement).value)}
                  autocomplete="one-time-code"
                />
              </label>
              <button
                class="chalk-auth-button"
                disabled={busy || enrollCode.trim().length !== 6}
                onClick={onConfirmTOTP}
                data-testid="recovery-reset-totp-confirm"
              >
                {busy ? "confirming..." : "Confirm and continue"}
              </button>
            </>
          ) : (
            // Enrollment couldn't start. Don't strand the user here: the reset
            // already succeeded and account security can finish the job.
            <>
              <button class="chalk-auth-button" disabled={busy} onClick={startEnroll}>
                {busy ? "starting..." : "Try again"}
              </button>
              <button class="chalk-auth-link" type="button" disabled={busy} onClick={() => void finish()}>
                continue without two-factor for now
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div class="chalk-auth" data-testid="recovery-reset">
      <div class="chalk-auth-card chalk-auth-card--wide">
        <header class="chalk-auth-header">
          <h2>reset access with your recovery phrase</h2>
          <p class="chalk-auth-subtitle">
            Use this if you've lost your password, your authenticator, or your
            passkey. Your recovery phrase is consumed; you'll get a fresh one.
          </p>
        </header>

        {err && <p class="chalk-auth-error" data-testid="recovery-reset-error">{err}</p>}

        <label class="chalk-auth-label">
          username
          <input
            class="chalk-auth-input"
            value={username}
            maxLength={32}
            onInput={(e) => setUsername((e.target as HTMLInputElement).value)}
            autocomplete="username"
            autocapitalize="none"
            autocorrect="off"
            spellcheck={false}
            data-testid="recovery-reset-username"
          />
        </label>

        <label class="chalk-auth-label">
          24 recovery words
          <textarea
            class="chalk-auth-input"
            rows={4}
            value={phrase}
            onInput={(e) => setPhrase((e.target as HTMLTextAreaElement).value)}
            autocomplete="off"
            autocapitalize="none"
            autocorrect="off"
            spellcheck={false}
            placeholder="paste your 24 recovery words here"
            data-testid="recovery-reset-phrase"
          />
        </label>
        <p class="chalk-auth-subtitle">
          {words.length === 0
            ? "separated by spaces or newlines"
            : words.length === 24
              ? "24 words detected"
              : `${words.length} word${words.length === 1 ? "" : "s"} detected — need 24`}
        </p>

        <label class="chalk-auth-label">
          new password
          <input
            class="chalk-auth-input"
            type="password"
            value={newPw}
            onInput={(e) => setNewPw((e.target as HTMLInputElement).value)}
            autocomplete="new-password"
            data-testid="recovery-reset-password"
          />
        </label>
        <label class="chalk-auth-label">
          confirm new password
          <input
            class="chalk-auth-input"
            type="password"
            value={confirmPw}
            onInput={(e) => setConfirmPw((e.target as HTMLInputElement).value)}
            autocomplete="new-password"
          />
        </label>
        <ul class="chalk-auth-checklist">
          {Object.entries(POLICY_LABELS).map(([id, label]) => {
            const met = !policy.missing.includes(id as never);
            return <li key={id} class={met ? "met" : "unmet"}>{met ? "✓" : "•"} {label}</li>;
          })}
          <li class={confirmMatches ? "met" : "unmet"}>
            {confirmMatches ? "✓" : "•"} both entries match
          </li>
        </ul>
        {newPw.length > 0 && (
          <p class={`chalk-auth-strength strength-${strength}`}>strength: {STRENGTH_LABELS[strength]}</p>
        )}

        {!lostAuthenticator && (
          <label class="chalk-auth-label">
            6-digit code from your authenticator
            <input
              class="chalk-auth-input"
              inputMode="numeric"
              maxLength={6}
              value={totpCode}
              onInput={(e) => setTotpCode((e.target as HTMLInputElement).value)}
              autocomplete="one-time-code"
              data-testid="recovery-reset-totp-code"
            />
          </label>
        )}
        <div class="chalk-field chalk-field--checkbox">
          <input
            id="recovery-reset-lost-auth"
            type="checkbox"
            checked={lostAuthenticator}
            onChange={(e) => setLostAuthenticator((e.target as HTMLInputElement).checked)}
            data-testid="recovery-reset-lost-auth"
          />
          <label class="chalk-field-label" for="recovery-reset-lost-auth">
            I've also lost my authenticator app — reset two-factor too
          </label>
        </div>

        <button
          class="chalk-auth-button"
          disabled={!canSubmit}
          onClick={onSubmitReset}
          data-testid="recovery-reset-submit"
        >
          {busy ? "resetting..." : "Reset my access"}
        </button>

        <p class="chalk-auth-footer">
          remembered it?{" "}
          <button class="chalk-auth-link" type="button" onClick={onGoLogin} disabled={busy}>
            back to sign in
          </button>
        </p>
      </div>
    </div>
  );
}
