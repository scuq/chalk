import { useEffect, useRef } from "preact/hooks";
import type { Message } from "../state/types";
import { AttachmentView } from "./AttachmentView";
import type { AttachmentController } from "../attachments/pipeline";
import { decideGiphyRender, type GiphyPref } from "../giphy/giphy";
import { DEFAULT_SELF_HUE, resolveNickHue } from "../chat/nickcolor";
import { lazyComponent } from "./LazyComponent";
// Lazy: Giphy render path is opt-in; keep it out of the initial bundle.
const GiphyView = lazyComponent(() =>
  import("./GiphyView").then((m) => m.GiphyView)
);

interface Props {
  messages: Message[];
  ownDevice: string | null;
  // Phase 9.6i: lets the renderer detect "this is my own message"
  // via user_id even when the message arrived from another of my
  // devices, AND lets us resolve other senders to handles via the
  // channel's members[] (passed in alongside).
  ownUserID?: string | null;
  // Phase 9.7k: the viewer's own handle, shown instead of the literal "you"
  // on their messages. Falls back to "you" when unknown (pre-session).
  ownHandle?: string | null;
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
    // Phase 9.7f: hue-based nick coloring (see chat/nickcolor.ts).
    userColorsEnabled: boolean;
    selfColorHue: number;
    userHues: Record<string, number>;
  };
  // Phase 9.7e: is the active channel a DM? Used to filter scoped color rules.
  isDM?: boolean;
  // att-4c: the viewer's Giphy consent pref + a way to open the consent modal
  // from a blocked-unset giphy message. Optional; absent => "unset" (giphy
  // messages render inert), which is the safe default for any caller that
  // doesn't wire these (e.g. the thread panel before att-4 lands there).
  giphyPref?: GiphyPref;
  onRequestEnableGiphy?: () => void;
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
  // Phase 26 (governance prereq): owner-only message deletion. When
  // canDeleteMessages is true, a hover "delete" control renders on each
  // non-deleted message; clicking calls onDeleteMessage(m). The caller
  // (App) wires this to a confirm + the delete_message request.
  canDeleteMessages?: boolean;
  onDeleteMessage?: (m: Message) => void;
  // att-2: receive-side attachment pipeline (decrypt meta/preview/full +
  // download), bound to the channel crypto. When absent (or a message has no
  // attachments) nothing extra renders.
  attachmentController?: AttachmentController;
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

export function MessageList({ messages, ownDevice, ownUserID, ownHandle, members, empty, display, isDM, onOpenThread, threadSeen, canDeleteMessages, onDeleteMessage, attachmentController, giphyPref, onRequestEnableGiphy }: Props) {
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
    userColorsEnabled: true,
    selfColorHue: DEFAULT_SELF_HUE,
    userHues: {} as Record<string, number>,
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
    <div class={`chalk-messages ${display_.compactMode ? "chalk-messages--compact" : ""} ${display_.showTimestamps ? "" : "chalk-messages--no-time"}`} data-testid="messages">
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
        // Phase 9.7k: size the sender column to the WIDEST label actually in
        // this view, not a fixed 8ch. Short-name channels ("you", "alice9")
        // tighten up; a long handle widens the column just enough. Capped at
        // 10ch: past that the label wraps (white-space: normal on the cell)
        // rather than pushing the body arbitrarily far right. Min 4ch so a
        // channel of only "you" still has a sane gutter.
        //
        // Computed from the labels we're about to render: own -> ownHandle,
        // others -> their handle, else the device-id slice (8).
        let maxNameLen = 4;
        for (const mm of messages) {
          const isOwn =
            (ownUserID != null && mm.senderUserID !== "" && mm.senderUserID === ownUserID) ||
            (ownDevice != null && mm.sender === ownDevice);
          let label: string;
          if (isOwn) label = (ownHandle && ownHandle.length > 0) ? ownHandle : "you";
          else {
            const hh = mm.senderUserID ? handleByUser.get(mm.senderUserID) : undefined;
            label = hh ?? (mm.sender === "" ? "[unknown]" : mm.sender.slice(-8));
          }
          if (label.length > maxNameLen) maxNameLen = label.length;
        }
        // Cap so an outlier name wraps instead of shoving every body right.
        const senderColCh = Math.min(maxNameLen, 10);

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
          ? (ownHandle && ownHandle.length > 0 ? ownHandle : "you")
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
            style={`--chalk-msg-sender-col:${senderColCh}ch`}
            data-testid="message"
            title={display_.showTimestamps ? undefined : m.ts.toLocaleString()}
          >
            {display_.showTimestamps && (
              <span class="chalk-message-time" title={m.ts.toLocaleString()}>
                {fmtTimeAs(m.ts, display_.timestampFormat, now)}
              </span>
            )}
            {(() => {
              // Phase 9.7f: resolve the sender's hue (own -> self color,
              // otherwise explicit pick / legacy 9.7e hex / auto hash). The
              // hue goes out as a CSS custom property and the theme supplies
              // saturation + lightness, so one stored value reads correctly
              // on both dark and light themes.
              const nickHue = resolveNickHue({
                enabled: display_.userColorsEnabled,
                own,
                handle,
                selfHue: display_.selfColorHue,
                userHues: display_.userHues,
                legacyColorByHandle: colorByHandle,
              });
              return (
                <span
                  class={`chalk-message-sender ${nickHue !== null ? "chalk-message-sender--tinted" : ""}`}
                  title={senderTitle}
                  style={nickHue !== null ? `--nick-h:${nickHue}` : undefined}
                >
                  {senderLabel}
                </span>
              );
            })()}
            {(() => {
              // giphy-layout: a giphy-marked body renders as a gated GIF that
              // BREAKS OUT to the row's left edge (grid-column 1/-1), exactly
              // like an attachment image -- not inline in the narrow body
              // column. Non-giphy bodies render as plain text in the body span.
              const gr = m.deleted ? null : decideGiphyRender(m.body, giphyPref ?? "unset");
              const isGiphy = gr !== null && gr.mode !== "text";
              return (
                <>
                  <span class="chalk-message-body" data-testid="message-body">
                    {m.deleted ? (
                      <span class="chalk-message-deleted" data-testid="message-deleted">
                        message deleted
                      </span>
                    ) : isGiphy ? null : (
                      m.body
                    )}
                  </span>
                  {gr && gr.mode !== "text" && (
                    <div class="chalk-message-giphy" data-testid="message-giphy">
                      <GiphyView render={gr} onRequestEnableGiphy={onRequestEnableGiphy} />
                    </div>
                  )}
                </>
              );
            })()}
            {/* att-2: encrypted attachments. Each decrypts independently and
                fails closed to a locked placeholder if the key is missing.
                Suppressed on deleted rows. */}
            {!m.deleted && attachmentController && m.attachments && m.attachments.length > 0 && (
              <div class="chalk-message-attachments" data-testid="message-attachments">
                {m.attachments.map((att) => (
                  <AttachmentView
                    key={att.id}
                    channelID={m.channelID}
                    att={att}
                    controller={attachmentController}
                  />
                ))}
              </div>
            )}
            {/* Phase 10b: hover-revealed reply button (desktop;
                shown via :hover in CSS). Hidden in compact mode to
                avoid stealing space. Suppressed on deleted rows. */}
            {onOpenThread && !display_.compactMode && !m.deleted && (
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
            {/* Phase 26 (governance prereq): owner-only delete control.
                Hidden on already-deleted rows. */}
            {canDeleteMessages && onDeleteMessage && !m.deleted && (
              <button
                type="button"
                class="chalk-message-delete"
                title="delete message"
                onClick={() => onDeleteMessage(m)}
                data-testid={`message-delete-${m.id}`}
              >
                ✕ delete
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
              // Phase 9.7j: wrapper carries the body-column indent. It must,
              // because `ch` is font-relative: the indicator (12px) and the
              // preview (11px) would each resolve the same ch-based offset to
              // a different width. The wrapper sits at the base font size, so
              // the offset matches the message grid exactly.
              <div class="chalk-message-thread-meta">
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
              </div>
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
