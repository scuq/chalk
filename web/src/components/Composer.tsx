import { useState } from "preact/hooks";
import type { JSX } from "preact";

// Phase 9.6g: disabledReason distinguishes the two reasons the
// composer might be unusable. "offline" reflects a real connection
// problem; "no_channel" is informational and means "you haven't
// picked a chat yet." `null` means the composer is enabled.
//
// We keep the existing `disabled` prop as an alternative for
// callers that don't care about the reason; the component renders
// from whichever is more specific.
type DisabledReason = "offline" | "no_channel" | null;

interface Props {
  // Legacy boolean. When provided AND disabledReason is null, we
  // fall back to a generic placeholder ("offline -- waiting to
  // reconnect") to preserve old behavior for callers that haven't
  // been updated to pass disabledReason.
  disabled?: boolean;
  // Phase 9.6g: prefer this over `disabled` for accurate UX.
  disabledReason?: DisabledReason;
  onSend: (body: string) => void;
  // Phase 10c: optional placeholder override (defaults to channel-aware
  // text from disabledReason mapping). The thread composer passes
  // "reply...". When disabled, the disabled-reason text still wins.
  placeholder?: string;
}

const MAX_LEN = 4000;

export function Composer({ disabled, disabledReason, onSend, placeholder }: Props) {
  const [draft, setDraft] = useState("");

  // Phase 9.6g: derive the effective disabled boolean + the
  // placeholder text from disabledReason (preferred) or fall back
  // to the legacy `disabled` prop.
  const effectiveDisabled =
    disabledReason !== null && disabledReason !== undefined
      ? true
      : disabled ?? false;
  const placeholderText =
    disabledReason === "offline"
      ? "offline -- waiting to reconnect"
      : disabledReason === "no_channel"
      ? "select a channel to start chatting"
      : effectiveDisabled
      ? "offline -- waiting to reconnect"
      : "say something...";

  const submit = () => {
    const body = draft.trim();
    if (!body) return;
    if (body.length > MAX_LEN) return;
    onSend(body);
    setDraft("");
  };

  const onInput = (e: JSX.TargetedEvent<HTMLTextAreaElement>) => {
    setDraft(e.currentTarget.value);
  };

  // Enter to send, Shift+Enter for newline. The Composer is a textarea
  // not a form because we don't want a browser submit + page reload.
  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div class="chalk-composer">
      <textarea
        class="chalk-composer-input"
        placeholder={(disabled ? (placeholderText) : (placeholder ?? (placeholderText)))}
        value={draft}
        onInput={onInput}
        onKeyDown={onKeyDown}
        disabled={effectiveDisabled}
        rows={2}
        maxLength={MAX_LEN}
        data-testid="composer-input"
        aria-label="message"
      />
      <button
        type="button"
        class="chalk-composer-send"
        onClick={submit}
        disabled={effectiveDisabled || draft.trim().length === 0}
        data-testid="composer-send"
      >
        send
      </button>
    </div>
  );
}
