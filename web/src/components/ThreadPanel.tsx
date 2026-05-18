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

import type { Message } from "../state/types";
import type { ResolvedChatPrefs } from "../state/types";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";

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
  // Channel members for sender → handle resolution.
  members: { userID: string; handle: string }[];
  isDM: boolean;
  // Chat display prefs (timestamps, compact, user colors).
  display: ResolvedChatPrefs;
  // Composer state.
  disabled: boolean;
  // Callbacks.
  onClose: () => void;
  onSend: (body: string) => void; // already bound to parentID by caller
}

export function ThreadPanel({
  parent,
  replies,
  loaded,
  ownDevice,
  ownUserID,
  members,
  isDM,
  display,
  disabled,
  onClose,
  onSend,
}: Props) {
  return (
    <aside class="chalk-thread-panel" data-testid="thread-panel">
      <header class="chalk-thread-panel-header">
        <span class="chalk-thread-panel-title">thread</span>
        <button
          type="button"
          class="chalk-thread-panel-close"
          onClick={onClose}
          title="close thread"
          data-testid="thread-panel-close"
        >
          ×
        </button>
      </header>

      <div class="chalk-thread-panel-body" data-testid="thread-panel-body">
        {parent ? (
          // Render the head as a "frozen" message above the divider.
          // We use a tiny MessageList containing just the parent so
          // it renders identically to channel feed rows -- same
          // sender colors, same timestamps, same body. No hover-
          // reply button since the head IS the reply target.
          <div class="chalk-thread-panel-parent">
            <MessageList
              messages={[parent]}
              ownDevice={ownDevice}
              ownUserID={ownUserID}
              members={members}
              isDM={isDM}
              display={display}
              // No onOpenThread: hides the hover-reply button and
              // any indicator (which wouldn\'t apply here anyway --
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
            members={members}
            isDM={isDM}
            display={display}
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
        />
      </footer>
    </aside>
  );
}
