// IdentitySetupScreen: the one-time setup of the client-only DECRYPTION
// phrase, distinct from the server-issued recovery code (RecoveryScreen).
// Rendered by App after auth (so the WS is open) whenever the current
// device has no stored identity for the user.
//
// It picks its mode from what the account has already published:
//   * no identity published yet  -> GENERATE: make a fresh 24-word phrase,
//     show it, require the user to re-enter 3 randomly chosen words (proof
//     they wrote it down), then derive + save + publish. Covers both new
//     registrations and accounts created before phase 22.
//   * an identity already published -> ENTER: this is a fresh device for an
//     established account. The user types their phrase; we derive and
//     confirm the X25519 public key matches the published one (a valid but
//     wrong phrase is rejected), then save locally.
//
// The phrase is the client-only decryption root: it is NEVER sent to the
// server. Only the derived PUBLIC keys + self-signature are published.
//
// All non-UI logic lives in crypto/identity-setup.ts (unit-tested); this
// file is the rendering shell. Markup uses the shared auth classes
// (chalk-field / chalk-button / chalk-recovery-word*), matching
// LoginScreen and RecoveryScreen.

import { useEffect, useMemo, useState } from "preact/hooks";

import { generateMnemonic } from "../crypto/bip39";
import { deriveIdentityFromMnemonic } from "../crypto/identity";
import { saveIdentity } from "../crypto/idb";
import { publishIdentity, fetchIdentity, type IdentityTransport } from "../crypto/identity-sync";
import { pickChallengeIndices, checkChallenge, classifyEnteredPhrase } from "../crypto/identity-setup";

interface Props {
  userID: string;
  transport: IdentityTransport;
  onReady: () => void;
}

type Mode = "loading" | "generate" | "enter" | "working" | "error";

export function IdentitySetupScreen({ userID, transport, onReady }: Props) {
  const [mode, setMode] = useState<Mode>("loading");
  const [errorMsg, setErrorMsg] = useState<string>("");

  // generate-mode state
  const [mnemonic, setMnemonic] = useState<string>("");
  const challengeIndices = useMemo(
    () => (mnemonic ? pickChallengeIndices(3, 24) : []),
    [mnemonic],
  );
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [acknowledged, setAcknowledged] = useState(false);
  const [challengeError, setChallengeError] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  // enter-mode state
  const [entered, setEntered] = useState<string>("");
  const [expectedX25519, setExpectedX25519] = useState<Uint8Array | null>(null);
  const [enterError, setEnterError] = useState<string>("");

  // Decide mode on mount: does the account already have a published identity?
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const peer = await fetchIdentity(transport, userID);
        if (cancelled) return;
        if (peer) {
          setExpectedX25519(peer.x25519Public);
          setMode("enter");
        } else {
          const fresh = await generateMnemonic();
          if (cancelled) return;
          setMnemonic(fresh);
          setMode("generate");
        }
      } catch (e) {
        if (cancelled) return;
        setErrorMsg(describe(e));
        setMode("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [transport, userID]);

  const words = useMemo(() => (mnemonic ? mnemonic.split(" ") : []), [mnemonic]);

  // Numbered, one-per-line rendering of the phrase for copy + print.
  const wordsText = useMemo(
    () => words.map((w, i) => `${(i + 1).toString().padStart(2, "0")}. ${w}`).join("\n"),
    [words],
  );

  const onCopy = async () => {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(wordsText);
        setCopyState("copied");
        window.setTimeout(() => setCopyState("idle"), 2000);
        return;
      }
      throw new Error("clipboard API unavailable");
    } catch (e) {
      console.warn("decryption phrase copy failed:", e);
      setCopyState("failed");
      window.setTimeout(() => setCopyState("idle"), 2000);
    }
  };

  // Print just the phrase (not the whole app) via a transient popup. If the
  // popup is blocked, we fail quietly -- copy is the reliable path.
  const onPrint = () => {
    const w = window.open("", "_blank", "width=480,height=640");
    if (!w) {
      console.warn("decryption phrase print: popup blocked");
      return;
    }
    const rows = words
      .map((word, i) => `<tr><td class="n">${(i + 1).toString().padStart(2, "0")}</td><td>${word}</td></tr>`)
      .join("");
    w.document.write(
      `<!doctype html><meta charset="utf-8"><title>chalk decryption phrase</title>` +
        `<style>body{font:14px/1.6 ui-monospace,Menlo,Consolas,monospace;padding:24px;color:#000}` +
        `h1{font-size:16px}p{max-width:42ch}table{border-collapse:collapse;margin-top:12px}` +
        `td{padding:2px 10px}.n{color:#666;text-align:right}</style>` +
        `<h1>chalk decryption phrase</h1>` +
        `<p>Keep this safe and offline. Anyone with these 24 words can read your ` +
        `encrypted messages. It is never sent to the server; if you lose it, your ` +
        `encrypted history is unrecoverable.</p>` +
        `<table>${rows}</table>`,
    );
    w.document.close();
    w.focus();
    w.print();
  };

  // ---- generate: confirm the 3-word challenge, then derive/save/publish ----
  const onConfirmGenerated = async () => {
    setChallengeError(false);
    const answerMap = new Map<number, string>(
      challengeIndices.map((i) => [i, answers[i] ?? ""]),
    );
    if (!checkChallenge(mnemonic, answerMap)) {
      setChallengeError(true);
      return;
    }
    setMode("working");
    try {
      const identity = await deriveIdentityFromMnemonic(mnemonic);
      await saveIdentity(userID, identity);
      await publishIdentity(transport, identity);
      onReady();
    } catch (e) {
      setErrorMsg(describe(e));
      setMode("error");
    }
  };

  // ---- enter: classify the entered phrase against the published key ----
  // This is the device-2 onboarding gate. classifyEnteredPhrase runs the
  // checksum check, derives the identity, and compares its X25519 public key
  // to the one already published for this account. The key match is the
  // load-bearing security step: it prevents a valid-but-wrong phrase from
  // silently forking a divergent identity onto this device.
  const onSubmitEntered = async () => {
    setEnterError("");
    if (!expectedX25519) {
      setEnterError("Lost the published key reference. Please refresh.");
      return;
    }
    setMode("working");
    try {
      const result = await classifyEnteredPhrase(entered, expectedX25519);
      if (result.status === "invalid") {
        setMode("enter");
        setEnterError(
          "That doesn't look like a valid 24-word phrase. Check for typos, missing words, or wrong word order.",
        );
        return;
      }
      if (result.status === "mismatch") {
        setMode("enter");
        setEnterError(
          "That's a valid phrase, but it doesn't match this account's identity. Make sure you're entering the phrase for THIS account.",
        );
        return;
      }
      await saveIdentity(userID, result.identity);
      onReady();
    } catch (e) {
      setErrorMsg(describe(e));
      setMode("error");
    }
  };

  if (mode === "loading" || mode === "working") {
    return (
      <div class="chalk-auth" data-testid="identity-setup-loading">
        <div class="chalk-auth-card">
          <p>{mode === "working" ? "Setting up your encryption identity…" : "Checking your identity…"}</p>
        </div>
      </div>
    );
  }

  if (mode === "error") {
    return (
      <div class="chalk-auth" data-testid="identity-setup-error">
        <div class="chalk-auth-card">
          <div class="chalk-auth-error">Couldn't set up your encryption identity: {errorMsg}</div>
          <button class="chalk-button chalk-button--primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }

  if (mode === "enter") {
    return (
      <div class="chalk-auth" data-testid="identity-setup-enter">
        <div class="chalk-auth-card">
          <header class="chalk-auth-header">
            <h1>Set up chalk on this device</h1>
            <p class="chalk-auth-subtitle">
              This account already has an encryption identity, but this device doesn't
              have it yet. Enter your 24-word decryption phrase to add this device. The
              same phrase derives the same keys, so this device can read your encrypted
              history. The phrase is never sent to the server.
            </p>
          </header>
          <div class="chalk-auth-warning" data-testid="identity-enter-revocation-notice">
            <strong>This device will have full access to your account.</strong> All
            devices that hold your phrase are equal — there is no per-device sign-out.
            If this device is ever lost or compromised, the only way to revoke it is to
            rotate your identity (which re-keys your account and locks out every device
            that doesn't re-enter the new phrase).
          </div>
          {enterError && (
            <div class="chalk-auth-error" data-testid="identity-enter-error">{enterError}</div>
          )}
          <div class="chalk-field">
            <label class="chalk-field-label" for="identity-phrase">
              decryption phrase
            </label>
            <textarea
              id="identity-phrase"
              class="chalk-field-input"
              rows={4}
              placeholder="word1 word2 word3 …"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellcheck={false}
              value={entered}
              onInput={(e) => setEntered((e.target as HTMLTextAreaElement).value)}
              data-testid="identity-phrase-input"
            />
          </div>
          <button
            class="chalk-button chalk-button--primary"
            onClick={onSubmitEntered}
            disabled={entered.trim().length === 0}
            data-testid="identity-phrase-submit"
          >
            Add this device
          </button>
        </div>
      </div>
    );
  }

  // mode === "generate"
  return (
    <div class="chalk-auth" data-testid="identity-setup-generate">
      <div class="chalk-auth-card">
        <header class="chalk-auth-header">
          <h1>Your decryption phrase</h1>
          <p class="chalk-auth-subtitle">
            These 24 words derive the keys that encrypt your messages. They are your
            decryption phrase, separate from your recovery code, and are{" "}
            <strong>never sent to the server</strong>. Write them down and keep them safe —
            if you lose them, you lose access to your encrypted history.
          </p>
        </header>

        {!acknowledged && (
          <>
            <ol class="chalk-recovery-words" data-testid="identity-phrase-words">
              {words.map((w, i) => (
                <li key={i} class="chalk-recovery-word">
                  <span class="chalk-recovery-word-index">{(i + 1).toString().padStart(2, "0")}</span>
                  <span class="chalk-recovery-word-text">{w}</span>
                </li>
              ))}
            </ol>

            <div class="chalk-auth-actions-row">
              <button class="chalk-button" onClick={onCopy} data-testid="identity-phrase-copy">
                {copyState === "copied" ? "copied" : copyState === "failed" ? "copy failed" : "copy"}
              </button>
              <button class="chalk-button" onClick={onPrint} data-testid="identity-phrase-print">
                print
              </button>
            </div>
          </>
        )}

        <div class="chalk-field chalk-field--checkbox chalk-auth-gate">
          <input
            id="identity-ack"
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged((e.target as HTMLInputElement).checked)}
            data-testid="identity-ack"
          />
          <label class="chalk-field-label" for="identity-ack">
            I've written down all 24 words.
          </label>
        </div>

        {acknowledged && (
          <p class="chalk-field-hint" data-testid="identity-words-hidden">
            Words hidden so you confirm from your own copy. Uncheck above to view them again.
          </p>
        )}

        {acknowledged && (
          <div class="chalk-identity-challenge" data-testid="identity-challenge">
            <p class="chalk-field-hint">Confirm by re-entering these words:</p>
            {challengeIndices.map((idx) => (
              <div key={idx} class="chalk-field">
                <label class="chalk-field-label" for={`identity-challenge-${idx}`}>
                  Word #{idx + 1}
                </label>
                <input
                  id={`identity-challenge-${idx}`}
                  class="chalk-field-input"
                  type="text"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellcheck={false}
                  value={answers[idx] ?? ""}
                  onInput={(e) =>
                    setAnswers((a) => ({ ...a, [idx]: (e.target as HTMLInputElement).value }))
                  }
                  data-testid={`identity-challenge-${idx}`}
                />
              </div>
            ))}
            {challengeError && (
              <div class="chalk-auth-error" data-testid="identity-challenge-error">
                Those words don't match. Check the list above.
              </div>
            )}
            <button
              class="chalk-button chalk-button--primary"
              onClick={onConfirmGenerated}
              data-testid="identity-generate-confirm"
            >
              Confirm &amp; continue
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
