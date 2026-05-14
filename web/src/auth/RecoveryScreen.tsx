// RecoveryScreen: displays the one-time 24-word recovery code and
// requires the user to confirm they've saved it before proceeding.
// Phase 09b sub-step 4.
//
// The recovery words are the ONLY mechanism for regaining access if
// every passkey is lost. They never leave the server again after
// register/finish; if the user loses them, they're locked out.
//
// Confirmation gate (sub-step 09b-4 cut):
//   - Checkbox "I have saved these recovery words"
//   - 3-second countdown after the checkbox is ticked before the
//     Continue button enables. The countdown is anti-muscle-memory:
//     if the user reflexively ticks-then-clicks, the delay gives a
//     beat to actually look at the words.
//
// Promoted to a stricter gate in 09b-6 (recovery login lands then,
// and a stricter gate is appropriate when the user is being told
// what these words are for).
//
// Aids:
//   - Copy-to-clipboard button (clipboard API; falls back silently)
//   - Download-as-text button (Blob + a temporary <a download>)
//   - Word index numbers (1..24) so the user can transcribe in order

import { useEffect, useState } from "preact/hooks";
import type { RegistrationResult } from "./types";

interface Props {
  result: RegistrationResult;
  onConfirmed: () => void;
}

const COUNTDOWN_SECONDS = 3;

export function RecoveryScreen({ result, onConfirmed }: Props) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(COUNTDOWN_SECONDS);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  // Countdown effect. Runs only while acknowledged is true.
  useEffect(() => {
    if (!acknowledged) {
      setSecondsLeft(COUNTDOWN_SECONDS);
      return;
    }
    if (secondsLeft <= 0) return;
    const id = window.setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => window.clearTimeout(id);
  }, [acknowledged, secondsLeft]);

  const wordsText = result.recoveryWords
    .map((w, i) => `${(i + 1).toString().padStart(2, " ")}. ${w}`)
    .join("\n");

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
      console.warn("recovery copy failed:", e);
      setCopyState("failed");
      window.setTimeout(() => setCopyState("idle"), 2000);
    }
  };

  const onDownload = () => {
    const blob = new Blob(
      [
        "chalk recovery code\n",
        `user: ${result.username}\n`,
        `user_id: ${result.userID}\n`,
        `generated: ${new Date().toISOString()}\n`,
        "\n",
        "KEEP THIS FILE SAFE. Anyone with these words can recover\n",
        "your chalk account if all your passkeys are lost.\n",
        "Treat it like a password — store offline if possible.\n",
        "\n",
        wordsText,
        "\n",
      ],
      { type: "text/plain;charset=utf-8" }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chalk-recovery-${result.username}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const canContinue = acknowledged && secondsLeft <= 0;

  return (
    <div class="chalk-auth" data-testid="recovery-screen">
      <div class="chalk-auth-card chalk-auth-card--wide">
        <header class="chalk-auth-header">
          <h2>your recovery code</h2>
          <p class="chalk-auth-subtitle">
            registered as <strong>@{result.username}</strong>
          </p>
        </header>

        <div class="chalk-auth-warning" data-testid="recovery-warning">
          <strong>save these {result.recoveryWords.length} words now.</strong>{" "}
          They are the only way to recover your account if you lose every
          passkey. They will never be shown again.
        </div>

        <ol class="chalk-recovery-words" data-testid="recovery-words">
          {result.recoveryWords.map((w, i) => (
            <li key={i} class="chalk-recovery-word">
              <span class="chalk-recovery-word-index">{i + 1}.</span>
              <span class="chalk-recovery-word-text">{w}</span>
            </li>
          ))}
        </ol>

        <div class="chalk-auth-actions-row">
          <button
            type="button"
            class="chalk-button"
            onClick={onCopy}
            data-testid="recovery-copy"
          >
            {copyState === "copied"
              ? "copied!"
              : copyState === "failed"
                ? "copy failed"
                : "copy to clipboard"}
          </button>
          <button
            type="button"
            class="chalk-button"
            onClick={onDownload}
            data-testid="recovery-download"
          >
            download as .txt
          </button>
        </div>

        <div class="chalk-field chalk-field--checkbox chalk-auth-gate">
          <input
            id="recovery-ack"
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged((e.target as HTMLInputElement).checked)}
            data-testid="recovery-ack"
          />
          <label class="chalk-field-label" for="recovery-ack">
            I have saved these recovery words somewhere safe.
          </label>
        </div>

        <button
          type="button"
          class="chalk-button chalk-button--primary"
          disabled={!canContinue}
          onClick={onConfirmed}
          data-testid="recovery-continue"
        >
          {!acknowledged
            ? "continue (acknowledge first)"
            : secondsLeft > 0
              ? `continue (in ${secondsLeft}s)`
              : "continue"}
        </button>
      </div>
    </div>
  );
}
