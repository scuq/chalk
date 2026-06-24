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

import { useCallback, useEffect, useReducer, useRef, useState } from "preact/hooks";
import {
  TypeMessage,
  TypeMessageDeleted,
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
  type Frame,
  type WelcomePayload,
  type ErrorPayload,
  // Phase 9.7a:
  type PrefsAckPayload,
  type MessagePayload,
  type MessageDeletedPayload,
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
  type FriendListAckPayload,
  // Phase 9.6c:
  type PresencePayload,
  type PresenceSubscribePayload,
  type PresenceUnsubscribePayload,
} from "../proto";
import { WSClient, getOrCreateDeviceId, clearDeviceId, getThreadSeen, setThreadSeen } from "../ws-client";
import { reducer } from "../state/reducer";
import { initialState, selectChatPrefs, type AppState, type Message, type ChannelSummary, type ProposalView } from "../state/types";
import { StatusBar } from "./StatusBar";
import { Sidebar } from "./Sidebar";
import { MessageList } from "./MessageList";
import { ConfirmModal } from "./ConfirmModal";
import { Composer } from "./Composer";
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
import { CreateChannelModal } from "./CreateChannelModal";
import { AuthGate } from "../auth/AuthGate";
import { IdentitySetupScreen } from "../auth/IdentitySetupScreen";
import { loadIdentity, loadVerification, saveVerification } from "../crypto/idb";
import { fetchIdentity, type IdentityTransport } from "../crypto/identity-sync";
import {
  computeSafetyNumber,
  verificationState,
  digestToHex,
} from "../crypto/safety-number";
import type { MemberVerifyInfo } from "./MembersPanel";
import { commitRotation, removeMember, addMember, deleteMessage } from "../crypto/spacekey-sync";
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

  // Phase 22c-3c: identity gate. After the WS welcomes us we know the
  // userID; check whether this device already has the user's encryption
  // identity stored. If not, IdentitySetupScreen runs (generate or enter
  // the decryption phrase) before the chat renders. "ready" = identity
  // present locally; "needs-setup" = render the screen; null = still
  // checking. The check re-runs if the userID changes (e.g. re-login as a
  // different user on this browser).
  const [identityGate, setIdentityGate] =
    useState<"checking" | "ready" | "needs-setup" | null>(null);
  const identityCheckedForRef = useRef<string | null>(null);
  useEffect(() => {
    const uid = state.user?.id;
    if (state.wsState !== "open" || !uid) return;
    if (identityCheckedForRef.current === uid) return;
    identityCheckedForRef.current = uid;
    setIdentityGate("checking");
    let cancelled = false;
    (async () => {
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

  // Phase 23d: when a channel becomes active (and on membership changes),
  // ensure we hold its key -- fetch+unwrap, or creator-bootstrap a keyless
  // channel, then auto-rewrap for members who lack it. Records the status
  // that gates the composer.
  useEffect(() => {
    const cid = state.activeChannelID;
    if (!cid || state.wsState !== "open" || !ccReady || !ccRef.current) return;
    const ch = state.channels[cid];
    if (!ch) return;
    let cancelled = false;
    (async () => {
      try {
        // Phase 25: tell ChannelCrypto the channel's current key version (from
        // the server) before ensuring the key, so new sends encrypt under it.
        ccRef.current!.setCurrentKeyVersion(cid, ch.currentKeyVersion);
        const status = await ccRef.current!.ensureChannelKey(cid, ch.memberIDs, ch.createdBy);
        if (cancelled) return;
        setKeyStatus((s) => ({ ...s, [cid]: status }));
        // Phase 23g backstop: if the key just became ready and we already have
        // history for this channel, some messages may have rendered as the
        // "key not available" placeholder before the key arrived. Re-fetch the
        // history once so those bodies re-decrypt in place (no reload).
        if (status === "ready" && state.historyLoaded[cid]) {
          historyRequestedRef.current.delete(cid);
          const c = clientRef.current;
          if (c && c.isOpen()) {
            c.send<FetchHistoryPayload>(TypeFetchHistory, { channel_id: cid, limit: 50 });
          }
        }
      } catch (err) {
        console.error("ensureChannelKey failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.activeChannelID, state.wsState, state.channels, ccReady]);

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

  // Phase 26 (governance prereq): owner-only message deletion. The hover
  // "delete" control in MessageList stages a message here; the ConfirmModal
  // confirms, then we fire delete_message. The server scrubs the body and
  // pushes message_deleted to every member (including us), and the reducer
  // tombstones the row. We do NOT optimistically tombstone: the round-trip is
  // fast and waiting for the authoritative push keeps all clients in lockstep.
  const [pendingDelete, setPendingDelete] = useState<Message | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const onDeleteMessage = useCallback((m: Message) => {
    setPendingDelete(m);
  }, []);

  const confirmDeleteMessage = useCallback(async () => {
    const m = pendingDelete;
    const cid = state.activeChannelID;
    if (!m || !cid || !clientRef.current) {
      setPendingDelete(null);
      return;
    }
    setDeleteBusy(true);
    try {
      await deleteMessage(
        { request: (t, p) => clientRef.current!.request(t, p) },
        cid,
        m.id,
        m.ts.getTime(),
      );
    } catch (err) {
      console.error("deleteMessage failed:", err);
    } finally {
      setDeleteBusy(false);
      setPendingDelete(null);
    }
  }, [pendingDelete, state.activeChannelID]);


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
        }),
      onFrame: (f: Frame) => handleFrame(f),
    });
    clientRef.current = client;
    // Phase 11b-1 debug: expose the live client on window.__chalk so
    // DevTools can fire WS requests during MLS verification. Pure
    // debug surface; remove (or gate behind a build flag) before we
    // ever ship to a non-dev environment.
    (window as any).__chalk = {
      get client() { return clientRef.current; },
      get userID() { return state.user?.id; },
      get deviceID() { return state.user?.device; },
    };
    client.start();
    return () => client.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.authStage]);



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
      case TypeMessage: {
        const wire = f.payload as MessagePayload;
        const m = wireToMessage(wire);
        // Phase 23f (fail-closed): always decrypt before dispatch; a null-
        // version or undecryptable body becomes a placeholder, never cleartext.
        if (ccRef.current) {
          void ccRef.current
            .decryptForChannel(m.channelID, m.keyVersion, m.body)
            .then((body) => dispatch({ kind: "message", message: { ...m, body } }));
        } else {
          dispatch({
            kind: "message",
            message: { ...m, body: "[encrypted message -- key not available yet]" },
          });
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
        break;
      }
      case TypeListChannelsAck: {
        const p = f.payload as ListChannelsAckPayload;
        const channels = (p.channels ?? []).map(wireToChannel);
        dispatch({
          kind: "channels_loaded",
          channels,
        });
        break;
      }
      case TypeFetchHistoryAck: {
        const p = f.payload as FetchHistoryAckPayload;
        void decryptAll((p.messages ?? []).map(wireToMessage)).then((messages) =>
          dispatch({ kind: "history_loaded", channelID: p.channel_id, messages }),
        );
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
        if (p.kind === "member_added" && p.channel) {
          // Add-member: update the roster from the summary. If WE hold the
          // channel key, reshare it so the newcomer gets the current key
          // (idempotent: skips members who already have a wrap). Any key holder
          // doing this is safe and fixes the offline-inviter case.
          const cid = p.channel.id;
          const before = state.channels[cid];
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
          const before = state.channels[cid];
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
          const ch = state.channels[cid];
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
            const ch = state.channels[cid];
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
        }
        // Phase 11c-7: a member (possibly us) was removed from a
        // channel. If it's us, drop the channel from the sidebar live.
        if (p.kind === "removed" && p.channel) {
          const cid = p.channel.id;
          dispatch({ kind: "channel_removed", channelID: cid });
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

  // Phase 9.6j: compute the intended presence and send presence_update
  // when it transitions. "intended" is:
  //   - WS not open → offline (server handles via WS close; nothing to send)
  //   - mode=online → online
  //   - mode=away   → away
  //   - mode=auto   → tabVisible ? online : away
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
    else intended = tabVisible ? "online" : "away";

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
    tabVisible,
  ]);

  const presenceSubscribedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (state.wsState !== "open") {
      presenceSubscribedRef.current = new Set();
      // Also clear the presence map: an offline-and-back round-trip
      // shouldn't leave stale "online" dots from before the drop.
      dispatch({ kind: "presence_reset" });
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

  const onSend = async (body: string, parentID?: string, pending?: PendingAttachment[]) => {
    const c = clientRef.current;
    if (!c || !c.isOpen()) return;
    const cid = state.activeChannelID;
    if (!cid) return;
    if (!state.user) return;

    // Phase 23d: encrypt for this channel if it holds a key. "waiting" means
    // the channel is encrypted but our key hasn't arrived -- block the send
    // (the composer is also disabled in that state) BEFORE the optimistic
    // append, so nothing is shown that won't actually be sent.
    // Phase 23f (fail-closed): a message is sent ONLY if it can be encrypted.
    // No crypto instance, or no usable channel key, means the send is blocked
    // entirely -- plaintext is never transmitted.
    if (!ccRef.current) return;
    const enc = await ccRef.current.encryptForChannel(cid, body);
    if (enc.kind !== "encrypted") return; // "waiting": blocked until key arrives
    const sendBody = enc.body;
    const sendKeyVersion: number = enc.keyVersion;

    // att-2: upload any pending attachments BEFORE the optimistic append + send
    // frame. Each is encrypted under the channel key, chunk-uploaded over HTTP,
    // then finalized; we carry the ids on the send frame and the refs on the
    // optimistic message (chalkd echo-suppresses our own device, so our own
    // attachments render from these optimistic refs). If any upload blocks on
    // the key or errors, abort the whole send -- nothing half-sent.
    const attachmentIDs: string[] = [];
    const attachmentRefs: AttachmentRef[] = [];
    if (pending && pending.length > 0) {
      const deviceID = getOrCreateDeviceId();
      try {
        for (const p of pending) {
          const res = await uploadAttachment(ccRef.current, cid, deviceID, p.file);
          if (res.kind !== "uploaded") return; // "waiting": key vanished mid-send
          attachmentIDs.push(res.ref.id);
          attachmentRefs.push(res.ref);
        }
      } catch (err) {
        console.error("attachment upload failed; send aborted:", err);
        return;
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
      },
    });

    const payload: SendPayload = { channel_id: cid, body: sendBody, key_version: sendKeyVersion };
    if (parentID) payload.parent_id = parentID;
    if (attachmentIDs.length > 0) payload.attachment_ids = attachmentIDs;
    c.send(TypeSend, payload);
  };

  const onCreateChannel = (name: string, isDM: boolean, memberIDs: string[]) => {
    const c = clientRef.current;
    if (!c || !c.isOpen()) return;
    const payload: CreateChannelPayload = {
      name,
      is_dm: isDM,
      member_ids: memberIDs,
    };
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
    onCreateChannel(dmName, true, [friendUserID]);
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
        recoveryLogin={state.recoveryLogin}
        pendingRegenerateWords={state.pendingRegenerateWords}
        me={state.me}
        inviteContext={state.inviteContext}
        verifyEmailChange={state.verifyEmailChange}
        adminBootstrap={state.adminBootstrap}
        dispatch={dispatch}
      />
    );
  }

  // Phase 22c-3c: once authed and the WS is open, ensure this device has
  // the user's encryption identity before showing the chat. While checking,
  // fall through to the chat (which itself waits on wsState); only when we
  // positively need setup do we render the screen.
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

  // Phase 10d: load threadSeen from localStorage once we know the
  // user id. Keyed per-user so multiple accounts on the same browser
  // don't collide.
  useEffect(() => {
    if (!state.user?.id) return;
    const seen = getThreadSeen(state.user.id);
    dispatch({ kind: "thread_seen_init", seen });
  }, [state.user?.id]);

  // Phase 10d: persist threadSeen to localStorage when it changes.
  useEffect(() => {
    if (!state.user?.id) return;
    setThreadSeen(state.user.id, state.threadSeen);
  }, [state.user?.id, state.threadSeen]);

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



  return (
    <div class={`chalk-app chalk-app--phase08b ${state.openThread ? "chalk-app--thread-open" : ""}`}>
      <header class="chalk-header">
        <h1>chalk</h1>
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
          presenceMode={state.myPresenceMode}
          effectivePresence={state.myEffectivePresence}
          onPresenceModeChange={(mode) =>
            dispatch({ kind: "presence_mode_set", mode })
          }
        />
      </header>

      <aside class="chalk-sidebar">
        <Sidebar
          channels={state.channelOrder.map((id) => state.channels[id])}
          friends={state.friends}
          activeID={state.activeChannelID}
          ownUserID={state.user?.id ?? null}
          presence={state.presence}
          onSelect={(id) => dispatch({ kind: "set_active_channel", channelID: id })}
          onFriendClick={handleFriendClickInRoster}
          onCreateClick={() => dispatch({ kind: "open_create_modal" })}
        />
      </aside>

      <main class="chalk-main">
        {activeChannel ? (
          <>
            <div class="chalk-channel-header" data-testid="channel-header">
              <span class="chalk-channel-header-name">
                {displayName(activeChannel, state.user?.id ?? null)}
              </span>
              {activeChannel.isDM && <span class="chalk-channel-header-tag">dm</span>}
              <ModeBadge
                mode={activeChannel.governanceMode}
                onClick={() => dispatch({ kind: "open_panel", panel: "governance" })}
              />
              <EncryptionIndicator
                status={
                  state.activeChannelID ? keyStatus[state.activeChannelID] : undefined
                }
                onClick={() => dispatch({ kind: "open_panel", panel: "members" })}
              />
            </div>
            <MessageList
              messages={activeMessages}
              ownDevice={state.user?.device ?? null}
              ownUserID={state.user?.id ?? null}
              members={activeChannel.members ?? []}
              isDM={activeChannel.isDM}
              display={selectChatPrefs(state.prefs)}
              threadSeen={state.threadSeen}
              canDeleteMessages={
                !!state.user?.id && activeChannel.createdBy === state.user.id
              }
              onDeleteMessage={onDeleteMessage}
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
        return (
          <ThreadPanel
            parent={parent}
            replies={replies}
            loaded={loaded}
            ownDevice={state.user?.device ?? null}
            ownUserID={state.user?.id ?? null}
            members={activeChannel.members ?? []}
            isDM={activeChannel.isDM}
            display={selectChatPrefs(state.prefs)}
            disabled={state.wsState !== "open"}
            onClose={() => dispatch({ kind: "close_thread" })}
            onSend={(body) => onSend(body, tid)}
          />
        );
      })()}

      <footer class="chalk-footer">
        <Composer
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
          onSend={(body, pending) => onSend(body, undefined, pending)}
          enableAttachments
        />
      </footer>


      {state.createModalOpen && (
        <CreateChannelModal
          friends={state.friends}
          loading={!state.friendsLoaded}
          onClose={() => dispatch({ kind: "close_create_modal" })}
          onSubmit={onCreateChannel}
        />
      )}

      {/* Phase 26 (governance prereq): owner-only delete confirmation. */}
      <ConfirmModal
        open={pendingDelete !== null}
        title="Delete message?"
        body={
          "This removes the message from the server for everyone. Anyone who already read it may still have a local copy."
        }
        confirmLabel="Delete"
        danger
        busy={deleteBusy}
        onConfirm={confirmDeleteMessage}
        onCancel={() => setPendingDelete(null)}
      />

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
      {state.openPanel === "governance" && activeChannel && (
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
          refreshing={state.profileRefreshing}
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
        />
      )}
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
