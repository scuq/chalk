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
  // Phase 9.7d: chat display settings (timestamps + compact mode).
  // Resolved upstream by selectChatPrefs() so all fields are defaulted.
  display?: {
    showTimestamps: boolean;
    timestampFormat: "hms" | "hm" | "relative";
    compactMode: boolean;
    // Phase 9.7e:
    userColors: { handle: string; color: string; scope: "all" | "dm" }[];
  };
  // Phase 9.7e: is the active channel a DM? Used to filter scoped color rules.
  isDM?: boolean;
  // Phase 10b: clicked an indicator or hover "reply" button. Dispatches
  // up to App.tsx, which routes to an open_thread action.
  // parentID is the message clicked; the parent itself doesn't have
  // to be the thread head, the caller resolves that.
  onOpenThread?: (parentID: string, resolvedThreadID: string) => void;
  // Phase 10d: per-thread "last seen reply seq" map. Used to compute
  // the unread badge ("↳ 5 replies · 2 new"). Optional -- callers
  // that don't care (e.g. the thread panel rendering its head)
  // can omit it.
  threadSeen?: Record<string, number>;
}

function fmtTime(d: Date): string {
  // Legacy hms format. Kept for the fallback path when display
  // prefs aren't passed (older callers, tests).
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// Phase 9.7d: format-aware timestamp.
function fmtTimeAs(d: Date, fmt: "hms" | "hm" | "relative", now: Date): string {
  if (fmt === "hms") return fmtTime(d);
  if (fmt === "hm") {
    const hh = d.getHours().toString().padStart(2, "0");
    const mm = d.getMinutes().toString().padStart(2, "0");
    return `${hh}:${mm}`;
  }
  // relative
  const diffMs = now.getTime() - d.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 2) return "yesterday";
  if (day < 7) return `${day}d ago`;
  // Older than a week: short calendar date.
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

export function MessageList({ messages, ownDevice, ownUserID, members, empty, display, isDM, onOpenThread, threadSeen }: Props) {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  // Phase 9.7d: resolved display settings + "now" for relative time.
  // We capture "now" once per render so all rows in a batch share the
  // same reference point; a setInterval would re-render every minute
  // for staleness, but that's out of scope for v1.
  const display_ = display ?? {
    showTimestamps: true,
    timestampFormat: "hms" as const,
    compactMode: false,
    userColors: [] as { handle: string; color: string; scope: "all" | "dm" }[],
  };
  const now = new Date();

  if (messages.length === 0) {
    return (
      <div class="chalk-messages chalk-messages--empty" data-testid="messages">
        <p class="chalk-empty-hint">{empty ?? "no messages yet. say something."}</p>
      </div>
    );
  }

  return (
    <div class={`chalk-messages ${display_.compactMode ? "chalk-messages--compact" : ""}`} data-testid="messages">
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
        // Phase 9.7e: lowercase-keyed lookup of user color rules
        // that apply in the current channel. Scope "all" always
        // applies; "dm" only when isDM is true. First-match wins,
        // so we build a Map (later identical-handle rules are
        // overwritten by earlier ones via set-once-if-absent).
        const colorByHandle = new Map<string, string>();
        for (const rule of display_.userColors) {
          if (!rule.handle || !rule.color) continue;
          if (rule.scope === "dm" && !isDM) continue;
          const key = rule.handle.toLowerCase();
          if (!colorByHandle.has(key)) colorByHandle.set(key, rule.color);
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
          <div class="chalk-message-group" key={m.id}>
          <div
            class={`chalk-message ${own ? "chalk-message--own" : ""} ${display_.showTimestamps ? "" : "chalk-message--no-time"}`}
            data-testid="message"
            title={display_.showTimestamps ? undefined : m.ts.toLocaleString()}
          >
            {display_.showTimestamps && (
              <span class="chalk-message-time" title={m.ts.toLocaleString()}>
                {fmtTimeAs(m.ts, display_.timestampFormat, now)}
              </span>
            )}
            <span
              class="chalk-message-sender"
              title={senderTitle}
              style={
                // Phase 9.7e: only color other users, never "you".
                !own && handle && colorByHandle.has(handle.toLowerCase())
                  ? { color: colorByHandle.get(handle.toLowerCase()) }
                  : undefined
              }
            >
              {senderLabel}
            </span>
            <span class="chalk-message-body" data-testid="message-body">
              {m.body}
            </span>
            {/* Phase 10b: hover-revealed reply button (desktop;
                shown via :hover in CSS). Hidden in compact mode to
                avoid stealing space. */}
            {onOpenThread && !display_.compactMode && (
              <button
                type="button"
                class="chalk-message-reply"
                title="reply in thread"
                onClick={() =>
                  onOpenThread(m.id, m.threadID ?? m.id)
                }
                data-testid={`message-reply-${m.id}`}
              >
                ↳ reply
              </button>
            )}
          </div>
          {/* Phase 10b: thread indicator. Only rendered for messages
              that are themselves thread heads (no parentID) AND that
              have at least one reply. Clicking opens the thread. */}
          {!m.parentID && (m.replyCount ?? 0) > 0 && onOpenThread && (() => {
            // Phase 10d: compute unread state.
            const seen = threadSeen?.[m.id] ?? 0;
            const lastSeq = m.lastReplySeq ?? 0;
            const hasUnread = lastSeq > seen;
            // Phase 10e: resolve the last-reply preview's sender label.
            // Mirrors the main row's "you" logic: if the sender_user_id
            // matches ownUserID, show "you"; else look up in members.
            let previewSenderLabel: string | null = null;
            if (m.lastReplyBody && m.lastReplySenderUserID) {
              if (ownUserID && m.lastReplySenderUserID === ownUserID) {
                previewSenderLabel = "you";
              } else {
                const handle = handleByUser.get(m.lastReplySenderUserID);
                if (handle) previewSenderLabel = handle;
              }
            }
            return (
              <>
                <button
                  type="button"
                  class={`chalk-message-thread-indicator ${hasUnread ? "chalk-message-thread-indicator--unread" : ""}`}
                  onClick={() => onOpenThread(m.id, m.id)}
                  data-testid={`thread-indicator-${m.id}`}
                >
                  ↳ {m.replyCount} {(m.replyCount === 1) ? "reply" : "replies"}
                  {hasUnread && (
                    <span class="chalk-message-thread-indicator-new"> · new</span>
                  )}
                </button>
                {previewSenderLabel && m.lastReplyBody && (
                  <button
                    type="button"
                    class="chalk-message-thread-preview"
                    onClick={() => onOpenThread(m.id, m.id)}
                    title={m.lastReplyBody}
                    data-testid={`thread-preview-${m.id}`}
                  >
                    <span class="chalk-message-thread-preview-sender">
                      {previewSenderLabel}:
                    </span>{" "}
                    <span class="chalk-message-thread-preview-body">
                      {m.lastReplyBody}
                    </span>
                  </button>
                )}
              </>
            );
          })()}
          </div>
        );
      });
      })()}
      <div ref={endRef} />
    </div>
  );
}
