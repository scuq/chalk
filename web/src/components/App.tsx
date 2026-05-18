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

import { useEffect, useReducer, useRef } from "preact/hooks";
import {
  TypeMessage,
  TypeSend,
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
  type Frame,
  type WelcomePayload,
  type ErrorPayload,
  type MessagePayload,
  type SendPayload,
  type ChannelSummaryWire,
  type ListChannelsPayload,
  type ListChannelsAckPayload,
  type FetchHistoryPayload,
  type FetchHistoryAckPayload,
  type CreateChannelPayload,
  type CreateChannelAckPayload,
  type ChannelEventPayload,
  type SubscribeChannelPayload,
  type FriendListPayload,
  type FriendListAckPayload,
} from "../proto";
import { WSClient, getOrCreateDeviceId } from "../ws-client";
import { reducer } from "../state/reducer";
import { initialState, type AppState, type Message, type ChannelSummary } from "../state/types";
import { StatusBar } from "./StatusBar";
import { Sidebar } from "./Sidebar";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
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
import { InvitesPanel } from "./InvitesPanel";
import { ProfilePanel } from "./ProfilePanel";

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
    ts: new Date(w.ts),
    body: w.body,
  };
}

export function App() {
  const [state, dispatch] = useReducer<AppState, Parameters<typeof reducer>[1]>(
    reducer,
    initialState
  );
  const clientRef = useRef<WSClient | null>(null);

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
    client.start();
    return () => client.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.authStage]);

  function handleFrame(f: Frame) {
    switch (f.type) {
      case TypeMessage: {
        const m = wireToMessage(f.payload as MessagePayload);
        dispatch({ kind: "message", message: m });
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
        dispatch({
          kind: "channels_loaded",
          channels: (p.channels ?? []).map(wireToChannel),
        });
        break;
      }
      case TypeFetchHistoryAck: {
        const p = f.payload as FetchHistoryAckPayload;
        dispatch({
          kind: "history_loaded",
          channelID: p.channel_id,
          messages: (p.messages ?? []).map(wireToMessage),
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
        // Phase 06 wire shape: four bucketed arrays. We want only
        // accepted friends in the picker -- pending requests should
        // not show up as channel-creation candidates.
        const friends = (p.accepted ?? []).map((fs) => ({
          // phase 08c: thread handle
          userID: fs.user_id,
          handle: fs.handle ?? "",
        }));
        dispatch({ kind: "friends_loaded", friends });
        break;
      }
      default:
        break;
    }
  }

  // --- Side effects driven by state ------------------------------------

  // After connect, fetch the channel list.
  useEffect(() => {
    if (state.wsState !== "open" || !state.user) return;
    const c = clientRef.current;
    if (!c) return;
    c.send<ListChannelsPayload>(TypeListChannels, {});
    // Reset per-connect bookkeeping. After reconnect the server's
    // hello-time loop re-subscribes from scratch, and we should
    // forget what we'd previously asked for at the protocol layer.
    subscribeSentRef.current = new Set();
    historyRequestedRef.current = new Set();
  }, [state.wsState, state.user?.id]);

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

  const onSend = (body: string) => {
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
        ts: new Date(),
        body,
      },
    });

    const payload: SendPayload = { channel_id: cid, body };
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
        dispatch={dispatch}
      />
    );
  }

  const activeChannel = state.activeChannelID
    ? state.channels[state.activeChannelID]
    : null;
  const activeMessages = state.activeChannelID
    ? state.messages[state.activeChannelID] ?? []
    : [];

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
    dispatch({ kind: "auth_logged_out" });
  };

  return (
    <div class="chalk-app chalk-app--phase08b">
      <header class="chalk-header">
        <h1>chalk</h1>
        <StatusBar
          state={state.wsState}
          detail={state.wsDetail}
          user={state.user}
          me={state.me}
          onLogout={handleLogout}
          onOpenInvites={() => dispatch({ kind: "open_panel", panel: "invites" })}
          onOpenProfile={() => dispatch({ kind: "open_panel", panel: "profile" })}
        />
      </header>

      <aside class="chalk-sidebar">
        <Sidebar
          channels={state.channelOrder.map((id) => state.channels[id])}
          activeID={state.activeChannelID}
          ownUserID={state.user?.id ?? null}
          onSelect={(id) => dispatch({ kind: "set_active_channel", channelID: id })}
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
            </div>
            <MessageList
              messages={activeMessages}
              ownDevice={state.user?.device ?? null}
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

      <footer class="chalk-footer">
        <Composer
          disabled={state.wsState !== "open" || !state.activeChannelID}
          onSend={onSend}
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
