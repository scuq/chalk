// chalk-web -- phase31-slice31-8 account-security section for ProfilePanel.
//
// Three actions, each an expandable sub-view:
//
//   change password   current pw -> new pw (policy checklist + confirm).
//                     Derives the CURRENT KEK, unwraps the seed entropy from
//                     the server-side wrap, derives the NEW KEK (fresh salt),
//                     re-seals, and submits everything atomically to
//                     /password/change. If no wrap exists yet, the user is
//                     asked for their 24-word ENCRYPTION phrase once so the
//                     wrap can be (re)created as part of the change.
//
//   two-factor reset  stages a fresh TOTP secret (QR + copy-paste secret)
//                     and confirms with a live code. The OLD code keeps
//                     working until confirm succeeds (server-side staging).
//
//   re-link phrase    password + encryption phrase -> upload the seed wrap.
//                     For accounts whose wrap was purged (recovery reset) or
//                     never uploaded. Phrase checksum is validated locally;
//                     the definitive key-match check happens at next unlock.

import { useMemo, useState } from "preact/hooks";
import qrcode from "qrcode-generator";
import {
  deriveAuth,
  newAuthSalt,
  wrapEntropy,
  unwrapEntropy,
  toB64,
  fromB64,
  checkPasswordPolicy,
  estimateStrength,
  DEFAULT_KDF,
  WRAP_SUITE_AESGCM,
  PASSWORD_MIN_LENGTH,
} from "../crypto/authkdf";
import { mnemonicToEntropy } from "../crypto/bip39";
import { cleanEnteredPhrase } from "../crypto/identity-setup";
import { prelogin, fetchSeedWraps } from "../auth/login-v2-api";
import { putSeedWrap, SignupApiError } from "../auth/signup-v2-api";
import { changePassword, totpEnroll, totpConfirm } from "../auth/security-api";
import type { StepUpProof } from "../auth/stepup";
import { StepUpPrompt } from "./StepUpPrompt";

interface Props {
  username: string;
}

type View = "idle" | "password" | "totp" | "relink";

const POLICY_LABELS: Record<string, string> = {
  length: `at least ${PASSWORD_MIN_LENGTH} characters`,
  upper: "an UPPERCASE letter",
  lower: "a lowercase letter",
  digit: "a digit",
  special: "a special character (spaces count)",
};
const STRENGTH_LABELS = ["", "weak", "okay", "good", "excellent"] as const;

export function SecurityPanel({ username }: Props) {
  const [view, setView] = useState<View>("idle");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");   // success banner
  const [err, setErr] = useState("");   // error banner

  // change-password state
  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [needPhrase, setNeedPhrase] = useState(false);
  const [phrase, setPhrase] = useState("");

  // totp-reset state
  const [provisioningURI, setProvisioningURI] = useState("");
  const [secretB32, setSecretB32] = useState("");
  const [code, setCode] = useState("");

  // relink state
  const [relinkPw, setRelinkPw] = useState("");
  const [relinkPhrase, setRelinkPhrase] = useState("");

  const policy = useMemo(() => checkPasswordPolicy(newPw), [newPw]);
  const strength = useMemo(() => estimateStrength(newPw), [newPw]);
  const confirmMatches = confirmPw.length > 0 && confirmPw === newPw;

  const qrDataURL = useMemo(() => {
    if (!provisioningURI) return "";
    const qr = qrcode(0, "M");
    qr.addData(provisioningURI);
    qr.make();
    return qr.createDataURL(4, 8);
  }, [provisioningURI]);

  const open = (v: View) => {
    setView(v);
    setMsg("");
    setErr("");
  };

  const fail = (e: unknown, fallback: string) => {
    if (e instanceof SignupApiError) setErr(e.message);
    else {
      console.error(fallback, e);
      setErr("Something went wrong. Please try again.");
    }
  };

  // ---- change password ----------------------------------------------------

  const onChangePassword = async () => {
    setErr("");
    setBusy(true);
    try {
      // 1. current KEK + proof from the account's stored params.
      const params = await prelogin(username);
      const cur = await deriveAuth(curPw, {
        alg: params.kdf_alg,
        memKiB: params.kdf_mem_kib,
        iters: params.kdf_iters,
        par: params.kdf_par,
        salt: fromB64(params.salt_b64),
      });

      // 2. entropy: from the server-side wrap, or (fallback) from the phrase.
      let entropy: Uint8Array | null = null;
      const wraps = await fetchSeedWraps(1);
      const pw = wraps.find((w) => w.method === "password" && w.wrap_suite === WRAP_SUITE_AESGCM);
      if (pw) {
        try {
          entropy = await unwrapEntropy(fromB64(pw.wrap_b64), cur.kek);
        } catch {
          // wrap exists but doesn't open under this password's KEK -> the
          // current-password entry is wrong; surface it as such.
          setErr("Current password is incorrect.");
          setBusy(false);
          return;
        }
      } else if (phrase.trim()) {
        entropy = await mnemonicToEntropy(cleanEnteredPhrase(phrase));
      } else {
        setNeedPhrase(true);
        setErr("No stored key wrap found; enter your 24-word encryption phrase once to re-create it.");
        setBusy(false);
        return;
      }

      // 3. new KEK under a fresh salt; re-seal; submit atomically.
      const salt = newAuthSalt();
      const next = await deriveAuth(newPw, { ...DEFAULT_KDF, salt });
      const blob = await wrapEntropy(entropy, next.kek);
      entropy.fill(0);
      await changePassword({
        current_auth_proof_b64: toB64(cur.authProof),
        auth_proof_b64: toB64(next.authProof),
        salt_b64: toB64(salt),
        kdf_alg: DEFAULT_KDF.alg,
        kdf_mem_kib: DEFAULT_KDF.memKiB,
        kdf_iters: DEFAULT_KDF.iters,
        kdf_par: DEFAULT_KDF.par,
        generation: 1,
        wrap_suite: WRAP_SUITE_AESGCM,
        wrap_b64: toB64(blob),
      });
      setMsg("Password changed.");
      setView("idle");
      setCurPw(""); setNewPw(""); setConfirmPw(""); setPhrase(""); setNeedPhrase(false);
    } catch (e) {
      if (e instanceof SignupApiError && e.code === "invalid_credentials") {
        setErr("Current password is incorrect.");
      } else if (e instanceof Error && /checksum|word|mnemonic/i.test(e.message)) {
        setErr("That doesn't look like a valid 24-word phrase.");
      } else {
        fail(e, "change password:");
      }
    } finally {
      setBusy(false);
    }
  };

  // ---- totp reset ---------------------------------------------------------

  // 81-2: replacing a confirmed authenticator is step-up gated, so the reset
  // opens on a proof form instead of staging a secret straight away.
  const onStartTOTPReset = async (stepUp: StepUpProof) => {
    setErr("");
    setBusy(true);
    try {
      const res = await totpEnroll(stepUp);
      setProvisioningURI(res.provisioning_uri);
      setSecretB32(res.secret_b32);
      setCode("");
    } catch (e) {
      fail(e, "totp enroll:");
    } finally {
      setBusy(false);
    }
  };

  const onConfirmTOTP = async () => {
    setErr("");
    setBusy(true);
    try {
      await totpConfirm(code.trim());
      setMsg("Two-factor secret replaced. Your old codes no longer work.");
      setView("idle");
      setProvisioningURI(""); setSecretB32(""); setCode("");
    } catch (e) {
      if (e instanceof SignupApiError && e.code === "invalid_totp") {
        setErr("That code didn't match. Wait for the next code and try again.");
      } else {
        fail(e, "totp confirm:");
      }
    } finally {
      setBusy(false);
    }
  };

  // ---- re-link phrase -----------------------------------------------------

  const onRelink = async () => {
    setErr("");
    setBusy(true);
    try {
      const entropy = await mnemonicToEntropy(cleanEnteredPhrase(relinkPhrase));
      const params = await prelogin(username);
      const { kek } = await deriveAuth(relinkPw, {
        alg: params.kdf_alg,
        memKiB: params.kdf_mem_kib,
        iters: params.kdf_iters,
        par: params.kdf_par,
        salt: fromB64(params.salt_b64),
      });
      const blob = await wrapEntropy(entropy, kek);
      entropy.fill(0);
      await putSeedWrap(1, WRAP_SUITE_AESGCM, toB64(blob));
      setMsg("Encryption phrase re-linked; new devices can now unlock with your password.");
      setView("idle");
      setRelinkPw(""); setRelinkPhrase("");
    } catch (e) {
      if (e instanceof Error && /checksum|word|mnemonic/i.test(e.message)) {
        setErr("That doesn't look like a valid 24-word phrase.");
      } else {
        fail(e, "relink:");
      }
    } finally {
      setBusy(false);
    }
  };

  // ---- render -------------------------------------------------------------

  return (
    <section class="chalk-profile-security" data-testid="profile-security">
      <h3>account security</h3>
      {msg && <p class="chalk-profile-hint" data-testid="security-msg">{msg}</p>}
      {err && <p class="chalk-auth-error" data-testid="security-err">{err}</p>}

      {view === "idle" && (
        <div class="chalk-profile-field">
          <button class="chalk-auth-link" type="button" onClick={() => open("password")}>
            change password
          </button>
          {" · "}
          <button class="chalk-auth-link" type="button" onClick={() => open("totp")}>
            reset two-factor
          </button>
          {" · "}
          <button class="chalk-auth-link" type="button" onClick={() => open("relink")}>
            re-link encryption phrase
          </button>
        </div>
      )}

      {view === "password" && (
        <div data-testid="security-password">
          <label class="chalk-auth-label">
            current password
            <input class="chalk-auth-input" type="password" value={curPw}
              onInput={(e) => setCurPw((e.target as HTMLInputElement).value)}
              autocomplete="current-password" />
          </label>
          <label class="chalk-auth-label">
            new password
            <input class="chalk-auth-input" type="password" value={newPw}
              onInput={(e) => setNewPw((e.target as HTMLInputElement).value)}
              autocomplete="new-password" />
          </label>
          <label class="chalk-auth-label">
            confirm new password
            <input class="chalk-auth-input" type="password" value={confirmPw}
              onInput={(e) => setConfirmPw((e.target as HTMLInputElement).value)}
              autocomplete="new-password" />
          </label>
          {needPhrase && (
            <label class="chalk-auth-label">
              24-word encryption phrase
              <textarea class="chalk-auth-input" rows={3} value={phrase}
                onInput={(e) => setPhrase((e.target as HTMLTextAreaElement).value)} />
            </label>
          )}
          <ul class="chalk-auth-checklist">
            {Object.entries(POLICY_LABELS).map(([id, label]) => {
              const met = !policy.missing.includes(id as never);
              return <li key={id} class={met ? "met" : "unmet"}>{met ? "\u2713" : "\u2022"} {label}</li>;
            })}
            <li class={confirmMatches ? "met" : "unmet"}>
              {confirmMatches ? "\u2713" : "\u2022"} both entries match
            </li>
          </ul>
          {newPw.length > 0 && (
            <p class={`chalk-auth-strength strength-${strength}`}>strength: {STRENGTH_LABELS[strength]}</p>
          )}
          <button class="chalk-auth-button"
            disabled={busy || curPw.length === 0 || !policy.ok || !confirmMatches}
            onClick={onChangePassword} data-testid="security-password-submit">
            {busy ? "re-securing..." : "Change password"}
          </button>
          <button class="chalk-auth-link" type="button" onClick={() => open("idle")}>cancel</button>
        </div>
      )}

      {view === "totp" && !secretB32 && (
        <StepUpPrompt
          username={username}
          action="replace your authenticator"
          busy={busy}
          onConfirm={onStartTOTPReset}
          onCancel={() => open("idle")}
          testid="security-totp-stepup"
        />
      )}

      {view === "totp" && secretB32 && (
        <div data-testid="security-totp">
          <p class="chalk-auth-subtitle">
            Scan the new code with your authenticator, then confirm with one
            live code. Your current codes keep working until you confirm.
          </p>
          {qrDataURL && (
            <img class="chalk-auth-qr" src={qrDataURL} alt="TOTP reset QR code" width={192} height={192} />
          )}
          {secretB32 && (
            <div class="chalk-auth-secret"><code>{secretB32}</code></div>
          )}
          <label class="chalk-auth-label">
            6-digit code
            <input class="chalk-auth-input" inputMode="numeric" maxLength={6} value={code}
              onInput={(e) => setCode((e.target as HTMLInputElement).value)}
              autocomplete="one-time-code" />
          </label>
          <button class="chalk-auth-button"
            disabled={busy || code.trim().length !== 6}
            onClick={onConfirmTOTP} data-testid="security-totp-confirm">
            {busy ? "confirming..." : "Confirm new secret"}
          </button>
          <button class="chalk-auth-link" type="button" onClick={() => open("idle")}>cancel</button>
        </div>
      )}

      {view === "relink" && (
        <div data-testid="security-relink">
          <p class="chalk-auth-subtitle">
            Re-creates the encrypted link between your password and your
            24-word encryption phrase, so a NEW device can unlock message
            history with the password alone. Needed after a password reset
            via recovery, or if signup was interrupted.
          </p>
          <label class="chalk-auth-label">
            password
            <input class="chalk-auth-input" type="password" value={relinkPw}
              onInput={(e) => setRelinkPw((e.target as HTMLInputElement).value)}
              autocomplete="current-password" />
          </label>
          <label class="chalk-auth-label">
            24-word encryption phrase
            <textarea class="chalk-auth-input" rows={3} value={relinkPhrase}
              onInput={(e) => setRelinkPhrase((e.target as HTMLTextAreaElement).value)} />
          </label>
          <button class="chalk-auth-button"
            disabled={busy || relinkPw.length === 0 || relinkPhrase.trim().length === 0}
            onClick={onRelink} data-testid="security-relink-submit">
            {busy ? "linking..." : "Re-link"}
          </button>
          <button class="chalk-auth-link" type="button" onClick={() => open("idle")}>cancel</button>
        </div>
      )}
    </section>
  );
}
