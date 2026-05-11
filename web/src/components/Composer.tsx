import { useState } from "preact/hooks";
import type { JSX } from "preact";

interface Props {
  disabled: boolean;
  onSend: (body: string) => void;
}

const MAX_LEN = 4000;

export function Composer({ disabled, onSend }: Props) {
  const [draft, setDraft] = useState("");

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
        placeholder={disabled ? "offline -- waiting to reconnect" : "say something..."}
        value={draft}
        onInput={onInput}
        onKeyDown={onKeyDown}
        disabled={disabled}
        rows={2}
        maxLength={MAX_LEN}
        data-testid="composer-input"
        aria-label="message"
      />
      <button
        type="button"
        class="chalk-composer-send"
        onClick={submit}
        disabled={disabled || draft.trim().length === 0}
        data-testid="composer-send"
      >
        send
      </button>
    </div>
  );
}
