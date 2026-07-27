import { Fragment } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { Message, ReactionSet } from "../state/types";
import { aggregate } from "../chat/reactions";
import { buildMessageMenu, type MessageMenuItem } from "../chat/message-menu";
import { MessageMenu } from "./MessageMenu";
import { AttachmentView } from "./AttachmentView";
import type { AttachmentController } from "../attachments/pipeline";
import { decideGiphyRender, type GiphyPref } from "../giphy/giphy";
import { DEFAULT_SELF_HUE, nickTintStyle, resolveNickHue } from "../chat/nickcolor";
import { splitBodyParts } from "../chat/links";
import { fmtRelative } from "../chat/reltime";
import { lazyComponent } from "./LazyComponent";
// Lazy: Giphy render path is opt-in; keep it out of the initial bundle.
const GiphyView = lazyComponent(() =>
  import("./GiphyView").then((m) => m.GiphyView)
);

// 33-3 / 41-4: render a body with member mentions highlighted and http(s)
// URLs turned into links. The split yields plain strings, mention tokens and
// link tokens; the text of all three goes in as text nodes, and a link's href
// is restricted to http/https by chat/links.ts, so this adds no
// HTML-injection surface over rendering the raw body.
function MessageBody({
  body,
  known,
  ownHandle,
}: {
  body: string;
  known: Set<string>;
  ownHandle?: string | null;
}) {
  const segments = splitBodyParts(body, known);
  if (segments.length === 1 && !segments[0].handle && !segments[0].href) return <>{body}</>;
  const me = ownHandle ? ownHandle.toLowerCase() : null;
  return (
    <>
      {segments.map((seg, i) =>
        seg.href ? (
          <a
            key={i}
            class="chalk-body-link"
            href={seg.href}
            target="_blank"
            // noopener is what matters: the destination is a page someone
            // else chose, and it must not be able to reach back into this
            // tab. noreferrer additionally keeps the chalk host out of the
            // request -- a self-hosted instance's address is not something to
            // hand to every site anyone ever pastes.
            rel="noopener noreferrer"
            title={seg.href}
            data-testid="body-link"
          >
            {seg.text}
          </a>
        ) : seg.handle ? (
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

// 37-6: is the keystroke going into something the user is typing in? A bare
// letter shortcut must never eat a character meant for the composer, a search
// box, or the emoji picker's own filter field.
function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
}

// 41-3: should a right-click on a row fall through to the browser's own menu?
// Only where the browser's menu is the one the user wants: over a link ("copy
// link address") and over text they have selected ("copy"). Reimplementing
// either inside the row menu would be strictly worse than not stealing the
// gesture in the first place.
function wantsNativeContextMenu(target: EventTarget | null, row: HTMLElement): boolean {
  const el = target as HTMLElement | null;
  // Links, images and the media wrappers: "copy link address" and "save image
  // as" have no equivalent in our menu, and never will.
  if (el?.closest?.("a[href], img, .chalk-message-attachments, .chalk-message-giphy")) {
    return true;
  }
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  if (!sel || sel.isCollapsed || sel.toString().trim() === "") return false;
  // Only a selection inside THIS row counts -- a stale one elsewhere on the
  // page must not disable the menu here.
  return sel.anchorNode !== null && row.contains(sel.anchorNode);
}

// How long a touch has to rest on a row before it counts as a press. Matches
// the roster's colour menu.
const LONG_PRESS_MS = 500;
// ...and how far it may wander first. A finger is never perfectly still, so
// cancelling on any movement at all would make the press unreliable; this is
// wide enough to survive a resting hand and narrow enough that a scroll or a
// drag never opens a menu. (The roster's rows are short enough to rely on
// pointercancel alone; a message row is tall enough to drag inside.)
const LONG_PRESS_SLOP_PX = 10;

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

// 33-5: where the view should stay while the feed is still settling.
// "divider" and "end" are the two landing targets; null means the user has
// taken over and nothing should move the view but the user.
type Anchor = "divider" | "end" | null;

function scrollToAnchor(
  anchor: Anchor,
  divider: HTMLElement | null,
  end: HTMLElement | null,
) {
  if (anchor === "divider" && divider) {
    divider.scrollIntoView({ behavior: "auto", block: "start" });
  } else if (anchor === "end" && end) {
    end.scrollIntoView({ behavior: "auto", block: "end" });
  }
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
  // Phase 10b: clicked a thread indicator or the menu's "reply in thread".
  // Dispatches
  // up to App.tsx, which routes to an open_thread action.
  // parentID is the message clicked; the parent itself doesn't have
  // to be the thread head, the caller resolves that.
  onOpenThread?: (parentID: string, resolvedThreadID: string) => void;
  // Phase 10d: per-thread "last seen reply seq" map. Used to compute
  // the unread badge ("↳ 5 replies · 2 new"). Optional -- callers
  // that don't care (e.g. the thread panel rendering its head)
  // can omit it.
  threadSeen?: Record<string, number>;
  // Phase 26 (governance prereq) / 35-3: message deletion. Both what you may
  // do and what it's called vary per message (your own vs another member's,
  // DM vs group, dictator vs democratic), so the caller owns the policy --
  // see chat/deletepolicy.ts. deleteLabelFor names the action because in a
  // democratic channel it opens a vote rather than deleting. The control sits
  // at the bottom of the row menu, below a rule: deletion is destructive and
  // irreversible, so it should not be where the pointer lands first.
  canDeleteMessage?: (m: Message) => boolean;
  onDeleteMessage?: (m: Message) => void;
  deleteLabelFor?: (m: Message) => string;
  // Phase 37-3: message editing. Same caller-owns-the-policy shape as delete
  // (see chat/editpolicy.ts), but a narrower rule: only the author, only
  // inside the edit window, and the caller additionally restricts it to their
  // most recent message. Sits beside delete in the row menu -- the primary way
  // in is cursor-up from the composer, so this is the discoverable fallback
  // rather than the main path.
  canEditMessage?: (m: Message) => boolean;
  onEditMessage?: (m: Message) => void;
  // The message currently open for editing, so its row can show it. Null when
  // not editing.
  editingMessageID?: string | null;
  // 37-5: decrypted reaction sets by message id, and the toggle callback. The
  // caller owns the crypto and the frame; this only renders chips and reports
  // clicks. Absent props mean no reaction affordance at all (the thread
  // panel's head list passes them, the same as delete/edit).
  reactions?: Record<string, ReactionSet[]>;
  onToggleReaction?: (m: Message, emoji: string) => void;
  // Opens the caller's emoji picker for this message. Separate from
  // onToggleReaction because the picker is a modal the caller owns: chips
  // toggle a KNOWN emoji, this asks for a new one.
  onPickReaction?: (m: Message) => void;
  // att-2: receive-side attachment pipeline (decrypt meta/preview/full +
  // download), bound to the channel crypto. When absent (or a message has no
  // attachments) nothing extra renders.
  attachmentController?: AttachmentController;
  // 45-3: voice-channel scratchpad mode. The feed is not history here -- it
  // lives for the duration of a call -- so it shows only what fits above the
  // composer and lets the rest scroll off the top for good. No scrollback
  // means the landing/anchor machinery has nothing to do either.
  ephemeral?: boolean;
  // 49-1: "show message" -- the row to scroll to and flash-highlight, or
  // null/absent for none. While the row is not yet in `messages` (App may
  // still be backfilling history pages to reach it) the effect simply waits;
  // onFlashDone fires once the highlight has run, and the caller clears the
  // id in response.
  flashMessageID?: string | null;
  onFlashDone?: () => void;
}

// 45-3: how many scratchpad rows are kept in the DOM. Well past what any
// realistic pane shows -- the clipping is done by CSS, this only stops a long
// call from growing an unbounded list of nodes nobody can scroll to.
const EPHEMERAL_MAX_ROWS = 60;

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
  // 42-8: shared with the thread inbox, which formats times the same way.
  return fmtRelative(d, now);
}

export function MessageList({ messages: allMessages, channelID, unreadMark, ownDevice, ownUserID, ownHandle, members, empty, display, isDM, onOpenThread, threadSeen, canDeleteMessage, onDeleteMessage, deleteLabelFor, canEditMessage, onEditMessage, editingMessageID, reactions, onToggleReaction, onPickReaction, attachmentController, giphyPref, onRequestEnableGiphy, ephemeral, flashMessageID, onFlashDone }: Props) {
  const messages = ephemeral ? allMessages.slice(-EPHEMERAL_MAX_ROWS) : allMessages;
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
  // 33-5: what the view is currently anchored to, if anything. Landing is
  // not a single scroll -- attachments render a 200x120 placeholder and then
  // swap in a full-size image, and Giphy embeds are lazily imported with no
  // reserved height. Both inflate the feed AFTER the landing scroll has run,
  // and neither changes messages.length, so nothing re-ran and the view was
  // left parked at whichever image grew. Holding the anchor until the user
  // takes over is what makes the landing survive that.
  const anchorRef = useRef<Anchor>(null);
  // 41-3: the open row menu -- which message, and where the pointer was.
  // Coordinates are viewport-relative because the menu is position:fixed. The
  // message is held by id, not by value: a reaction or an edit landing while
  // the menu is open replaces the Message object, and a captured one would go
  // stale under it.
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  // Never leave a menu hanging over a different channel's feed.
  useEffect(() => setMenu(null), [channelID]);

  // What this caller lets the viewer do to a given message. One place, so the
  // marker's visibility, the right-click, the long-press and the "r" shortcut
  // can never disagree about whether there is a menu to open.
  const menuItemsFor = useCallback(
    (m: Message): MessageMenuItem[] =>
      buildMessageMenu({
        deleted: Boolean(m.deleted),
        canReact: Boolean(onPickReaction),
        canReply: Boolean(onOpenThread),
        hasText: m.body.trim().length > 0,
        canEdit: Boolean(canEditMessage?.(m) && onEditMessage),
        canDelete: Boolean(canDeleteMessage?.(m) && onDeleteMessage),
        deleteLabel: deleteLabelFor?.(m),
      }),
    [onPickReaction, onOpenThread, canEditMessage, onEditMessage, canDeleteMessage, onDeleteMessage, deleteLabelFor],
  );

  const openMenu = useCallback((m: Message, x: number, y: number) => {
    setMenu({ id: m.id, x, y });
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  // 37-6: id of the row the pointer is over, for the "r" shortcut.
  //
  // A ref rather than state on purpose: hovering must not re-render the feed
  // (that would be a full list re-render per row you sweep past), and the only
  // reader is the keydown handler, which runs outside render anyway.
  const hoverRef = useRef<string | null>(null);

  // Hover a message, press "r", get the menu. Guarded three ways: no
  // modifiers (so Ctrl-R still reloads), not while typing anywhere (so "r" in
  // the composer stays an "r"), and only when the pointer is actually over a
  // row. Both mounted lists register this, but only the one under the pointer
  // has a hoverRef set, so exactly one responds.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "r" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (isTypingTarget(e.target)) return;
      const id = hoverRef.current;
      if (!id) return;
      const m = messages.find((x) => x.id === id);
      if (!m || menuItemsFor(m).length === 0) return;
      // Anchor to the row rather than the pointer: the keyboard has no
      // pointer, and the row's left edge is where the marker would be.
      const row = rootRef.current?.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
      const r = row?.getBoundingClientRect();
      e.preventDefault();
      openMenu(m, r ? r.left + 8 : 0, r ? r.bottom : 0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [messages, menuItemsFor, openMenu]);

  // Touch has no hover to reveal the marker with, so a 500ms press on the row
  // opens the menu -- the same gesture the roster's colour menu uses.
  const longPressTimer = useRef<number | null>(null);
  const longPressFired = useRef(false);
  const pressOrigin = useRef<{ x: number; y: number } | null>(null);
  const cancelLongPress = () => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    pressOrigin.current = null;
  };

  // Watch the scroll position of whichever ancestor actually scrolls
  // (.chalk-main today). Found by computed style rather than by walking a
  // known number of parents, so a layout change doesn't silently break it.
  useEffect(() => {
    if (ephemeral) return; // 45-3: nothing scrolls, nothing to follow
    const sc = scrollParentOf(rootRef.current);
    if (!sc) return;
    const onScroll = () => {
      pinnedRef.current = isNearBottom(sc);
    };
    // Release the anchor on a real user gesture, not on scroll events --
    // our own programmatic scrolls fire those too, and couldn't be told
    // apart. keydown goes on the window because page-level scroll keys
    // (space, PageDown) are rarely delivered to the scroller itself.
    const release = () => {
      anchorRef.current = null;
    };
    sc.addEventListener("scroll", onScroll, { passive: true });
    sc.addEventListener("wheel", release, { passive: true });
    sc.addEventListener("touchstart", release, { passive: true });
    sc.addEventListener("mousedown", release);
    window.addEventListener("keydown", release);
    return () => {
      sc.removeEventListener("scroll", onScroll);
      sc.removeEventListener("wheel", release);
      sc.removeEventListener("touchstart", release);
      sc.removeEventListener("mousedown", release);
      window.removeEventListener("keydown", release);
    };
    // hasMessages is a dependency because the empty state renders a
    // different root element -- without it, a channel entered while empty
    // would never get a listener once its history arrived. It flips only on
    // the empty/non-empty edge, not per message.
  }, [channelID, messages.length > 0, ephemeral]);

  // 33-5: re-apply the anchor whenever the feed changes height. This is the
  // fix for late-loading media: every image that resolves fires this, and
  // the view is put back where the landing meant to leave it.
  //
  // scrollIntoView changes scrollTop, not layout, so this can't feed itself.
  useEffect(() => {
    const el = rootRef.current;
    if (ephemeral || !el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (anchorRef.current === null) return;
      scrollToAnchor(anchorRef.current, dividerRef.current, endRef.current);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [channelID, messages.length > 0, ephemeral]);

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
    if (ephemeral || messages.length === 0) return;
    if (landedRef.current !== (channelID ?? null)) {
      landedRef.current = channelID ?? null;
      // Landing mid-history means not pinned. Set it here rather than
      // waiting for the scroll event, so a message arriving in the same
      // tick can't win the race and yank us to the bottom.
      const landOnDivider = dividerIndex >= 0 && dividerRef.current !== null;
      pinnedRef.current = !landOnDivider;
      anchorRef.current = landOnDivider ? "divider" : "end";
      scrollToAnchor(anchorRef.current, dividerRef.current, endRef.current);
      return;
    }
    if (!pinnedRef.current) return;
    // Re-arm the anchor: we're following the feed, so keep following it
    // while this message's images resolve.
    anchorRef.current = "end";
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, channelID, dividerIndex, ephemeral]);

  // 49-1: "show message" -- scroll the flash target into view once it
  // exists. Declared after the landing effect so a channel-switch-and-jump
  // in one action ends on the target, not on the landing anchor. Backfill
  // pages arriving change messages.length, so a target that isn't loaded yet
  // is retried, not failed. The anchor is dropped for good: the user asked
  // to be HERE, and the next live message must not yank them to the bottom.
  useEffect(() => {
    if (ephemeral || !flashMessageID) return;
    const row = rootRef.current?.querySelector<HTMLElement>(
      `[data-message-id="${flashMessageID}"]`,
    );
    if (!row) return;
    anchorRef.current = null;
    pinnedRef.current = false;
    row.scrollIntoView({ behavior: "auto", block: "center" });
    // Outlives the highlight animation; the caller clears flashMessageID in
    // response, which removes the row class.
    const t = window.setTimeout(() => onFlashDone?.(), 1600);
    return () => window.clearTimeout(t);
    // onFlashDone is deliberately not a dep: the caller recreates it every
    // render, and re-arming the timer each render would keep pushing "done"
    // out under a busy feed.
  }, [flashMessageID, messages.length, channelID, ephemeral]);

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
      <div
        class={`chalk-messages chalk-messages--empty ${ephemeral ? "chalk-messages--ephemeral" : ""}`}
        data-testid="messages"
      >
        <p class="chalk-empty-hint">{empty ?? "no messages yet. say something."}</p>
      </div>
    );
  }

  return (
    <div ref={rootRef} class={`chalk-messages ${display_.compactMode ? "chalk-messages--compact" : ""} ${display_.showTimestamps ? "" : "chalk-messages--no-time"} ${ephemeral ? "chalk-messages--ephemeral" : ""}`} data-testid="messages">
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
        // giphy-layout: a giphy-marked body renders as a gated GIF that
        // BREAKS OUT to the row's left edge (grid-column 1/-1), exactly
        // like an attachment image -- not inline in the narrow body
        // column. Non-giphy bodies render as plain text in the body span.
        const gr = m.deleted ? null : decideGiphyRender(m.body, giphyPref ?? "unset");
        const isGiphy = gr !== null && gr.mode !== "text";
        // The body span renders nothing (no text, no deletion notice, no
        // edited marker); media on such rows pulls up beside the sender.
        const noBody = !m.deleted && (isGiphy || m.body.trim() === "") && !m.editedAt;
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
          <div
            class="chalk-message-group"
            onMouseEnter={() => (hoverRef.current = m.id)}
            onMouseLeave={() => {
              if (hoverRef.current === m.id) hoverRef.current = null;
            }}
          >
          <div
            class={`chalk-message ${own ? "chalk-message--own" : ""} ${isUnread ? "chalk-message--unread" : ""} ${display_.showTimestamps ? "" : "chalk-message--no-time"} ${editingMessageID === m.id ? "chalk-message--editing" : ""} ${menu?.id === m.id ? "chalk-message--menu-open" : ""} ${flashMessageID === m.id ? "chalk-message--flash" : ""} ${noBody ? "chalk-message--no-body" : ""}`}
            style={`--chalk-msg-sender-col:${senderColCh}ch`}
            data-testid="message"
            data-message-id={m.id}
            title={display_.showTimestamps ? undefined : m.ts.toLocaleString()}
            onContextMenu={(e) => {
              const row = e.currentTarget as HTMLElement;
              if (wantsNativeContextMenu(e.target, row)) return;
              if (menuItemsFor(m).length === 0) return;
              e.preventDefault();
              openMenu(m, e.clientX, e.clientY);
            }}
            onPointerDown={(e) => {
              if (e.pointerType === "mouse") return; // right-click covers desktop
              cancelLongPress();
              longPressFired.current = false;
              if (menuItemsFor(m).length === 0) return;
              const x = e.clientX;
              const y = e.clientY;
              pressOrigin.current = { x, y };
              longPressTimer.current = window.setTimeout(() => {
                longPressFired.current = true;
                openMenu(m, x, y);
              }, LONG_PRESS_MS);
            }}
            // A press that turns into a scroll or a drag is not a press.
            onPointerMove={(e) => {
              const o = pressOrigin.current;
              if (!o) return;
              if (Math.hypot(e.clientX - o.x, e.clientY - o.y) > LONG_PRESS_SLOP_PX) {
                cancelLongPress();
              }
            }}
            onPointerUp={cancelLongPress}
            onPointerLeave={cancelLongPress}
            onPointerCancel={cancelLongPress}
            onClick={(e) => {
              // The browser synthesises a click when the finger lifts. It
              // would reach the menu's own document-level dismissal and close
              // the menu the press just opened, so it stops here -- and it is
              // cancelled outright, because a press that started on a link
              // would otherwise navigate away to it.
              if (longPressFired.current) {
                longPressFired.current = false;
                e.preventDefault();
                e.stopPropagation();
              }
            }}
          >
            {(() => {
              // 41-3: the menu's handle, in the row's left padding. It has to
              // live outside the grid columns -- the strip this replaces was
              // an overlay on the row's right edge, and it painted over the
              // text of every message longer than half a line.
              if (menuItemsFor(m).length === 0) return null;
              return (
                <button
                  type="button"
                  class="chalk-message-marker"
                  title="message actions (r)"
                  aria-label="message actions"
                  aria-haspopup="menu"
                  aria-expanded={menu?.id === m.id}
                  data-testid={`message-marker-${m.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (menu?.id === m.id) {
                      closeMenu();
                      return;
                    }
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    openMenu(m, r.left, r.bottom + 2);
                  }}
                >
                  <span aria-hidden="true">⋮</span>
                </button>
              );
            })()}
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
                  style={nickHue !== null ? nickTintStyle(nickHue) : undefined}
                >
                  {senderLabel}
                </span>
              );
            })()}
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
              {/* 37-3: only one version of a message is ever stored, so
                  this marks that the text changed after it was sent
                  without offering any history to look at. */}
              {!m.deleted && m.editedAt && (
                <span
                  class="chalk-message-edited"
                  title={`edited ${fmtTimeAs(m.editedAt, display_.timestampFormat, now)}`}
                  data-testid={`message-edited-${m.id}`}
                >
                  (edited)
                </span>
              )}
            </span>
            {gr && gr.mode !== "text" && (
              <div class="chalk-message-giphy" data-testid="message-giphy">
                <GiphyView render={gr} onRequestEnableGiphy={onRequestEnableGiphy} />
              </div>
            )}
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
          </div>
          {/* 37-5: reaction chips. Suppressed on tombstoned rows (the server
              scrubs reactions with the body), and rendered only when there is
              something to show -- an always-present empty bar would add a row
              of dead space to every message in the feed. Adding the FIRST
              reaction therefore happens from the row menu, not from here. */}
          {!m.deleted && onToggleReaction && (() => {
            const sets = reactions?.[m.id];
            if (!sets || sets.length === 0) return null;
            const tallies = aggregate(sets, ownUserID);
            if (tallies.length === 0) return null;
            return (
              <div class="chalk-message-reactions" data-testid={`message-reactions-${m.id}`}>
                {tallies.map((t) => (
                  <button
                    key={t.emoji}
                    type="button"
                    class={`chalk-reaction ${t.mine ? "chalk-reaction--mine" : ""}`}
                    onClick={() => onToggleReaction(m, t.emoji)}
                    title={t.userIDs
                      .map((u) =>
                        ownUserID && u === ownUserID
                          ? "you"
                          : handleByUser.get(u) ?? "someone",
                      )
                      .join(", ")}
                    aria-pressed={t.mine}
                    data-testid={`reaction-${m.id}-${t.emoji}`}
                  >
                    <span class="chalk-reaction-emoji" aria-hidden="true">{t.emoji}</span>
                    <span class="chalk-reaction-count">{t.count}</span>
                  </button>
                ))}
              </div>
            );
          })()}
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
      {/* One menu for the whole feed, resolved from the id at render time so
          it always acts on the message as it stands now. */}
      {menu && (() => {
        const m = messages.find((x) => x.id === menu.id);
        if (!m) return null; // the message went away while the menu was open
        return (
          <MessageMenu
            items={menuItemsFor(m)}
            x={menu.x}
            y={menu.y}
            onClose={closeMenu}
            onQuickReact={(emoji) => {
              closeMenu();
              onToggleReaction?.(m, emoji);
            }}
            onPick={(item) => {
              closeMenu();
              switch (item.kind) {
                case "react":
                  onPickReaction?.(m);
                  break;
                case "reply":
                  onOpenThread?.(m.id, m.threadID ?? m.id);
                  break;
                case "copy":
                  navigator.clipboard?.writeText(m.body).catch(() => {});
                  break;
                case "edit":
                  onEditMessage?.(m);
                  break;
                case "delete":
                  onDeleteMessage?.(m);
                  break;
              }
            }}
          />
        );
      })()}
    </div>
  );
}
