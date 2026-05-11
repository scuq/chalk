import { useEffect, useRef } from "preact/hooks";
import type { MessagePayload } from "../proto";

interface Props {
  messages: MessagePayload[];
  ownDevice: string | null;
}

// Format a unix-ms timestamp as HH:MM:SS in local time. Phase 08 will
// switch to a smarter "today / yesterday / weekday / date" scheme; for
// the shell, raw time is enough and avoids a date library.
function fmtTime(ms: number): string {
  const d = new Date(ms);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function MessageList({ messages, ownDevice }: Props) {
  const endRef = useRef<HTMLDivElement | null>(null);

  // Scroll to bottom on every new message. Phase 08 will add "scroll
  // to bottom only when already near the bottom" so a user scrolled
  // up to read history isn't yanked back down.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  if (messages.length === 0) {
    return (
      <div class="chalk-messages chalk-messages--empty" data-testid="messages">
        <p class="chalk-empty-hint">no messages yet. say something.</p>
      </div>
    );
  }

  return (
    <div class="chalk-messages" data-testid="messages">
      {messages.map((m) => {
        const own = ownDevice !== null && m.sender === ownDevice;
        const senderLabel = m.sender === ""
          ? "[unknown]"
          : m.sender.slice(0, 8);
        return (
          <div
            key={m.id}
            class={`chalk-message ${own ? "chalk-message--own" : ""}`}
            data-testid="message"
          >
            <span class="chalk-message-time">{fmtTime(m.ts)}</span>
            <span class="chalk-message-sender">{senderLabel}</span>
            <span class="chalk-message-body" data-testid="message-body">
              {m.body}
            </span>
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
