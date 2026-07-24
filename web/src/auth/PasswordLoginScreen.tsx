// chalk-web -- phase31-slice31-7 password login screen.
//
// The auth-v2 login. Two steps, mirroring the server contract:
//   1. credentials  username + password -> prelogin (KDF params) ->
//                   Argon2id (WASM, ~1s) -> login/password -> totp_pending
//   2. totp         6-digit code -> login/totp -> SESSION + onLoggedIn
//
// The derived KEK is stashed (kek-holder) so the post-login identity gate
// can silently unlock the encryption phrase from the server-side seed wrap
// (IdentitySetupScreen auto-unlock, patched in this slice) -- a new device
// logs in with password + TOTP alone, no 24-word typing.
//
// "Use a passkey instead" switches to an embedded passkey mode that drives
// the EXISTING authenticate/begin + finish ceremony (passkeys remain a
// device-local fast path; note: until the 31-9 cutover the passkey path
// still mints a session without TOTP for pre-migration compatibility).

import { useState } from "preact/hooks";
import type { LoginResult } from "./types";
import { prelogin, loginPassword, loginTOTP } from "./login-v2-api";
import { SignupApiError } from "./signup-v2-api";
import { authenticateBegin, authenticateFinish, ApiError } from "./api";
import { performAuthentication, WebAuthnError } from "../webauthn";
import { deriveAuth, fromB64, toB64 } from "../crypto/authkdf";
import { setKEK } from "./kek-holder";

interface Props {
  onLoggedIn: (result: LoginResult) => void;
  onGoRegister: () => void;
  onGoRecovery?: () => void;
  showRegisterLink?: boolean;
}

type Mode = "credentials" | "totp" | "passkey";

export function PasswordLoginScreen({ onLoggedIn, onGoRegister, onGoRecovery, showRegisterLink = true }: Props) {
  const [mode, setMode] = useState<Mode>("credentials");
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState("");

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totpPending, setTotpPending] = useState("");
  const [code, setCode] = useState("");

  const usernameOK = /^[a-z0-9_]{3,32}$/.test(username.trim().toLowerCase());

  const onSubmitCredentials = async () => {
    setBanner("");
    setBusy(true);
    try {
      const uname = username.trim().toLowerCase();
      const params = await prelogin(uname);
      const { authProof, kek } = await deriveAuth(password, {
        alg: params.kdf_alg,
        memKiB: params.kdf_mem_kib,
        iters: params.kdf_iters,
        par: params.kdf_par,
        salt: fromB64(params.salt_b64),
      });
      const res = await loginPassword(uname, toB64(authProof));
      // Stash the KEK for the post-login identity unlock. In-memory only.
      setKEK(kek);
      setTotpPending(res.totp_pending);
      setMode("totp");
    } catch (e) {
      if (e instanceof SignupApiError) {
        if (e.code === "invalid_credentials") {
          setBanner("Incorrect username or password.");
        } else if (e.code === "user_blocked" || e.code === "user_deleted") {
          setBanner(e.message);
        } else {
          setBanner(e.message);
        }
      } else {
        console.error("login/password:", e);
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
      const result = await loginTOTP(totpPending, code.trim());
      onLoggedIn(result);
    } catch (e) {
      if (e instanceof SignupApiError) {
        if (e.code === "invalid_totp") {
          setBanner("That code didn't match. Wait for the next code and try again.");
        } else if (e.code === "totp_locked") {
          setBanner("Too many incorrect codes. Try again in a few minutes.");
        } else if (e.code === "pending_invalid") {
          setBanner("Login expired; enter your password again.");
          setMode("credentials");
          setCode("");
        } else if (e.code === "totp_enrollment_required") {
          setBanner(
            "Two-factor authentication isn't set up for this account yet. " +
              "Log in with your passkey or recovery phrase to set it up.",
          );
          setMode("credentials");
        } else {
          setBanner(e.message);
        }
      } else {
        console.error("login/totp:", e);
        setBanner("Something went wrong. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  const onSubmitPasskey = async () => {
    setBanner("");
    setBusy(true);
    try {
      const uname = username.trim().toLowerCase();
      const options = await authenticateBegin(uname);
      const assertion = await performAuthentication(options);
      const result = await authenticateFinish(assertion);
      onLoggedIn(result);
    } catch (e) {
      if (e instanceof WebAuthnError) {
        setBanner(
          e.kind === "user_cancelled"
            ? "Passkey prompt was cancelled."
            : "Passkey sign-in failed on this device.",
        );
      } else if (e instanceof ApiError) {
        setBanner(e.message);
      } else {
        console.error("login/passkey:", e);
        setBanner("Something went wrong. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="chalk-auth" data-testid="password-login">
      <div class="chalk-auth-card">
        <h1 class="chalk-auth-title">Sign in</h1>
        {banner && <p class="chalk-auth-error" data-testid="login-banner">{banner}</p>}

        {mode === "credentials" && (
          <div data-testid="login-step-credentials">
            <label class="chalk-auth-label">
              username
              <input
                class="chalk-auth-input"
                value={username}
                onInput={(e) => setUsername((e.target as HTMLInputElement).value)}
                autocomplete="username"
              />
            </label>
            <label class="chalk-auth-label">
              password
              <input
                class="chalk-auth-input"
                type="password"
                value={password}
                onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && usernameOK && password.length > 0 && !busy) {
                    void onSubmitCredentials();
                  }
                }}
                autocomplete="current-password"
              />
            </label>
            <button
              class="chalk-auth-button"
              disabled={busy || !usernameOK || password.length === 0}
              onClick={onSubmitCredentials}
              data-testid="login-credentials-next"
            >
              {busy ? "checking..." : "Continue"}
            </button>
            <button class="chalk-auth-link" type="button" onClick={() => { setBanner(""); setMode("passkey"); }}>
              use a passkey instead
            </button>
          </div>
        )}

        {mode === "totp" && (
          <div data-testid="login-step-totp">
            <p class="chalk-auth-subtitle">
              Enter the 6-digit code from your authenticator app.
            </p>
            <label class="chalk-auth-label">
              6-digit code
              <input
                class="chalk-auth-input"
                inputMode="numeric"
                maxLength={6}
                value={code}
                onInput={(e) => setCode((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && code.trim().length === 6 && !busy) {
                    void onSubmitTOTP();
                  }
                }}
                autocomplete="one-time-code"
              />
            </label>
            <button
              class="chalk-auth-button"
              disabled={busy || code.trim().length !== 6}
              onClick={onSubmitTOTP}
              data-testid="login-totp-submit"
            >
              {busy ? "signing in..." : "Sign in"}
            </button>
            <button class="chalk-auth-link" type="button" onClick={() => { setBanner(""); setMode("credentials"); setCode(""); }}>
              back
            </button>
          </div>
        )}

        {mode === "passkey" && (
          <div data-testid="login-step-passkey">
            <label class="chalk-auth-label">
              username
              <input
                class="chalk-auth-input"
                value={username}
                onInput={(e) => setUsername((e.target as HTMLInputElement).value)}
                autocomplete="username webauthn"
              />
            </label>
            <button
              class="chalk-auth-button"
              disabled={busy || !usernameOK}
              onClick={onSubmitPasskey}
              data-testid="login-passkey-submit"
            >
              {busy ? "waiting for passkey..." : "Sign in with passkey"}
            </button>
            <button class="chalk-auth-link" type="button" onClick={() => { setBanner(""); setMode("credentials"); }}>
              use password instead
            </button>
          </div>
        )}

        <p class="chalk-auth-footer">
          {showRegisterLink && (
            <>
              new here?{" "}
              <button class="chalk-auth-link" type="button" onClick={onGoRegister}>
                create an account
              </button>
              {" · "}
            </>
          )}
          {onGoRecovery && (
            <button class="chalk-auth-link" type="button" onClick={onGoRecovery}>
              lost access? recover
            </button>
          )}
        </p>
      </div>
    </div>
  );
}
