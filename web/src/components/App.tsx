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

import { useEffect, useReducer, useRef, useState } from "preact/hooks";
import {
  TypeMessage,
  // Phase 11b-2: MLS welcome + commit_bundle
  TypeMlsWelcome,
  TypeMlsWelcomeAck,
  ContentTypeMlsCiphertext,
  type MlsWelcomePayload,
  // Phase 11c-2 PR 3: MLS commit broadcast + catchup
  TypeMlsCommitEvent,
  type MlsCommitEventPayload,
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
import { initialState, selectChatPrefs, type AppState, type Message, type ChannelSummary } from "../state/types";
import { StatusBar } from "./StatusBar";
import { Sidebar } from "./Sidebar";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
// Phase 11c-2 PR 4: member-management modal.
import { ChannelMembersPanel } from "./ChannelMembersPanel";
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
import { CreateChannelModal } from "./CreateChannelModal";
import { AuthGate } from "../auth/AuthGate";
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
    isMls: w.is_mls ?? false,
    createdBy: w.created_by,
    createdAt: new Date(w.created_at),
    memberIDs: w.member_ids ?? [],
    // phase 08c: members carries handles too; SPA prefers it
    members: (w.members ?? []).map((m) => ({
      userID: m.user_id,
      handle: m.handle ?? "",
    })),
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
  };
}

export function App() {
  const [state, dispatch] = useReducer<AppState, Parameters<typeof reducer>[1]>(
    reducer,
    initialState
  );
  const clientRef = useRef<WSClient | null>(null);

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
      // Phase 11c-2 PR 3: convenience wrappers for the PR-2 MLS
      // primitives. Each method auto-supplies the MLS input and
      // SendFn from live refs so DevTools callers only need to
      // pass channel + target. Usage:
      //   await window.__chalk.mlsGroups.addMember("<chid>", "<uid>");
      //   await window.__chalk.mlsGroups.removeMember("<chid>", "<uid>");
      //   await window.__chalk.mlsGroups.catchup("<chid>");
      mlsGroups: {
        async addMember(channelID: string, targetUserID: string) {
          const u = userRef.current;
          const c = clientRef.current;
          if (!u || !c) throw new Error("not connected");
          const { addMemberToGroup } = await import("../mls/groups");
          return addMemberToGroup(channelID, targetUserID, {
            userID: u.id, deviceID: u.device,
            databaseKey: getDeviceMlsKey(u.id, u.device),
          }, { request: (t, p) => c.request(t, p) });
        },
        async removeMember(channelID: string, targetUserID: string) {
          const u = userRef.current;
          const c = clientRef.current;
          if (!u || !c) throw new Error("not connected");
          const { removeMemberFromGroup } = await import("../mls/groups");
          return removeMemberFromGroup(channelID, targetUserID, {
            userID: u.id, deviceID: u.device,
            databaseKey: getDeviceMlsKey(u.id, u.device),
          }, { request: (t, p) => c.request(t, p) });
        },
        async catchup(channelID: string) {
          const u = userRef.current;
          const c = clientRef.current;
          if (!u || !c) throw new Error("not connected");
          const { fetchCommitsCatchup } = await import("../mls/groups");
          return fetchCommitsCatchup(channelID, {
            userID: u.id, deviceID: u.device,
            databaseKey: getDeviceMlsKey(u.id, u.device),
          }, { request: (t, p) => c.request(t, p) });
        },
      },
    };
    client.start();
    return () => client.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.authStage]);

  // Phase 11b-2: decrypt helper for incoming MLS messages.
  // Lives here so it closes over `state.user` for the input shape.
  async function decryptIncomingMls(wire: MessagePayload): Promise<string> {
    const { decryptForGroup, base64ToBytes } = await import("../mls/groups");
    const ciphertext = base64ToBytes(wire.body);
    // Group ID is derived from the channel UUID.
    const groupIDHex = wire.channel_id.replace(/-/g, "");
    const groupID = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      groupID[i] = parseInt(groupIDHex.slice(i * 2, i * 2 + 2), 16);
    }
    // Phase 11b-2 fix5: read user via ref so stale closures don't see null.
    const u = userRef.current;
    if (!u) throw new Error("no user (stale closure?)");
    const plaintext = await decryptForGroup(groupID, ciphertext, {
      userID: u.id,
      deviceID: u.device,
      databaseKey: getDeviceMlsKey(u.id, u.device),
    });
    return new TextDecoder().decode(plaintext);
  }

  // Phase 11b-2 fix6: decrypt a batch of MLS messages from a
  // history/thread fetch. Returns the messages with bodies decrypted
  // in place; non-MLS messages pass through unchanged. Decryption
  // failures yield a "[unable to decrypt]" placeholder.
  async function decryptBatch(wires: MessagePayload[]): Promise<MessagePayload[]> {
    return Promise.all(
      wires.map(async (w) => {
        if (w.content_type !== ContentTypeMlsCiphertext) return w;
        try {
          const decrypted = await decryptIncomingMls(w);
          return { ...w, body: decrypted };
        } catch (err) {
          console.warn("[chalk] history decrypt failed:", err);
          return { ...w, body: "[unable to decrypt]" };
        }
      }),
    );
  }

  // Phase 11a: device-local MLS DB key (32 random bytes) per
  // (userID, deviceID). Stored in localStorage; generated on first
  // use. Same accessor session.ts uses for KP publishing.
  function getDeviceMlsKey(userID: string, deviceID: string): Uint8Array {
    const k = `chalk.mls.dbkey.${userID}.${deviceID}`;
    const existing = localStorage.getItem(k);
    if (existing) {
      const bytes = new Uint8Array(32);
      const s = atob(existing);
      for (let i = 0; i < 32; i++) bytes[i] = s.charCodeAt(i);
      return bytes;
    }
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let str = "";
    for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
    localStorage.setItem(k, btoa(str));
    return bytes;
  }

  function handleFrame(f: Frame) {
    switch (f.type) {
      case TypeFetchThreadAck: {
        // Phase 10c: server returned the replies for a thread.
        // Phase 11b-2 fix6: decrypt MLS rows before assembling.
        const p = f.payload as FetchThreadAckPayload;
        decryptBatch(p.messages ?? []).then((wires) => {
          const msgs = wires.map(wireToMessage);
          msgs.sort((a, b) => a.seq - b.seq);
          dispatch({
            kind: "thread_loaded",
            threadID: p.thread_id,
            messages: msgs,
          });
        });
        break;
      }
      case TypeMessage: {
        const wire = f.payload as MessagePayload;
        // Phase 11b-2: MLS rows arrive with body=base64(ciphertext)
        // and content_type="mls_ciphertext". Decrypt before the
        // reducer ever sees the row. The reducer + UI always see
        // plaintext bodies (or a "[unable to decrypt]" placeholder).
        if (wire.content_type === ContentTypeMlsCiphertext) {
          decryptIncomingMls(wire).then((decrypted) => {
            const m = wireToMessage({ ...wire, body: decrypted });
            dispatch({ kind: "message", message: m });
          }).catch((err) => {
            console.warn("[chalk] decrypt failed:", err);
            const m = wireToMessage({ ...wire, body: "[unable to decrypt]" });
            dispatch({ kind: "message", message: m });
          });
        } else {
          const m = wireToMessage(wire);
          dispatch({ kind: "message", message: m });
        }
        break;
      }
      case TypeMlsWelcome: {
        // Phase 11b-2 (fix3): peer added us to an MLS group. Process
        // the welcome locally, then ack the server. The group ID is
        // derived from channel_id (deterministic), not from the
        // welcome return value (broken getter in 9.3.4).
        const p = f.payload as MlsWelcomePayload;
        (async () => {
          try {
            // Phase 11b-2 fix5: read user via ref so we see the live
            // value, not the closure-captured null.
            const u = userRef.current;
            if (!u) throw new Error("no user (stale closure?)");
            const { processWelcome, base64ToBytes } = await import("../mls/groups");
            const welcomeBytes = base64ToBytes(p.welcome);
            await processWelcome(welcomeBytes, {
              userID: u.id,
              deviceID: u.device,
              databaseKey: getDeviceMlsKey(u.id, u.device),
            });
            console.log("[chalk] MLS welcome processed for channel:", p.channel_id);
            clientRef.current?.send(TypeMlsWelcomeAck, {
              channel_id: p.channel_id, ok: true,
            });
          } catch (err) {
            console.warn("[chalk] MLS welcome processing failed:", err);
            clientRef.current?.send(TypeMlsWelcomeAck, {
              channel_id: p.channel_id, ok: false,
            });
          }
        })();
        break;
      }
      case TypeMlsCommitEvent: {
        // Phase 11c-2 PR 3: an MLS Commit was broadcast to this
        // channel (either live from another member's commit_bundle,
        // or as part of a catchup stream from handleFetchMlsCommits).
        // Feed the bytes to CoreCrypto to advance the local group
        // state. Fire-and-forget; failures are logged.
        const p = f.payload as MlsCommitEventPayload;
        (async () => {
          try {
            const u = userRef.current;
            if (!u) throw new Error("no user (stale closure?)");
            const { processCommitEvent, base64ToBytes } = await import("../mls/groups");
            const commitBytes = base64ToBytes(p.commit);
            const newEpoch = await processCommitEvent(p.channel_id, commitBytes, {
              userID: u.id,
              deviceID: u.device,
              databaseKey: getDeviceMlsKey(u.id, u.device),
            });
            console.log(
              "[chalk] processed MLS commit for channel", p.channel_id,
              "epoch:", p.epoch, "(local now:", newEpoch + ")",
            );
          } catch (err) {
            console.warn("[chalk] MLS commit processing failed:", err);
            // Recovery: a failed commit often means we missed
            // earlier events. Catchup catches us up; if local was
            // already ahead, the fetch returns 0 commits.
            try {
              const u = userRef.current;
              const c = clientRef.current;
              if (u && c) {
                const { fetchCommitsCatchup } = await import("../mls/groups");
                await fetchCommitsCatchup(p.channel_id, {
                  userID: u.id,
                  deviceID: u.device,
                  databaseKey: getDeviceMlsKey(u.id, u.device),
                }, { request: (t, payload) => c.request(t, payload) });
              }
            } catch (catchupErr) {
              console.warn("[chalk] MLS catchup recovery failed:", catchupErr);
            }
          }
        })();
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
        // Phase 11c-2 PR 3: catchup-on-reconnect for MLS channels.
        // The server may have stored commits we missed while
        // disconnected (other members added/removed people, rotated
        // keys, etc). Iterate MLS channels and fire fetch_mls_commits
        // per channel with a 100ms stagger -- the server handles
        // them serially anyway (single-threaded WS reader) but
        // staggering keeps logs tidy. Failures per channel are
        // logged and don't abort the whole catchup pass.
        const u = userRef.current;
        const c = clientRef.current;
        if (u && c) {
          const mlsChannels = channels.filter((ch) => ch.isMls);
          mlsChannels.forEach((ch, i) => {
            setTimeout(() => {
              (async () => {
                try {
                  const { fetchCommitsCatchup } = await import("../mls/groups");
                  const count = await fetchCommitsCatchup(ch.id, {
                    userID: u.id,
                    deviceID: u.device,
                    databaseKey: getDeviceMlsKey(u.id, u.device),
                  }, { request: (t, payload) => c.request(t, payload) });
                  if (count > 0) {
                    console.log(
                      "[chalk] catchup fetched", count,
                      "commit(s) for channel", ch.id,
                    );
                  }
                } catch (err) {
                  console.warn(
                    "[chalk] catchup failed for channel", ch.id, err,
                  );
                }
              })();
            }, i * 100);
          });
        }
        break;
      }
      case TypeFetchHistoryAck: {
        const p = f.payload as FetchHistoryAckPayload;
        // Phase 11b-2 fix6: decrypt MLS rows before mapping to domain
        // shape. The async path means a brief flicker is possible
        // (history arrives, decrypts, then renders) -- acceptable
        // for now; cleaner UX is a 11c polish.
        decryptBatch(p.messages ?? []).then((wires) => {
          dispatch({
            kind: "history_loaded",
            channelID: p.channel_id,
            messages: wires.map(wireToMessage),
          });
        });
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
        // "removed" not emitted in phase 08; future work.
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
  const [membersPanelOpen, setMembersPanelOpen] = useState<boolean>(false);

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

  const onSend = async (body: string, parentID?: string) => {
    const c = clientRef.current;
    if (!c || !c.isOpen()) return;
    const cid = state.activeChannelID;
    if (!cid) return;
    if (!state.user) return;

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
      },
    });

    // Phase 11b-2: encrypt for MLS DMs. Plaintext channels: send
    // body as-is (legacy path). MLS channels: ensure the group
    // exists (bringing it up if first send), encrypt the body, send
    // base64 ciphertext with content_type="mls_ciphertext".
    // Phase 11b-2 fix5: route channel + user lookups through refs.
    const channel = channelsRef.current[cid];
    if (channel?.isMls) {
      (async () => {
        try {
          const u = userRef.current;
          if (!u) throw new Error("no user (stale closure?)");
          const {
            ensureGroupForChannel, encryptForGroup, bytesToBase64,
          } = await import("../mls/groups");
          const input = {
            userID: u.id,
            deviceID: u.device,
            databaseKey: getDeviceMlsKey(u.id, u.device),
          };
          // Phase 11c-2 PR 5: ensureGroupForChannel handles BOTH
          // single-peer DMs (1-entry array) AND multi-member channels.
          // The function is idempotent: if the local group already
          // exists, it's a no-op return. Otherwise it bootstraps the
          // group from the current channel_members on first send.
          const otherMembers = (channel.memberIDs ?? []).filter(
            (id: string) => id !== u.id,
          );
          const groupID = await ensureGroupForChannel(
            cid, otherMembers, input, {
              request: (t, p) => clientRef.current!.request(t, p),
            },
          );
          const plaintext = new TextEncoder().encode(body);
          const ciphertext = await encryptForGroup(groupID, plaintext, input);
          const payload: SendPayload = {
            channel_id: cid,
            body: bytesToBase64(ciphertext),
            content_type: "mls_ciphertext",
          };
          if (parentID) payload.parent_id = parentID;
          c.send(TypeSend, payload);
        } catch (err) {
          console.warn("[chalk] MLS encrypted send failed:", err);
          // Surface to the user via console for now; a banner is
          // a polish pass.
        }
      })();
      return;
    }
    const payload: SendPayload = { channel_id: cid, body };
    if (parentID) payload.parent_id = parentID;
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

  // Phase 11a: background MLS KeyPackage stock check.
  //
  // On first authenticated WS open per session, lazily load
  // CoreCrypto, derive/load a device DB passphrase, and ensure we
  // have ≥10 unused KeyPackages on file with the server. This is a
  // best-effort background task -- if it fails, the chat still works
  // (just no MLS until next attempt).
  //
  // We do NOT lazy-load the MLS module on the critical path. The
  // import is fired only after the user has been authenticated AND
  // the WS connection is open.
  useEffect(() => {
    if (!state.user?.id || !state.user?.device) return;
    if (state.wsState !== "open") return;

    let cancelled = false;
    const userID = state.user.id;
    const deviceID = state.user.device;

    // Derive a 32-byte database key from a per-device localStorage
    // entry. If absent, generate one. The key never leaves the
    // browser (11a). Future phase 11b will encrypt this under a
    // passkey-derived secret instead.
    const dbKeyStorageKey = `chalk.mls.dbkey.${userID}.${deviceID}`;
    let dbKeyHex = window.localStorage.getItem(dbKeyStorageKey);
    if (!dbKeyHex) {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      dbKeyHex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
      window.localStorage.setItem(dbKeyStorageKey, dbKeyHex);
    }
    const dbKey = new Uint8Array(
      dbKeyHex.match(/.{1,2}/g)!.map((h) => parseInt(h, 16)),
    );

    // Schedule on a microtask so the initial render isn't blocked.
    Promise.resolve().then(async () => {
      try {
        const { ensureKeyPackageStock } = await import("../mls/session");
        if (cancelled) return;
        const sendRequest = (type: string, payload: unknown): Promise<unknown> => {
          // Use the existing WS client's request/response correlation.
          const c = clientRef.current;
          if (!c || !c.isOpen()) return Promise.reject(new Error("ws closed"));
          return c.request(type, payload);
        };
        const result = await ensureKeyPackageStock(
          { userID, deviceID, databaseKey: dbKey },
          { request: sendRequest },
        );
        if (!cancelled) {
          console.log("[chalk] MLS KP stock:", result);
        }
      } catch (err) {
        if (!cancelled) {
          console.warn("[chalk] MLS KP stock check failed:", err);
        }
      }
    });

    return () => {
      cancelled = true;
    };
  }, [state.user?.id, state.user?.device, state.wsState]);

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
              {/* Phase 11c-2 PR 5: e2ee tag for MLS channels. */}
              {activeChannel.isMls && (
                <span
                  class="chalk-channel-header-tag"
                  title="end-to-end encrypted via MLS"
                  data-testid="channel-header-e2ee-tag"
                >e2ee</span>
              )}
              {/* Phase 11c-2 PR 4: open the members panel.
                  Hidden for DMs (the 2-member set is fixed). */}
              {!activeChannel.isDM && (
                <button
                  type="button"
                  class="chalk-channel-header-action"
                  onClick={() => setMembersPanelOpen(true)}
                  data-testid="channel-members-open"
                  title="manage channel members"
                >
                  members ({activeChannel.memberIDs.length})
                </button>
              )}
            </div>
            <MessageList
              messages={activeMessages}
              ownDevice={state.user?.device ?? null}
              ownUserID={state.user?.id ?? null}
              members={activeChannel.members ?? []}
              isDM={activeChannel.isDM}
              display={selectChatPrefs(state.prefs)}
              threadSeen={state.threadSeen}
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
              : null
          }
          onSend={onSend}
        />
      </footer>

      {membersPanelOpen && activeChannel && state.user && !activeChannel.isDM && (
        <ChannelMembersPanel
          channel={activeChannel}
          ownUserID={state.user.id}
          friends={state.friends}
          onClose={() => setMembersPanelOpen(false)}
          onAdd={async (targetUserID: string) => {
            // Phase 11c-2 PR 4: invoke the PR-2 primitive, then
            // dispatch the optimistic local update on success.
            // Phase 11c-2 PR 5: bootstrap the local MLS group first
            // (idempotent no-op if it already exists). This is
            // necessary because multi-member channels created via
            // the create-channel modal don't have a local MLS group
            // until first action.
            const u = state.user;
            const c = clientRef.current;
            if (!u || !c || !state.activeChannelID || !activeChannel) {
              throw new Error("not ready");
            }
            const input = {
              userID: u.id,
              deviceID: u.device,
              databaseKey: getDeviceMlsKey(u.id, u.device),
            };
            const sendFn = { request: (t: string, p: unknown) => c.request(t, p) };
            const { ensureGroupForChannel, addMemberToGroup } = await import("../mls/groups");
            const otherMembers = activeChannel.memberIDs.filter(
              (id: string) => id !== u.id,
            );
            await ensureGroupForChannel(state.activeChannelID, otherMembers, input, sendFn);
            await addMemberToGroup(
              state.activeChannelID,
              targetUserID,
              input,
              sendFn,
            );
            const friend = state.friends.find((f) => f.userID === targetUserID);
            dispatch({
              kind: "channel_member_added",
              channelID: state.activeChannelID,
              userID: targetUserID,
              handle: friend?.handle ?? "",
            });
          }}
          onRemove={async (targetUserID: string) => {
            // Phase 11c-2 PR 5: bootstrap the local MLS group first
            // (idempotent). The pre-PR-5 code failed here with "no
            // conversation" for channels created via the modal but
            // never sent to.
            const u = state.user;
            const c = clientRef.current;
            if (!u || !c || !state.activeChannelID || !activeChannel) {
              throw new Error("not ready");
            }
            const input = {
              userID: u.id,
              deviceID: u.device,
              databaseKey: getDeviceMlsKey(u.id, u.device),
            };
            const sendFn = { request: (t: string, p: unknown) => c.request(t, p) };
            const { ensureGroupForChannel, removeMemberFromGroup } = await import("../mls/groups");
            // Bootstrap with the CURRENT members (including the
            // target -- they need to be in the MLS group before
            // they can be removed from it).
            const otherMembers = activeChannel.memberIDs.filter(
              (id: string) => id !== u.id,
            );
            await ensureGroupForChannel(state.activeChannelID, otherMembers, input, sendFn);
            await removeMemberFromGroup(
              state.activeChannelID,
              targetUserID,
              input,
              sendFn,
            );
            dispatch({
              kind: "channel_member_removed",
              channelID: state.activeChannelID,
              userID: targetUserID,
            });
          }}
        />
      )}

      {state.createModalOpen && (
        <CreateChannelModal
          friends={state.friends}
          loading={!state.friendsLoaded}
          onClose={() => dispatch({ kind: "close_create_modal" })}
          onSubmit={onCreateChannel}
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
