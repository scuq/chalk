// chalk-web -- phase31-slice31-9 migration wizard.
//
// Shown (by App's gate) to a logged-in user whose account predates auth v2:
// they signed in -- typically via passkey -- but have no password + confirmed
// TOTP. The wizard walks them through both, then completes enrollment:
//
//   1. password  choose + confirm + policy checklist + meter
//                -> POST /api/auth/migration/password
//   2. totp      QR + copy-paste secret + live code
//                -> totp/enroll + totp/confirm (staging path)
//   3. done      -> POST /api/auth/migration/complete -> onDone()
//
// Their EXISTING recovery phrase and encryption phrase are untouched. This
// device already holds its identity, so chat keeps working the moment the
// wizard closes. A note points at Profile -> account security -> "re-link
// encryption phrase" to enable password-unlock on NEW devices (the wizard
// cannot do it silently: the phrase's entropy never touches this device's
// storage, only the derived keys do).

import { useMemo, useState } from "preact/hooks";
import qrcode from "qrcode-generator";
import {
  deriveAuth,
  newAuthSalt,
  toB64,
  checkPasswordPolicy,
  estimateStrength,
  DEFAULT_KDF,
  PASSWORD_MIN_LENGTH,
} from "../crypto/authkdf";
import { migrationPassword, migrationComplete } from "./migration-api";
import { totpEnroll, totpConfirm } from "./security-api";
import { SignupApiError } from "./signup-v2-api";

interface Props {
  onDone: () => void;
}

type Step = "password" | "totp";

const POLICY_LABELS: Record<string, string> = {
  length: `at least ${PASSWORD_MIN_LENGTH} characters`,
  upper: "an UPPERCASE letter",
  lower: "a lowercase letter",
  digit: "a digit",
  special: "a special character (spaces count)",
};
const STRENGTH_LABELS = ["", "weak", "okay", "good", "excellent"] as const;

export function MigrationScreen({ onDone }: Props) {
  const [step, setStep] = useState<Step>("password");
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState("");

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const [provisioningURI, setProvisioningURI] = useState("");
  const [secretB32, setSecretB32] = useState("");
  const [code, setCode] = useState("");

  const policy = useMemo(() => checkPasswordPolicy(password), [password]);
  const strength = useMemo(() => estimateStrength(password), [password]);
  const confirmMatches = confirm.length > 0 && confirm === password;

  const qrDataURL = useMemo(() => {
    if (!provisioningURI) return "";
    const qr = qrcode(0, "M");
    qr.addData(provisioningURI);
    qr.make();
    return qr.createDataURL(4, 8);
  }, [provisioningURI]);

  const onSubmitPassword = async () => {
    setBanner("");
    setBusy(true);
    try {
      const salt = newAuthSalt();
      const { authProof } = await deriveAuth(password, { ...DEFAULT_KDF, salt });
      const authProofB64 = toB64(authProof);
      await migrationPassword({
        auth_proof_b64: authProofB64,
        salt_b64: toB64(salt),
        kdf_alg: DEFAULT_KDF.alg,
        kdf_mem_kib: DEFAULT_KDF.memKiB,
        kdf_iters: DEFAULT_KDF.iters,
        kdf_par: DEFAULT_KDF.par,
      });
      // 81-2: enroll is step-up gated. This is initial enrollment (no
      // confirmed secret yet) so no code is asked for, but the password
      // proof still has to travel -- and it is right here in hand.
      const res = await totpEnroll({ auth_proof_b64: authProofB64 });
      setProvisioningURI(res.provisioning_uri);
      setSecretB32(res.secret_b32);
      setStep("totp");
    } catch (e) {
      if (e instanceof SignupApiError) setBanner(e.message);
      else {
        console.error("migration password:", e);
        setBanner("Something went wrong. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  const onSubmitTOTP = async () => {
    setBanner("");
    setBusy(true);
    try {
      await totpConfirm(code.trim());
      await migrationComplete();
      onDone();
    } catch (e) {
      if (e instanceof SignupApiError && e.code === "invalid_totp") {
        setBanner("That code didn't match. Wait for the next code and try again.");
      } else if (e instanceof SignupApiError) {
        setBanner(e.message);
      } else {
        console.error("migration totp:", e);
        setBanner("Something went wrong. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="chalk-auth" data-testid="migration-wizard">
      <div class="chalk-auth-card">
        <h1 class="chalk-auth-title">Secure your account</h1>
        <p class="chalk-auth-subtitle">
          chalk now uses a password and two-factor code for signing in.
          This takes a minute and only happens once. Your passkeys, recovery
          phrase, and encryption phrase all keep working.
        </p>
        {banner && <p class="chalk-auth-error" data-testid="migration-banner">{banner}</p>}

        {step === "password" && (
          <div data-testid="migration-step-password">
            <label class="chalk-auth-label">
              password
              <input class="chalk-auth-input" type="password" value={password}
                onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
                autocomplete="new-password" />
            </label>
            <label class="chalk-auth-label">
              confirm password
              <input class="chalk-auth-input" type="password" value={confirm}
                onInput={(e) => setConfirm((e.target as HTMLInputElement).value)}
                autocomplete="new-password" />
            </label>
            <ul class="chalk-auth-checklist">
              {Object.entries(POLICY_LABELS).map(([id, label]) => {
                const met = !policy.missing.includes(id as never);
                return <li key={id} class={met ? "met" : "unmet"}>{met ? "\u2713" : "\u2022"} {label}</li>;
              })}
              <li class={confirmMatches ? "met" : "unmet"}>
                {confirmMatches ? "\u2713" : "\u2022"} both entries match
              </li>
            </ul>
            {password.length > 0 && (
              <p class={`chalk-auth-strength strength-${strength}`}>strength: {STRENGTH_LABELS[strength]}</p>
            )}
            <button class="chalk-auth-button"
              disabled={busy || !policy.ok || !confirmMatches}
              onClick={onSubmitPassword} data-testid="migration-password-next">
              {busy ? "securing..." : "Next: set up two-factor"}
            </button>
          </div>
        )}

        {step === "totp" && (
          <div data-testid="migration-step-totp">
            <p class="chalk-auth-subtitle">
              Scan with your authenticator app (or enter the code manually),
              then type the 6-digit code it shows.
            </p>
            {qrDataURL && (
              <img class="chalk-auth-qr" src={qrDataURL} alt="TOTP enrollment QR code" width={192} height={192} />
            )}
            <div class="chalk-auth-secret"><code>{secretB32}</code></div>
            <label class="chalk-auth-label">
              6-digit code
              <input class="chalk-auth-input" inputMode="numeric" maxLength={6} value={code}
                onInput={(e) => setCode((e.target as HTMLInputElement).value)}
                autocomplete="one-time-code" />
            </label>
            <button class="chalk-auth-button"
              disabled={busy || code.trim().length !== 6}
              onClick={onSubmitTOTP} data-testid="migration-finish">
              {busy ? "finishing..." : "Verify & finish"}
            </button>
            <p class="chalk-auth-footer">
              tip: afterwards, open Profile → account security → "re-link
              encryption phrase" so NEW devices can unlock your message
              history with just this password.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
