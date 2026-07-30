// Phase 10c: ThreadPanel renders the reply side-pane.
//
// Layout:
//   ┌──────────────────────┐
//   │ thread       [×]     │  <-- header
//   ├──────────────────────┤
//   │ <parent message>     │  <-- read from channel cache
//   ├──────────────────────┤
//   │ <replies, scrollable>│  <-- read from state.threadMessages
//   │ ...                  │
//   ├──────────────────────┤
//   │ <reply composer>     │  <-- Composer with parentID closure
//   └──────────────────────┘
//
// On desktop: this lives in the 3rd column of the .chalk-app grid.
// On mobile: media query covers main + channel composer entirely.

import type { Message, ReactionSet } from "../state/types";
import type { ResolvedChatPrefs } from "../state/types";
import type { PendingAttachment } from "../attachments/types";
import type { AttachmentController } from "../attachments/pipeline";
import type { GiphyPref } from "../giphy/giphy";
import type { LinkPreviewPref } from "../linkpreview/linkpreview";
import { MessageList } from "./MessageList";
import { Composer, type SendOptions } from "./Composer";

interface Props {
  // The thread head. Already in the channel cache; the panel\'s caller
  // looks it up. Pass undefined if not yet loaded (panel renders a
  // placeholder).
  parent: Message | undefined;
  // Replies, oldest first. Empty array while fetch_thread is in flight.
  replies: Message[];
  // True once the fetch_thread_ack arrived for this thread.
  loaded: boolean;
  // Identity bits for MessageList\'s "you" detection.
  ownDevice: string | null;
  ownUserID: string | null;
  // Phase 9.7k: viewer's own handle, forwarded to the reply MessageLists so
  // own replies show the username instead of "you".
  ownHandle?: string | null;
  // Channel members for sender → handle resolution.
  members: { userID: string; handle: string }[];
  isDM: boolean;
  // Chat display prefs (timestamps, compact, user colors).
  display: ResolvedChatPrefs;
  // Composer state.
  disabled: boolean;
  // 35-5: message deletion, forwarded verbatim to both lists so a reply
  // obeys exactly the rules its channel does -- a thread is not a place
  // where deletion means something else. See chat/deletepolicy.ts.
  canDeleteMessage?: (m: Message) => boolean;
  onDeleteMessage?: (m: Message) => void;
  deleteLabelFor?: (m: Message) => string;
  // 37-3: message editing, forwarded to both lists for the same reason as
  // delete. The panel's own composer gets the edit-mode props too, so
  // cursor-up in a thread edits your last REPLY rather than reaching back
  // into the channel feed.
  canEditMessage?: (m: Message) => boolean;
  onEditMessage?: (m: Message) => void;
  // 37-5: reactions, forwarded to both lists like delete and edit.
  reactions?: Record<string, ReactionSet[]>;
  onToggleReaction?: (m: Message, emoji: string) => void;
  onPickReaction?: (m: Message) => void;
  editing?: { id: string; body: string } | null;
  onEditSubmit?: (body: string) => void | Promise<boolean | void>;
  onEditCancel?: () => void;
  onEditLast?: () => void;
  // Forwarded to the reply composer: opening a thread puts the caret in it.
  // See Composer's focusKey.
  focusKey?: string | null;
  // 49-1: the thread's title, derived from the head message body. Computed
  // by App rather than from `parent` here because App may know the body
  // even when the parent row is not in the channel cache (the thread inbox
  // decrypts its own head previews). Null falls back to a generic label.
  title?: string | null;
  // 49-1: jump the channel feed to the head message. Absent hides the
  // button (tests, callers that predate it).
  onShowParent?: () => void;
  // Composer tools, forwarded verbatim so a thread reply offers the same
  // affordances as a channel message: attach, paste an image, GIF, emoji.
  // See Composer for what each does.
  enableAttachments?: boolean;
  giphyEnabled?: boolean;
  giphyReady?: boolean;
  onRequestEnableGiphy?: () => void;
  // 57-3: link-preview props, forwarded verbatim to the reply composer.
  linkPreviewEnabled?: boolean;
  linkPreviewPref?: LinkPreviewPref;
  linkPreviewDomains?: string[];
  onRequestEnableLinkPreview?: () => void;
  toolStyle?: "text" | "icons";
  // Receive side of the same parity: without the controller MessageList
  // renders an attachment-only reply as an empty row, and without giphyPref
  // a GIF reply renders as its raw marker body. Forwarded to both lists.
  attachmentController?: AttachmentController;
  giphyPref?: GiphyPref;
  // 57-4: the viewer's hide-preview-cards display pref, forwarded to both
  // lists so a thread renders cards exactly like the feed does.
  linkPreviewHide?: boolean;
  // Callbacks.
  onClose: () => void;
  // Already bound to parentID by the caller. The return value matters:
  // false means the send was blocked and the composer restores the draft
  // (or keeps the attachment tray) for a retry.
  onSend: (
    body: string,
    attachments?: PendingAttachment[],
    opts?: SendOptions,
  ) => void | Promise<boolean | void>;
}

export function ThreadPanel({
  parent,
  replies,
  loaded,
  ownDevice,
  ownUserID,
  ownHandle,
  members,
  isDM,
  display,
  disabled,
  canDeleteMessage,
  onDeleteMessage,
  deleteLabelFor,
  canEditMessage,
  onEditMessage,
  reactions,
  onToggleReaction,
  onPickReaction,
  editing,
  onEditSubmit,
  onEditCancel,
  onEditLast,
  focusKey,
  title,
  onShowParent,
  enableAttachments,
  giphyEnabled,
  giphyReady,
  onRequestEnableGiphy,
  linkPreviewEnabled,
  linkPreviewPref,
  linkPreviewDomains,
  onRequestEnableLinkPreview,
  toolStyle,
  attachmentController,
  giphyPref,
  linkPreviewHide,
  onClose,
  onSend,
}: Props) {
  return (
    <aside class="chalk-thread-panel" data-testid="thread-panel">
      <header class="chalk-thread-panel-header">
        <span
          class={`chalk-thread-panel-title${title ? " chalk-thread-panel-title--head" : ""}`}
          // The full head body on hover, since the visible title is clipped.
          title={title ?? undefined}
          data-testid="thread-panel-title"
        >
          {title ?? "thread"}
        </span>
        <div class="chalk-thread-panel-actions">
          {onShowParent && (
            <button
              type="button"
              class="chalk-thread-panel-showparent"
              onClick={onShowParent}
              title="jump to the message this thread was started on"
              data-testid="thread-panel-show-parent"
            >
              show message
            </button>
          )}
          <button
            type="button"
            class="chalk-thread-panel-close"
            onClick={onClose}
            title="close thread"
            data-testid="thread-panel-close"
          >
            ×
          </button>
        </div>
      </header>

      <div class="chalk-thread-panel-body" data-testid="thread-panel-body">
        {parent ? (
          // Render the head as a "frozen" message above the divider.
          // We use a tiny MessageList containing just the parent so
          // it renders identically to channel feed rows -- same
          // sender colors, same timestamps, same body. No reply
          // action since the head IS the reply target.
          <div class="chalk-thread-panel-parent">
            <MessageList
              messages={[parent]}
              ownDevice={ownDevice}
              ownUserID={ownUserID}
              ownHandle={ownHandle}
              members={members}
              isDM={isDM}
              display={display}
              canDeleteMessage={canDeleteMessage}
              onDeleteMessage={onDeleteMessage}
              deleteLabelFor={deleteLabelFor}
              canEditMessage={canEditMessage}
              onEditMessage={onEditMessage}
              editingMessageID={editing?.id ?? null}
              reactions={reactions}
              onToggleReaction={onToggleReaction}
              onPickReaction={onPickReaction}
              attachmentController={attachmentController}
              giphyPref={giphyPref}
              onRequestEnableGiphy={onRequestEnableGiphy}
              linkPreviewHide={linkPreviewHide}
              // No onOpenThread: drops "reply in thread" from the row
              // menu and hides any indicator (which wouldn\'t apply here --
              // the head\'s replyCount is the indicator we\'re
              // already showing in the main feed).
            />
          </div>
        ) : (
          <div class="chalk-thread-panel-loading">
            parent message not in cache
          </div>
        )}

        <div class="chalk-thread-panel-divider" />

        {!loaded ? (
          <div class="chalk-thread-panel-loading">loading replies…</div>
        ) : replies.length === 0 ? (
          <div class="chalk-thread-panel-empty">no replies yet.</div>
        ) : (
          <MessageList
            messages={replies}
            ownDevice={ownDevice}
            ownUserID={ownUserID}
            ownHandle={ownHandle}
            members={members}
            isDM={isDM}
            display={display}
            canDeleteMessage={canDeleteMessage}
            onDeleteMessage={onDeleteMessage}
            deleteLabelFor={deleteLabelFor}
            canEditMessage={canEditMessage}
            onEditMessage={onEditMessage}
            editingMessageID={editing?.id ?? null}
            reactions={reactions}
            onToggleReaction={onToggleReaction}
            onPickReaction={onPickReaction}
            attachmentController={attachmentController}
            giphyPref={giphyPref}
            onRequestEnableGiphy={onRequestEnableGiphy}
            linkPreviewHide={linkPreviewHide}
            // No onOpenThread inside the panel either; nesting
            // threads-in-threads is out of scope.
          />
        )}
      </div>

      <footer class="chalk-thread-panel-footer">
        <Composer
          disabled={disabled}
          disabledReason={disabled ? "offline" : null}
          onSend={onSend}
          placeholder="reply..."
          emoticons={display.emoticons}
          enableAttachments={enableAttachments}
          giphyEnabled={giphyEnabled}
          giphyReady={giphyReady}
          onRequestEnableGiphy={onRequestEnableGiphy}
          linkPreviewEnabled={linkPreviewEnabled}
          linkPreviewPref={linkPreviewPref}
          linkPreviewDomains={linkPreviewDomains}
          onRequestEnableLinkPreview={onRequestEnableLinkPreview}
          toolStyle={toolStyle}
          editing={editing}
          onEditSubmit={onEditSubmit}
          onEditCancel={onEditCancel}
          onEditLast={onEditLast}
          focusKey={focusKey}
          mentionHandles={members.map((m) => m.handle)}
        />
      </footer>
    </aside>
  );
}
