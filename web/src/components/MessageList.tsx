import { Fragment } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { Message } from "../state/types";
import { AttachmentView } from "./AttachmentView";
import type { AttachmentController } from "../attachments/pipeline";
import { decideGiphyRender, type GiphyPref } from "../giphy/giphy";
import { DEFAULT_SELF_HUE, resolveNickHue } from "../chat/nickcolor";
import { splitBodyMentions } from "../chat/mentions";
import { lazyComponent } from "./LazyComponent";
// Lazy: Giphy render path is opt-in; keep it out of the initial bundle.
const GiphyView = lazyComponent(() =>
  import("./GiphyView").then((m) => m.GiphyView)
);

// 33-3: render a body with member mentions highlighted. The split yields
// plain strings and mention tokens; both go in as text nodes, so this adds
// no HTML-injection surface over rendering the raw body.
function MessageBody({
  body,
  known,
  ownHandle,
}: {
  body: string;
  known: Set<string>;
  ownHandle?: string | null;
}) {
  const segments = splitBodyMentions(body, known);
  if (segments.length === 1 && !segments[0].handle) return <>{body}</>;
  const me = ownHandle ? ownHandle.toLowerCase() : null;
  return (
    <>
      {segments.map((seg, i) =>
        seg.handle ? (
          <span
            key={i}
            class={`chalk-mention ${seg.handle === me ? "chalk-mention--self" : ""}`}
            data-testid={seg.handle === me ? "mention-self" : "mention"}
            data-handle={seg.handle}
          >
            {seg.text}
          </span>
        ) : (
          seg.text
        )
      )}
    </>
  );
}

// 33-4: how close to the bottom still counts as "following the feed". One
// message row of slack, so a partly-scrolled last line doesn't unpin you.
const PINNED_THRESHOLD_PX = 80;

function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= PINNED_THRESHOLD_PX;
}

// Nearest scrollable ancestor, or null if nothing scrolls (tests, jsdom).
function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  if (typeof window === "undefined") return null;
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const oy = window.getComputedStyle(p).overflowY;
    if (oy === "auto" || oy === "scroll") return p;
  }
  return null;
}

interface Props {
  messages: Message[];
  // 33-4: the channel these messages belong to. Identity, not data -- a
  // change means "the user navigated", which is what re-arms the landing
  // scroll. Optional so the thread panel (one continuous view) can omit it.
  channelID?: string;
  // 33-4: frozen unread window for this channel, if it had unread messages
  // when the user arrived. Drives the divider and the highlighted rows.
  unreadMark?: { afterSeq: number; throughSeq: number };
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

export function MessageList({ messages, channelID, unreadMark, ownDevice, ownUserID, ownHandle, members, empty, display, isDM, onOpenThread, threadSeen, canDeleteMessages, onDeleteMessage, attachmentController, giphyPref, onRequestEnableGiphy }: Props) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dividerRef = useRef<HTMLDivElement | null>(null);
  // 33-4: the channel we've already done the one-time landing scroll for.
  // Re-arms whenever channelID changes, i.e. on every navigation.
  const landedRef = useRef<string | null>(null);
  // 33-4: is the reader sitting at the bottom of the feed? Only then does a
  // new message scroll the view. Without this, landing on the divider is
  // undone by the first message that arrives afterwards -- and scrolling
  // back through history was already interrupted by every new message.
  const pinnedRef = useRef(true);

  // Watch the scroll position of whichever ancestor actually scrolls
  // (.chalk-main today). Found by computed style rather than by walking a
  // known number of parents, so a layout change doesn't silently break it.
  useEffect(() => {
    const sc = scrollParentOf(rootRef.current);
    if (!sc) return;
    const onScroll = () => {
      pinnedRef.current = isNearBottom(sc);
    };
    sc.addEventListener("scroll", onScroll, { passive: true });
    return () => sc.removeEventListener("scroll", onScroll);
    // hasMessages is a dependency because the empty state renders a
    // different root element -- without it, a channel entered while empty
    // would never get a listener once its history arrived. It flips only on
    // the empty/non-empty edge, not per message.
  }, [channelID, messages.length > 0]);

  // 33-4: index of the first message that was unread on arrival -- where the
  // "new messages" divider goes. -1 when there's nothing to mark.
  //
  // Note this looks only at afterSeq. If the unread run is longer than the
  // page of history we loaded, every visible message is new and the divider
  // lands at the top, which is honest.
  const dividerIndex = unreadMark
    ? messages.findIndex((m) => m.seq > unreadMark.afterSeq)
    : -1;

  // Scroll behaviour, in two modes.
  //
  // On arrival (first commit for this channelID that has messages) we land
  // once: on the divider if there is one, otherwise at the newest message.
  // The landing is instant rather than smooth -- animating a jump the user
  // didn't ask for just makes the view feel like it's still settling.
  //
  // After that, any new message pins the view to the bottom as before.
  useEffect(() => {
    if (messages.length === 0) return;
    if (landedRef.current !== (channelID ?? null)) {
      landedRef.current = channelID ?? null;
      if (dividerIndex >= 0 && dividerRef.current) {
        dividerRef.current.scrollIntoView({ behavior: "auto", block: "start" });
        // Landing mid-history means not pinned. Set it here rather than
        // waiting for the scroll event, so a message arriving in the same
        // tick can't win the race and yank us to the bottom.
        pinnedRef.current = false;
        return;
      }
      endRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
      pinnedRef.current = true;
      return;
    }
    if (!pinnedRef.current) return;
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, channelID, dividerIndex]);

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
    <div ref={rootRef} class={`chalk-messages ${display_.compactMode ? "chalk-messages--compact" : ""} ${display_.showTimestamps ? "" : "chalk-messages--no-time"}`} data-testid="messages">
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
        // 33-3: the handles a mention may resolve to in this channel. Only
        // members get highlighted, so "@nobody" reads as ordinary text
        // instead of implying someone was pinged.
        const knownHandles = new Set<string>();
        for (const h of handleByUser.values()) knownHandles.add(h.toLowerCase());
        if (ownHandle) knownHandles.add(ownHandle.toLowerCase());
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

        return messages.map((m, mi) => {
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
        // 33-4: highlight only what was unread on arrival. The upper bound
        // is what stops messages arriving while you read from joining the
        // highlighted block.
        const isUnread =
          unreadMark !== undefined &&
          m.seq > unreadMark.afterSeq &&
          m.seq <= unreadMark.throughSeq;
        return (
          <Fragment key={m.id}>
          {mi === dividerIndex && (
            <div
              class="chalk-unread-divider"
              ref={dividerRef}
              data-testid="unread-divider"
            >
              <span class="chalk-unread-divider-label">new messages</span>
            </div>
          )}
          <div class="chalk-message-group">
          <div
            class={`chalk-message ${own ? "chalk-message--own" : ""} ${isUnread ? "chalk-message--unread" : ""} ${display_.showTimestamps ? "" : "chalk-message--no-time"}`}
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
                      // 33-3: mentions of channel members render highlighted,
                      // with the user's own mention louder. Segments are text
                      // nodes either way -- nothing here is parsed as markup.
                      <MessageBody
                        body={m.body}
                        known={knownHandles}
                        ownHandle={ownHandle}
                      />
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
            {/* Phase 10b: hover-revealed reply button (shown via :hover in
                CSS, always visible on touch). It's an absolute overlay on
                the row's right edge, so it costs no layout space -- compact
                mode gets it too, same as the delete control below.
                Suppressed on deleted rows. */}
            {onOpenThread && !m.deleted && (
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
          </Fragment>
        );
      });
      })()}
      <div ref={endRef} />
    </div>
  );
}
