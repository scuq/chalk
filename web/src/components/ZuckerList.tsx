// Zuckermode's home screen (62-6): one list of every conversation, DMs and
// channels mixed, newest activity first, each row previewing the last
// message. Presentational only -- rows arrive pre-built from
// buildConversationList (chat/zucker.ts), navigation lives in App.
//
// The pinned rows above the list keep the two non-conversation surfaces the
// classic drawer carried (parking lot, thread inbox); the header buttons
// keep its two "+" entry points.

import type { ZuckerRow } from "../chat/zucker";
import type { PresenceMap } from "../state/types";
import { fmtRelative } from "../chat/reltime";
import { UnreadDot } from "./UnreadDot";
import { ChannelGlyph, presenceClass, presenceLabel } from "./Sidebar";

interface Props {
  rows: ZuckerRow[];
  presence: PresenceMap;
  // null hides the row (prefs.parkingLot.hidden), mirroring the sidebar.
  parkingName: string | null;
  threadsUnread: number;
  onSelect: (channelID: string) => void;
  onPark: () => void;
  onOpenThreads: () => void;
  onAddFriend: () => void;
  onCreateChannel: () => void;
}

export function ZuckerList({
  rows,
  presence,
  parkingName,
  threadsUnread,
  onSelect,
  onPark,
  onOpenThreads,
  onAddFriend,
  onCreateChannel,
}: Props) {
  // One clock per render, the MessageList precedent: a list of relative
  // times must agree with itself.
  const now = new Date();
  return (
    <div class="chalk-zucker" data-testid="zucker-list">
      <div class="chalk-zucker-head">
        <span class="chalk-zucker-title">conversations</span>
        <button
          type="button"
          class="chalk-zucker-add"
          onClick={onAddFriend}
          title="add a friend"
          aria-label="add a friend"
          data-testid="zucker-add-friend"
        >
          @+
        </button>
        <button
          type="button"
          class="chalk-zucker-add"
          onClick={onCreateChannel}
          title="new channel"
          aria-label="new channel"
          data-testid="zucker-new-channel"
        >
          +
        </button>
      </div>

      {parkingName !== null && (
        <button
          type="button"
          class="chalk-zucker-pinned"
          onClick={onPark}
          data-testid="zucker-parking"
        >
          {parkingName}
        </button>
      )}
      <button
        type="button"
        class="chalk-zucker-pinned"
        onClick={onOpenThreads}
        data-testid="zucker-threads"
      >
        <span>↳ threads</span>
        {threadsUnread > 0 && <UnreadDot mention={false} />}
      </button>

      <ul class="chalk-zucker-rows" data-testid="zucker-rows">
        {rows.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              class="chalk-zucker-row"
              onClick={() => onSelect(r.id)}
              data-testid="zucker-row"
              data-channel-id={r.id}
            >
              <span class="chalk-zucker-row-badge">
                {r.isDM ? (
                  <span
                    class={`chalk-presence-dot ${presenceClass(
                      r.otherUserID !== null ? presence[r.otherUserID] : undefined,
                    )}`}
                    title={presenceLabel(
                      r.otherUserID !== null ? presence[r.otherUserID] : undefined,
                    )}
                  />
                ) : (
                  <ChannelGlyph type={r.isVoice ? "voice" : "text"} />
                )}
              </span>
              <span class="chalk-zucker-row-main">
                <span class="chalk-zucker-row-top">
                  <span class="chalk-zucker-row-name">{r.name}</span>
                  <span class="chalk-zucker-row-when">
                    {fmtRelative(new Date(r.when), now)}
                  </span>
                </span>
                <span class="chalk-zucker-row-preview">
                  {r.preview !== null ? (
                    <>
                      {r.previewSender !== null && (
                        <span class="chalk-zucker-row-sender">{r.previewSender}: </span>
                      )}
                      {r.preview}
                    </>
                  ) : (
                    <span class="chalk-zucker-row-empty">
                      {r.isVoice ? "voice room" : "no messages yet"}
                    </span>
                  )}
                </span>
              </span>
              {r.unread && <UnreadDot mention={r.mention} />}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
