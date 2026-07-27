// chalk top-level component (phase 08b).
//
// Channel-aware version. Lays out as a 2-column grid: sidebar (channel
// list + create button) on the left, message pane on the right.
//
// Side effects (sending WS frames in response to state changes) live
// here as useEffect hooks. The reducer is pure.
//
// Phase 08b flow:
//   - On WS open + welcome, fire list_channels to load the sidebar.
//   - On set_active_channel, if history not yet loaded, fire fetch_history.
//   - On incoming channel_event{added}, dispatch channel_added AND
//     send subscribe_channel to start receiving messages in the new channel.
//   - On open_create_modal, if friends not yet loaded, fire friend_list.

import { resolveNickHue } from "../chat/nickcolor";
import type { ThreadLine } from "../chat/threadinbox";
import { TYPING_PING_MS } from "../chat/typing";
import { typingStore } from "../chat/typing-store";
import { mentionsHandle } from "../chat/mentions";
import { threadTitle, attachmentTitle } from "../chat/threadtitle";
import { notifySounds, type NotifySounds } from "../notify";
import { categoryForMessage } from "../notify/classify";
import { publishNotifyEvent, subscribeNotifyEvents } from "../notify/bus";
import { notifyBanners } from "../notify/banners";
import { titleController } from "../notify/title";
import { actionsFor, resolvePriority, type RulesConfig } from "../notify/rules";
import { loadRulesConfig, subscribeRulesConfig } from "../notify/rules-store";
import { RulesSync } from "../notify/rules-sync";
import { loadSoundPrefs, subscribeSoundPrefs } from "../notify/prefs";
import {
  channelEventNotifies,
  friendEventNotifies,
  governanceEventNotifies,
  voiceCallStarted,
} from "../notify/events";
import { deleteActionFor, deleteLabelFor } from "../chat/deletepolicy";
import { canEditMessage, lastEditableMessage } from "../chat/editpolicy";
import { ownSet, toggle } from "../chat/reactions";
import { useIsMobile } from "../mobile";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "preact/hooks";
import {
  TypeMessage,
  TypeSendAck,
  TypeMessageDeleted,
  TypeMessageEdited,
  TypeSetReactions,
  TypeReactionUpdate,
  TypeFetchReactions,
  TypeFetchReactionsAck,
  // Phase 11b-2: MLS welcome + commit_bundle
  // Phase 11c-2 PR 3: MLS commit broadcast + catchup
  TypeSend,
  TypeFetchThread,
  TypeFetchThreadAck,
  TypeError,
  TypeListChannels,
  TypeListChannelsAck,
  TypeFetchHistory,
  TypeFetchHistoryAck,
  TypeCreateChannel,
  TypeCreateChannelAck,
  TypeChannelEvent,
  TypeSubscribeChannel,
  TypeFriendList,
  TypeFriendListAck,
  // Phase 9.6a: outgoing friend ops + incoming push.
  TypeFriendRequest,
  TypeFriendAccept,
  TypeFriendDecline,
  TypeFriendRemove,
  TypeFriendEvent,
  // Phase 9.6c: presence wire types.
  TypePresence,
  TypePresenceSubscribe,
  TypePresenceSubscribeAck,
  TypePresenceUnsubscribe,
  // Phase 9.6j:
  TypePresenceUpdate,
  // Phase 9.7a:
  TypePrefsGet,
  TypePrefsGetAck,
  TypePrefsSet, // Phase 9.7b
  TypePrefsSetAck,
  TypePrefsChanged,
  // 33-1: read cursors.
  TypeMarkRead,
  TypeMarkReadAck,
  TypeReadState,
  type MarkReadPayload,
  type ReadStatePayload,
  // 42-4: thread read cursors.
  TypeMarkThreadRead,
  TypeMarkThreadReadAck,
  TypeThreadReadState,
  type MarkThreadReadPayload,
  type ThreadReadStatePayload,
  // 43-1: typing indicators.
  TypeTyping,
  TypeTypingUpdate,
  type TypingPayload,
  type TypingUpdatePayload,
  // 42-6: the thread inbox.
  TypeThreadInbox,
  TypeThreadInboxAck,
  type ThreadInboxPayload,
  type ThreadInboxAckPayload,
  type ThreadInboxEntry,
  type Frame,
  type WelcomePayload,
  type ErrorPayload,
  // Phase 9.7a:
  type PrefsAckPayload,
  type MessagePayload,
  type SendAckPayload,
  type MessageDeletedPayload,
  type MessageEditedPayload,
  type ReactionUpdatePayload,
  type FetchReactionsAckPayload,
  // gov-2:
  TypeGovernanceEvent,
  GovEventModeChanged,
  GovEventProposalOpened,
  GovEventProposalUpdated,
  GovEventProposalResolved,
  type GovernanceEventPayload,
  type ProposalViewWire,
  TypeGovSetMode,
  TypeGovPropose,
  TypeGovVote,
  TypeGovCancel,
  TypeGovList,
  type GovListPayload,
  type GovListAckPayload,
  type SendPayload,
  type ChannelSummaryWire,
  type ListChannelsPayload,
  type ListChannelsAckPayload,
  type FetchHistoryPayload,
  type FetchHistoryAckPayload,
  type FetchThreadAckPayload,
  type CreateChannelPayload,
  type CreateChannelAckPayload,
  type ChannelEventPayload,
  type SubscribeChannelPayload,
  type FriendListPayload,
  type FriendEventPayload,
  type FriendListAckPayload,
  // Phase 9.6c:
  type PresencePayload,
  type PresenceSubscribePayload,
  type PresenceUnsubscribePayload,
  // Phase 30 (30-4): voice pushes routed to the reducer + voiceBus.
  TypeVoiceSignal,
  TypeVoiceParticipantJoined,
  TypeVoiceParticipantLeft,
  TypeVoiceParticipantState,
  TypeVoicePurged, // 45-1: scratchpad destroyed
  TypeVoiceRoster, // 30-5: sidebar occupancy seed
  type VoiceRosterAckPayload,
  type VoiceParticipantJoinedPayload,
  type VoiceParticipantLeftPayload,
  type VoiceParticipantStatePayload,
  type VoicePurgedPayload,
  TypeServerNotice, // 46-1: the server is going down
  NoticeRestarting,
  type ServerNoticePayload,
} from "../proto";
import { WSClient, getOrCreateDeviceId, clearDeviceId } from "../ws-client";
import { reducer } from "../state/reducer";
import { hasUnread, initialState, selectChatPrefs, type AppState, type Message, type ChannelSummary, type ProposalView, type ReactionSet, type ThreadInboxRow } from "../state/types";
import { selectGiphyPref } from "../giphy/giphy";
import { Logo } from "./Logo";
import { VersionLink } from "./VersionLink";
import { StatusBar } from "./StatusBar";
import { Sidebar, ChannelGlyph } from "./Sidebar";
import { MessageList } from "./MessageList";
import { ConfirmModal } from "./ConfirmModal";
import { Composer } from "./Composer";
import { TypingLine } from "./TypingLine";
// Phase 11c-2 PR 4: member-management modal.
import { ThreadPanel } from "./ThreadPanel";
// Phase 9.6d: heavy panels are lazy-loaded so the initial bundle
// can stay small. Each becomes a separate chunk file that fetches
// the first time the user opens that panel. Subsequent opens use
// the cached chunk; no second fetch. See ./LazyComponent.tsx for
// the loader implementation.
import { lazyComponent } from "./LazyComponent";
const InvitesPanel = lazyComponent(() =>
  import("./InvitesPanel").then((m) => m.InvitesPanel)
);
const ProfilePanel = lazyComponent(() =>
  import("./ProfilePanel").then((m) => m.ProfilePanel)
);
const AdminPanel = lazyComponent(() =>
  import("./AdminPanel").then((m) => m.AdminPanel)
);
const FriendsPanel = lazyComponent(() =>
  import("./FriendsPanel").then((m) => m.FriendsPanel)
);
const MembersPanel = lazyComponent(() =>
  import("./MembersPanel").then((m) => m.MembersPanel)
);
const GovernancePanel = lazyComponent(() =>
  import("./GovernancePanel").then((m) => m.GovernancePanel)
);
// 50-4: notification rules + priorities.
const NotificationsPanel = lazyComponent(() =>
  import("./NotificationsPanel").then((m) => m.NotificationsPanel)
);
// 42-8: the thread inbox. Lazy for the same reason the other panels are -- most
// sessions never open it, and the dot that advertises it costs nothing.
const ThreadInboxPanel = lazyComponent(() =>
  import("./ThreadInboxPanel").then((m) => m.ThreadInboxPanel)
);
// 37-5: the reaction picker. Lazy for the same reason the composer's is --
// the emoji catalogue is static data most sessions never open.
const EmojiPicker = lazyComponent(() =>
  import("./EmojiPicker").then((m) => m.EmojiPicker)
);
import { CreateChannelModal } from "./CreateChannelModal";
// Phase 30 (30-4): the minimal in-call surface + the frame bus that hands
// voice pushes from handleFrame to the mounted panel's VoiceCall.
import { VoiceCallPanel } from "./VoiceCallPanel";
import { VoiceDock } from "./VoiceDock";
import { VoiceControls } from "./VoiceControls"; // 44-2
import { MicSettingsDialog } from "./MicSettingsDialog"; // 44-3
import { SidebarResizer } from "./SidebarResizer";
import { voiceBus } from "../voice/bus";
import { voiceSession } from "../voice/session";
import { applyRemoteMicPrefs, setMicPrefsPublisher } from "../voice/mic-prefs"; // 44-4
import { installVoiceHotkeys } from "../voice/hotkeys";
import { installIdleWatch, type IdleWatch } from "../presence/idle";
import { useIdlePrefs } from "../presence/idle-prefs";
import {
  startSystemIdle,
  systemIdlePermission,
  type SystemIdlePermission,
} from "../presence/system-idle";
import { AuthGate } from "../auth/AuthGate";
import { IdentitySetupScreen } from "../auth/IdentitySetupScreen";
import { UnsupportedBrowserScreen } from "../auth/UnsupportedBrowserScreen";
import { cryptoSupported } from "../crypto/support";
import { MigrationScreen } from "../auth/MigrationScreen"; // 31-9
import { loadIdentity, loadVerification, saveVerification } from "../crypto/idb";
import { fetchIdentity, type IdentityTransport } from "../crypto/identity-sync";
import {
  computeSafetyNumber,
  verificationState,
  digestToHex,
} from "../crypto/safety-number";
import type { MemberVerifyInfo } from "./MembersPanel";
import { commitRotation, removeMember, addMember, deleteMessage, editMessage } from "../crypto/spacekey-sync";
import {
  ChannelCrypto,
  type ChannelKeyStatus,
} from "../crypto/channel-crypto";
// att-2: attachment pipeline (send-side upload + receive-side controller),
// the transport list query for history backfill, and the ciphertext cache
// teardown (logout / settings "clear cached images").
import {
  uploadAttachment,
  wireRefToRef,
  makeAttachmentController,
  type AttachmentController,
} from "../attachments/pipeline";
import { listAttachments } from "../attachments/transport";
import { clearCache as clearAttachmentCache } from "../attachments/cache";
import type { AttachmentRef, PendingAttachment } from "../attachments/types";
import { EncryptionIndicator } from "./EncryptionIndicator";
import { ModeBadge } from "./ModeBadge";
import {
  logout as logoutAPI,
  fetchMe,
  fetchAuthConfig,
  listMyInvites,
  createInvite as createInviteAPI,
  revokeInvite as revokeInviteAPI,
  startEmailChange as startEmailChangeAPI,
  ApiError,
} from "../auth/api";
import { lookupUser } from "../auth/users";

function classifyDevice(): "phone" | "tablet" | "desktop" {
  const ua = navigator.userAgent;
  if (/iPad|Tablet|PlayBook|Silk|Android(?!.*Mobile)/i.test(ua)) return "tablet";
  if (/Mobi|iPhone|iPod|Android.*Mobile|BlackBerry|IEMobile|Opera Mini/i.test(ua)) return "phone";
  return "desktop";
}

// Convert wire types (with snake_case + epoch-millis numbers) to
// domain types (camelCase + Date). Centralized so component code
// works with a friendly shape.
function wireToChannel(w: ChannelSummaryWire): ChannelSummary {
  return {
    id: w.id,
    name: w.name,
    isDM: w.is_dm,
    // Phase 11b-2: surface MLS flag. SPA branches on this for
    // encrypted-send / decrypted-receive routing.
    createdBy: w.created_by,
    createdAt: new Date(w.created_at),
    memberIDs: w.member_ids ?? [],
    // phase 08c: members carries handles too; SPA prefers it
    members: (w.members ?? []).map((m) => ({
      userID: m.user_id,
      handle: m.handle ?? "",
    })),
    currentKeyVersion: w.current_key_version ?? 1,
    rotationPending: w.rotation_pending ?? false,
    governanceMode: w.governance_mode ?? "dictator",
    channelType: w.channel_type ?? "text", // 30-4
    lastSeq: w.last_seq ?? 0, // 33-1
    lastReadSeq: w.last_read_seq ?? 0, // 33-1
  };
}

// gov-2: map a wire proposal view into the client shape (RFC3339 -> Date).
function wireToProposal(w: ProposalViewWire): ProposalView {
  return {
    id: w.id,
    channelID: w.channel_id,
    type: w.type,
    targetID: w.target_id ?? "",
    payload: w.payload,
    createdBy: w.created_by,
    createdAt: new Date(w.created_at),
    expiresAt: new Date(w.expires_at),
    status: w.status,
    eligible: w.eligible,
    yes: w.yes,
    no: w.no,
    voted: w.voted,
    yourVote: w.your_vote ?? "",
  };
}

function wireToMessage(w: MessagePayload): Message {
  return {
    id: w.id,
    channelID: w.channel_id,
    seq: w.seq,
    sender: w.sender,
    // Phase 9.6i: server populates sender_user_id when possible.
    senderUserID: w.sender_user_id ?? "",
    // Phase 23d: carry the message-suite version so the receive path knows
    // whether to decrypt. Undefined for legacy plaintext rows.
    keyVersion: w.key_version,
    ts: new Date(w.ts),
    body: w.body,
    // Phase 10a: threading metadata. Undefined when omitted by older
    // servers or for non-thread messages.
    parentID: w.parent_id || undefined,
    threadID: w.thread_id || undefined,
    replyCount: w.reply_count ?? 0,
    // Phase 10d:
    lastReplySeq: w.last_reply_seq ?? 0,
    // Phase 10e: preview snippet from server (history fetches only;
    // live pushes don't carry these because each push IS a single
    // reply, not a thread-head summary -- the reducer's live-bump
    // branch fills the parent's preview from the reply's own body).
    lastReplySenderUserID: w.last_reply_sender_user_id || undefined,
    lastReplyBody: w.last_reply_body || undefined,
    lastReplyKeyVersion: w.last_reply_key_version ?? undefined,
    // Phase 26 (governance prereq): tombstone fields from history fetches.
    deleted: w.deleted || undefined,
    deletedBy: w.deleted_by || undefined,
    deletedAt: w.deleted_at ? new Date(w.deleted_at) : undefined,
    // att-2: attachments carried on the live push (server populates them there;
    // history fetches backfill via the window list query). Undefined when none.
    attachments:
      w.attachments && w.attachments.length > 0
        ? w.attachments.map(wireRefToRef)
        : undefined,
    // Idempotency key echoed back on the live push of a freshly-sent message.
    // The reducer uses it to replace the optimistic row instead of duplicating.
    clientMsgID: w.client_msg_id || undefined,
    // 42-3: our own thread cursor, riding along with the head row it decorates.
    // History fetches only; undefined on a live push.
    threadLastReadSeq: w.thread_last_read_seq,
    threadInvolved: w.thread_involved,
  };
}

// 42-7: wire -> domain for one inbox row. Bodies stay as they arrive
// (ciphertext) and are replaced by the decrypt pass; undefined means "not
// decrypted yet", so an absent body must NOT become an empty string here.
function wireToThreadInboxRow(w: ThreadInboxEntry): ThreadInboxRow {
  return {
    channelID: w.channel_id,
    threadID: w.thread_id,
    headSeq: w.head_seq,
    headTS: new Date(w.head_ts),
    headSenderUserID: w.head_sender_user_id || undefined,
    headKeyVersion: w.head_key_version,
    headDeleted: w.head_deleted || undefined,
    lastReplySeq: w.last_reply_seq,
    lastReplyTS: new Date(w.last_reply_ts),
    lastReplySenderUserID: w.last_reply_sender_user_id || undefined,
    lastReplyKeyVersion: w.last_reply_key_version,
    lastReplyDeleted: w.last_reply_deleted || undefined,
    replyCount: w.reply_count,
    lastReadSeq: w.last_read_seq,
    involved: w.involved,
  };
}

export function App() {
  const [state, dispatch] = useReducer<AppState, Parameters<typeof reducer>[1]>(
    reducer,
    initialState
  );
  const clientRef = useRef<WSClient | null>(null);
  // Phase 23d: per-channel encryption orchestration. Built once the identity
  // is ready; reads clientRef.current dynamically so it survives reconnects.
  const ccRef = useRef<ChannelCrypto | null>(null);
  const [ccReady, setCcReady] = useState(false);
  // att-2: receive-side attachment pipeline (decrypt/fetch/cache), bound to the
  // ChannelCrypto instance when it's built. Passed to MessageList for rendering.
  const attControllerRef = useRef<AttachmentController | null>(null);
  // Per-channel key status ("ready" | "waiting" | "plaintext") gating the composer.
  const [keyStatus, setKeyStatus] = useState<Record<string, ChannelKeyStatus>>({});
  // Phase 23e: members-panel key-status (who has a wrapped key). Fetched via
  // ChannelCrypto when the panel opens; not reducer-owned.
  const [memberRecipients, setMemberRecipients] = useState<Set<string>>(new Set());
  const [membersLoading, setMembersLoading] = useState(false);
  // Phase 24b: per-member verification info for the members panel. App stores
  // digestHex + generation (needed to persist a verification) alongside the
  // panel-facing { state, words, numeric }.
  const [memberVerify, setMemberVerify] = useState<
    Record<string, MemberVerifyInfo & { digestHex?: string; generation?: number }>
  >({});
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [resharing, setResharing] = useState(false);
  const [rotating, setRotating] = useState(false);

  // Mobile: below the phone breakpoint the roster stops being a column and
  // becomes a drawer over the message list. Desktop never reads navOpen, but
  // reset it when we widen so a drawer left open on a phone-sized window
  // doesn't come back as a stuck overlay after a resize.
  const isMobile = useIsMobile();
  const [navOpen, setNavOpen] = useState(false);

  // 33-4: sidebar width. The committed value lives in prefs (so it follows
  // the user to their other devices); sidebarDrag holds the in-flight width
  // during a drag so the column tracks the pointer without a prefs write per
  // frame. Null means "not dragging -- show the pref".
  const [sidebarDrag, setSidebarDrag] = useState<number | null>(null);
  const prefSidebarWidth = selectChatPrefs(state.prefs).sidebarWidth;
  const sidebarWidth = sidebarDrag ?? prefSidebarWidth;
  const commitSidebarWidth = useCallback(
    (w: number) => {
      setSidebarDrag(null);
      if (w === prefSidebarWidth) return;
      const c = clientRef.current;
      if (!c || !c.isOpen()) return;
      // Same read-modify-write as the other chat prefs: the server merges at
      // the top level only, so the whole chat object goes with each patch.
      const current = state.prefs?.chat ?? {};
      c.send(TypePrefsSet, { patch: { chat: { ...current, sidebarWidth: w } } });
    },
    [prefSidebarWidth, state.prefs],
  );
  useEffect(() => {
    if (!isMobile) setNavOpen(false);
  }, [isMobile]);
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  // Phase 22c-3c: identity gate. After the WS welcomes us we know the
  // userID; check whether this device already has the user's encryption
  // identity stored. If not, IdentitySetupScreen runs (generate or enter
  // the decryption phrase) before the chat renders. "ready" = identity
  // present locally; "needs-setup" = render the screen; null = still
  // checking. The check re-runs if the userID changes (e.g. re-login as a
  // different user on this browser).
  // 48-4: "unsupported" = this browser lacks the WebCrypto curves the whole
  // E2E layer needs; render an honest dead-end instead of the setup screen.
  const [identityGate, setIdentityGate] =
    useState<"checking" | "ready" | "needs-setup" | "unsupported" | null>(null);
  // 31-9: local flag flipped when the migration wizard completes, so the
  // gate clears without a /me refetch (the server has committed the flip).
  const [authV2Done, setAuthV2Done] = useState(false);
  const identityCheckedForRef = useRef<string | null>(null);
  // att-4c: ensure /api/auth/config is loaded once we're authenticated, so
  // server feature flags (giphy_enabled) are available in the app. AuthGate
  // only fetches config on the login/register screens, so a session resumed
  // from a cookie would otherwise never have it and the GIF button would stay
  // hidden. Non-fatal on failure -- the button simply stays hidden.
  useEffect(() => {
    if (state.authStage !== "authed") return undefined;
    if (state.authConfig) return undefined;
    let cancelled = false;
    fetchAuthConfig()
      .then((config) => {
        if (!cancelled) dispatch({ kind: "auth_config_loaded", config });
      })
      .catch((err) => {
        console.error("post-login auth config fetch failed:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [state.authStage, state.authConfig]);

  useEffect(() => {
    const uid = state.user?.id;
    if (state.wsState !== "open" || !uid) return;
    if (identityCheckedForRef.current === uid) return;
    identityCheckedForRef.current = uid;
    setIdentityGate("checking");
    let cancelled = false;
    (async () => {
      // 48-4: probe the WebCrypto curves before anything identity-shaped.
      // Without this, an unsupported browser landed on the setup screen,
      // where a correct 24-word phrase then failed with a generic error --
      // indistinguishable, to the user, from having mistyped their phrase.
      if (!(await cryptoSupported())) {
        if (!cancelled) setIdentityGate("unsupported");
        return;
      }
      try {
        const existing = await loadIdentity(uid);
        if (cancelled) return;
        setIdentityGate(existing ? "ready" : "needs-setup");
      } catch (err) {
        console.error("identity gate: loadIdentity failed:", err);
        if (!cancelled) setIdentityGate("needs-setup");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.wsState, state.user?.id]);

  // Phase 23d: construct the ChannelCrypto instance once the identity is
  // ready. Separate from the gate check so it also runs after first-time
  // setup (IdentitySetupScreen.onReady flips identityGate to "ready").
  useEffect(() => {
    if (identityGate !== "ready") return;
    const uid = state.user?.id;
    if (!uid || ccRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        const id = await loadIdentity(uid);
        if (cancelled) return;
        if (!id) {
          // Fail-closed: without an identity in THIS browser we cannot build
          // the crypto, so nothing can be sent or read. Surface it loudly
          // rather than silently degrading -- complete identity setup here.
          console.error(
            "channel-crypto: no identity for",
            uid,
            "in this browser -- encryption unavailable; complete identity setup.",
          );
          return;
        }
        ccRef.current = new ChannelCrypto(
          { request: (t, p) => clientRef.current!.request(t, p) },
          { userID: uid, x25519Private: id.x25519Private, x25519Public: id.x25519Public },
        );
        // att-2: bind the receive-side attachment pipeline to this crypto.
        attControllerRef.current = makeAttachmentController(ccRef.current);
        setCcReady(true);
      } catch (err) {
        console.error("channel-crypto: build failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [identityGate, state.user?.id]);

  // 50-6: cross-device sync of the notification rules, encrypted under a
  // key derived from the identity (rules-sync.ts). Started once the
  // identity is usable; until then the local cache serves.
  const rulesSyncRef = useRef<RulesSync | null>(null);
  const [rulesSyncReady, setRulesSyncReady] = useState(false);
  useEffect(() => {
    if (!ccReady) return;
    const uid = state.user?.id;
    if (!uid || rulesSyncRef.current) return;
    let cancelled = false;
    void (async () => {
      try {
        const id = await loadIdentity(uid);
        if (!id || cancelled) return;
        const sync = new RulesSync();
        await sync.start(id.x25519Private, {
          send: (patch) => {
            const c = clientRef.current;
            if (c && c.isOpen()) c.send(TypePrefsSet, { patch });
          },
        });
        if (cancelled) {
          sync.stop();
          return;
        }
        rulesSyncRef.current = sync;
        setRulesSyncReady(true);
      } catch (err) {
        console.error("rules-sync: start failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ccReady, state.user?.id]);

  // Apply the server's blob whenever prefs land -- but only once they
  // HAVE landed: pushing local before the first prefs_get_ack could
  // clobber a newer blob written by another device.
  useEffect(() => {
    if (!rulesSyncReady || !state.prefsLoaded) return;
    void rulesSyncRef.current?.applyRemote(state.prefs.notify_rules_enc);
  }, [rulesSyncReady, state.prefsLoaded, state.prefs.notify_rules_enc]);

  // Phase 23d: ensure we hold a channel's key -- fetch+unwrap, or
  // creator-bootstrap a keyless channel, then auto-rewrap for members who lack
  // it. Records the status that gates the composer.
  //
  // 38-3: shared by the channel-open effect below and the key_available push,
  // which is what rescues a channel that settled as "waiting" because we asked
  // for the key before a holder had deposited our wrap.
  const ensureKeyFor = useCallback(async (cid: string) => {
    const cc = ccRef.current;
    const ch = channelsRef.current[cid];
    // No row yet (a key_available that overtook the channel_added render) is
    // safe to drop: the wrap is already stored, so the ensure that follows the
    // channel landing in state finds it.
    if (!cc || !ch) return;
    try {
      // Phase 25: tell ChannelCrypto the channel's current key version (from
      // the server) before ensuring the key, so new sends encrypt under it.
      cc.setCurrentKeyVersion(cid, ch.currentKeyVersion);
      const status = await cc.ensureChannelKey(cid, ch.memberIDs, ch.createdBy);
      setKeyStatus((s) => ({ ...s, [cid]: status }));
      // Phase 23g backstop: if the key is ready and we already have history for
      // this channel, some messages may have rendered as the "key not available"
      // placeholder before the key arrived. Re-fetch the history once so those
      // bodies re-decrypt in place (no reload). This is also what pulls messages
      // missed while offline into the active channel after a reconnect.
      if (status === "ready" && historyLoadedRef.current[cid]) {
        historyRequestedRef.current.delete(cid);
        const c = clientRef.current;
        if (c && c.isOpen()) {
          c.send<FetchHistoryPayload>(TypeFetchHistory, { channel_id: cid, limit: 50 });
        }
      }
    } catch (err) {
      console.error("ensureChannelKey failed:", err);
    }
  }, []);

  // When a channel becomes active (and on membership changes), ensure its key.
  useEffect(() => {
    const cid = state.activeChannelID;
    if (!cid || state.wsState !== "open" || !ccReady) return;
    if (!state.channels[cid]) return;
    void ensureKeyFor(cid);
  }, [state.activeChannelID, state.wsState, state.channels, ccReady, ensureKeyFor]);

  // att-2: backfill attachment refs for the active channel. History fetches
  // don't carry attachments (live pushes do), so once history is loaded we pull
  // the recent attachments via the window list query and merge them onto the
  // matching messages by id. Re-runs when history (re)loads. Bounded server-side
  // by CHALK_ATTACH_FETCH_WINDOW_HOURS.
  useEffect(() => {
    const cid = state.activeChannelID;
    if (!cid || !ccReady || !state.historyLoaded[cid]) return;
    let cancelled = false;
    (async () => {
      try {
        const wire = await listAttachments(cid);
        if (cancelled || wire.length === 0) return;
        const byMessageID: Record<string, AttachmentRef[]> = {};
        for (const w of wire) {
          if (!w.message_id) continue; // still 'uploading' / unlinked
          (byMessageID[w.message_id] ??= []).push(wireRefToRef(w));
        }
        if (Object.keys(byMessageID).length > 0) {
          dispatch({ kind: "attachments_merged", channelID: cid, byMessageID });
        }
      } catch (err) {
        console.error("attachment backfill failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.activeChannelID, state.historyLoaded, ccReady]);

  // 37-5: backfill reactions for the active channel, on the same trigger and
  // for the same reason as attachments -- history fetches don't carry them, so
  // without this a channel you just opened shows no reactions until someone
  // reacts again. Asks only for the message ids actually loaded, so the batch
  // is bounded by the history window rather than by channel size.
  useEffect(() => {
    const cid = state.activeChannelID;
    const c = clientRef.current;
    if (!cid || !ccReady || !state.historyLoaded[cid] || !c || !c.isOpen()) return;
    const ids = (state.messages[cid] ?? []).map((m) => m.id).filter((id) => !id.startsWith("local-"));
    if (ids.length === 0) return;
    c.send(TypeFetchReactions, { channel_id: cid, message_ids: ids });
    // Deliberately NOT keyed on state.messages: that changes on every new
    // message, and re-fetching the whole window per message would be absurd.
    // Live changes arrive as reaction_update pushes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeChannelID, state.historyLoaded, ccReady]);

  // Phase 23e: when the members panel opens, fetch which members currently
  // have a wrapped key (the per-member "has key" vs "waiting" status).
  const refreshMemberKeyStatus = useCallback(async () => {
    const cid = state.activeChannelID;
    if (!cid || !ccRef.current) return;
    setMembersLoading(true);
    try {
      const recips = await ccRef.current.keyRecipients(cid);
      setMemberRecipients(recips);
    } catch (err) {
      console.error("keyRecipients failed:", err);
    } finally {
      setMembersLoading(false);
    }
  }, [state.activeChannelID]);

  useEffect(() => {
    if (state.openPanel !== "members") return;
    void refreshMemberKeyStatus();
  }, [state.openPanel, refreshMemberKeyStatus]);

  // Phase 24b: when the members panel opens, compute each member's safety
  // number + verification state. Needs my own Ed25519 key (loadIdentity) and
  // each peer's verified Ed25519 key (fetchIdentity over the WS).
  const refreshVerification = useCallback(async () => {
    const cid = state.activeChannelID;
    const ch = cid ? state.channels[cid] : undefined;
    const myID = state.user?.id ?? null;
    if (!cid || !ch || !myID) return;
    setVerifyLoading(true);
    try {
      const me = await loadIdentity(myID);
      if (!me) {
        setVerifyLoading(false);
        return;
      }
      const transport: IdentityTransport = {
        request: (t, p) => clientRef.current!.request(t, p),
      };
      const out: Record<
        string,
        MemberVerifyInfo & { digestHex?: string; generation?: number }
      > = {};
      for (const m of ch.members ?? []) {
        if (m.userID === myID) continue;
        const peer = await fetchIdentity(transport, m.userID);
        if (!peer) {
          out[m.userID] = { state: "no_identity" };
          continue;
        }
        const sn = await computeSafetyNumber(me.ed25519Public, peer.ed25519Public);
        const stored = await loadVerification(m.userID);
        out[m.userID] = {
          state: verificationState(sn.digest, stored),
          words: sn.words,
          numeric: sn.numeric,
          digestHex: digestToHex(sn.digest),
          generation: peer.generation,
        };
      }
      setMemberVerify(out);
    } catch (err) {
      console.error("verification refresh failed:", err);
    } finally {
      setVerifyLoading(false);
    }
  }, [state.activeChannelID, state.channels, state.user]);

  useEffect(() => {
    if (state.openPanel !== "members") return;
    void refreshVerification();
  }, [state.openPanel, refreshVerification]);

  const onMarkVerified = useCallback(
    async (userID: string) => {
      const v = memberVerify[userID];
      if (!v || !v.digestHex || v.generation == null) return;
      try {
        await saveVerification({
          peerUserID: userID,
          digestHex: v.digestHex,
          generation: v.generation,
          verifiedAt: Date.now(),
        });
        setMemberVerify((prev) => ({
          ...prev,
          [userID]: { ...prev[userID], state: "verified" },
        }));
      } catch (err) {
        console.error("saveVerification failed:", err);
      }
    },
    [memberVerify],
  );

  const onReshareKey = useCallback(async () => {
    const cid = state.activeChannelID;
    const ch = cid ? state.channels[cid] : undefined;
    if (!cid || !ch || !ccRef.current) return;
    setResharing(true);
    try {
      await ccRef.current.reshareKey(cid, ch.memberIDs);
      await refreshMemberKeyStatus();
    } catch (err) {
      console.error("reshareKey failed:", err);
    } finally {
      setResharing(false);
    }
  }, [state.activeChannelID, state.channels, refreshMemberKeyStatus]);

  // Phase 25-2 / removal: rotate a channel's key. Mint+wrap the new version for
  // the given members (ChannelCrypto), then commit the version bump on the
  // server. Shared by the manual rotate button, the rotate_needed push, and the
  // rotation_pending catch-up. Only the owner (key holder) can actually rotate.
  const rotateChannelKeyFor = useCallback(
    async (cid: string, members: string[], currentVersion: number): Promise<boolean> => {
      if (!ccRef.current || !clientRef.current) return false;
      // In-flight guard: if a rotation for this channel is already running,
      // don't start a second one (it would race and be rejected as stale).
      if (rotatingChannelsRef.current.has(cid)) return false;
      rotatingChannelsRef.current.add(cid);
      try {
        const newVersion = currentVersion + 1;
        const ok = await ccRef.current.rotateChannelKey(cid, members, newVersion);
        if (!ok) return false; // we don't hold the key / not a forward step
        let confirmed: number;
        try {
          confirmed = await commitRotation(
            { request: (t, p) => clientRef.current!.request(t, p) },
            cid,
            newVersion,
          );
        } catch (err) {
          // Backstop: if another rotation (e.g. a second owner device) advanced
          // the version under us, the server rejects with stale_key_version.
          // That's not a failure -- the rotation we wanted already happened; the
          // key_rotated push will sync us to the new version. Swallow it.
          if (err instanceof Error && err.message.includes("stale_key_version")) {
            return true;
          }
          throw err;
        }
        dispatch({ kind: "channel_key_version_updated", channelID: cid, currentKeyVersion: confirmed });
        ccRef.current.setCurrentKeyVersion(cid, confirmed);
        return true;
      } finally {
        rotatingChannelsRef.current.delete(cid);
      }
    },
    [],
  );

  const onRotateKey = useCallback(async () => {
    const cid = state.activeChannelID;
    const ch = cid ? state.channels[cid] : undefined;
    if (!cid || !ch) return;
    setRotating(true);
    try {
      await rotateChannelKeyFor(cid, ch.memberIDs, ch.currentKeyVersion);
      await refreshMemberKeyStatus();
    } catch (err) {
      console.error("rotateChannelKey failed:", err);
    } finally {
      setRotating(false);
    }
  }, [state.activeChannelID, state.channels, rotateChannelKeyFor, refreshMemberKeyStatus]);

  // Member removal: remove a member (owner removes others; anyone removes self
  // = leave). The server flags rotation_pending + prompts the owner to rotate.
  const onRemoveMember = useCallback(
    async (targetID: string) => {
      const cid = state.activeChannelID;
      if (!cid || !clientRef.current) return;
      try {
        await removeMember(
          { request: (t, p) => clientRef.current!.request(t, p) },
          cid,
          targetID,
        );
        dispatch({ kind: "channel_member_removed", channelID: cid, userID: targetID });
        dispatch({ kind: "channel_rotation_pending_set", channelID: cid, pending: true });
        await refreshMemberKeyStatus();
      } catch (err) {
        console.error("removeMember failed:", err);
      }
    },
    [state.activeChannelID, refreshMemberKeyStatus],
  );

  // Add-member: invite a member (any member may add). The server adds them and
  // pushes member_added to everyone; a key holder reshares the current key so
  // the newcomer can read from now forward (handled in the event branch below).
  const onAddMember = useCallback(
    async (targetID: string, handle: string) => {
      const cid = state.activeChannelID;
      if (!cid || !clientRef.current) return;
      try {
        await addMember(
          { request: (t, p) => clientRef.current!.request(t, p) },
          cid,
          targetID,
        );
        dispatch({ kind: "channel_member_added", channelID: cid, userID: targetID, handle });
        if (ccRef.current) {
          const ch = state.channels[cid];
          const members = ch ? [...ch.memberIDs, targetID] : [targetID];
          await ccRef.current.reshareKey(cid, members);
        }
        await refreshMemberKeyStatus();
      } catch (err) {
        console.error("addMember failed:", err);
      }
    },
    [state.activeChannelID, state.channels, refreshMemberKeyStatus],
  );

  // gov-2: governance send-paths. Acks are awaited so the panel can surface
  // errors; the live state (mode, tallies, resolution) arrives via
  // governance_event pushes that the reducer folds in.
  const onGovListProposals = useCallback(async () => {
    const cid = state.activeChannelID;
    if (!cid || !clientRef.current) return;
    try {
      const ack = await clientRef.current.request<GovListPayload, GovListAckPayload>(
        TypeGovList,
        { channel_id: cid, include_resolved: false },
      );
      dispatch({
        kind: "proposals_loaded",
        channelID: cid,
        proposals: (ack.proposals ?? []).map(wireToProposal),
      });
    } catch (err) {
      console.error("gov list proposals failed:", err);
    }
  }, [state.activeChannelID]);

  const onGovSetMode = useCallback(
    async (mode: string) => {
      const cid = state.activeChannelID;
      if (!cid || !clientRef.current) return;
      await clientRef.current.request(TypeGovSetMode, { channel_id: cid, mode });
    },
    [state.activeChannelID],
  );

  const onGovProposeDictator = useCallback(async () => {
    const cid = state.activeChannelID;
    if (!cid || !clientRef.current) return;
    await clientRef.current.request(TypeGovPropose, {
      channel_id: cid,
      type: "set_mode",
      payload: { mode: "dictator" },
    });
  }, [state.activeChannelID]);

  const onGovPropose = useCallback(
    async (type: string, targetID: string) => {
      const cid = state.activeChannelID;
      if (!cid || !clientRef.current) return;
      await clientRef.current.request(TypeGovPropose, {
        channel_id: cid,
        type,
        target_id: targetID,
      });
    },
    [state.activeChannelID],
  );

  const onGovVote = useCallback(async (proposalID: string, vote: "yes" | "no") => {
    if (!clientRef.current) return;
    await clientRef.current.request(TypeGovVote, { proposal_id: proposalID, vote });
  }, []);

  const onGovCancel = useCallback(async (proposalID: string) => {
    if (!clientRef.current) return;
    await clientRef.current.request(TypeGovCancel, { proposal_id: proposalID });
  }, []);

  // gov-2: refresh the channel's proposals whenever the governance panel opens.
  useEffect(() => {
    if (state.openPanel !== "governance") return;
    void onGovListProposals();
  }, [state.openPanel, onGovListProposals]);

  // Phase 26 (governance prereq): message deletion. The row menu in
  // MessageList stages a message here; the ConfirmModal confirms, then we fire
  // delete_message. The server scrubs the body and pushes message_deleted to
  // every member (including us), and the reducer tombstones the row. We do NOT
  // optimistically tombstone: the round-trip is fast and waiting for the
  // authoritative push keeps all clients in lockstep.
  //
  // 35-3/35-4: what a delete MEANS depends on the channel, so the modal and
  // the confirm handler both branch on deleteMode:
  //   "own"        -- DM. You may delete your own message and nothing else
  //                   (mirrored server-side), so one confirm is enough.
  //   "unilateral" -- group in dictator mode. The owner erases someone else's
  //                   words for everyone, with no recourse: confirmed twice.
  //   "proposal"   -- group in democratic mode. Any member may ask, but the
  //                   channel decides -- the action opens a delete_message
  //                   proposal and the message stays until the vote passes.
  const [pendingDelete, setPendingDelete] = useState<Message | null>(null);
  // Which step of the two-step "unilateral" confirmation we're on. Reset
  // whenever a message is staged.
  const [deleteStep, setDeleteStep] = useState<1 | 2>(1);
  // att-4b: Giphy consent modal. Opened from the settings toggle when the
  // user moves to enable Giphy from unset/disabled; confirming sends the
  // prefs_set. (att-4c reuses this same modal from the composer button and
  // the first received Giphy message.)
  const [giphyConsentOpen, setGiphyConsentOpen] = useState(false);
  // 44-3: mic settings dialog. App-level because two places open it -- the ⚙
  // in the footer's voice cluster and the profile panel's signpost.
  const [micSettingsOpen, setMicSettingsOpen] = useState(false);
  const sendGiphyPref = useCallback((v: "enabled" | "disabled") => {
    const c = clientRef.current;
    if (!c || !c.isOpen()) return;
    // giphy is a flat top-level pref (like theme), so a single-key patch is
    // safe under the server's shallow JSONB merge.
    c.send(TypePrefsSet, { patch: { giphy: v } });
  }, []);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const deleteChannel = state.activeChannelID
    ? state.channels[state.activeChannelID]
    : undefined;
  const deleteActionOf = useCallback(
    (m: Message) => deleteActionFor(deleteChannel, m.senderUserID, state.user?.id),
    [deleteChannel, state.user?.id],
  );
  // What the staged message would cost to delete. Drives the modal copy and
  // whether the confirm takes one step or two.
  const deleteAction = pendingDelete ? deleteActionOf(pendingDelete) : "none";

  const onDeleteMessage = useCallback((m: Message) => {
    setPendingDelete(m);
    setDeleteStep(1);
  }, []);

  // ---- 37-3: message editing --------------------------------------------
  //
  // Two independent editors, because there are two composers: the channel feed
  // and the open thread panel. Keeping them separate means cursor-up in a
  // thread edits your last REPLY, and the channel composer isn't hijacked by
  // an edit you started in the panel.
  const [editingFeed, setEditingFeed] = useState<{ id: string; body: string } | null>(null);
  const [editingThread, setEditingThread] = useState<{ id: string; body: string } | null>(null);

  const canEditMessageOf = useCallback(
    (m: Message) => canEditMessage(m, state.user?.id ?? null, Date.now()),
    [state.user?.id],
  );

  // An editor is scoped to the thing it was opened from. Leaving that context
  // -- switching channel, or closing/changing the thread -- abandons the edit
  // rather than carrying a stale message id into a different conversation.
  useEffect(() => {
    setEditingFeed(null);
  }, [state.activeChannelID]);
  useEffect(() => {
    setEditingThread(null);
  }, [state.openThread?.threadID]);

  // The row menu offers "edit" only on the message cursor-up would open, so
  // the two entry points agree. The server allows any own message inside the
  // window; this is the narrower UI promise (see chat/editpolicy.ts).
  const lastEditableFeedID = useMemo(() => {
    const cid = state.activeChannelID;
    if (!cid) return null;
    const list = (state.messages[cid] ?? []).filter((m) => !m.parentID);
    return lastEditableMessage(list, state.user?.id ?? null, Date.now())?.id ?? null;
  }, [state.activeChannelID, state.messages, state.user?.id]);

  const openThreadID = state.openThread?.threadID ?? null;
  const lastEditableThreadID = useMemo(() => {
    if (!openThreadID) return null;
    const list = state.threadMessages[openThreadID] ?? [];
    return lastEditableMessage(list, state.user?.id ?? null, Date.now())?.id ?? null;
  }, [openThreadID, state.threadMessages, state.user?.id]);

  // Sending an edit is the same encrypt-then-frame path as a send, minus the
  // optimistic append: we wait for the authoritative message_edited push so
  // every device (including this one) converges on what the server stored.
  const submitEdit = useCallback(
    async (target: { id: string; body: string } | null, body: string): Promise<boolean> => {
      const cid = state.activeChannelID;
      const c = clientRef.current;
      if (!target || !cid || !c || !c.isOpen() || !ccRef.current) return false;
      const source =
        (state.messages[cid] ?? []).find((m) => m.id === target.id) ??
        Object.values(state.threadMessages)
          .flat()
          .find((m) => m.id === target.id);
      if (!source) return false;
      const enc = await ccRef.current.encryptForChannel(cid, body);
      if (enc.kind !== "encrypted") return false; // key vanished; leave the editor open
      try {
        await editMessage(
          { request: (t, p) => c.request(t, p) },
          cid,
          source.id,
          source.ts.getTime(),
          enc.body,
          enc.keyVersion,
        );
        return true;
      } catch (err) {
        console.error("editMessage failed:", err);
        return false;
      }
    },
    [state.activeChannelID, state.messages, state.threadMessages],
  );

  // ---- 37-5: reactions ---------------------------------------------------
  //
  // The whole set is re-sealed and re-sent on every toggle. That is the point:
  // set_reactions replaces the row, so a double-click or a second device
  // converges instead of drifting, and the server never needs to understand
  // add-vs-remove (it cannot -- it can't read the emoji).
  //
  // No optimistic update. The authoritative reaction_update push is what
  // renders, so every device shows the same tally, and a rejected toggle
  // (message deleted underneath you) simply never appears.
  const [reactionPickerFor, setReactionPickerFor] = useState<Message | null>(null);

  const toggleReaction = useCallback(
    async (m: Message, emoji: string) => {
      const cid = state.activeChannelID;
      const c = clientRef.current;
      const cc = ccRef.current;
      if (!cid || !c || !c.isOpen() || !cc || !state.user) return;
      const current = ownSet(state.reactions[m.id] ?? [], state.user.id);
      const next = toggle(current, emoji);
      try {
        if (next.length === 0) {
          // Empty body is the "clear mine" verb; nothing to seal, and the
          // server deletes the row rather than storing a sealed empty array.
          await c.request(TypeSetReactions, {
            channel_id: cid,
            message_id: m.id,
            ts: m.ts.getTime(),
            body: "",
          });
          return;
        }
        const sealed = await cc.sealJSONForChannel(cid, next);
        if (sealed.kind !== "encrypted") return; // no key: fail closed
        await c.request(TypeSetReactions, {
          channel_id: cid,
          message_id: m.id,
          ts: m.ts.getTime(),
          body: sealed.body,
          key_version: sealed.keyVersion,
        });
      } catch (err) {
        console.error("setReactions failed:", err);
      }
    },
    [state.activeChannelID, state.reactions, state.user],
  );

  const confirmDeleteMessage = useCallback(async () => {
    const m = pendingDelete;
    const cid = state.activeChannelID;
    if (!m || !cid || !clientRef.current) {
      setPendingDelete(null);
      return;
    }
    // Deleting another member's message unilaterally asks twice; the first
    // confirm only advances.
    if (deleteAction === "unilateral" && deleteStep === 1) {
      setDeleteStep(2);
      return;
    }
    setDeleteBusy(true);
    try {
      if (deleteAction === "proposal") {
        // The server refuses a unilateral delete_message in democratic mode;
        // the vote is the only path. payload.ts is required to locate the
        // (ts-partitioned) row when the proposal executes.
        await clientRef.current.request(TypeGovPropose, {
          channel_id: cid,
          type: "delete_message",
          target_id: m.id,
          payload: { ts: m.ts.getTime() },
        });
      } else {
        await deleteMessage(
          { request: (t, p) => clientRef.current!.request(t, p) },
          cid,
          m.id,
          m.ts.getTime(),
        );
      }
    } catch (err) {
      console.error("deleteMessage failed:", err);
    } finally {
      setDeleteBusy(false);
      setPendingDelete(null);
      setDeleteStep(1);
    }
  }, [pendingDelete, state.activeChannelID, deleteAction, deleteStep]);


  // case where we were offline when the removal happened and missed the
  // rotate_needed push -- the durable flag closes the window on next open.
  useEffect(() => {
    const cid = state.activeChannelID;
    const ch = cid ? state.channels[cid] : undefined;
    const myID = state.user?.id ?? null;
    if (!cid || !ch || !ccRef.current) return;
    if (!ch.rotationPending) return;
    if (ch.createdBy !== myID) return; // only the owner rotates
    if (keyStatus[cid] !== "ready") return; // need our key first
    let cancelled = false;
    (async () => {
      try {
        const ok = await rotateChannelKeyFor(cid, ch.memberIDs, ch.currentKeyVersion);
        if (!cancelled && ok) await refreshMemberKeyStatus();
      } catch (err) {
        console.error("rotation_pending catch-up failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    state.activeChannelID,
    state.channels,
    state.user,
    keyStatus,
    rotateChannelKeyFor,
    refreshMemberKeyStatus,
  ]);

  // Phase 11b-2 fix5: WS callbacks (onFrame, etc.) capture the
  // handleFrame closure ONCE at WSClient construction, before
  // state.user has been populated by the welcome event. Reading
  // state.user from those closures returns null forever. Refs let
  // us read the live value without re-creating the client.
  const userRef = useRef(state.user);
  userRef.current = state.user;
  const channelsRef = useRef(state.channels);
  channelsRef.current = state.channels;
  // 30-6: handleFrame gates roster seeding on the voice flag; same
  // stale-closure caveat as userRef above, so it reads through a ref.
  const voiceEnabledRef = useRef(state.voiceEnabled);
  voiceEnabledRef.current = state.voiceEnabled;
  // 33-3: mention detection runs inside handleFrame, so it reads its inputs
  // through refs for the same stale-closure reason as userRef above.
  const unreadRef = useRef(state.unread);
  unreadRef.current = state.unread;
  const activeChannelRef = useRef(state.activeChannelID);
  activeChannelRef.current = state.activeChannelID;
  // 43-6: whether this viewer takes part in typing indicators at all. Read
  // inside handleFrame, so it goes through a ref for the same stale-closure
  // reason as userRef above -- without it the store would keep filling, and
  // keep its sweep timer running, for someone who asked not to see any of it.
  const typingEnabled = selectChatPrefs(state.prefs).typingIndicators;
  const typingEnabledRef = useRef(typingEnabled);
  typingEnabledRef.current = typingEnabled;
  // 38-3: ensureKeyFor runs from both an effect and a push, so it reads which
  // channels have history through a ref rather than closing over the state.
  const historyLoadedRef = useRef(state.historyLoaded);
  historyLoadedRef.current = state.historyLoaded;
  // Assigned next to the visibilitychange effect, which declares tabVisible.
  const tabVisibleRef = useRef(true);
  // 45-3: the sound gate needs to know whether the viewer is actually there,
  // not merely whether the tab is on screen, and it is asked from inside
  // handleFrame -- so a ref, for the same reason as tabVisibleRef.
  const userIdleRef = useRef(false);
  // 40-2: deciding whether an arriving reply belongs to a thread the viewer
  // is part of needs both halves of the thread -- the parent lives in the
  // channel's messages, the replies in threadMessages -- and the decision
  // happens inside handleFrame, so both read through refs.
  const messagesRef = useRef(state.messages);
  messagesRef.current = state.messages;
  const threadMessagesRef = useRef(state.threadMessages);
  threadMessagesRef.current = state.threadMessages;
  // 40-4: the presence sound needs the state a friend is coming *from*,
  // read before the dispatch that overwrites it.
  const presenceRef = useRef(state.presence);
  presenceRef.current = state.presence;

  // 40-2: notification sounds. Shared with the profile panel's preview
  // buttons, so both halves agree about whether audio has been unlocked.
  const notifyRef = useRef<NotifySounds | null>(null);
  if (!notifyRef.current) notifyRef.current = notifySounds();
  // 50-2: the voice "call started" decision needs the roster as it stood
  // before the join being handled -- read inside handleFrame, so a ref.
  const voiceRostersRef = useRef(state.voiceRosters);
  voiceRostersRef.current = state.voiceRosters;
  // 50-2: the rules config, read inside handleFrame's bus consumer. Kept
  // current by subscribeRulesConfig below rather than by render.
  const rulesConfigRef = useRef<RulesConfig | null>(null);
  if (!rulesConfigRef.current) rulesConfigRef.current = loadRulesConfig();
  // 33-1: highest seq we've already sent a mark_read for, per channel.
  // Suppresses re-sends while the ack is in flight. Cleared on reconnect,
  // where the fresh listing re-establishes the real cursors anyway.
  const markReadSentRef = useRef<Map<string, number>>(new Map());
  // 42-4: the same, per thread. Cleared on reconnect for the same reason --
  // history rows carry the real cursors when they come back.
  const markThreadReadSentRef = useRef<Map<string, number>>(new Map());

  // 42-8: the inbox previews' CIPHERTEXT, keyed by thread id.
  //
  // Deliberately a ref and not state: state holds only decrypted previews (an
  // absent one means "not decrypted yet"), and putting ciphertext beside it
  // would give every row two sources of truth for the same field. The decrypt
  // pass reads from here and dispatches plaintext.
  const inboxCipherRef = useRef<
    Map<
      string,
      {
        channelID: string;
        headBody: string;
        headKeyVersion?: number;
        headDeleted: boolean;
        lastReplyBody: string;
        lastReplyKeyVersion?: number;
        lastReplyDeleted: boolean;
      }
    >
  >(new Map());
  // Channels we've already run the read-only key warm for this session. Bounds
  // the warm pass to once per channel however often the panel is reopened.
  const inboxWarmedRef = useRef<Set<string>>(new Set());
  // True while a "load more" request is in flight, so the ack appends instead of
  // replacing. A ref rather than state because handleFrame reads it.
  const inboxPagingRef = useRef(false);
  // The inbox rows as the frame handler last saw them. handleFrame is captured
  // once at WSClient construction, so it must not read state.threadInbox*.
  const threadInboxRef = useRef<ThreadInboxRow[]>([]);
  threadInboxRef.current = [...state.threadInboxActive, ...state.threadInboxAgedUnread];

  // Track which channel we've already fired fetch_history for. The
  // historyLoaded state flag covers ACK; this ref covers REQUEST so
  // we don't fire a duplicate during the round-trip.
  const historyRequestedRef = useRef<Set<string>>(new Set());

  // Track which channels we've subscribe_channeled. Avoids duplicate
  // sends on idempotent channel_event delivery.
  const subscribeSentRef = useRef<Set<string>>(new Set());
  // Removal-3: channels with a rotation currently in flight. Guards against the
  // two auto-rotate paths (rotate_needed push + rotation_pending catch-up)
  // firing concurrently for the same channel and racing into a doomed second
  // rotation (the server's monotonic guard rejects it with stale_key_version).
  const rotatingChannelsRef = useRef<Set<string>>(new Set());

  // 50-2/50-3: the notification bus consumer -- the one place events meet
  // the rules. Publishers (noteSound, the event frame cases) report what
  // happened; this resolves a priority, looks up the actions for it, and
  // drives the sinks: sound, OS banner, title blink.
  useEffect(() => {
    const unsubRules = subscribeRulesConfig((c) => {
      rulesConfigRef.current = c;
    });
    // The sound and banner sinks read dnd through their own gates; the
    // blink has no gate of its own, so it checks here.
    let dnd = loadSoundPrefs().dnd;
    const unsubPrefs = subscribeSoundPrefs((p) => {
      dnd = p.dnd;
    });
    const unsubBus = subscribeNotifyEvents((ev) => {
      const cfg = rulesConfigRef.current;
      if (!cfg) return;
      const actions = actionsFor(resolvePriority(ev, cfg.rules), cfg.profiles);
      const moment = {
        tabVisible: tabVisibleRef.current,
        userIdle: userIdleRef.current,
        isRelevantSurfaceOpen: !!ev.channelID && ev.channelID === activeChannelRef.current,
      };
      if (actions.sound) notifyRef.current?.play(ev.type, moment);
      if (actions.banner) notifyBanners().show(ev, moment);
      // blink() itself declines while the window is visible and focused.
      if (actions.blink && !dnd) titleController().blink();
    });
    return () => {
      unsubRules();
      unsubPrefs();
      unsubBus();
    };
  }, []);

  // 50-3: clicking a banner focuses the window and goes to what it was
  // about. Installed once; dispatch is stable for the app's lifetime.
  useEffect(() => {
    notifyBanners().setNavigateHandler((nav) => {
      if (nav.channelID && nav.threadID) {
        dispatch({ kind: "open_thread_from_inbox", channelID: nav.channelID, threadID: nav.threadID });
      } else if (nav.channelID) {
        dispatch({ kind: "set_active_channel", channelID: nav.channelID });
      }
    });
  }, []);

  // --- WS lifecycle ----------------------------------------------------

  // Phase 09b sub-step 5b: defer WS connect until authStage is
  // "authed". Before that the user is on LoginScreen, RegisterScreen,
  // or RecoveryScreen; opening the WS prematurely would either fail
  // (no cookie → server rejects) or, worse, succeed with the wrong
  // identity. After authStage flips to "authed", the cookie is set
  // (by register/finish or authenticate/finish or persisted from a
  // previous session), the WS upgrade carries it, and the server
  // resolves the right user.
  //
  // On logout the auth_logged_out action flips authStage back to
  // "login"; this effect's cleanup runs client.stop() and the WS
  // closes cleanly. Subsequent login fires the effect again with the
  // new session cookie.
  useEffect(() => {
    if (state.authStage !== "authed") return;
    const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${wsProto}//${window.location.host}/ws`;
    const client = new WSClient({
      url,
      deviceId: getOrCreateDeviceId(),
      deviceType: classifyDevice(),
      onState: (s, detail) => dispatch({ kind: "ws_state", state: s, detail }),
      onWelcome: (w: WelcomePayload) =>
        dispatch({
          kind: "welcome",
          userID: w.user_id,
          deviceID: w.device_id,
          // phase 08c: handle threads to status badge
          handle: w.handle ?? "",
          channels: w.channels,
          voiceEnabled: !!w.voice_enabled, // 30-6
          serverVersion: w.server_version, // 39-1
          serverCommit: w.server_commit,
        }),
      onFrame: (f: Frame) => handleFrame(f),
    });
    clientRef.current = client;
    client.start();
    return () => client.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.authStage]);



  // ---- Phase 30 (30-5c): app-level voice session lifecycle edges -------
  //
  // The persistent call (Discord behavior) is owned by voiceSession, not by
  // any component -- so the edges that used to ride on panel unmount are
  // explicit app-level events:
  //   * WS loss while connected  -> drop from the room (design §9, v1)
  //   * our room left the channel list (removed / deleted) -> teardown
  //   * logout -> full reset

  useEffect(() => {
    if (state.wsState !== "open") voiceSession.handleWsDown();
  }, [state.wsState]);

  useEffect(() => {
    voiceSession.leaveIfChannelGone(new Set(Object.keys(state.channels)));
  }, [state.channels]);

  useEffect(() => {
    if (state.authStage !== "authed") voiceSession.reset();
  }, [state.authStage]);

  // Click-to-join (Addendum C, core): selecting a voice room connects to it,
  // Discord-style. This used to be a synchronous check inside the sidebar's
  // onSelect, but that raced ensureChannelKey (the effect above) -- on a
  // channel's first-ever visit the key isn't ready yet at click time, so the
  // join was skipped and the lobby's manual "join voice" button showed
  // instead; only a later visit (key already cached in keyStatus) joined
  // automatically. Keying this off keyStatus instead of the click makes both
  // cases the same: it fires as soon as the active channel is a voice room
  // AND its key is ready, whether that's immediate (cached) or async (first
  // visit).
  //
  // It must fire at most ONCE per selection, which is what autoJoinedForRef
  // enforces. session.join is only idempotent while we are in/joining the
  // room -- once you hang up it happily reconnects, and this effect's deps
  // include state.channels, whose identity is rebuilt by channels_loaded on
  // every socket connect (also by membership, rotation and governance
  // updates). Without the guard, hanging up while still viewing the room
  // meant the next reconnect silently dragged you back into the call. It
  // also keeps a WS drop consistent with design §9: you rejoin with a click,
  // not automatically. Selecting a different channel re-arms it, so leaving
  // and later re-picking the room still auto-joins.
  const autoJoinedForRef = useRef<string | null>(null);
  useEffect(() => {
    const cid = state.activeChannelID;
    if (autoJoinedForRef.current !== cid) autoJoinedForRef.current = null;
    if (!cid || !state.voiceEnabled || !state.user || !ccReady) return;
    const ch = state.channels[cid];
    if (!ch || ch.channelType !== "voice") return;
    if (keyStatus[cid] !== "ready") return;
    if (autoJoinedForRef.current === cid) return;
    autoJoinedForRef.current = cid;
    void voiceSession.join({
      channelID: ch.id,
      channelName: ch.name,
      selfUserID: state.user.id,
      selfDeviceID: state.user.device,
      client: clientRef,
      cc: ccRef,
    });
  }, [state.activeChannelID, state.channels, state.voiceEnabled, state.user, ccReady, keyStatus]);

  // 30-5i: auto-rejoin after a page reload. A reload cannot preserve WebRTC
  // state, so the prior session left a hint (sessionStorage). Once we're
  // authed, the socket is open, crypto is ready and the room's key is ready,
  // consume the hint EXACTLY ONCE and re-run the normal join. The ref guards
  // against a second attempt (crash-loop safety); consumeRejoinHint also
  // clears the hint, so a failed rejoin won't retry. Browsers may suspend
  // audio playback until the first click -- the dock shows a nudge then.
  const autoRejoinTried = useRef(false);
  useEffect(() => {
    if (autoRejoinTried.current) return;
    if (
      state.authStage !== "authed" ||
      state.wsState !== "open" ||
      !ccReady ||
      !state.voiceEnabled ||
      !state.user
    ) {
      return;
    }
    const hint = voiceSession.snap().rejoinHint;
    if (!hint) {
      autoRejoinTried.current = true; // nothing to do; don't re-check forever
      return;
    }
    const ch = state.channels[hint.channelID];
    if (!ch || ch.channelType !== "voice") {
      voiceSession.dismissRejoin();
      autoRejoinTried.current = true;
      return;
    }
    if (keyStatus[hint.channelID] !== "ready") return; // wait for the key
    autoRejoinTried.current = true;
    const consumed = voiceSession.consumeRejoinHint();
    if (!consumed || !state.user) return;
    dispatch({ kind: "set_active_channel", channelID: ch.id });
    void voiceSession.join({
      channelID: ch.id,
      channelName: ch.name,
      selfUserID: state.user.id,
      selfDeviceID: state.user.device,
      client: clientRef,
      cc: ccRef,
    });
  }, [
    state.authStage,
    state.wsState,
    ccReady,
    state.voiceEnabled,
    state.user,
    state.channels,
    keyStatus,
  ]);

  // Phase 23f (fail-closed): run EVERY message through decryptForChannel
  // before it reaches the reducer. It returns plaintext only for properly
  // decrypted ciphertext; a null/0 key_version body is replaced by a blocked
  // placeholder, so cleartext can never be displayed. When the crypto isn't
  // built yet, bodies are replaced with a placeholder too (we can't read).
  async function decryptAll(msgs: Message[]): Promise<Message[]> {
    const cc = ccRef.current;
    return Promise.all(
      msgs.map(async (m) => {
        // Phase 26: deleted messages carry no decryptable body; render the
        // tombstone placeholder and skip decryption entirely.
        if (m.deleted) return { ...m, body: "[message deleted]" };
        if (!cc) return { ...m, body: "[encrypted message -- key not available yet]" };
        const body = await cc.decryptForChannel(m.channelID, m.keyVersion, m.body);
        // Decrypt the thread last-reply preview too (it's separate ciphertext
        // with its own key version), so the preview shows plaintext, not base64.
        let lastReplyBody = m.lastReplyBody;
        if (lastReplyBody) {
          lastReplyBody = await cc.decryptForChannel(
            m.channelID,
            m.lastReplyKeyVersion,
            lastReplyBody,
          );
        }
        return { ...m, body, lastReplyBody };
      }),
    );
  }

  // 33-3: flag a channel as having a mention of the viewer.
  //
  // Only decrypted plaintext can answer this, so it happens here rather than
  // anywhere on the server. Skipped for DMs (every message in a DM is
  // addressed to you, so a mention badge would say nothing the unread dot
  // doesn't), for your own messages, and for the channel you're actively
  // looking at.
  function noteMention(channelID: string, senderUserID: string, body: string) {
    const me = userRef.current;
    if (!me?.handle) return;
    if (senderUserID === me.id) return;
    const ch = channelsRef.current[channelID];
    if (!ch || ch.isDM) return;
    if (channelID === activeChannelRef.current && tabVisibleRef.current) return;
    if (!mentionsHandle(body, me.handle)) return;
    dispatch({ kind: "mention_set", channelID });
  }

  // 42-7: the thread-level half of the same idea. A mention inside a reply makes
  // that THREAD need you even if you never took part in it -- which is the one
  // thing the server's `involved` flag cannot know, because it would have to
  // read the body.
  //
  // Deliberately not gated on the active channel the way noteMention is: a
  // thread badge is per thread, not per channel, so being in the channel does
  // not mean you have seen the thread.
  function noteThreadMention(threadID: string, senderUserID: string, body: string) {
    const me = userRef.current;
    if (!me?.handle) return;
    if (senderUserID === me.id) return;
    if (!mentionsHandle(body, me.handle)) return;
    dispatch({ kind: "thread_mention_set", threadID });
  }

  // 40-2 / 50-2: report a message that just arrived to the notification
  // bus. classify.ts still decides what kind of event it is; whether and
  // how it notifies is the rules engine's call, downstream of the bus.
  //
  // Live pushes only. The other caller of noteMention scans decrypted
  // history after a reload or a reconnect, and hooking this in there too
  // would empty the room every time someone opens a laptop -- the whole
  // backlog would play at once. Everything else (your own messages, the
  // channel you're reading, do-not-disturb, rate limiting) is handled
  // downstream in the bus consumer and gate.ts.
  function noteSound(
    m: { channelID: string; senderUserID: string; parentID?: string; threadID?: string },
    body: string,
  ) {
    const me = userRef.current;
    if (!me) return;
    const ch = channelsRef.current[m.channelID];
    if (!ch) return;
    const category = categoryForMessage(
      { senderUserID: m.senderUserID, body, parentID: m.parentID },
      { id: me.id, handle: me.handle },
      { isDM: !!ch.isDM, threadInvolvesViewer: threadInvolvesMe(m, me.id) },
      mentionsHandle,
    );
    if (!category) return;
    publishNotifyEvent({
      type: category,
      senderUserID: m.senderUserID,
      channelID: m.channelID,
      threadID: m.parentID ? (m.threadID ?? m.parentID) : undefined,
      isDM: !!ch.isDM,
      senderHandle: ch.members.find((mem) => mem.userID === m.senderUserID)?.handle,
      channelName: ch.name || undefined,
      // Decrypted on this device; the banner sink renders it locally.
      preview: body || undefined,
    });
  }

  // Did the viewer write the parent of this reply, or any reply already in
  // its thread? Both halves are needed: the parent lives in the channel's
  // message list, the replies in threadMessages. A thread neither cached
  // nor loaded answers "no", which is the honest reading -- it means the
  // viewer hasn't opened it in this session.
  function threadInvolvesMe(
    m: { channelID: string; parentID?: string; threadID?: string },
    meID: string,
  ): boolean {
    if (!m.parentID) return false;
    const parent = (messagesRef.current[m.channelID] ?? []).find((x) => x.id === m.parentID);
    if (parent?.senderUserID === meID) return true;
    const tid = m.threadID ?? m.parentID;
    return (threadMessagesRef.current[tid] ?? []).some((r) => r.senderUserID === meID);
  }

  // 37-5: open one member's sealed reaction set. Anything unreadable -- no
  // key, a cleared set (empty body), a malformed array -- resolves to [],
  // which renders as "this person reacts with nothing" rather than as a
  // broken chip. Reaction sets are not worth a placeholder the way a message
  // body is.
  async function openReactionSet(
    channelID: string,
    r: { body?: string; key_version?: number },
  ): Promise<string[]> {
    if (!r.body || !ccRef.current) return [];
    const opened = await ccRef.current.openJSONForChannel<unknown>(
      channelID,
      r.key_version,
      r.body,
    );
    if (!Array.isArray(opened)) return [];
    return opened.filter((e): e is string => typeof e === "string");
  }

  function handleFrame(f: Frame) {
    switch (f.type) {
      case TypeFetchThreadAck: {
        // Phase 10c: server returned the replies for a thread.
        const p = f.payload as FetchThreadAckPayload;
        void decryptAll((p.messages ?? []).map(wireToMessage)).then((msgs) => {
          msgs.sort((a, b) => a.seq - b.seq);
          dispatch({ kind: "thread_loaded", threadID: p.thread_id, messages: msgs });
        });
        break;
      }
      case TypeSendAck: {
        // Our own send committed. Retire the optimistic row deterministically
        // (see reducer case "send_ack"): the live echo is suppressed for this
        // connection and history carries no client_msg_id, so this ack is the
        // only authoritative signal that our optimistic row is now persisted.
        const p = f.payload as SendAckPayload;
        dispatch({
          kind: "send_ack",
          channelID: p.channel_id,
          clientMsgID: p.client_msg_id,
          id: p.id,
          seq: p.seq,
          ts: new Date(p.ts),
        });
        // 40-4: off by default. isRelevantSurfaceOpen is false rather than
        // "is this the active channel" on purpose -- you almost always send
        // to the channel you're looking at, and passing true would make the
        // setting do nothing at all.
        notifyRef.current?.play("send_confirm", {
          tabVisible: tabVisibleRef.current,
          userIdle: userIdleRef.current,
          isRelevantSurfaceOpen: false,
        });
        break;
      }
      case TypeTypingUpdate: {
        const p = f.payload as TypingUpdatePayload;
        // Two guards the server already applies, repeated here because a
        // mixed-version fleet is cheaper to survive than to diagnose: never
        // show ourselves, and ignore thread pings (nothing renders them, and
        // "alice is typing" in the channel while she replies in a thread
        // nobody has open would be actively wrong).
        // userRef, not state.user: handleFrame is captured by the WS effect
        // before welcome lands, so the closure's state.user is null forever.
        if (!typingEnabledRef.current) break;
        if (!p.user_id || p.user_id === userRef.current?.id) break;
        if (p.thread_id) break;
        typingStore.note(p.channel_id, p.user_id, Date.now());
        break;
      }

      case TypeMessage: {
        const wire = f.payload as MessagePayload;
        const m = wireToMessage(wire);
        // They were typing this. Drop the name now rather than leaving it up
        // for the rest of the TTL, which reads as a second message coming.
        // Keyed on the user, not m.sender -- that field is a device id.
        if (m.senderUserID) typingStore.clearUser(m.channelID, m.senderUserID);
        // Phase 23f (fail-closed): always decrypt before dispatch; a null-
        // version or undecryptable body becomes a placeholder, never cleartext.
        if (ccRef.current) {
          void ccRef.current
            .decryptForChannel(m.channelID, m.keyVersion, m.body)
            .then((body) => {
              dispatch({ kind: "message", message: { ...m, body } });
              noteMention(m.channelID, m.senderUserID, body); // 33-3
              if (m.parentID) {
                // 42-7: a reply naming us makes its thread need us.
                noteThreadMention(m.threadID ?? m.parentID, m.senderUserID, body);
              }
              noteSound(m, body); // 40-2
            });
        } else {
          dispatch({
            kind: "message",
            message: { ...m, body: "[encrypted message -- key not available yet]" },
          });
          // Still worth a sound: a message you can't read yet is a message.
          // The empty body is deliberate -- classifying an unreadable
          // message as a mention would be guessing.
          noteSound(m, "");
        }
        break;
      }



      case TypeMessageDeleted: {
        const p = f.payload as MessageDeletedPayload;
        dispatch({
          kind: "message_deleted",
          channelID: p.channel_id,
          messageID: p.message_id,
          deletedBy: p.deleted_by || undefined,
          deletedAt: p.deleted_at ? new Date(p.deleted_at) : undefined,
        });
        break;
      }

      case TypeMessageEdited: {
        const p = f.payload as MessageEditedPayload;
        // Same fail-closed decrypt as the message push: the edited body is
        // ciphertext, and an undecryptable one becomes a placeholder rather
        // than being dispatched raw. If this client is the editor, this is
        // also what closes the editor -- we never optimistically apply an
        // edit, so the server's copy is the only one that ever renders.
        //
        // No noteMention here: the push carries no sender, and noteMention's
        // "skip your own messages" test is by sender id, so an edit to your
        // own message would badge you for mentioning yourself. An edit that
        // introduces a new mention therefore doesn't raise the badge -- a
        // small gap, and the honest one until the push carries a sender.
        const applyEdited = (body: string) => {
          dispatch({
            kind: "message_edited",
            channelID: p.channel_id,
            messageID: p.message_id,
            body,
            keyVersion: p.key_version || undefined,
            editedAt: new Date(p.edited_at),
          });
        };
        if (ccRef.current) {
          void ccRef.current
            .decryptForChannel(p.channel_id, p.key_version, p.body)
            .then(applyEdited);
        } else {
          applyEdited("[encrypted message -- key not available yet]");
        }
        break;
      }

      case TypeReactionUpdate: {
        const p = f.payload as ReactionUpdatePayload;
        void openReactionSet(p.channel_id, p.reaction).then((emoji) => {
          dispatch({
            kind: "reaction_set",
            messageID: p.reaction.message_id,
            userID: p.reaction.user_id,
            emoji,
          });
        });
        break;
      }

      case TypeFetchReactionsAck: {
        const p = f.payload as FetchReactionsAckPayload;
        // Decrypt the whole batch, then dispatch ONE merge: a dispatch per row
        // would re-render the feed once per reaction in the loaded window.
        void Promise.all(
          p.reactions.map(async (r) => ({
            r,
            emoji: await openReactionSet(p.channel_id, r),
          })),
        ).then((rows) => {
          const byMessageID: Record<string, ReactionSet[]> = {};
          for (const { r, emoji } of rows) {
            if (emoji.length === 0) continue;
            (byMessageID[r.message_id] ??= []).push({
              userID: r.user_id,
              emoji,
            });
          }
          if (Object.keys(byMessageID).length > 0) {
            dispatch({ kind: "reactions_merged", byMessageID });
          }
        });
        break;
      }

      // gov-2: governance pushes -- mode change + proposal lifecycle.
      case TypeGovernanceEvent: {
        const p = f.payload as GovernanceEventPayload;
        switch (p.kind) {
          case GovEventModeChanged:
            dispatch({
              kind: "governance_mode_changed",
              channelID: p.channel_id,
              mode: p.mode ?? "dictator",
            });
            break;
          case GovEventProposalOpened:
            if (p.proposal)
              dispatch({ kind: "proposal_opened", channelID: p.channel_id, proposal: wireToProposal(p.proposal) });
            break;
          case GovEventProposalUpdated:
            if (p.proposal)
              dispatch({ kind: "proposal_updated", channelID: p.channel_id, proposal: wireToProposal(p.proposal) });
            break;
          case GovEventProposalResolved:
            if (p.proposal)
              dispatch({ kind: "proposal_resolved", channelID: p.channel_id, proposal: wireToProposal(p.proposal) });
            break;
        }
        // 50-2: a proposal opening or resolving is worth telling the
        // viewer about -- it is time-boxed, and missing it means missing
        // the vote. Their own proposals stay quiet (events.ts).
        if (
          userRef.current &&
          governanceEventNotifies({
            kind: p.kind,
            createdBy: p.proposal?.created_by,
            meID: userRef.current.id,
          })
        ) {
          publishNotifyEvent({
            type: "governance",
            senderUserID: p.proposal?.created_by,
            channelID: p.channel_id,
            channelName: channelsRef.current[p.channel_id]?.name || undefined,
            preview: p.kind === GovEventProposalOpened ? "a proposal opened" : "a proposal resolved",
          });
        }
        break;
      }

      // Phase 9.7a: preferences round-trip.
      case TypePrefsGetAck: {
        const ack = f.payload as PrefsAckPayload;
        dispatch({ kind: "prefs_loaded", prefs: ack.prefs as never });
        break;
      }
      case TypePrefsSetAck: {
        const ack = f.payload as PrefsAckPayload;
        dispatch({ kind: "prefs_merged", prefs: ack.prefs as never });
        break;
      }
      case TypePrefsChanged: {
        const push = f.payload as PrefsAckPayload;
        dispatch({ kind: "prefs_merged", prefs: push.prefs as never });
        break;
      }
      case TypeError: {
        const e = f.payload as ErrorPayload;
        // Phase 07 surfaced errors in a banner; phase 08b drops them
        // into the console for now. A toast component is a polish
        // pass.
        console.warn("chalk error:", e.code, e.message);
        // 40-4: until that toast exists, this sound is the only thing that
        // tells a user something failed without the console open.
        notifyRef.current?.play("error", {
          tabVisible: tabVisibleRef.current,
          userIdle: userIdleRef.current,
          isRelevantSurfaceOpen: false,
        });
        break;
      }
      case TypeListChannelsAck: {
        const p = f.payload as ListChannelsAckPayload;
        const channels = (p.channels ?? []).map(wireToChannel);
        dispatch({
          kind: "channels_loaded",
          channels,
        });
        // 30-5: seed sidebar occupancy for every voice room. The channel
        // list is (re)fetched on every connect, so this also refreshes
        // rosters after a reconnect; joined/left/state pushes keep them
        // current in between. Fire-and-forget per channel: a failed
        // roster fetch degrades to an empty sublist, nothing else.
        const rosterClient = clientRef.current;
        if (rosterClient && rosterClient.isOpen() && voiceEnabledRef.current) {
          for (const ch of channels) {
            if (ch.channelType !== "voice") continue;
            rosterClient
              .request<{ channel_id: string }, VoiceRosterAckPayload>(
                TypeVoiceRoster,
                { channel_id: ch.id },
              )
              .then((ack) => {
                dispatch({
                  kind: "voice_roster_set",
                  channelID: ack.channel_id,
                  roster: (ack.roster ?? []).map((w) => ({
                    userID: w.user_id,
                    deviceID: w.device_id,
                    muted: !!w.muted,
                    videoOn: !!w.video_on,
                    screenOn: !!w.screen_on,
                  })),
                });
              })
              .catch((err) => console.warn("voice_roster seed:", err));
          }
        }
        break;
      }
      case TypeFetchHistoryAck: {
        const p = f.payload as FetchHistoryAckPayload;
        void decryptAll((p.messages ?? []).map(wireToMessage)).then((messages) => {
          dispatch({ kind: "history_loaded", channelID: p.channel_id, messages });
          // 33-3: scan the messages that are still unread for a mention of
          // the viewer. This is what re-establishes mention dots after a
          // reload or on a device that was offline -- the flag isn't stored
          // anywhere, because only a client can compute it. Messages older
          // than this page of history are not scanned.
          const cursor = unreadRef.current[p.channel_id]?.lastReadSeq ?? 0;
          for (const m of messages) {
            if (m.seq <= cursor) continue;
            noteMention(m.channelID, m.senderUserID, m.body);
          }
        });
        break;
      }
      // 33-1: both frames carry the same shape. The ack confirms our own
      // mark_read (possibly clamped); the push is another of this user's
      // devices having read the channel.
      case TypeMarkReadAck:
      case TypeReadState: {
        const p = f.payload as ReadStatePayload;
        dispatch({
          kind: "read_state",
          channelID: p.channel_id,
          lastReadSeq: p.last_read_seq,
        });
        break;
      }
      // 42-4: same pairing one level down. The ack confirms our own
      // mark_thread_read (possibly clamped); the push is another of this
      // user's devices having read the thread -- which is what makes a badge
      // cleared on a phone clear on a laptop.
      case TypeMarkThreadReadAck:
      case TypeThreadReadState: {
        const p = f.payload as ThreadReadStatePayload;
        dispatch({
          kind: "thread_read_state",
          threadID: p.thread_id,
          lastReadSeq: p.last_read_seq,
        });
        break;
      }
      // 42-6/42-8: a page of the thread inbox. Rows are dispatched with
      // metadata only so they render immediately; the ciphertext previews go
      // into a ref for the decrypt pass, which fills them in per channel as each
      // channel's key settles.
      case TypeThreadInboxAck: {
        const p = f.payload as ThreadInboxAckPayload;
        const activeWire = p.active ?? [];
        const agedWire = p.aged_unread ?? [];
        for (const w of [...activeWire, ...agedWire]) {
          inboxCipherRef.current.set(w.thread_id, {
            channelID: w.channel_id,
            headBody: w.head_body ?? "",
            headKeyVersion: w.head_key_version,
            headDeleted: w.head_deleted === true,
            lastReplyBody: w.last_reply_body ?? "",
            lastReplyKeyVersion: w.last_reply_key_version,
            lastReplyDeleted: w.last_reply_deleted === true,
          });
        }
        dispatch({
          kind: "thread_inbox_loaded",
          active: activeWire.map(wireToThreadInboxRow),
          agedUnread: agedWire.map(wireToThreadInboxRow),
          unreadTotal: p.unread_involved_total ?? 0,
          hasMoreActive: p.has_more_active === true,
          windowHours: p.active_window_hours || 48,
          // A page request carries before_ts; the ref tells us which this was.
          append: inboxPagingRef.current,
        });
        inboxPagingRef.current = false;
        break;
      }
      case TypeCreateChannelAck: {
        const p = f.payload as CreateChannelAckPayload;
        dispatch({ kind: "channel_added", channel: wireToChannel(p.channel) });
        dispatch({ kind: "close_create_modal" });
        // Subscribe to the new channel so subsequent messages route here.
        // Creator-side: we're already in channel_members, server's
        // hello-time loop would catch it on the NEXT connect, but we
        // can save the reconnect by subscribing now.
        const cid = p.channel.id;
        if (clientRef.current && !subscribeSentRef.current.has(cid)) {
          subscribeSentRef.current.add(cid);
          clientRef.current.send<SubscribeChannelPayload>(TypeSubscribeChannel, {
            channel_id: cid,
          });
        }
        // Activate the new channel.
        dispatch({ kind: "set_active_channel", channelID: cid });
        break;
      }
      case TypeChannelEvent: {
        const p = f.payload as ChannelEventPayload;
        if (p.kind === "key_available" && p.channel) {
          // 38-3: a holder just deposited our wrapped space key. Re-run the
          // ensure so a channel that settled as "waiting" picks the key up now.
          // The summary is minimal (id + version) -- everything else comes from
          // the channel row we already hold, so nothing here touches state.
          void ensureKeyFor(p.channel.id);
          break;
        }
        if (p.kind === "member_added" && p.channel) {
          // Add-member: update the roster from the summary. If WE hold the
          // channel key, reshare it so the newcomer gets the current key
          // (idempotent: skips members who already have a wrap). Any key holder
          // doing this is safe and fixes the offline-inviter case.
          const cid = p.channel.id;
          // 38-2: through the ref, not state -- handleFrame is captured once at
          // WSClient construction, when the channel map is still empty, so a
          // direct state read here reports EVERY channel as unknown.
          const before = channelsRef.current[cid];
          const handles = new Map(
            (p.channel.members ?? []).map((m) => [m.user_id, m.handle ?? ""]),
          );
          if (before) {
            const known = new Set(before.memberIDs);
            for (const id of p.channel.member_ids ?? []) {
              if (!known.has(id)) {
                dispatch({
                  kind: "channel_member_added",
                  channelID: cid,
                  userID: id,
                  handle: handles.get(id) ?? "",
                });
              }
            }
            if (ccRef.current) {
              void ccRef.current
                .reshareKey(cid, p.channel.member_ids ?? [])
                .then(() => refreshMemberKeyStatus())
                .catch((err) => console.error("reshare on member_added failed:", err));
            }
          } else {
            dispatch({ kind: "channel_added", channel: wireToChannel(p.channel) });
            if (clientRef.current && !subscribeSentRef.current.has(cid)) {
              subscribeSentRef.current.add(cid);
              clientRef.current.send<SubscribeChannelPayload>(TypeSubscribeChannel, {
                channel_id: cid,
              });
            }
          }
          break;
        }
        if (p.kind === "member_removed" && p.channel) {
          // Member removal: update the roster. If WE were removed, the reducer
          // drops the channel entirely. rotation_pending is reflected from the
          // summary so the panel can show it.
          const cid = p.channel.id;
          const before = channelsRef.current[cid]; // 38-2: see member_added
          const after = new Set(p.channel.member_ids ?? []);
          if (before) {
            for (const id of before.memberIDs) {
              if (!after.has(id)) {
                dispatch({ kind: "channel_member_removed", channelID: cid, userID: id });
              }
            }
          }
          dispatch({
            kind: "channel_rotation_pending_set",
            channelID: cid,
            pending: p.channel.rotation_pending ?? false,
          });
          break;
        }
        if (p.kind === "rotate_needed" && p.channel) {
          // Member removal: the server is asking the owner to rotate (the removed
          // member must lose access to future messages). Auto-rotate silently.
          const cid = p.channel.id;
          dispatch({ kind: "channel_rotation_pending_set", channelID: cid, pending: true });
          const ch = channelsRef.current[cid]; // 38-2: see member_added
          const members = ch ? ch.memberIDs : (p.channel.member_ids ?? []);
          const curVer = ch ? ch.currentKeyVersion : (p.channel.current_key_version ?? 1);
          void rotateChannelKeyFor(cid, members, curVer).catch((err) =>
            console.error("auto-rotate on rotate_needed failed:", err),
          );
          break;
        }
        if (p.kind === "key_rotated" && p.channel) {
          // Phase 25-2: the channel's key was rotated. Adopt the new version
          // (the summary carries it), tell ChannelCrypto, and re-ensure the key
          // so we fetch our new-version wrap and encrypt under it going forward.
          const cid = p.channel.id;
          const newVer = p.channel.current_key_version ?? 1;
          dispatch({ kind: "channel_key_version_updated", channelID: cid, currentKeyVersion: newVer });
          if (ccRef.current) {
            ccRef.current.setCurrentKeyVersion(cid, newVer);
            const ch = channelsRef.current[cid]; // 38-2: see member_added
            const members = ch ? ch.memberIDs : (p.channel.member_ids ?? []);
            const createdBy = ch ? ch.createdBy : p.channel.created_by;
            void ccRef.current
              .ensureChannelKey(cid, members, createdBy)
              .then((status) => setKeyStatus((s) => ({ ...s, [cid]: status })))
              .catch((err) => console.error("post-rotation ensureChannelKey failed:", err));
          }
          break;
        }
        if (p.kind === "added" && p.channel) {
          dispatch({ kind: "channel_added", channel: wireToChannel(p.channel) });
          const cid = p.channel.id;
          if (clientRef.current && !subscribeSentRef.current.has(cid)) {
            subscribeSentRef.current.add(cid);
            clientRef.current.send<SubscribeChannelPayload>(TypeSubscribeChannel, {
              channel_id: cid,
            });
          }
          // 50-2: being added to a channel is news for the person added --
          // and "added" is exactly that; the kinds existing members see
          // (member_added etc.) stay quiet (events.ts).
          if (channelEventNotifies(p.kind)) {
            publishNotifyEvent({
              type: "channel_added",
              channelID: cid,
              channelName: p.channel.name || undefined,
            });
          }
        }
        // Phase 11c-7: a member (possibly us) was removed from a
        // channel. If it's us, drop the channel from the sidebar live.
        if (p.kind === "removed" && p.channel) {
          const cid = p.channel.id;
          dispatch({ kind: "channel_removed", channelID: cid });
          typingStore.clearChannel(cid);
          // Allow a future re-add to re-subscribe.
          subscribeSentRef.current.delete(cid);
        }
        break;
      }
      case TypeFriendListAck: {
        const p = f.payload as FriendListAckPayload;
        // Phase 06 wire shape: four bucketed arrays. Accepted goes
        // to the friend picker; pending_incoming + pending_outgoing
        // populate the FriendsPanel (Phase 9.6a).
        const toFriend = (fs: { user_id: string; handle?: string }) => ({
          userID: fs.user_id,
          handle: fs.handle ?? "",
        });
        const friends = (p.accepted ?? []).map(toFriend);
        const pendingIncoming = (p.pending_incoming ?? []).map(toFriend);
        const pendingOutgoing = (p.pending_outgoing ?? []).map(toFriend);
        dispatch({
          kind: "friends_loaded",
          friends,
          pendingIncoming,
          pendingOutgoing,
        });
        break;
      }
      case TypePresenceSubscribeAck: {
        // Phase 9.6c: server confirmed our subscribe. Per-id rejected
        // entries (not_a_friend, self, etc) we currently log but don't
        // surface; the friend list reconciliation makes them rare. The
        // useful info -- current presence state for each subscribed user
        // -- arrives via subsequent TypePresence pushes immediately
        // after, so there's nothing to do here for state.
        break;
      }
      case TypePresence: {
        // Phase 9.6c: server push with a friend's aggregated state.
        const pp = f.payload as PresencePayload;
        if (pp && pp.user_id) {
          // 40-4: sound only on a real arrival, and only for a friend we
          // already had a state for. Subscribing makes the server push the
          // whole roster at once, so "no previous state" means this is the
          // seed after a connect -- treating that as everyone coming online
          // would play the sound N times on every reconnect.
          const before = presenceRef.current[pp.user_id];
          if (before !== undefined && before !== "online" && pp.state === "online") {
            notifyRef.current?.play("presence", {
              tabVisible: tabVisibleRef.current,
              userIdle: userIdleRef.current,
              isRelevantSurfaceOpen: false,
            });
          }
          dispatch({
            kind: "presence_set",
            userID: pp.user_id,
            state: pp.state,
          });
        }
        break;
      }
      case TypeFriendEvent: {
        // Phase 9.6a: server-pushed friend lifecycle change.
        // Simplest correct behavior: re-fetch the friend list. The
        // event payload (kind + from_user_id + handle) doesn't carry
        // enough info to surgically update all buckets, and a fresh
        // friend_list is cheap (single SELECT on the server).
        const c = clientRef.current;
        if (c && c.isOpen()) {
          c.send(TypeFriendList, {});
        }
        // 50-2: a received request is the one friend event that asks the
        // viewer to do something; the rest stay quiet (events.ts).
        const p = f.payload as FriendEventPayload;
        if (p && friendEventNotifies(p.kind)) {
          publishNotifyEvent({
            type: "friend_request",
            senderUserID: p.from_user_id,
            senderHandle: p.handle || undefined,
          });
        }
        break;
      }
      // ---- Phase 30 (30-4): voice pushes -----------------------------
      //
      // Occupancy deltas feed the reducer (any member sees who's in the
      // room); ALL voice frames additionally go onto voiceBus so the
      // mounted VoiceCallPanel's VoiceCall can react (tear down a peer on
      // "left", process relayed signals). Signals are imperative events
      // for the live RTCPeerConnection mesh -- they never touch state.
      case TypeVoiceParticipantJoined: {
        const p = f.payload as VoiceParticipantJoinedPayload;
        if (p?.channel_id) {
          // 50-2: only the join that turns an empty room into a call
          // notifies, and only for someone else's join -- read against
          // the roster BEFORE the dispatch below applies this one.
          // Reconnect roster seeding arrives as voice_roster acks, not as
          // join pushes, so this cannot burst on connect.
          const me = userRef.current;
          if (
            me &&
            voiceCallStarted({
              joinerUserID: p.user_id,
              meID: me.id,
              priorRosterSize: (voiceRostersRef.current[p.channel_id] ?? []).length,
            })
          ) {
            const vch = channelsRef.current[p.channel_id];
            publishNotifyEvent({
              type: "voice",
              senderUserID: p.user_id,
              channelID: p.channel_id,
              senderHandle: vch?.members.find((mem) => mem.userID === p.user_id)?.handle,
              channelName: vch?.name || undefined,
            });
          }
          dispatch({
            kind: "voice_participant_joined",
            channelID: p.channel_id,
            userID: p.user_id,
            deviceID: p.device_id,
          });
        }
        voiceBus.emit(f);
        break;
      }
      case TypeVoiceParticipantLeft: {
        const p = f.payload as VoiceParticipantLeftPayload;
        if (p?.channel_id) {
          dispatch({
            kind: "voice_participant_left",
            channelID: p.channel_id,
            userID: p.user_id,
            deviceID: p.device_id,
          });
        }
        voiceBus.emit(f);
        break;
      }
      case TypeServerNotice: {
        // 46-3: the server is going down (chalkctl update, or a plain
        // restart). Only a hint that the drop about to happen is expected --
        // whether this tab is now stale is decided by the build in the next
        // welcome frame, since a restart onto the SAME build changes nothing.
        const p = f.payload as ServerNoticePayload;
        if (p?.kind === NoticeRestarting) dispatch({ kind: "server_restarting" });
        break;
      }
      case TypeVoicePurged: {
        // 45-1: the last person left the room, so the server destroyed what
        // was typed in it. Nothing to emit on the bus -- this is state, not a
        // media event.
        const p = f.payload as VoicePurgedPayload;
        if (p?.channel_id) {
          dispatch({ kind: "voice_purged", channelID: p.channel_id });
        }
        break;
      }
      case TypeVoiceParticipantState: {
        const p = f.payload as VoiceParticipantStatePayload;
        if (p?.channel_id) {
          dispatch({
            kind: "voice_participant_state",
            channelID: p.channel_id,
            participant: {
              userID: p.user_id,
              deviceID: p.device_id,
              muted: !!p.muted,
              videoOn: !!p.video_on,
              screenOn: !!p.screen_on,
            },
          });
        }
        voiceBus.emit(f);
        break;
      }
      case TypeVoiceSignal: {
        // Relayed peer signal (offer/answer/ice). E2E ciphertext payload;
        // only the in-call manager can open it.
        voiceBus.emit(f);
        break;
      }
      default:
        break;
    }
  }

  // --- Side effects driven by state ------------------------------------

  // After connect, fetch the channel list AND the friend list.
  //
  // Phase 9.6e: the friend list send was added here in addition to
  // the channel list. The motivation: friend_event pushes are
  // server-initiated and require an open WS at the moment the
  // event is emitted. If alice was disconnected when bob sent her
  // a friend_request, the server's handleFriendEvent bails
  // (ConnsForUser is empty) and the event is lost forever -- no
  // replay queue. Re-fetching friend_list on every (re)connect
  // closes this race: even if a push was missed, the very next
  // friend_list_ack carries the up-to-date pending buckets.
  //
  // Bonus: this also fixes the "fresh-login user has empty friend
  // list until they open CreateChannelModal" papercut that was
  // present since phase 06.
  useEffect(() => {
    if (state.wsState !== "open" || !state.user) return;
    const c = clientRef.current;
    if (!c) return;
    c.send<ListChannelsPayload>(TypeListChannels, {});
    c.send(TypeFriendList, {}); // Phase 9.6e
    c.send(TypePrefsGet, {}); // Phase 9.7a
    // Reset per-connect bookkeeping. After reconnect the server's
    // hello-time loop re-subscribes from scratch, and we should
    // forget what we'd previously asked for at the protocol layer.
    subscribeSentRef.current = new Set();
    historyRequestedRef.current = new Set();
    markReadSentRef.current = new Map(); // 33-1
    markThreadReadSentRef.current = new Map(); // 42-4
  }, [state.wsState, state.user?.id]);

  // Phase 9.7b: apply the user's selected theme to the document root.
  // Runs whenever prefs.theme changes (initial load, picker change,
  // or push from another device via prefs_changed). Unknown theme
  // values fall back to the default by removing the attribute.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const theme = state.prefs.theme;
    if (theme && theme !== "green") {
      root.setAttribute("data-theme", theme);
    } else {
      // "green" is the default (no attribute needed). Also handle
      // unset / unknown by removing.
      root.removeAttribute("data-theme");
    }
  }, [state.prefs.theme]);

  // 44-4: microphone tuning and the voice keybinds follow the account. The
  // download direction -- initial prefs, and any change pushed from another
  // device -- folded into the local mic store, which is what the live call,
  // the meter and the hotkeys actually read.
  useEffect(() => {
    if (state.prefs.mic) applyRemoteMicPrefs(state.prefs.mic);
  }, [state.prefs.mic]);

  // The upload direction. Registered only while the socket is open, so an
  // edit made offline stays local rather than being silently dropped -- it
  // still applies to this machine, and the next edit online carries it up.
  // `mic` is a flat top-level pref (like theme, unlike chat), and the dialog
  // always publishes the whole synced object, so the server's shallow JSONB
  // merge is safe.
  useEffect(() => {
    if (state.wsState !== "open") return;
    setMicPrefsPublisher((synced) => {
      const c = clientRef.current;
      if (c?.isOpen()) c.send(TypePrefsSet, { patch: { mic: synced } });
    });
    return () => setMicPrefsPublisher(null);
  }, [state.wsState]);

  // Phase 9.6c: keep the presence subscription synchronized with the
  // accepted-friends list. Whenever friends change (after a
  // friend_list_ack lands, or after add/remove), diff against the
  // last-subscribed set and send subscribe / unsubscribe deltas.
  //
  // The ref-stored Set survives across renders so we don't re-send
  // the same subscribe each time the friend list reloads. On
  // disconnect (wsState !== "open") we clear the set so the next
  // reconnect re-subscribes from scratch.
  // Phase 9.6j: track document visibility so "auto" mode can map
  // tab-visible → online and tab-hidden → away. The visible state
  // lives in a ref+state pair so the effect can read the latest
  // value without re-running on every change (we just want to
  // re-trigger when the MODE changes or the WS opens/closes).
  // Phase 11c-2 PR 4: open/closed flag for the channel-members modal.

  const [tabVisible, setTabVisible] = useState<boolean>(
    typeof document === "undefined" ? true : !document.hidden
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onChange = () => setTabVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  // --- 50-3: banner teardown -------------------------------------------
  //
  // A banner announces something unread. The moment it stops being
  // unread -- read here, read on the phone, the tab brought back to the
  // channel -- the banner is stale, and stale banners are how people
  // learn to ignore them. Cursors sync across devices, so watching local
  // state covers the remote reads too. Closing a tag with no banner
  // behind it is a no-op, so none of this needs to know what was shown.
  useEffect(() => {
    for (const [cid, u] of Object.entries(state.unread)) {
      if (!hasUnread(u)) notifyBanners().closeChannel(cid);
    }
  }, [state.unread]);

  // Thread cursors: any advance means the viewer (on some device) went
  // into that thread; whatever the banner said, they've seen newer.
  const prevThreadSeenRef = useRef<Record<string, number>>({});
  useEffect(() => {
    const prev = prevThreadSeenRef.current;
    for (const [tid, seq] of Object.entries(state.threadSeen)) {
      if (prev[tid] !== seq) notifyBanners().closeThread(tid);
    }
    prevThreadSeenRef.current = state.threadSeen;
  }, [state.threadSeen]);

  useEffect(() => {
    if (state.pendingIncoming.length === 0) notifyBanners().closeFriend();
  }, [state.pendingIncoming]);

  // Coming back to the tab clears the active channel's banner without
  // waiting for the mark_read round-trip.
  useEffect(() => {
    if (tabVisible && state.activeChannelID) notifyBanners().closeChannel(state.activeChannelID);
  }, [tabVisible, state.activeChannelID]);

  // 40-4: your own connection coming and going. Both off by default.
  //
  // Driven off transitions, not off the current value, so a re-render
  // can't replay them. The first open is skipped as well: arriving at a
  // working app is not news, and on a cold load the sound would be
  // competing with the page still drawing itself.
  const prevWsStateRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevWsStateRef.current;
    prevWsStateRef.current = state.wsState;
    if (prev === null) return;
    if (prev === state.wsState) return;
    const category =
      state.wsState === "open" ? "connect" : prev === "open" ? "disconnect" : null;
    if (!category) return;
    notifyRef.current?.play(category, {
      tabVisible: tabVisibleRef.current,
      userIdle: userIdleRef.current,
      isRelevantSurfaceOpen: false,
    });
  }, [state.wsState]);

  // 40-2: an AudioContext is born suspended and only resume()s from
  // inside a real user gesture, so the first click or keypress anywhere
  // is what grants sound for the rest of the session. One-shot, and the
  // same shape VoiceDock uses to recover autoplay-blocked call audio.
  //
  // Until this fires the gate returns "locked" and nothing is queued: a
  // message that arrives before the user has touched the page is silent
  // rather than saved up to play later.
  //
  // 45-4: the same gesture is what IdleDetector.requestPermission() needs, so
  // the two share one listener pair rather than racing for the first click.
  const [hadGesture, setHadGesture] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const unlock = () => {
      notifyRef.current?.unlock();
      setHadGesture(true);
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  // 41-5: the voice keybinds (push-to-talk / mute / deafen). Installed once for
  // the app's lifetime -- the handlers no-op when nothing is bound, and the
  // session ignores mute/deafen outside a call.
  useEffect(() => installVoiceHotkeys(), []);

  // 33-3: read by mention detection inside handleFrame (see unreadRef).
  tabVisibleRef.current = tabVisible;

  // 33-4: coming back to the tab is the same event as opening the channel --
  // messages piled up while you were away and the mark_read effect is about
  // to clear them. Re-freeze the unread window first so they get a divider.
  // Only on the rising edge; going away must not disturb an existing mark.
  useEffect(() => {
    if (!tabVisible) return;
    dispatch({ kind: "unread_mark_refresh", channelID: activeChannelRef.current });
  }, [tabVisible]);

  // 45-2: auto mode follows activity, not just whether the tab is on screen.
  // The hidden-tab grace period that used to live here is rule 3 of
  // decideIdle, so tab flipping behaves exactly as it did (see idle.ts for
  // why the dot must not move on the visibilitychange itself).
  //
  // The watcher is installed once and owns its own listeners; visibility is
  // pushed in rather than watched twice.
  const [userIdle, setUserIdle] = useState(false);
  const idleWatchRef = useRef<IdleWatch | null>(null);
  useEffect(() => {
    const watch = installIdleWatch((v) => setUserIdle(v.idle));
    idleWatchRef.current = watch;
    return () => {
      idleWatchRef.current = null;
      watch.stop();
    };
  }, []);
  useEffect(() => {
    idleWatchRef.current?.setVisible(tabVisible);
  }, [tabVisible]);
  userIdleRef.current = userIdle;

  // 45-4: the Chromium layer on top -- the only thing that can see input chalk
  // never received. On by default where it exists; the toggle in the profile
  // panel turns it off.
  //
  // Two ways in. An existing grant (a returning visitor, and sticky once chalk
  // is installed) starts on load with no prompt. Otherwise we wait for the
  // first gesture, because requestPermission() needs transient user activation
  // and calling it on a cold page is a guaranteed NotAllowedError -- and
  // because a permission prompt on a page nobody has touched yet is rude.
  const [idlePrefs] = useIdlePrefs();
  const [systemIdlePerm, setSystemIdlePerm] = useState<SystemIdlePermission | null>(null);
  useEffect(() => {
    let live = true;
    void systemIdlePermission().then((p) => {
      if (live) setSystemIdlePerm(p);
    });
    return () => {
      live = false;
    };
  }, []);
  // Collapsed to one boolean on purpose: with the three inputs as separate
  // dependencies, the first click would flip hadGesture under an already-
  // running detector and tear it down to build the same thing again.
  const mayWatchSystemIdle =
    idlePrefs.systemIdle &&
    (systemIdlePerm === "granted" || (systemIdlePerm === "prompt" && hadGesture));
  useEffect(() => {
    if (!mayWatchSystemIdle) return;

    let stop: (() => void) | null = null;
    let cancelled = false;
    void startSystemIdle((s) => idleWatchRef.current?.setSystem(s)).then((r) => {
      if (!r.ok) {
        // A block is the browser's answer, not the user's, so the pref stays on
        // and the panel says "blocked" rather than quietly un-ticking itself.
        setSystemIdlePerm(r.permission);
        return;
      }
      if (cancelled) {
        r.stop();
        return;
      }
      stop = r.stop;
    });
    return () => {
      cancelled = true;
      stop?.();
      // Dropping back to "unknown" rather than "active": without the detector
      // we have no idea, and claiming activity would pin the dot to online.
      idleWatchRef.current?.setSystem({});
    };
  }, [mayWatchSystemIdle]);

  // Phase 9.6j: compute the intended presence and send presence_update
  // when it transitions. "intended" is:
  //   - WS not open → offline (server handles via WS close; nothing to send)
  //   - mode=online → online
  //   - mode=away   → away
  //   - mode=auto   → userIdle ? away : online
  useEffect(() => {
    if (state.wsState !== "open" || !state.user) {
      if (state.myEffectivePresence !== "offline") {
        dispatch({ kind: "my_effective_presence_set", state: "offline" });
      }
      return;
    }
    let intended: "online" | "away";
    if (state.myPresenceMode === "online") intended = "online";
    else if (state.myPresenceMode === "away") intended = "away";
    else intended = userIdle ? "away" : "online";

    if (intended === state.myEffectivePresence) return;

    const c = clientRef.current;
    if (!c || !c.isOpen()) return;
    c.send(TypePresenceUpdate, { state: intended });
    dispatch({ kind: "my_effective_presence_set", state: intended });
  }, [
    state.wsState,
    state.user?.id,
    state.myPresenceMode,
    state.myEffectivePresence,
    userIdle,
  ]);

  // 43-6: turning the feature off clears whoever is on screen right now, so
  // the line goes away immediately rather than at the next TTL.
  useEffect(() => {
    if (!typingEnabled) typingStore.clearAll();
  }, [typingEnabled]);

  // 43-7: when we last announced ourselves, per channel. Keyed by channel so
  // the first keystroke after switching pings immediately instead of serving
  // out the previous room's window; cleared on send so the next character
  // does the same.
  const typingSentRef = useRef<Map<string, number>>(new Map());
  const notifyTyping = (active: boolean) => {
    const cid = state.activeChannelID;
    if (!cid) return;
    if (!active) {
      typingSentRef.current.delete(cid);
      return;
    }
    if (!typingEnabled) return;
    const c = clientRef.current;
    if (!c || !c.isOpen()) return;
    const now = Date.now();
    const last = typingSentRef.current.get(cid) ?? 0;
    if (now - last < TYPING_PING_MS) return;
    typingSentRef.current.set(cid, now);
    c.send<TypingPayload>(TypeTyping, { channel_id: cid });
  };

  const presenceSubscribedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (state.wsState !== "open") {
      presenceSubscribedRef.current = new Set();
      // Also clear the presence map: an offline-and-back round-trip
      // shouldn't leave stale "online" dots from before the drop.
      dispatch({ kind: "presence_reset" });
      // Same reasoning for typing: names frozen across a drop are worse than
      // none, and over a long one the typist may have left entirely.
      typingStore.clearAll();
      return;
    }
    const c = clientRef.current;
    if (!c || !c.isOpen()) return;
    const wantSubs = new Set(state.friends.map((f) => f.userID));
    const have = presenceSubscribedRef.current;
    const toAdd: string[] = [];
    const toRemove: string[] = [];
    wantSubs.forEach((id) => { if (!have.has(id)) toAdd.push(id); });
    have.forEach((id) => { if (!wantSubs.has(id)) toRemove.push(id); });
    if (toAdd.length > 0) {
      c.send<PresenceSubscribePayload>(
        TypePresenceSubscribe,
        { user_ids: toAdd },
      );
    }
    if (toRemove.length > 0) {
      c.send<PresenceUnsubscribePayload>(
        TypePresenceUnsubscribe,
        { user_ids: toRemove },
      );
      // Drop their entries from the local presence map immediately.
      toRemove.forEach((id) => dispatch({ kind: "presence_clear", userID: id }));
    }
    presenceSubscribedRef.current = wantSubs;
  }, [state.wsState, state.friends]);


  // When the active channel changes, fetch history if not yet loaded.
  useEffect(() => {
    const cid = state.activeChannelID;
    if (!cid) return;
    if (state.historyLoaded[cid]) return;
    if (historyRequestedRef.current.has(cid)) return;
    if (state.wsState !== "open") return;
    const c = clientRef.current;
    if (!c) return;
    historyRequestedRef.current.add(cid);
    c.send<FetchHistoryPayload>(TypeFetchHistory, {
      channel_id: cid,
      limit: 50,
    });
  }, [state.activeChannelID, state.wsState, state.historyLoaded]);

  // 33-3: backfill mention dots for unread channels the user hasn't opened.
  //
  // The mention flag can't be stored or synced -- the server can't see who a
  // message names -- so after a reload or a spell offline the only way to
  // know is to decrypt the unread messages and look. We fetch the same page
  // of history a channel open would fetch (the ack handler does the
  // scanning), which also warms the channel for a fast first switch.
  //
  // Bounded on purpose: group channels only, and only the most recent page.
  // A channel with more than a page of unread messages may miss a mention
  // buried below that window -- an accepted cost of keeping mention data off
  // the server entirely.
  useEffect(() => {
    if (state.wsState !== "open") return;
    const c = clientRef.current;
    if (!c) return;
    for (const cid of state.channelOrder) {
      const ch = state.channels[cid];
      if (!ch || ch.isDM) continue;
      if (!hasUnread(state.unread[cid])) continue;
      if (state.historyLoaded[cid]) continue;
      if (historyRequestedRef.current.has(cid)) continue;
      historyRequestedRef.current.add(cid);
      c.send<FetchHistoryPayload>(TypeFetchHistory, { channel_id: cid, limit: 50 });
    }
  }, [state.wsState, state.channelOrder, state.unread, state.historyLoaded]);

  // When the modal opens for the first time in a session, fetch friends.
  useEffect(() => {
    if (!state.createModalOpen) return;
    if (state.friendsLoaded) return;
    if (state.wsState !== "open") return;
    const c = clientRef.current;
    if (!c) return;
    c.send<FriendListPayload>(TypeFriendList, {});
  }, [state.createModalOpen, state.friendsLoaded, state.wsState]);

  // Phase 09c-2: when InvitesPanel opens, fetch the current list of
  // invites. The reducer's loaded `items` is preserved across closes,
  // so reopening is cheap; we only fetch when items is null (never
  // fetched) OR the user explicitly opened the panel a second time.
  // For simplicity: refetch every open. The endpoint is cheap and
  // the user wants fresh data (someone might have used an invite
  // since they last looked).
  //
  // Also called by the InvitesPanel refresh button. The cancelled
  // flag is local to each call; concurrent invocations are tolerated
  // (last-writer-wins via the reducer; nothing here observes the
  // ordering across two in-flight fetches, and that's fine).
  const refreshInvites = () => {
    dispatch({ kind: "invites_load_start" });
    let cancelled = false;
    listMyInvites()
      .then((items) => {
        if (cancelled) return;
        dispatch({ kind: "invites_load_succeeded", items });
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("invites list failed:", err);
        const message = err instanceof ApiError ? err.message :
          err instanceof Error ? err.message : "unknown error";
        dispatch({ kind: "invites_load_failed", message });
      });
    return () => { cancelled = true; };
  };

  useEffect(() => {
    if (state.openPanel !== "invites") return;
    return refreshInvites();
    // refreshInvites closes over dispatch only, which is stable from
    // useReducer. We deliberately don't list it as a dep to avoid
    // re-fetching on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.openPanel]);

  // Phase 09c-2 refresh: ProfilePanel refresh button calls this to
  // re-fetch /api/auth/me so identity fields stay current (e.g. if
  // the user verified an email change in another tab). The actual
  // identity update arrives via the existing auth_me_loaded action;
  // profile_refresh_start/done just drives the spinner.
  const refreshProfile = async () => {
    if (state.profileRefreshing) return;
    dispatch({ kind: "profile_refresh_start" });
    try {
      const me = await fetchMe();
      if (me) {
        dispatch({ kind: "auth_me_loaded", me });
      }
      // If me is null, the session was lost; we don't kick to login
      // from here (the WS or the next gated request will). Refresh
      // just stops spinning.
    } catch (err) {
      console.error("profile refresh failed:", err);
    } finally {
      dispatch({ kind: "profile_refresh_done" });
    }
  };

  // Phase 09c-2: create-invite handler. Called from InvitesPanel
  // submit. Reads the draft from state, fires the POST, dispatches
  // succeed/error. Keep this as a non-effect function (callback)
  // because the user action drives it, not state transition.
  const onCreateInvite = async () => {
    const { email, note, busy } = state.myInvites.createForm;
    if (busy) return;
    const trimmedEmail = email.trim().toLowerCase();
    const trimmedNote = note.trim();
    if (!trimmedEmail) return;
    dispatch({ kind: "invites_create_submit_start" });
    try {
      const invite = await createInviteAPI({
        email: trimmedEmail,
        note: trimmedNote || undefined,
      });
      dispatch({ kind: "invites_create_submit_succeeded", invite });
    } catch (err) {
      if (err instanceof ApiError) {
        dispatch({ kind: "invites_create_submit_error",
          code: err.code, message: err.message });
        return;
      }
      console.error("create invite failed:", err);
      dispatch({ kind: "invites_create_submit_error",
        code: "unknown",
        message: err instanceof Error ? err.message : "unknown error" });
    }
  };

  // Phase 09c-2: revoke-invite handler. Token is the invite's raw
  // base64url-encoded string from the inviteDTO.
  const onRevokeInvite = async (token: string) => {
    dispatch({ kind: "invites_revoke_start", token });
    try {
      await revokeInviteAPI(token);
      dispatch({ kind: "invites_revoke_succeeded", token });
    } catch (err) {
      if (err instanceof ApiError) {
        dispatch({ kind: "invites_revoke_failed",
          token, code: err.code, message: err.message });
        return;
      }
      console.error("revoke invite failed:", err);
      dispatch({ kind: "invites_revoke_failed",
        token,
        code: "unknown",
        message: err instanceof Error ? err.message : "unknown error" });
    }
  };

  // Phase 09c-2: start-email-change handler. Fires when the user
  // submits the change-email form in ProfilePanel.
  const onStartEmailChange = async () => {
    const draft = state.emailChange.draft.trim().toLowerCase();
    if (!draft) return;
    if (state.emailChange.busy) return;
    dispatch({ kind: "email_change_submit_start" });
    try {
      const result = await startEmailChangeAPI(draft);
      dispatch({
        kind: "email_change_submit_succeeded",
        newEmail: result.new_email,
        expiresAt: result.expires_at,
      });
    } catch (err) {
      if (err instanceof ApiError) {
        dispatch({ kind: "email_change_submit_error",
          code: err.code, message: err.message });
        return;
      }
      console.error("email change failed:", err);
      dispatch({ kind: "email_change_submit_error",
        code: "unknown",
        message: err instanceof Error ? err.message : "unknown error" });
    }
  };

  // --- Event handlers --------------------------------------------------

  const onSend = async (
    body: string,
    parentID?: string,
    pending?: PendingAttachment[],
    opts?: { onProgress?: (localID: string, loaded: number, total: number) => void },
  ): Promise<boolean> => {
    const c = clientRef.current;
    if (!c || !c.isOpen()) return false;
    const cid = state.activeChannelID;
    if (!cid) return false;
    if (!state.user) return false;

    // Phase 23d: encrypt for this channel if it holds a key. "waiting" means
    // the channel is encrypted but our key hasn't arrived -- block the send
    // (the composer is also disabled in that state) BEFORE the optimistic
    // append, so nothing is shown that won't actually be sent.
    // Phase 23f (fail-closed): a message is sent ONLY if it can be encrypted.
    // No crypto instance, or no usable channel key, means the send is blocked
    // entirely -- plaintext is never transmitted.
    if (!ccRef.current) return false;
    const enc = await ccRef.current.encryptForChannel(cid, body);
    if (enc.kind !== "encrypted") return false; // "waiting": blocked until key arrives
    const sendBody = enc.body;
    const sendKeyVersion: number = enc.keyVersion;

    // att-2: upload any pending attachments BEFORE the optimistic append + send
    // frame. Each is encrypted under the channel key, chunk-uploaded over HTTP,
    // then finalized; we carry the ids on the send frame and the refs on the
    // optimistic message (chalkd echo-suppresses our own device, so our own
    // attachments render from these optimistic refs). If any upload blocks on
    // the key or errors, abort the whole send -- nothing half-sent.
    // att-3: thread per-item upload progress back to the composer tray.
    const attachmentIDs: string[] = [];
    const attachmentRefs: AttachmentRef[] = [];
    if (pending && pending.length > 0) {
      const deviceID = getOrCreateDeviceId();
      try {
        for (const p of pending) {
          const res = await uploadAttachment(ccRef.current, cid, deviceID, p.file, {
            onProgress: opts?.onProgress
              ? (loaded, total) => opts.onProgress!(p.localID, loaded, total)
              : undefined,
          });
          if (res.kind !== "uploaded") return false; // "waiting": key vanished mid-send
          attachmentIDs.push(res.ref.id);
          attachmentRefs.push(res.ref);
        }
      } catch (err) {
        console.error("attachment upload failed; send aborted:", err);
        return false;
      }
    }

    // Phase 08b polish: optimistic-append. chalkd intentionally
    // echo-suppresses the sender device so a smarter SPA can
    // render its own send immediately without double-rendering.
    // We do that here: dispatch the message into local state
    // before the WS frame goes out. The server persists it and
    // fan-outs to *other* members; we never get an echo so no
    // dedup is needed on this device. On full page reload, the
    // server-generated row is loaded via fetch_history (with a
    // different id), and the local-only id is gone since state
    // is fresh -- so no duplicate rendering across sessions.
    //
    // Optimistic seq: max of existing + 1, so the message sorts
    // to the end (where it visually belongs).
    const existing = state.messages[cid] ?? [];
    const nextSeq =
      existing.length === 0
        ? 1
        : Math.max(...existing.map((m) => m.seq)) + 1;
    const localID =
      "local-" +
      (typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : Date.now().toString(36) + Math.random().toString(36).slice(2));
    dispatch({
      kind: "message",
      message: {
        id: localID,
        channelID: cid,
        seq: nextSeq,
        sender: state.user.device,
        // Phase 9.6i: optimistic echo uses our own user_id so the
        // row renders "you" via the same code path as server-pushed
        // messages would.
        senderUserID: state.user.id,
        ts: new Date(),
        body,
        // Phase 10a/10c: thread metadata. parentID is set only when
        // this send is a thread reply (caller passed parentID). The
        // optimistic threadID resolves to parentID for first-replies
        // and inherits otherwise (the server may correct it; we'll
        // accept the server's value when it echoes back).
        parentID,
        threadID: parentID ? (state.openThread?.threadID ?? parentID) : undefined,
        replyCount: 0,
        // att-2: render our own attachments optimistically (no server echo).
        attachments: attachmentRefs.length > 0 ? attachmentRefs : undefined,
        // Idempotency key: the optimistic row's own local UUID. The server
        // echoes it back in the live push so the reducer replaces THIS row
        // (adopting the server id/seq/ts) instead of appending a duplicate
        // when the echo reaches us (e.g. after a reconnect).
        clientMsgID: localID,
      },
    });

    const payload: SendPayload = { channel_id: cid, body: sendBody, key_version: sendKeyVersion };
    if (parentID) payload.parent_id = parentID;
    if (attachmentIDs.length > 0) payload.attachment_ids = attachmentIDs;
    payload.client_msg_id = localID;
    c.send(TypeSend, payload);
    return true;
  };

  const onCreateChannel = (name: string, isDM: boolean, memberIDs: string[], voice: boolean) => {
    const c = clientRef.current;
    if (!c || !c.isOpen()) return;
    const payload: CreateChannelPayload = {
      name,
      is_dm: isDM,
      member_ids: memberIDs,
    };
    // 30-4: only stamp channel_type when it's a voice room -- omitting it
    // keeps the payload byte-compatible with older servers for text channels.
    if (voice) payload.channel_type = "voice";
    c.send(TypeCreateChannel, payload, "create-" + Date.now());
  };

  // --- Render ----------------------------------------------------------

  // ---- Phase 9.6a: friend management callbacks ---------------------
  //
  // Each callback dispatches a UI state update + sends the
  // appropriate WS frame. For the "add" flow we first do a
  // /api/users/lookup to resolve the username to a UUID, then
  // send friend_request. On any error we surface it inline in
  // the panel.
  //
  // The server pushes a friend_event back over the WS on each
  // lifecycle change, which our handleFrame() converts into a
  // friend_list re-fetch — so we don't need to optimistically
  // mutate local state.

  const handleFriendAddSubmit = async () => {
    const input = state.friendsPanel.addInput.trim();
    if (input.length < 3) {
      dispatch({
        kind: "friends_add_failed",
        error: "username must be at least 3 characters",
      });
      return;
    }
    dispatch({ kind: "friends_add_start" });
    try {
      const target = await lookupUser(input);
      if (!target) {
        dispatch({
          kind: "friends_add_failed",
          error: `no user named "${input}"`,
        });
        return;
      }
      const c = clientRef.current;
      if (!c || !c.isOpen()) {
        dispatch({
          kind: "friends_add_failed",
          error: "not connected; try again in a moment",
        });
        return;
      }
      c.send(TypeFriendRequest, { to_user_id: target.user_id });
      // The server will respond with a friend_request_ack (which we
      // currently ignore) and push a friend_event to the recipient.
      // We mark the add as succeeded here on the assumption the
      // request landed; the FriendsPanel will see the new outgoing
      // entry after the friend_list re-fetch.
      dispatch({ kind: "friends_add_succeeded" });
      // Trigger a friend_list re-fetch right away so the new
      // outgoing request shows up without waiting for a server push.
      c.send(TypeFriendList, {});
    } catch (err) {
      dispatch({
        kind: "friends_add_failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleFriendAccept = (userID: string) => {
    const c = clientRef.current;
    if (!c || !c.isOpen()) return;
    dispatch({ kind: "friends_action_start", userID });
    c.send(TypeFriendAccept, { from_user_id: userID });
    c.send(TypeFriendList, {});
    // The ack/event will trigger another re-fetch; pendingActionUserID
    // is cleared by friends_action_done dispatched from the eventual
    // re-fetch handler. For now, clear it after a short delay so the
    // button doesn't stay disabled forever if the ack is silent.
    setTimeout(() => dispatch({ kind: "friends_action_done", userID }), 800);
  };

  const handleFriendDecline = (userID: string) => {
    // Used for both: declining an incoming request AND cancelling
    // your own outgoing request. The server's handleFriendDecline
    // accepts both party roles.
    const c = clientRef.current;
    if (!c || !c.isOpen()) return;
    dispatch({ kind: "friends_action_start", userID });
    c.send(TypeFriendDecline, { from_user_id: userID });
    c.send(TypeFriendList, {});
    setTimeout(() => dispatch({ kind: "friends_action_done", userID }), 800);
  };

  const handleFriendRemove = (userID: string) => {
    const c = clientRef.current;
    if (!c || !c.isOpen()) return;
    dispatch({ kind: "friends_action_start", userID });
    c.send(TypeFriendRemove, { other_user_id: userID });
    c.send(TypeFriendList, {});
    setTimeout(() => dispatch({ kind: "friends_action_done", userID }), 800);
  };

  const handleFriendsRefresh = () => {
    const c = clientRef.current;
    if (c && c.isOpen()) c.send(TypeFriendList, {});
  };

  // ---- Phase 9.6b: click-friend-in-roster handler ---------------------
  //
  // Either opens the existing DM with this friend, or creates one
  // on the fly. The reducer's dm_pending_set + channel_added wiring
  // takes care of auto-activating the channel once it lands.
  const handleFriendClickInRoster = (friendUserID: string) => {
    // 1. Existing DM? Activate it directly.
    const ownID = state.user?.id ?? state.me?.userID ?? null;
    if (ownID) {
      for (const id of state.channelOrder) {
        const ch = state.channels[id];
        if (!ch || !ch.isDM) continue;
        if (ch.memberIDs.length !== 2) continue;
        const otherID = ch.memberIDs.find((m) => m !== ownID);
        if (otherID === friendUserID) {
          dispatch({ kind: "set_active_channel", channelID: ch.id });
          return;
        }
      }
    }
    // 2. No DM yet — send create_channel and stash the friend's
    //    user_id so we auto-activate when the channel_added lands.
    //
    // Phase 9.6h: the server validates name as 1-80 chars after
    // trim, regardless of is_dm. Synthesize a name from the
    // friend's handle so the request validates. The stored name
    // is never shown to users (displayName() overrides DM
    // channels to render as "@handle" from the members list), so
    // we just need something stable and non-empty.
    const c = clientRef.current;
    if (!c || !c.isOpen()) return;
    const friend = state.friends.find((f) => f.userID === friendUserID);
    const dmName = friend && friend.handle
      ? "dm-" + friend.handle
      : "dm-" + friendUserID.slice(-8);
    dispatch({ kind: "dm_pending_set", userID: friendUserID });
    onCreateChannel(dmName, true, [friendUserID], false);
  };

  // ---- Phase 09d-2d: backfill `me` after URL-driven registration ---
  //
  // AuthGate fetches /api/auth/me only when authStage is
  // "bootstrapping". After the URL-driven flows (invite registration,
  // admin bootstrap), state transitions through other stages straight
  // to "authed" without ever returning to bootstrapping, so `me`
  // stays null. The StatusBar's user menu requires `!!me`, so the
  // trigger button never appears until a page reload.
  //
  // This effect backfills `me` whenever we land in authed without
  // it. The `me === null` guard prevents loops (once me is set the
  // effect's body skips).
  useEffect(() => {
    if (state.authStage !== "authed") return;
    if (state.me !== null) return;
    let cancelled = false;
    fetchMe()
      .then((me) => {
        if (cancelled) return;
        if (me) {
          dispatch({ kind: "auth_me_loaded", me });
        }
        // If me is null, the session has somehow gone; the next
        // gated request will surface the issue. We don't kick to
        // login from here because the WS welcome path will catch
        // it if the cookie is genuinely invalid.
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("auth me backfill failed:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [state.authStage, state.me]);

  // ---- Phase 09d-2b: admin route + popstate listener ---------------
  //
  // Two responsibilities:
  //
  //   1. On mount AND whenever me changes, reconcile state.route
  //      with the URL. If the URL is /admin and the user is an
  //      admin, dispatch route_to_admin. If the URL is /admin and
  //      the user is NOT an admin, replace the URL with / and
  //      stay on chat. If the URL is /, ensure state.route is
  //      "chat".
  //
  //   2. Listen for popstate. The browser's back/forward buttons
  //      fire popstate; we update state.route to match the new
  //      location. (pushState alone doesn't fire popstate, so
  //      programmatic navigation needs an explicit dispatch.)
  useEffect(() => {
    const isAdmin = state.me?.role === "admin";
    const path = window.location.pathname;
    if (path === "/admin") {
      if (isAdmin) {
        if (state.route !== "admin") {
          dispatch({ kind: "route_to_admin" });
        }
      } else {
        // Non-admin landed on /admin (URL-typed, refreshed after
        // demotion, etc.). Bounce back to / silently.
        window.history.replaceState({}, "", "/");
        if (state.route !== "chat") {
          dispatch({ kind: "route_to_chat" });
        }
      }
    } else if (state.route !== "chat") {
      dispatch({ kind: "route_to_chat" });
    }

    function onPopState() {
      const isAdmin2 = state.me?.role === "admin";
      if (window.location.pathname === "/admin" && isAdmin2) {
        dispatch({ kind: "route_to_admin" });
      } else {
        dispatch({ kind: "route_to_chat" });
      }
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.me?.role]);

  // Phase 09b sub-step 5b: auth gate. Before the user is logged in
  // (or until /me bootstrap completes), render the auth flow instead
  // of the chat UI. Once authStage flips to "authed", the chat UI
  // renders. The WS connect effect above is gated on authStage too
  // so we don't open a WS until the user is authenticated.
  if (state.authStage !== "authed") {
    return (
      <AuthGate
        authStage={state.authStage}
        authConfig={state.authConfig}
        registration={state.registration}
        registrationResult={state.registrationResult}
        login={state.login}
        me={state.me}
        inviteContext={state.inviteContext}
        verifyEmailChange={state.verifyEmailChange}
        adminClaimUsername={state.adminClaimUsername}
        dispatch={dispatch}
      />
    );
  }

  // Phase 22c-3c: once authed and the WS is open, ensure this device has
  // the user's encryption identity before showing the chat. While checking,
  // fall through to the chat (which itself waits on wsState); only when we
  // positively need setup do we render the screen.
  // 31-9: hard-cutover migration gate. Renders BEFORE the identity gate:
  // a pre-cutover user must enroll password+TOTP before anything else.
  if (
    state.authStage === "authed" &&
    state.me &&
    state.me.authV2Enrolled === false &&
    !authV2Done
  ) {
    return <MigrationScreen onDone={() => setAuthV2Done(true)} />;
  }

  if (identityGate === "unsupported") {
    return <UnsupportedBrowserScreen />;
  }

  if (
    state.authStage === "authed" &&
    state.wsState === "open" &&
    state.user &&
    identityGate === "needs-setup" &&
    clientRef.current
  ) {
    return (
      <IdentitySetupScreen
        userID={state.user.id}
        transport={clientRef.current}
        onReady={() => setIdentityGate("ready")}
      />
    );
  }

  // Phase 09d-2b: if the route is "admin" AND the user is an
  // admin, render the moderation panel instead of the chat UI.
  // Non-admins are bounced by the effect above; reaching this
  // branch as a non-admin would be a bug, but defensively render
  // the chat UI anyway.
  if (state.route === "admin" && state.me?.role === "admin") {
    return (
      <AdminPanel
        state={state.adminPanel}
        ownUserID={state.me?.userID ?? null}
        dispatch={dispatch}
        onBackToChat={() => {
          window.history.pushState({}, "", "/");
          dispatch({ kind: "route_to_chat" });
        }}
      />
    );
  }

  const activeChannel = state.activeChannelID
    ? state.channels[state.activeChannelID]
    : null;

  // 42-8: lookup maps for the inbox panel, built once here rather than scanned
  // per row -- the same discipline MessageList's handleByUser follows. The inbox
  // spans channels, so it cannot reuse the active channel's roster.
  const threadInboxChannelNames: Record<string, string> = {};
  const threadInboxHandles: Record<string, string> = {};
  if (state.openPanel === "threads") {
    for (const id of state.channelOrder) {
      const ch = state.channels[id];
      if (ch) threadInboxChannelNames[id] = displayName(ch, state.user?.id ?? null);
    }
    for (const id of state.channelOrder) {
      for (const m of state.channels[id]?.members ?? []) {
        if (m.handle) threadInboxHandles[m.userID] = m.handle;
      }
    }
  }
  // 47-8: every decrypted line this client holds per inbox thread, so the
  // filter can match inside a thread rather than only on the one-line previews
  // a row carries. Sources are merged and deduped: threadMessages (live pushes
  // cache replies there even for never-opened threads, and opening a thread
  // loads the rest) plus replies sitting in the channel history cache. Newest
  // first, head last -- bestMatchLine and the preview fallback both want an
  // actual reply to win over the head.
  const threadInboxLines: Record<string, ThreadLine[]> = {};
  if (state.openPanel === "threads") {
    for (const r of [...state.threadInboxAgedUnread, ...state.threadInboxActive]) {
      const lines: ThreadLine[] = [];
      const seenIDs = new Set<string>();
      const cached = state.messages[r.channelID] ?? [];
      const replies = [
        ...(state.threadMessages[r.threadID] ?? []),
        ...cached.filter((m) => m.parentID === r.threadID),
      ].sort((a, b) => b.seq - a.seq);
      for (const m of replies) {
        if (m.deleted || seenIDs.has(m.id)) continue;
        seenIDs.add(m.id);
        lines.push({ senderUserID: m.senderUserID || undefined, body: m.body });
      }
      // The row's own decrypted preview of the newest reply, when that reply
      // is not in either cache (e.g. a channel not opened this session).
      if (
        r.lastReplyBody &&
        !r.lastReplyDeleted &&
        !lines.some((l) => l.body === r.lastReplyBody)
      ) {
        lines.unshift({ senderUserID: r.lastReplySenderUserID, body: r.lastReplyBody });
      }
      const head = cached.find((m) => m.id === r.threadID);
      if (head && !head.deleted) {
        lines.push({ senderUserID: head.senderUserID || undefined, body: head.body, head: true });
      } else if (r.headBody && !r.headDeleted) {
        lines.push({ senderUserID: r.headSenderUserID, body: r.headBody, head: true });
      }
      threadInboxLines[r.threadID] = lines;
    }
  }
  // Phase 10a: hide replies from the main channel feed. They'll
  // be visible inside the thread panel once 10c lands. Until then,
  // they're in the cache but not rendered. We keep the full list
  // in state so 10c can pull from it directly without re-fetching.
  const allActiveMessages = state.activeChannelID
    ? state.messages[state.activeChannelID] ?? []
    : [];
  const activeMessages = allActiveMessages.filter((m) => !m.parentID);

  // Phase 09b sub-step 5b: logout handler. Fires the server-side
  // session delete, then dispatches auth_logged_out to flip the SPA
  // back to LoginScreen. Errors are logged but we proceed with the
  // client-side teardown regardless — the user wants out either way.
  const handleLogout = async () => {
    try {
      await logoutAPI();
    } catch (err) {
      console.error("logout API call failed:", err);
    }
    // Phase 9.6f: clear the localStorage device_id so the next
    // sign-in (potentially a different user on this browser) gets
    // a fresh device identity. Avoids inheriting the previous
    // user's devices row on the server.
    clearDeviceId();
    // att-2: wipe the cached attachment ciphertext on logout (hygiene + frees
    // disk; the cache is ciphertext, but clearing keeps logout a clean teardown
    // alongside the device id, mirroring the space-key cache intent).
    void clearAttachmentCache().catch((err) =>
      console.error("clear attachment cache failed:", err),
    );
    dispatch({ kind: "auth_logged_out" });
  };

  // Phase 10c: when a thread is opened, fetch its replies if we
  // don't have them cached yet. The "open_thread" action sets
  // openThread synchronously; this effect picks it up and sends
  // fetch_thread. The ack arrives as a separate frame handled in
  // the main WS receive loop.
  useEffect(() => {
    if (!state.openThread) return;
    const { channelID, threadID } = state.openThread;
    if (state.threadLoaded[threadID]) return;
    const c = clientRef.current;
    if (!c || !c.isOpen()) return;
    c.send(TypeFetchThread, { channel_id: channelID, thread_id: threadID });
  }, [state.openThread?.threadID, state.openThread?.channelID, state.threadLoaded]);

  // 42-4: threadSeen is no longer loaded from or written to localStorage. It
  // hydrates from history rows (each head carries this viewer's cursor) and
  // stays in sync through mark_thread_read / thread_read_state, so it now
  // follows the user across devices instead of being stranded per browser.

  // Phase 10d: if a reply arrives while the matching thread panel is
  // open, immediately mark it as seen. This keeps the badge at 0 for
  // a thread the user is currently watching. We detect "panel is
  // open for this thread" by comparing state.openThread.threadID
  // against state.threadMessages[tid] tail.
  useEffect(() => {
    if (!state.openThread) return;
    const tid = state.openThread.threadID;
    const replies = state.threadMessages[tid] ?? [];
    if (replies.length === 0) return;
    const maxSeq = replies.reduce((mx, r) => (r.seq > mx ? r.seq : mx), 0);
    if (maxSeq > (state.threadSeen[tid] ?? 0)) {
      dispatch({ kind: "thread_seen_bump", threadID: tid, seq: maxSeq });
    }
  }, [state.openThread?.threadID, state.threadMessages, state.threadSeen]);

  // 33-1: looking at a channel marks it read. Fires on channel switch and
  // on each new message that lands while it's open.
  //
  // Gated on tab visibility: a chalk tab left open in the background must
  // not silently clear the unread dot the user is meant to see on their
  // phone. Returning to the tab re-runs this (tabVisible is a dependency)
  // and marks read then.
  //
  // No local state is optimistically updated here -- the cursor only moves
  // when mark_read_ack comes back with the server's clamped value, which
  // keeps this device's view identical to what the others are told.
  useEffect(() => {
    const cid = state.activeChannelID;
    if (!cid || !tabVisible) return;
    const c = clientRef.current;
    if (!c || !c.isOpen()) return;
    const u = state.unread[cid];
    if (!hasUnread(u)) return;
    // The cursor stays behind until the ack lands, so any unrelated state
    // change in that window would re-run this effect and re-send. Track
    // what we've already asked for instead.
    if ((markReadSentRef.current.get(cid) ?? 0) >= u.lastSeq) return;
    markReadSentRef.current.set(cid, u.lastSeq);
    c.send<MarkReadPayload>(TypeMarkRead, { channel_id: cid, seq: u.lastSeq });
  }, [state.activeChannelID, state.unread, state.wsState, tabVisible]);

  // 42-4: looking at a THREAD marks it read, durably. Same discipline as the
  // channel effect above: gated on tab visibility so a background tab can't
  // silently clear a badge the user is meant to see elsewhere, guarded by an
  // in-flight ref because the cursor stays behind until the ack lands, and no
  // optimistic write here -- thread_read_state carries the server's clamped
  // value to this device and every other one.
  //
  // The local threadSeen bump from open_thread / thread_seen_bump still makes
  // the badge feel instant; this is what makes it survive a reload and reach
  // the user's other devices.
  useEffect(() => {
    if (!state.openThread || !tabVisible) return;
    const { channelID, threadID } = state.openThread;
    const c = clientRef.current;
    if (!c || !c.isOpen()) return;
    const replies = state.threadMessages[threadID] ?? [];
    if (replies.length === 0) return;
    const maxSeq = replies.reduce((mx, r) => (r.seq > mx ? r.seq : mx), 0);
    if (maxSeq <= 0) return;
    if ((markThreadReadSentRef.current.get(threadID) ?? 0) >= maxSeq) return;
    markThreadReadSentRef.current.set(threadID, maxSeq);
    c.send<MarkThreadReadPayload>(TypeMarkThreadRead, {
      channel_id: channelID,
      thread_id: threadID,
      seq: maxSeq,
    });
  }, [
    state.openThread?.threadID,
    state.openThread?.channelID,
    state.threadMessages,
    state.wsState,
    tabVisible,
  ]);

  // 49-2: filename for an attachment-only thread head. A text body always
  // wins as the title; when there is none, the head's single attachment gets
  // its meta decrypted (local AES on a tiny blob, no network) so the panel
  // can say "image: cat.png" instead of a bare "[image]". Keyed by ref id:
  // stale entries from a previously opened thread are simply never matched.
  const [headMetaName, setHeadMetaName] = useState<{ refID: string; name: string } | null>(null);
  const openThreadParent = state.openThread
    ? (state.messages[state.openThread.channelID] ?? []).find(
        (m) => m.id === state.openThread!.threadID,
      )
    : undefined;
  useEffect(() => {
    const ot = state.openThread;
    const p = openThreadParent;
    const att = attControllerRef.current;
    if (!ot || !p || p.deleted || !att) return;
    if (threadTitle(p.body) !== null) return; // text wins; meta not needed
    const refs = p.attachments ?? [];
    if (refs.length !== 1) return; // multi-attachment heads keep the count label
    const ref = refs[0]!;
    // Not a dep on purpose: this guard only stops re-decrypting when the
    // parent object churns (history merges rebuild the list), and the set
    // below must not re-trigger the effect.
    if (headMetaName?.refID === ref.id) return;
    let cancelled = false;
    void att.decryptMeta(ot.channelID, ref).then((meta) => {
      if (!cancelled && meta?.name) setHeadMetaName({ refID: ref.id, name: meta.name });
    });
    return () => {
      cancelled = true;
    };
  }, [state.openThread?.threadID, openThreadParent]);

  // 49-1: "show message" -- the feed row the thread panel asked to jump to,
  // plus the head's seq so the backfill below knows when to stop looking.
  // Cleared by the MessageList once the flash has run, or on navigation.
  const [flashMessage, setFlashMessage] = useState<{
    channelID: string;
    messageID: string;
    seq: number | null;
  } | null>(null);
  const flashPagesRef = useRef(0);

  useEffect(() => {
    // Navigating away cancels the jump; a flash in a channel you left is
    // just a stale scroll waiting to happen.
    setFlashMessage((f) => (f && f.channelID !== state.activeChannelID ? null : f));
  }, [state.activeChannelID]);

  // 49-1: the jump target can be older than the loaded history window (the
  // feed loads the newest 50). Page backwards with before_seq -- the reducer's
  // history_loaded merges by id, so each ack just grows the window -- until
  // the row is present, we have paged past where its seq says it must be
  // (deleted so hard even the tombstone is gone), or a sanity cap trips.
  const flashList = flashMessage ? state.messages[flashMessage.channelID] : undefined;
  useEffect(() => {
    const f = flashMessage;
    if (!f) {
      flashPagesRef.current = 0;
      return;
    }
    const list = flashList ?? [];
    if (list.some((m) => m.id === f.messageID)) {
      flashPagesRef.current = 0;
      return;
    }
    // Seq 0 rows are local echoes still waiting for the server; the list is
    // kept seq-ascending by the reducer.
    const real = list.filter((m) => m.seq > 0);
    if (real.length === 0) return; // initial history fetch still in flight
    const oldest = real[0]!.seq;
    if (f.seq !== null && oldest <= f.seq) {
      setFlashMessage(null);
      return;
    }
    if (flashPagesRef.current >= 20) {
      // ~1000 messages of crawling is enough; give up quietly.
      setFlashMessage(null);
      return;
    }
    const c = clientRef.current;
    if (!c || !c.isOpen()) return;
    flashPagesRef.current += 1;
    c.send<FetchHistoryPayload>(TypeFetchHistory, {
      channel_id: f.channelID,
      before_seq: oldest,
      limit: 50,
    });
  }, [flashMessage, flashList]);

  // 42-8: fetch the inbox once per connect. A small page, and NO decryption on
  // this path, so it only costs what the dot needs -- connect stays cheap.
  useEffect(() => {
    if (state.wsState !== "open" || !state.user) return;
    const c = clientRef.current;
    if (!c || !c.isOpen()) return;
    inboxPagingRef.current = false;
    c.send<ThreadInboxPayload>(TypeThreadInbox, { limit: 25 });
  }, [state.wsState, state.user?.id]);

  // 42-8: opening the panel refetches a bigger page. Cheap, and it means the
  // list is current rather than as of connect.
  useEffect(() => {
    if (state.openPanel !== "threads") return;
    const c = clientRef.current;
    if (!c || !c.isOpen()) return;
    inboxPagingRef.current = false;
    c.send<ThreadInboxPayload>(TypeThreadInbox, { limit: 50 });
  }, [state.openPanel]);

  // 42-8: a live reply arrived for a thread we hold no row for, so the client
  // cannot know whether it concerns us -- only the server can. Debounced hard:
  // a busy channel would otherwise refetch per message.
  useEffect(() => {
    if (!state.threadInboxStale) return;
    const t = window.setTimeout(() => {
      const c = clientRef.current;
      if (!c || !c.isOpen()) return;
      inboxPagingRef.current = false;
      c.send<ThreadInboxPayload>(TypeThreadInbox, { limit: 50 });
    }, 30_000);
    return () => window.clearTimeout(t);
  }, [state.threadInboxStale]);

  // 42-8: decrypt the previews, per channel, as each channel's key settles.
  //
  // Two-phase by design: the rows are already on screen from metadata, and this
  // fills in the bodies. The problem it solves is specific -- a preview from a
  // channel we have not opened this session has no settled key, so
  // decryptForChannel would take the deferred branch and block for keyWaitMs (8s)
  // before rendering a placeholder anyway. warmChannelKey settles it first,
  // READ-ONLY: unlike ensureChannelKey it does not bootstrap or rewrap for other
  // members, which across forty channels would be a request and write storm to
  // render forty one-line previews.
  //
  // Bounded three ways: only channels present in the inbox, at most
  // KEY_WARM_CONCURRENCY in flight, and once per channel per session.
  useEffect(() => {
    if (state.openPanel !== "threads") return;
    const cc = ccRef.current;
    if (!cc) return;

    const rows = [...state.threadInboxActive, ...state.threadInboxAgedUnread];
    const pending = Array.from(new Set(rows.map((r) => r.channelID))).filter(
      (cid) => !inboxWarmedRef.current.has(cid),
    );
    if (pending.length === 0) return;
    for (const cid of pending) inboxWarmedRef.current.add(cid);

    let cancelled = false;
    const KEY_WARM_CONCURRENCY = 4;
    // 48-5: the upfront add above keeps overlapping runs from double-warming,
    // but "warmed" must only stick once a channel's previews actually made it
    // to a dispatch. This run's channels that never got there -- cancelled
    // mid-flight by an effect re-run (panel-open refetch ack, "load more",
    // the 30s stale refetch) or failed outright -- get their mark rolled
    // back so a later run retries them instead of leaving the rows on the
    // skeleton forever.
    const completed = new Set<string>();

    const decryptChannel = async (channelID: string) => {
      try {
        await cc.warmChannelKey(channelID);
        if (cancelled) return;
        const previews: Record<string, { headBody?: string; lastReplyBody?: string }> = {};
        for (const r of rows) {
          if (r.channelID !== channelID) continue;
          const cipher = inboxCipherRef.current.get(r.threadID);
          if (!cipher) continue;
          // Tombstones short-circuit exactly as decryptAll does: an empty body
          // under a tombstone must render a placeholder, not a failed decrypt.
          const head = cipher.headDeleted
            ? "[message deleted]"
            : cipher.headBody
              ? await cc.decryptForChannel(channelID, cipher.headKeyVersion, cipher.headBody)
              : undefined;
          const reply = cipher.lastReplyDeleted
            ? "[message deleted]"
            : cipher.lastReplyBody
              ? await cc.decryptForChannel(
                  channelID,
                  cipher.lastReplyKeyVersion,
                  cipher.lastReplyBody,
                )
              : undefined;
          previews[r.threadID] = { headBody: head, lastReplyBody: reply };
        }
        if (cancelled) return;
        if (Object.keys(previews).length > 0) {
          // One dispatch per channel, so the panel fills in visibly instead of
          // in one late blob, and a slow channel never holds up the others.
          dispatch({ kind: "thread_inbox_previews", channelID, previews });
        }
        completed.add(channelID);
      } catch (err) {
        console.error("thread inbox: preview warm failed for", channelID, err);
        inboxWarmedRef.current.delete(channelID);
      }
    };

    void (async () => {
      for (let i = 0; i < pending.length; i += KEY_WARM_CONCURRENCY) {
        if (cancelled) return;
        await Promise.all(pending.slice(i, i + KEY_WARM_CONCURRENCY).map(decryptChannel));
      }
    })();

    return () => {
      cancelled = true;
      for (const cid of pending) {
        if (!completed.has(cid)) inboxWarmedRef.current.delete(cid);
      }
    };
  }, [state.openPanel, state.threadInboxActive, state.threadInboxAgedUnread, ccReady]);

  // 47-5: nick colors outside the message feed (roster, voice occupants,
  // members panel). Same resolver the feed uses, so a name reads identically
  // everywhere; null means "no tint", including when coloring is switched off.
  const nickHueForHandle = (handle: string): number | null => {
    const chat = selectChatPrefs(state.prefs);
    return resolveNickHue({
      enabled: chat.userColorsEnabled,
      own: false,
      handle,
      selfHue: chat.selfColorHue,
      userHues: chat.userHues,
    });
  };
  const ownNickHue = selectChatPrefs(state.prefs).userColorsEnabled
    ? selectChatPrefs(state.prefs).selfColorHue
    : null;

  return (
    <div
      class={`chalk-app chalk-app--phase08b ${state.openThread ? "chalk-app--thread-open" : ""} ${isMobile ? "chalk-app--mobile" : ""} ${navOpen ? "chalk-app--nav-open" : ""}`}
      // 33-4: drives the sidebar grid column. Omitted on mobile, where the
      // sidebar is a drawer sized by its own rule.
      style={isMobile ? undefined : `--chalk-sidebar-w:${sidebarWidth}px`}
    >
      <header class="chalk-header">
        <div class="chalk-header-left">
          {isMobile && (
            <button
              type="button"
              class="chalk-nav-toggle"
              aria-label={navOpen ? "close channel list" : "open channel list"}
              aria-expanded={navOpen}
              aria-controls="chalk-roster"
              data-testid="nav-toggle"
              onClick={() => setNavOpen((open) => !open)}
            >
              ☰
            </button>
          )}
          <div class="chalk-brand">
            <Logo />
            <h1>chalk</h1>
            {/* 39-1: which build this is, linking to its changelog. Hidden on
                mobile by CSS -- the header is already tight there, and the
                profile panel carries the same link. */}
            <VersionLink version={state.serverVersion} commit={state.serverCommit} />
          </div>
        </div>
        <StatusBar
          state={state.wsState}
          detail={state.wsDetail}
          user={state.user}
          me={state.me}
          onLogout={handleLogout}
          onOpenInvites={() => dispatch({ kind: "open_panel", panel: "invites" })}
        onOpenFriends={() => {
          dispatch({ kind: "open_panel", panel: "friends" });
          handleFriendsRefresh();
        }}
          onOpenProfile={() => dispatch({ kind: "open_panel", panel: "profile" })}
          onOpenAdmin={() => {
            window.history.pushState({}, "", "/admin");
            dispatch({ kind: "route_to_admin" });
          }}
          updateAvailable={state.updateAvailable}
          onReload={() => window.location.reload()}
          onDismissUpdate={() => dispatch({ kind: "update_dismissed" })}
          serverRestarting={state.serverRestarting}
          presenceMode={state.myPresenceMode}
          effectivePresence={state.myEffectivePresence}
          onPresenceModeChange={(mode) =>
            dispatch({ kind: "presence_mode_set", mode })
          }
        />
      </header>

      {isMobile && navOpen && (
        <div
          class="chalk-nav-backdrop"
          data-testid="nav-backdrop"
          onClick={() => setNavOpen(false)}
        />
      )}

      <aside class="chalk-sidebar" id="chalk-roster">
        {/* The open drawer covers the header, so it carries its own close
            control instead of relying on the ☰ button behind it. */}
        {isMobile && (
          <div class="chalk-drawer-head">
            <span class="chalk-drawer-title">
              <Logo />
              chalk
            </span>
            <button
              type="button"
              class="chalk-drawer-close"
              aria-label="close channel list"
              data-testid="nav-close"
              onClick={() => setNavOpen(false)}
            >
              ✕
            </button>
          </div>
        )}
        <Sidebar
          // Phase 9.7f: nick colors in the roster context menu. hueForHandle
          // reports what a handle currently renders as (explicit pick, else
          // the automatic hash) so the picker opens on the live color;
          // onSetFriendHue persists a pick, or clears it back to automatic.
          // 47-5: it also tints the roster itself, so it honours the master
          // switch -- null means "leave this name the theme's color".
          nickColorsEnabled={selectChatPrefs(state.prefs).userColorsEnabled}
          hueForHandle={nickHueForHandle}
          selfHue={ownNickHue}
          onSetFriendHue={(handle, hue) => {
            // Same JSONB shallow-merge rule as the other chat prefs: ship the
            // whole chat object, not just the changed key.
            const c = clientRef.current;
            if (!c || !c.isOpen()) return;
            const current = selectChatPrefs(state.prefs);
            const key = handle.toLowerCase();
            const userHues = { ...current.userHues };
            if (hue === null) delete userHues[key];
            else userHues[key] = hue;
            c.send(TypePrefsSet, { patch: { chat: { ...current, userHues } } });
          }}
          channels={state.channelOrder.map((id) => state.channels[id])}
          friends={state.friends}
          activeID={state.activeChannelID}
          ownUserID={state.user?.id ?? null}
          presence={state.presence}
          voiceRosters={state.voiceRosters}
          unread={state.unread}
          onSelect={(id) => {
            dispatch({ kind: "set_active_channel", channelID: id });
            // On mobile the roster covers the conversation, so picking one
            // has to hand the screen back.
            setNavOpen(false);
            // 30-5c click-to-join (Addendum C, core): selecting a voice room
            // connects to it, Discord-style. The actual join call lives in
            // the keyStatus-driven effect above (it fires off this same
            // set_active_channel dispatch) so first-time visits -- where the
            // channel key isn't ready yet -- join automatically too, instead
            // of only on a later revisit.
          }}
          onFriendClick={(friendUserID) => {
            setNavOpen(false);
            handleFriendClickInRoster(friendUserID);
          }}
          onCreateClick={() => {
            setNavOpen(false);
            dispatch({ kind: "open_create_modal" });
          }}
          // 49-6: the thread inbox lives with the other unread dots now. On
          // mobile the sidebar is a drawer, so opening the panel closes it.
          onOpenThreads={() => {
            setNavOpen(false);
            dispatch({ kind: "open_panel", panel: "threads" });
          }}
          threadsUnread={state.threadInboxUnreadTotal}
        />
        {/* 30-5c: the persistent-call dock -- app-level audio sinks + the
            Discord-style connection bar. Renders nothing while idle. */}
        <VoiceDock
          activeChannelID={state.activeChannelID}
          onJumpToChannel={(id) =>
            dispatch({ kind: "set_active_channel", channelID: id })
          }
        />
        {/* 33-4: resize handle. Desktop only -- on mobile the sidebar is a
            fixed-width drawer and the grid column doesn't exist. */}
        {!isMobile && (
          <SidebarResizer
            width={sidebarWidth}
            onPreview={setSidebarDrag}
            onCommit={commitSidebarWidth}
          />
        )}
      </aside>

      {/* 45-3: a voice channel's pane does not scroll. The call sits at the
          top and the scratchpad fills whatever is left above the composer,
          clipped -- see .chalk-main--voice. */}
      <main
        class={
          "chalk-main" +
          (activeChannel?.channelType === "voice" ? " chalk-main--voice" : "")
        }
      >
        {activeChannel ? (
          <>
            <div class="chalk-channel-header" data-testid="channel-header">
              {/* 30-5: channel-kind glyph -- text vs voice, matching the
                  sidebar. DMs keep their textual tag instead. */}
              {!activeChannel.isDM && (
                <span
                  class={`chalk-chglyph chalk-chglyph--header ${activeChannel.channelType === "voice" ? "chalk-chglyph--voice" : "chalk-chglyph--text"}`}
                >
                  <ChannelGlyph
                    type={activeChannel.channelType === "voice" ? "voice" : "text"}
                  />
                </span>
              )}
              <span class="chalk-channel-header-name">
                {displayName(activeChannel, state.user?.id ?? null)}
              </span>
              {activeChannel.isDM && <span class="chalk-channel-header-tag">dm</span>}
              {!activeChannel.isDM && (
                <ModeBadge
                  mode={activeChannel.governanceMode}
                  onClick={() => dispatch({ kind: "open_panel", panel: "governance" })}
                />
              )}
              <EncryptionIndicator
                status={
                  state.activeChannelID ? keyStatus[state.activeChannelID] : undefined
                }
                onClick={() => dispatch({ kind: "open_panel", panel: "members" })}
              />
            </div>
            {/* Phase 30 (30-4): the minimal call surface for voice channels.
                Key by channel id so switching rooms unmounts (and thereby
                leaves) the previous call. 30-5 replaces this with the
                Discord-style UI. */}
            {activeChannel.channelType === "voice" && !state.voiceEnabled && (
              <div class="chalk-voice-panel chalk-voice-disabled" data-testid="voice-disabled">
                voice is disabled on this server (CHALK_VOICE_ENABLED)
              </div>
            )}
            {activeChannel.channelType === "voice" && state.voiceEnabled && state.user && ccReady && (
              <VoiceCallPanel
                key={activeChannel.id}
                channel={activeChannel}
                selfUserID={state.user.id}
                selfDeviceID={state.user.device}
                client={clientRef}
                cc={ccRef}
                roster={state.voiceRosters[activeChannel.id] ?? []}
                keyReady={keyStatus[activeChannel.id] === "ready"}
              />
            )}
            <MessageList
              messages={activeMessages}
              ephemeral={activeChannel.channelType === "voice"}
              // 33-4: channelID drives the "land on entry" scroll; the mark
              // is the frozen unread window the divider is drawn from.
              channelID={activeChannel.id}
              unreadMark={state.unreadMarks[activeChannel.id]}
              // 49-1: "show message" jump target from the thread panel.
              flashMessageID={
                flashMessage && flashMessage.channelID === activeChannel.id
                  ? flashMessage.messageID
                  : null
              }
              onFlashDone={() => setFlashMessage(null)}
              ownDevice={state.user?.device ?? null}
              ownUserID={state.user?.id ?? null}
              ownHandle={state.me?.username ?? null}
              members={activeChannel.members ?? []}
              isDM={activeChannel.isDM}
              display={selectChatPrefs(state.prefs)}
              giphyPref={selectGiphyPref(state.prefs)}
              onRequestEnableGiphy={() => setGiphyConsentOpen(true)}
              threadSeen={state.threadSeen}
              canDeleteMessage={(m) => deleteActionOf(m) !== "none"}
              onDeleteMessage={onDeleteMessage}
              deleteLabelFor={(m) => deleteLabelFor(deleteActionOf(m))}
              canEditMessage={(m) => m.id === lastEditableFeedID && canEditMessageOf(m)}
              onEditMessage={(m) => setEditingFeed({ id: m.id, body: m.body })}
              editingMessageID={editingFeed?.id ?? null}
              reactions={state.reactions}
              onToggleReaction={(m, emoji) => void toggleReaction(m, emoji)}
              onPickReaction={(m) => setReactionPickerFor(m)}
              attachmentController={attControllerRef.current ?? undefined}
              onOpenThread={(parentID, threadID) => {
                // Phase 10b: store the open thread on AppState. 10c
                // will render a panel keyed off this. For now, the
                // dispatch + console.log lets you verify the click
                // path works.
                if (!state.activeChannelID) return;
                console.log("[chalk] open_thread", {
                  channelID: state.activeChannelID,
                  threadID,
                  parentID,
                });
                dispatch({
                  kind: "open_thread",
                  channelID: state.activeChannelID,
                  threadID,
                });
              }}
              empty={!state.historyLoaded[activeChannel.id]
                ? "loading history..."
                : activeChannel.channelType === "voice"
                  ? "scratchpad is empty."
                  : "no messages yet. say something."}
            />
          </>
        ) : (
          <div class="chalk-main-empty" data-testid="no-channel">
            {state.channelOrder.length === 0
              ? "no channels yet. create one to get started."
              : "select a channel from the sidebar."}
          </div>
        )}
      </main>

      {state.openThread && activeChannel && (() => {
        // Phase 10c: resolve the panel's inputs.
        // - parent: thread head from the channel cache (filtered out of
        //   activeMessages but present in allActiveMessages).
        // - replies: from threadMessages keyed by threadID.
        const tid = state.openThread.threadID;
        const parent = allActiveMessages.find((m) => m.id === tid);
        const replies = state.threadMessages[tid] ?? [];
        const loaded = state.threadLoaded[tid] ?? false;
        // 49-1: title + "show message". The inbox row stands in when the
        // parent is not in the channel cache: it carries the decrypted head
        // preview and the head's seq (which the jump's backfill needs).
        const inboxRow = [...state.threadInboxAgedUnread, ...state.threadInboxActive].find(
          (r) => r.threadID === tid,
        );
        // 49-2: a head with no text titles by its attachments -- "[image]"
        // straight off the refs (only image kinds carry an inline preview),
        // upgraded to "image: cat.png" once the meta effect above resolves.
        const headRefs = parent?.attachments ?? [];
        const title = parent?.deleted
          ? null
          : threadTitle(parent?.body ?? inboxRow?.headBody) ??
            attachmentTitle(
              headRefs.length,
              headRefs.every((r) => !!r.encPreviewB64),
              headRefs.length === 1 && headMetaName?.refID === headRefs[0]!.id
                ? headMetaName.name
                : undefined,
            );
        const threadChannelID = state.openThread.channelID;
        return (
          <ThreadPanel
            parent={parent}
            title={title}
            onShowParent={() => {
              setFlashMessage({
                channelID: threadChannelID,
                messageID: tid,
                seq: parent?.seq ?? inboxRow?.headSeq ?? null,
              });
              // On mobile the panel covers the feed entirely, so the jump
              // would be invisible behind it.
              if (isMobile) dispatch({ kind: "close_thread" });
            }}
            replies={replies}
            loaded={loaded}
            ownDevice={state.user?.device ?? null}
            ownUserID={state.user?.id ?? null}
            ownHandle={state.me?.username ?? null}
            members={activeChannel.members ?? []}
            isDM={activeChannel.isDM}
            display={selectChatPrefs(state.prefs)}
            disabled={state.wsState !== "open"}
            canDeleteMessage={(m) => deleteActionOf(m) !== "none"}
            onDeleteMessage={onDeleteMessage}
            deleteLabelFor={(m) => deleteLabelFor(deleteActionOf(m))}
            canEditMessage={(m) => m.id === lastEditableThreadID && canEditMessageOf(m)}
            onEditMessage={(m) => setEditingThread({ id: m.id, body: m.body })}
            reactions={state.reactions}
            onToggleReaction={(m, emoji) => void toggleReaction(m, emoji)}
            onPickReaction={(m) => setReactionPickerFor(m)}
            editing={editingThread}
            onEditSubmit={async (body) => {
              const ok = await submitEdit(editingThread, body);
              if (ok) setEditingThread(null);
              return ok;
            }}
            onEditCancel={() => setEditingThread(null)}
            onEditLast={() => {
              const list = state.threadMessages[tid] ?? [];
              const m = lastEditableMessage(list, state.user?.id ?? null, Date.now());
              if (m) setEditingThread({ id: m.id, body: m.body });
            }}
            onClose={() => dispatch({ kind: "close_thread" })}
            onSend={(body, pending, opts) => onSend(body, tid, pending, opts)}
            enableAttachments
            giphyEnabled={state.authConfig?.giphy_enabled ?? false}
            giphyReady={selectGiphyPref(state.prefs) === "enabled"}
            onRequestEnableGiphy={() => setGiphyConsentOpen(true)}
            toolStyle={selectChatPrefs(state.prefs).composerToolStyle}
            attachmentController={attControllerRef.current ?? undefined}
            giphyPref={selectGiphyPref(state.prefs)}
            focusKey={isMobile ? null : tid}
          />
        );
      })()}

      <footer class="chalk-footer">
        {/* 44-2: the roster-width column the composer's tool rail used to
            occupy. Voice controls live here now -- always visible, so mute and
            camera are set before you join rather than after. */}
        <div class="chalk-footer-left">
          {state.voiceEnabled && (
            <VoiceControls onOpenMicSettings={() => setMicSettingsOpen(true)} />
          )}
        </div>
        <div class="chalk-footer-main">
          <TypingLine
            channelID={state.activeChannelID}
            members={activeChannel?.members}
            isDM={!!activeChannel?.isDM}
            display={selectChatPrefs(state.prefs)}
          />
          <Composer
            toolStyle={selectChatPrefs(state.prefs).composerToolStyle}
            emoticons={selectChatPrefs(state.prefs).emoticons}
            disabledReason={
              state.wsState !== "open"
                ? "offline"
                : !state.activeChannelID
                ? "no_channel"
                : keyStatus[state.activeChannelID] === "ready"
                ? null
                : keyStatus[state.activeChannelID] === "waiting"
                ? "waiting_for_key"
                : "encryption_initializing"
            }
            onSend={(body, pending, opts) => onSend(body, undefined, pending, opts)}
            onTyping={notifyTyping}
            editing={editingFeed}
            onEditSubmit={async (body) => {
              const ok = await submitEdit(editingFeed, body);
              if (ok) setEditingFeed(null);
              return ok;
            }}
            onEditCancel={() => setEditingFeed(null)}
            onEditLast={() => {
              const cid = state.activeChannelID;
              if (!cid) return;
              // Feed-only: thread replies belong to the thread composer's
              // cursor-up, not this one.
              const list = (state.messages[cid] ?? []).filter((m) => !m.parentID);
              const m = lastEditableMessage(list, state.user?.id ?? null, Date.now());
              if (m) setEditingFeed({ id: m.id, body: m.body });
            }}
            // While a thread is open its composer owns the caret; closing the
            // thread hands it back here.
            focusKey={isMobile || state.openThread ? null : state.activeChannelID}
            enableAttachments
            giphyEnabled={state.authConfig?.giphy_enabled ?? false}
            giphyReady={selectGiphyPref(state.prefs) === "enabled"}
            onRequestEnableGiphy={() => setGiphyConsentOpen(true)}
          />
        </div>
      </footer>


      {state.createModalOpen && (
        <CreateChannelModal
          friends={state.friends}
          loading={!state.friendsLoaded}
          voiceEnabled={state.voiceEnabled}
          onClose={() => dispatch({ kind: "close_create_modal" })}
          onSubmit={onCreateChannel}
        />
      )}

      {/* Phase 26 (governance prereq) / 35-4: delete confirmation. The copy
          and the number of confirms follow the staged message's action --
          retracting your own message is not the same act as an owner erasing
          someone else's, and in a democratic channel this only opens a vote. */}
      <ConfirmModal
        open={pendingDelete !== null}
        title={
          deleteAction === "proposal"
            ? "Propose deleting this message?"
            : deleteAction === "own"
              ? "Delete your message?"
              : deleteStep === 1
                ? "Delete this message?"
                : "Delete for everyone — are you sure?"
        }
        body={
          deleteAction === "proposal"
            ? "This channel is in democratic mode, so nobody deletes another member's message alone. This opens a proposal the channel votes on; the message stays until a majority agrees."
            : deleteAction === "own"
              ? "This removes your message from the server for everyone in the channel. Anyone who already read it may still have a local copy."
              : deleteStep === 1
                ? "As the channel owner you can delete this for everyone, including its author. This cannot be undone."
                : "Last check: the message is erased from the server for every member. Anyone who already read it may still have a local copy."
        }
        confirmLabel={
          deleteAction === "proposal"
            ? "Start vote"
            : deleteAction === "own"
              ? "Delete"
              : deleteStep === 1
                ? "Continue"
                : "Yes, delete for everyone"
        }
        danger={deleteAction !== "proposal"}
        busy={deleteBusy}
        onConfirm={confirmDeleteMessage}
        onCancel={() => {
          setPendingDelete(null);
          setDeleteStep(1);
        }}
      />

      {/* att-4b: Giphy consent. Reuses ConfirmModal -- confirm enables Giphy
          (the viewer accepts that rendering a GIF fetches it from Giphy's CDN,
          revealing their IP to Giphy); cancel leaves the pref unchanged. The
          explicit "disable" path is just unchecking the settings toggle. */}
      <ConfirmModal
        open={giphyConsentOpen}
        title="Enable Giphy?"
        body={
          "Giphy GIFs are loaded directly from Giphy's servers. Turning this on means your browser will fetch GIFs from Giphy's CDN when a Giphy message is shown, which reveals your IP address and which GIF you're viewing to Giphy. Messages stay end-to-end encrypted; only the GIF render reaches out. This choice is per-device and only affects you -- other members are never made to fetch anything. You can turn it off anytime in settings."
        }
        confirmLabel="Enable Giphy"
        onConfirm={() => {
          sendGiphyPref("enabled");
          setGiphyConsentOpen(false);
        }}
        onCancel={() => setGiphyConsentOpen(false)}
      />

      {/* 37-5: pick a NEW reaction for a message. Existing chips toggle
          directly; this is only for adding one that isn't on the row yet.
          Reuses the composer's emoji picker unchanged. Closes on pick --
          unlike the composer, where several emoji in a row is normal. */}
      <EmojiPicker
        open={reactionPickerFor !== null}
        onClose={() => setReactionPickerFor(null)}
        onPick={(char) => {
          const m = reactionPickerFor;
          setReactionPickerFor(null);
          if (m) void toggleReaction(m, char);
        }}
      />

      {state.openPanel === "notifications" && (
        <NotificationsPanel
          friends={state.friends}
          channels={Object.values(state.channels)}
          onClose={() => dispatch({ kind: "close_panel" })}
        />
      )}

      {state.openPanel === "friends" && (
        <FriendsPanel
          state={state.friendsPanel}
          friends={state.friends.map((f) => ({ userID: f.userID, handle: f.handle }))}
          pendingIncoming={state.pendingIncoming}
          pendingOutgoing={state.pendingOutgoing}
          onClose={() => dispatch({ kind: "close_panel" })}
          onAddFormChange={(v) => dispatch({ kind: "friends_add_input_change", value: v })}
          onAddSubmit={handleFriendAddSubmit}
          onClearAddError={() => dispatch({ kind: "friends_add_clear_error" })}
          onAccept={handleFriendAccept}
          onDecline={handleFriendDecline}
          onRemove={handleFriendRemove}
          onTabChange={(tab) => dispatch({ kind: "friends_panel_tab_change", tab })}
          onRefresh={handleFriendsRefresh}
        />
      )}
            {state.openPanel === "invites" && (
        <InvitesPanel
          state={state.myInvites}
          onClose={() => dispatch({ kind: "close_panel" })}
          onCreateFormChange={(field, value) =>
            dispatch({ kind: "invites_create_form_change", field, value })
          }
          onCreateSubmit={onCreateInvite}
          onRevoke={onRevokeInvite}
          onClearRevokeError={() => dispatch({ kind: "invites_revoke_error_cleared" })}
          onRefresh={refreshInvites}
        />
      )}

      {/* 42-8: the cross-channel thread inbox. Row click switches channel and
          opens the thread in ONE action -- set_active_channel clears openThread,
          so two dispatches would only work by ordering luck. ThreadPanel and the
          existing fetch_thread effect do the rest. */}
      {state.openPanel === "threads" && (
        <ThreadInboxPanel
          active={state.threadInboxActive}
          agedUnread={state.threadInboxAgedUnread}
          loaded={state.threadInboxLoaded}
          hasMoreActive={state.threadInboxHasMoreActive}
          unreadTotal={state.threadInboxUnreadTotal}
          windowHours={state.threadInboxWindowHours}
          threadSeen={state.threadSeen}
          mentions={state.threadMentions}
          ownUserID={state.user?.id ?? null}
          channelNames={threadInboxChannelNames}
          handles={threadInboxHandles}
          threadLines={threadInboxLines}
          onOpenThread={(channelID, threadID) => {
            dispatch({ kind: "open_thread_from_inbox", channelID, threadID });
            dispatch({ kind: "close_panel" });
          }}
          onLoadMore={() => {
            const c = clientRef.current;
            if (!c || !c.isOpen()) return;
            const oldest = state.threadInboxActive[state.threadInboxActive.length - 1];
            if (!oldest) return;
            inboxPagingRef.current = true;
            c.send<ThreadInboxPayload>(TypeThreadInbox, {
              before_ts: oldest.lastReplyTS.getTime(),
              limit: 50,
            });
          }}
          onClose={() => dispatch({ kind: "close_panel" })}
        />
      )}
      {state.openPanel === "members" && activeChannel && (
        <MembersPanel
          channelName={displayName(activeChannel, state.user?.id ?? null)}
          members={activeChannel.members ?? []}
          recipients={memberRecipients}
          ownUserID={state.user?.id ?? null}
          weHoldKey={
            state.activeChannelID
              ? keyStatus[state.activeChannelID] === "ready"
              : false
          }
          loading={membersLoading}
          resharing={resharing}
          isCreator={
            activeChannel.createdBy != null &&
            activeChannel.createdBy === (state.user?.id ?? null)
          }
          currentKeyVersion={activeChannel.currentKeyVersion}
          rotationPending={activeChannel.rotationPending}
          rotating={rotating}
          isDM={activeChannel.isDM}
          onRemoveMember={onRemoveMember}
          addableFriends={state.friends.filter(
            (fr) => !activeChannel.memberIDs.includes(fr.userID),
          )}
          onAddMember={onAddMember}
          hueForHandle={nickHueForHandle}
          selfHue={ownNickHue}
          verification={memberVerify}
          verificationLoading={verifyLoading}
          onMarkVerified={onMarkVerified}
          onReshare={onReshareKey}
          onRotate={onRotateKey}
          onRefresh={() => {
            void refreshMemberKeyStatus();
            void refreshVerification();
          }}
          onClose={() => dispatch({ kind: "close_panel" })}
        />
      )}
      {state.openPanel === "governance" && activeChannel && !activeChannel.isDM && (
        <GovernancePanel
          channelName={displayName(activeChannel, state.user?.id ?? null)}
          mode={activeChannel.governanceMode}
          isOwner={
            activeChannel.createdBy != null &&
            activeChannel.createdBy === (state.user?.id ?? null)
          }
          ownUserID={state.user?.id ?? null}
          createdBy={activeChannel.createdBy}
          members={activeChannel.members ?? []}
          addableFriends={state.friends.filter(
            (fr) => !activeChannel.memberIDs.includes(fr.userID),
          )}
          proposals={state.proposals[activeChannel.id] ?? []}
          loading={false}
          onSetMode={onGovSetMode}
          onProposeDictator={onGovProposeDictator}
          onPropose={onGovPropose}
          onVote={onGovVote}
          onCancel={onGovCancel}
          onRefresh={() => {
            void onGovListProposals();
          }}
          onClose={() => dispatch({ kind: "close_panel" })}
        />
      )}
      {state.openPanel === "profile" && state.me && (
        <ProfilePanel
          me={state.me}
          emailChange={state.emailChange}
          onClose={() => dispatch({ kind: "close_panel" })}
          onEmailChangeDraft={(value) =>
            dispatch({ kind: "email_change_draft_change", value })
          }
          onEmailChangeSubmit={onStartEmailChange}
          onEmailChangeDismiss={() => dispatch({ kind: "email_change_dismissed" })}
          onRefresh={refreshProfile}
          onOpenNotificationRules={() => dispatch({ kind: "open_panel", panel: "notifications" })}
          refreshing={state.profileRefreshing}
          serverVersion={state.serverVersion} // 39-1
          serverCommit={state.serverCommit}
          theme={state.prefs.theme ?? "green"}
          onSetTheme={(t) => {
            // Phase 9.7b: send prefs_set; server merges, acks, and
            // fans out to other devices. Local cache updates via
            // prefs_set_ack arriving back (state.prefs.theme then
            // changes, the theme-application effect re-fires).
            const c = clientRef.current;
            if (!c || !c.isOpen()) return;
            c.send(TypePrefsSet, { patch: { theme: t } });
          }}
          chatPrefs={selectChatPrefs(state.prefs)}
          onSetChatPref={(key, value) => {
            // Phase 9.7d: merge a single chat-pref key. The patch is
            // shaped {chat: {[key]: value}}; server's JSONB || does
            // a SHALLOW merge, so we must include the full chat
            // object with the new value (not just the diff) to
            // avoid wiping other chat prefs. Reconstruct from the
            // current resolved prefs.
            const c = clientRef.current;
            if (!c || !c.isOpen()) return;
            const current = selectChatPrefs(state.prefs);
            const next = { ...current, [key]: value };
            c.send(TypePrefsSet, { patch: { chat: next } });
          }}
          onSetUserColors={(rules) => {
            // Phase 9.7e: replace the userColors array. Same JSONB
            // shallow-merge trick: ship the full chat object.
            const c = clientRef.current;
            if (!c || !c.isOpen()) return;
            const current = selectChatPrefs(state.prefs);
            const next = { ...current, userColors: rules };
            c.send(TypePrefsSet, { patch: { chat: next } });
          }}
          onClearImageCache={() => clearAttachmentCache()}
          giphyPref={selectGiphyPref(state.prefs)}
          onSetGiphyPref={sendGiphyPref}
          onRequestEnableGiphy={() => setGiphyConsentOpen(true)}
          onOpenMicSettings={() => setMicSettingsOpen(true)}
        />
      )}

      {micSettingsOpen && <MicSettingsDialog onClose={() => setMicSettingsOpen(false)} />}
    </div>
  );
}

// displayName picks the visible label for a channel. For DMs we render
// "@<other-user-prefix>"; for everything else the channel's name as-is.
export function displayName(ch: ChannelSummary, ownUserID: string | null): string {
  // phase 08c: prefer member handle from server
  if (ch.isDM && ownUserID && ch.members && ch.members.length > 0) {
    const otherMember = ch.members.find((m) => m.userID !== ownUserID);
    if (otherMember && otherMember.handle) {
      return "@" + otherMember.handle;
    }
    if (otherMember) {
      return "@" + otherMember.userID.slice(-8);
    }
  }
  if (ch.isDM && ownUserID) {
    const other = ch.memberIDs.find((id) => id !== ownUserID);
    if (other) {
      return "@" + other.slice(-8);
    }
    return "@you";
  }
  return ch.name;
}
