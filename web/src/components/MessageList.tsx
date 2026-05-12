import { useEffect, useRef } from "preact/hooks";
import type { Message } from "../state/types";

interface Props {
  messages: Message[];
  ownDevice: string | null;
  // empty is the text shown when messages.length === 0. Phase 08b uses
  // this to distinguish "no messages yet" from "still loading history".
  empty?: string;
}

function fmtTime(d: Date): string {
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function MessageList({ messages, ownDevice, empty }: Props) {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  if (messages.length === 0) {
    return (
      <div class="chalk-messages chalk-messages--empty" data-testid="messages">
        <p class="chalk-empty-hint">{empty ?? "no messages yet. say something."}</p>
      </div>
    );
  }

  return (
    <div class="chalk-messages" data-testid="messages">
      {messages.map((m) => {
        const own = ownDevice !== null && m.sender === ownDevice;
        const senderLabel = m.sender === "" ? "[unknown]" : m.sender.slice(0, 8);
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
