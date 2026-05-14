// RegenerateScreen: post-recovery-login forced regenerate step. Phase
// 09b sub-step 6.
//
// Sequence:
//   1. Mount → call /api/auth/recovery/regenerate (requires session,
//      which was just set by the recovery ceremony).
//   2. While the call is in flight, show a spinner.
//   3. On 200, dispatch auth_regenerate_words_loaded → state.
//      pendingRegenerateWords is populated, this screen re-renders
//      with <RecoveryScreen intent="regenerated"> showing the new
//      words + the acknowledge-and-continue gate.
//   4. On error, show a retry button. The server has a strong
//      guarantee that the old code is already consumed, so we can't
//      go back to LoginScreen — the user MUST get fresh words. The
//      retry button re-attempts the regenerate call.
//
// On user confirm (the inner RecoveryScreen's onConfirmed), the
// reducer clears pendingRegenerateWords and flips authStage to
// "authed", at which point AuthGate stops rendering this screen.

import { useEffect, useState } from "preact/hooks";
import type { MeResponse } from "./types";
import { regenerateRecovery, ApiError } from "./api";
import { RecoveryScreen } from "./RecoveryScreen";

interface Props {
  me: MeResponse;
  pendingWords: string[] | null;
  onWordsLoaded: (words: string[]) => void;
  onConfirmed: () => void;
}

export function RegenerateScreen({ me, pendingWords, onWordsLoaded, onConfirmed }: Props) {
  // Local UI state: loading | error. Success is signaled by pendingWords
  // becoming non-null (via the dispatched action).
  const [phase, setPhase] = useState<"loading" | "error">("loading");
  const [errorText, setErrorText] = useState<string>("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (pendingWords) return; // already loaded; nothing to do
    let cancelled = false;
    setPhase("loading");
    setErrorText("");
    regenerateRecovery()
      .then((words) => {
        if (cancelled) return;
        if (words.length !== 24) {
          setPhase("error");
          setErrorText(`server returned ${words.length} words; expected 24`);
          return;
        }
        onWordsLoaded(words);
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("regenerate failed:", e);
        const msg = e instanceof ApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : "unknown error";
        setErrorText(msg);
        setPhase("error");
      });
    return () => {
      cancelled = true;
    };
    // attempt deps so a manual retry re-runs the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  // Loading state: spinner card.
  if (!pendingWords && phase === "loading") {
    return (
      <div class="chalk-auth" data-testid="regenerate-loading">
        <div class="chalk-auth-card">
          <header class="chalk-auth-header">
            <h2>generating new recovery code...</h2>
            <p class="chalk-auth-subtitle">
              recovered as <strong>@{me.username}</strong>; rotating your code now.
            </p>
          </header>
          <p class="chalk-auth-subtitle">
            this should only take a moment.
          </p>
        </div>
      </div>
    );
  }

  // Error state: retry card.
  if (!pendingWords && phase === "error") {
    return (
      <div class="chalk-auth" data-testid="regenerate-error">
        <div class="chalk-auth-card">
          <header class="chalk-auth-header">
            <h2>couldn't generate new recovery code</h2>
            <p class="chalk-auth-subtitle">
              recovered as <strong>@{me.username}</strong>; but the
              regenerate step failed.
            </p>
          </header>
          <div class="chalk-auth-error" data-testid="regenerate-error-message">
            {errorText}
          </div>
          <p class="chalk-auth-subtitle">
            <strong>important:</strong> your previous recovery code was
            consumed during recovery, and you don't have a new one yet.
            Please retry — if it keeps failing, contact the admin
            before logging out.
          </p>
          <button
            type="button"
            class="chalk-button chalk-button--primary"
            onClick={() => setAttempt((a) => a + 1)}
            data-testid="regenerate-retry"
          >
            try again
          </button>
        </div>
      </div>
    );
  }

  // Success: defer to RecoveryScreen with intent=regenerated.
  return (
    <RecoveryScreen
      username={me.username}
      userID={me.userID}
      recoveryWords={pendingWords ?? []}
      intent="regenerated"
      onConfirmed={onConfirmed}
    />
  );
}
