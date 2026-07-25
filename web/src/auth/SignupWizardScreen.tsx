// chalk-web -- phase31-slice31-6b signup wizard (password + TOTP first).
//
// Replaces the passkey-first RegisterScreen at authStage "registering".
// Steps (locked flow):
//   1. account   username / display name / email / (advanced) invite token
//   2. password  choose + double-entry confirm + policy checklist + meter
//   3. totp      QR (or copy-paste secret) + LIVE code verify
// On finish the server commits the account, mints the session, and returns
// the recovery words; we dispatch onRegistered(result) and the EXISTING
// machinery takes over: RecoveryScreen (words + challenge), then
// IdentitySetupScreen (encryption phrase), which -- via the 31-6b patch --
// uploads the password-wrapped entropy using the KEK stashed here.
//
// The Argon2id derivation (256 MiB) runs in WASM at finish time; the button
// shows a "securing your account..." state for the ~1s it takes.

import { useMemo, useState } from "preact/hooks";
import qrcode from "qrcode-generator";
import type { AuthConfig, RegistrationResult } from "./types";
import { signupV2Begin, signupV2Finish, SignupApiError } from "./signup-v2-api";
import {
  checkPasswordPolicy,
  estimateStrength,
  deriveAuth,
  newAuthSalt,
  toB64,
  DEFAULT_KDF,
  PASSWORD_MIN_LENGTH,
} from "../crypto/authkdf";
import { setKEK } from "./kek-holder";

interface Props {
  config: AuthConfig;
  initialInviteToken?: string;
  // Set when the visitor arrived on an /?admin_token= enrollment URL:
  // the username is fixed to the configured admin name and the wizard
  // explains that it is claiming the admin account rather than creating
  // an ordinary one. The authorization itself is the token in the URL,
  // which signupV2Begin attaches; locking the field is a UX guard, not
  // a security one.
  adminClaimUsername?: string;
  onRegistered: (result: RegistrationResult) => void;
  onGoLogin?: () => void;
}

type Step = "account" | "password" | "totp";

const POLICY_LABELS: Record<string, string> = {
  length: `at least ${PASSWORD_MIN_LENGTH} characters`,
  upper: "an UPPERCASE letter",
  lower: "a lowercase letter",
  digit: "a digit",
  special: "a special character (spaces count)",
};

const STRENGTH_LABELS = ["", "weak", "okay", "good", "excellent"] as const;

export function SignupWizardScreen({
  config, initialInviteToken, adminClaimUsername, onRegistered, onGoLogin,
}: Props) {
  const isAdminClaim = !!adminClaimUsername;
  const [step, setStep] = useState<Step>("account");
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState("");

  // step 1
  const [username, setUsername] = useState(adminClaimUsername ?? "");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [invite, setInvite] = useState(initialInviteToken ?? "");
  const [showAdvanced, setShowAdvanced] = useState(false);

  // step 2
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  // step 3
  const [signupToken, setSignupToken] = useState("");
  const [provisioningURI, setProvisioningURI] = useState("");
  const [secretB32, setSecretB32] = useState("");
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);

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

  const usernameOK = /^[a-z0-9_]{3,32}$/.test(username.trim().toLowerCase());
  const emailOK = config.dev_mode ? true : /.+@.+\..+/.test(email.trim());

  // step 1 -> 2 is local; step 2 -> 3 calls begin (admission + TOTP secret).
  const onAccountNext = () => {
    setBanner("");
    setStep("password");
  };

  const onPasswordNext = async () => {
    setBanner("");
    setBusy(true);
    try {
      const res = await signupV2Begin({
        username: username.trim().toLowerCase(),
        display_name: displayName.trim() || undefined,
        email: email.trim() || undefined,
        invite_token: invite.trim() || undefined,
      });
      setSignupToken(res.signup_token);
      setProvisioningURI(res.provisioning_uri);
      setSecretB32(res.secret_b32);
      setStep("totp");
    } catch (e) {
      if (e instanceof SignupApiError) {
        setBanner(e.message);
        // field-level problems live on step 1; send the user back there
        if (
          ["bad_username", "username_reserved", "username_taken", "bad_email",
            "email_taken", "invite_email_mismatch", "email_blacklisted",
            "registration_closed", "invite_invalid", "invite_required"].includes(e.code)
        ) {
          setStep("account");
        }
      } else {
        console.error("signup begin:", e);
        setBanner("Something went wrong. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  const onFinish = async () => {
    setBanner("");
    setBusy(true);
    try {
      const salt = newAuthSalt();
      const { authProof, kek } = await deriveAuth(password, { ...DEFAULT_KDF, salt });
      const result = await signupV2Finish({
        signup_token: signupToken,
        totp_code: code.trim(),
        auth_proof_b64: toB64(authProof),
        salt_b64: toB64(salt),
        kdf_alg: DEFAULT_KDF.alg,
        kdf_mem_kib: DEFAULT_KDF.memKiB,
        kdf_iters: DEFAULT_KDF.iters,
        kdf_par: DEFAULT_KDF.par,
      });
      // Stash the KEK so IdentitySetupScreen can upload the seed wrap once
      // the encryption phrase exists. In-memory only; consumed once.
      setKEK(kek);
      onRegistered(result);
    } catch (e) {
      if (e instanceof SignupApiError) {
        if (e.code === "invalid_totp") {
          setBanner("That code didn't match. Wait for the next code and try again.");
        } else if (e.code === "signup_expired") {
          setBanner("This signup expired. Start again.");
          setStep("account");
          setSignupToken("");
        } else {
          setBanner(e.message);
        }
      } else {
        console.error("signup finish:", e);
        setBanner("Something went wrong. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  const copySecret = async () => {
    try {
      await navigator.clipboard.writeText(secretB32);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable; the secret is selectable text */
    }
  };

  return (
    <div class="chalk-auth" data-testid="signup-wizard">
      <div class="chalk-auth-card">
        <h1 class="chalk-auth-title">
          {isAdminClaim ? "Claim the admin account" : "Create your account"}
        </h1>
        {isAdminClaim && (
          <p class="chalk-auth-subtitle" data-testid="signup-admin-claim-note">
            This one-time link enrolls the server's admin account,{" "}
            <strong>{adminClaimUsername}</strong>. Set a password and an
            authenticator app; the link stops working once you're done.
          </p>
        )}
        {banner && <p class="chalk-auth-error" data-testid="signup-banner">{banner}</p>}

        {step === "account" && (
          <div data-testid="signup-step-account">
            <label class="chalk-auth-label">
              username
              <input
                class="chalk-auth-input"
                value={username}
                onInput={(e) => setUsername((e.target as HTMLInputElement).value)}
                placeholder="a-z, 0-9, _ (3-32 chars)"
                autocomplete="username"
                readOnly={isAdminClaim}
                data-testid="signup-username"
              />
            </label>
            <label class="chalk-auth-label">
              display name (optional)
              <input
                class="chalk-auth-input"
                value={displayName}
                onInput={(e) => setDisplayName((e.target as HTMLInputElement).value)}
              />
            </label>
            <label class="chalk-auth-label">
              email{config.dev_mode ? " (optional in dev)" : ""}
              <input
                class="chalk-auth-input"
                type="email"
                value={email}
                onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
                autocomplete="email"
              />
            </label>
            {!showAdvanced ? (
              <button class="chalk-auth-link" type="button" onClick={() => setShowAdvanced(true)}>
                have an invite token?
              </button>
            ) : (
              <label class="chalk-auth-label">
                invite token
                <input
                  class="chalk-auth-input"
                  value={invite}
                  onInput={(e) => setInvite((e.target as HTMLInputElement).value)}
                />
              </label>
            )}
            <button
              class="chalk-auth-button"
              disabled={!usernameOK || !emailOK}
              onClick={onAccountNext}
              data-testid="signup-account-next"
            >
              Next: choose a password
            </button>
          </div>
        )}

        {step === "password" && (
          <div data-testid="signup-step-password">
            <label class="chalk-auth-label">
              password
              <input
                class="chalk-auth-input"
                type="password"
                value={password}
                onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
                autocomplete="new-password"
              />
            </label>
            <label class="chalk-auth-label">
              confirm password
              <input
                class="chalk-auth-input"
                type="password"
                value={confirm}
                onInput={(e) => setConfirm((e.target as HTMLInputElement).value)}
                autocomplete="new-password"
              />
            </label>
            <ul class="chalk-auth-checklist" data-testid="signup-policy">
              {Object.entries(POLICY_LABELS).map(([id, label]) => {
                const met = !policy.missing.includes(id as never);
                return (
                  <li key={id} class={met ? "met" : "unmet"}>
                    {met ? "\u2713" : "\u2022"} {label}
                  </li>
                );
              })}
              <li class={confirmMatches ? "met" : "unmet"}>
                {confirmMatches ? "\u2713" : "\u2022"} both entries match
              </li>
            </ul>
            {password.length > 0 && (
              <p class={`chalk-auth-strength strength-${strength}`} data-testid="signup-strength">
                strength: {STRENGTH_LABELS[strength]}
              </p>
            )}
            <button
              class="chalk-auth-button"
              disabled={busy || !policy.ok || !confirmMatches}
              onClick={onPasswordNext}
              data-testid="signup-password-next"
            >
              {busy ? "checking..." : "Next: set up two-factor"}
            </button>
            <button class="chalk-auth-link" type="button" onClick={() => setStep("account")}>
              back
            </button>
          </div>
        )}

        {step === "totp" && (
          <div data-testid="signup-step-totp">
            <p class="chalk-auth-subtitle">
              Scan this with your authenticator app (or enter the code manually),
              then type the 6-digit code it shows. Two-factor is required for
              every login.
            </p>
            {qrDataURL && (
              <img
                class="chalk-auth-qr"
                src={qrDataURL}
                alt="TOTP enrollment QR code"
                width={192}
                height={192}
              />
            )}
            <div class="chalk-auth-secret">
              <code data-testid="signup-secret">{secretB32}</code>
              <button class="chalk-auth-link" type="button" onClick={copySecret}>
                {copied ? "copied!" : "copy"}
              </button>
            </div>
            <label class="chalk-auth-label">
              6-digit code
              <input
                class="chalk-auth-input"
                inputMode="numeric"
                maxLength={6}
                value={code}
                onInput={(e) => setCode((e.target as HTMLInputElement).value)}
                autocomplete="one-time-code"
              />
            </label>
            <button
              class="chalk-auth-button"
              disabled={busy || code.trim().length !== 6}
              onClick={onFinish}
              data-testid="signup-finish"
            >
              {busy ? "securing your account..." : "Verify & create account"}
            </button>
          </div>
        )}

        {onGoLogin && (
          <p class="chalk-auth-footer">
            have an account?{" "}
            <button class="chalk-auth-link" type="button" onClick={onGoLogin}>
              log in
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
