import { useEffect, useRef } from "preact/hooks";
import type { Message } from "../state/types";

interface Props {
  messages: Message[];
  ownDevice: string | null;
  // Phase 9.6i: lets the renderer detect "this is my own message"
  // via user_id even when the message arrived from another of my
  // devices, AND lets us resolve other senders to handles via the
  // channel's members[] (passed in alongside).
  ownUserID?: string | null;
  members?: { userID: string; handle: string }[];
  // empty is the text shown when messages.length === 0.
  empty?: string;
}

function fmtTime(d: Date): string {
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function MessageList({ messages, ownDevice, ownUserID, members, empty }: Props) {
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
      {(() => {
        // Phase 9.6i: build a userID → handle lookup once per render
        // pass instead of re-scanning members for every message row.
        const handleByUser = new Map<string, string>();
        if (members) {
          for (const mem of members) {
            if (mem.userID && mem.handle) {
              handleByUser.set(mem.userID, mem.handle);
            }
          }
        }
        return messages.map((m) => {
        // "Own" detection prefers user_id matching when both sides
        // are known; falls back to device matching otherwise. This
        // means if you have multiple devices for the same account,
        // your own messages from another device still render as "you".
        const ownByUser = ownUserID !== null && ownUserID !== undefined
          && m.senderUserID !== "" && m.senderUserID === ownUserID;
        const ownByDevice = ownDevice !== null && m.sender === ownDevice;
        const own = ownByUser || ownByDevice;
        // Sender label: prefer member handle (resolved via
        // sender_user_id), fall back to device-id slice for legacy
        // / purged-user messages.
        const handle = m.senderUserID
          ? handleByUser.get(m.senderUserID)
          : undefined;
        const senderLabel = own
          ? "you"
          : handle
          ? handle
          : m.sender === ""
          ? "[unknown]"
          : m.sender.slice(-8);
        const senderTitle = m.sender === ""
          ? "unknown sender"
          : m.senderUserID
          ? `${handle ?? "?"} (user ${m.senderUserID.slice(0, 8)}…, device ${m.sender.slice(0, 8)}…)`
          : m.sender;
        return (
          <div
            key={m.id}
            class={`chalk-message ${own ? "chalk-message--own" : ""}`}
            data-testid="message"
          >
            <span class="chalk-message-time">{fmtTime(m.ts)}</span>
            <span class="chalk-message-sender" title={senderTitle}>
              {senderLabel}
            </span>
            <span class="chalk-message-body" data-testid="message-body">
              {m.body}
            </span>
          </div>
        );
      });
      })()}
      <div ref={endRef} />
    </div>
  );
}
