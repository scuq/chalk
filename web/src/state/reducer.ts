// Pure reducer for the chalk SPA. (state, action) -> state, no
// side effects, no I/O. Side effects (sending WS frames, fetching
// history) live in App.tsx as useEffect hooks driven by state changes.

import type { Action, AppState, Message } from "./types";
// Phase 09d-2b: runtime import for the admin panel's initial state
// (used by the route_to_chat handler to reset the panel cleanly).
import { initialAdminPanelState } from "./types";

export function reducer(state: AppState, action: Action): AppState {
  switch (action.kind) {
    case "ws_state":
      return {
        ...state,
        wsState: action.state,
        wsDetail: action.detail ?? state.wsDetail,
        // Drop user on disconnect; re-populated on the next welcome.
        user: action.state === "open" ? state.user : null,
      };

    case "welcome":
      return {
        ...state,
        user: {
          id: action.userID,
          device: action.deviceID,
          handle: action.handle,
        },
        // welcome.channels is just IDs; the full summaries arrive
        // via a separate list_channels round-trip. We pre-seed
        // channelOrder so the sidebar can show a loading state
        // immediately if needed.
      };

    case "channels_loaded": {
      const channels: Record<string, AppState["channels"][string]> = {};
      const order: string[] = [];
      // Sort by created_at descending (newest first).
      const sorted = [...action.channels].sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
      );
      for (const ch of sorted) {
        channels[ch.id] = ch;
        order.push(ch.id);
      }
      // Auto-select first channel if none active. Fallback to null
      // if there are no channels.
      const active =
        state.activeChannelID && channels[state.activeChannelID]
          ? state.activeChannelID
          : order[0] ?? null;
      return {
        ...state,
        channels,
        channelOrder: order,
        activeChannelID: active,
      };
    }

    case "channel_removed": {
      const cid = action.channelID;
      if (!state.channels[cid]) {
        return state; // not known; idempotent
      }
      // Phase 11c-7: drop the channel from sidebar + state. If it was
      // the active channel, fall back to the next one in order (or null).
      const nextChannels = { ...state.channels };
      delete nextChannels[cid];
      const nextOrder = state.channelOrder.filter((id) => id !== cid);
      const nextMessages = { ...state.messages };
      delete nextMessages[cid];
      const nextActive =
        state.activeChannelID === cid
          ? (nextOrder.length > 0 ? nextOrder[0] : null)
          : state.activeChannelID;
      return {
        ...state,
        channels: nextChannels,
        channelOrder: nextOrder,
        messages: nextMessages,
        activeChannelID: nextActive,
      };
    }
    case "channel_added": {
      const ch = action.channel;
      if (state.channels[ch.id]) {
        return state; // already known; idempotent
      }
      // Phase 9.6b: when a DM-create is in flight and this is the
      // matching DM, auto-activate it (overriding the usual "leave
      // active alone" behavior). memberIDs is a small array for
      // DMs (always 2 entries), so includes() is cheap.
      const pending = state.dmPendingForUserID;
      const isMatchingDM =
        pending !== null &&
        ch.isDM &&
        ch.memberIDs.includes(pending);
      // Pick the next active channel:
      //   - If a DM-create is pending and this is it: activate.
      //   - Else if nothing was active: activate this one.
      //   - Otherwise keep current selection (don't yank the user).
      const nextActive = isMatchingDM
        ? ch.id
        : state.activeChannelID ?? ch.id;
      // Insert at the top of the order (newest).
      return {
        ...state,
        channels: { ...state.channels, [ch.id]: ch },
        channelOrder: [ch.id, ...state.channelOrder],
        activeChannelID: nextActive,
        dmPendingForUserID: isMatchingDM ? null : state.dmPendingForUserID,
      };
    }

    case "channel_member_added": {
      // Phase 11c-2 PR 4: optimistic update after MLS add_to_channel
      // succeeds. Idempotent: re-adding an existing member is a no-op.
      const ch = state.channels[action.channelID];
      if (!ch) return state;
      if (ch.memberIDs.includes(action.userID)) return state;
      const nextCh = {
        ...ch,
        memberIDs: [...ch.memberIDs, action.userID],
        members: [...ch.members, { userID: action.userID, handle: action.handle }],
      };
      return {
        ...state,
        channels: { ...state.channels, [action.channelID]: nextCh },
      };
    }

    case "channel_member_removed": {
      // Phase 11c-2 PR 4: optimistic update after MLS remove_from_channel
      // succeeds. Idempotent: removing a non-member is a no-op. If the
      // caller removed themselves, also drops the channel from the
      // local view -- the user is no longer a member.
      const ch = state.channels[action.channelID];
      if (!ch) return state;
      if (!ch.memberIDs.includes(action.userID)) return state;
      // Self-removal: drop the channel from local state entirely.
      // (Server's channel_members table no longer includes us; the
      // next reconnect would have done this anyway.)
      if (action.userID === state.user?.id) {
        const { [action.channelID]: _dropped, ...remaining } = state.channels;
        return {
          ...state,
          channels: remaining,
          channelOrder: state.channelOrder.filter((id) => id !== action.channelID),
          activeChannelID:
            state.activeChannelID === action.channelID ? null : state.activeChannelID,
        };
      }
      // Removing someone else: just update the channel's members.
      const nextCh = {
        ...ch,
        memberIDs: ch.memberIDs.filter((id) => id !== action.userID),
        members: ch.members.filter((m) => m.userID !== action.userID),
      };
      return {
        ...state,
        channels: { ...state.channels, [action.channelID]: nextCh },
      };
    }

    case "set_active_channel":
      // No-op if same. Switching to a channel triggers fetch_history
      // via a useEffect in App.tsx; reducer stays pure.
      if (action.channelID === state.activeChannelID) {
        return state;
      }
      return { ...state, activeChannelID: action.channelID, openThread: null };

    case "message": {
      const m = action.message;
      const existing = state.messages[m.channelID] ?? [];
      // Insert in seq order. Most incoming live messages append (highest
      // seq), but historical pushes via cross-instance latency could
      // arrive out of order. Defensively sort.
      //
      // Dedup by id in case the message also arrived via fetch_history
      // and as a live push.
      if (existing.some((x) => x.id === m.id)) {
        return state;
      }
      const merged = [...existing, m].sort((a, b) => a.seq - b.seq);
      // ---- channel cache (Phase 10d) ----
      // Bind nextMessages so the live-bump branch below can reference
      // (and rewrite) it without re-deriving the channel list. If
      // there's no parentID, this is the value used in the return.
      const nextMessages = { ...state.messages, [m.channelID]: merged };
      // ---- thread routing (Phase 10c) ----
      // If this message is a reply (parentID set), also append to
      // the thread's reply list. Dedup by id (optimistic-then-real,
      // or push-then-history overlap). Replies for threads we
      // haven't opened yet are still cached -- when the user opens
      // the thread the panel reads from this same record.
      let nextThreadMessages = state.threadMessages;
      if (m.parentID) {
        const tid = m.threadID ?? m.parentID;
        const existingReplies = state.threadMessages[tid] ?? [];
        const without = existingReplies.filter((x) => x.id !== m.id);
        const nextReplies = [...without, m].sort((a, b) => a.seq - b.seq);
        nextThreadMessages = {
          ...state.threadMessages,
          [tid]: nextReplies,
        };
      }

      // ---- live reply-count bump (Phase 10d) ----
      // When a reply arrives, find its parent in the channel cache
      // and bump its replyCount + lastReplySeq so the main feed's
      // "↳ N replies" indicator updates live. The dedup uses the
      // reply's id, so push-then-history won't double-count: if the
      // same reply is dispatched twice (optimistic + server echo, or
      // push + history overlap), this branch runs twice but the
      // earlier branch above is idempotent on the threadMessages
      // map, and we recompute replyCount/lastReplySeq from that.
      let liveBumpMessages = nextMessages;
      if (m.parentID) {
        const parentChannel = m.channelID;
        const parentID = m.parentID;
        const channelList = nextMessages[parentChannel];
        if (channelList) {
          const tid = m.threadID ?? m.parentID;
          const updatedReplies = nextThreadMessages[tid] ?? [];
          const newReplyCount = updatedReplies.length;
          const newLastSeq = updatedReplies.reduce(
            (max, r) => (r.seq > max ? r.seq : max),
            0,
          );
          // Phase 10e: also update the preview fields so the snippet
          // beneath the indicator appears immediately for the new
          // reply. We could use the OLD max-seq reply (if there is
          // one) when the new arrival isn't actually the newest --
          // but our merging ensures replies arrive in seq order in
          // practice, and the optimistic-then-server replacement
          // (same id, server overwrites) keeps things consistent.
          //
          // We pick the reply with the highest seq in the
          // (post-merge) thread message list to be safe.
          const tailReply = updatedReplies.length > 0
            ? updatedReplies[updatedReplies.length - 1]
            : m;
          liveBumpMessages = {
            ...nextMessages,
            [parentChannel]: channelList.map((x) =>
              x.id === parentID
                ? {
                    ...x,
                    replyCount: newReplyCount,
                    lastReplySeq: newLastSeq,
                    lastReplySenderUserID: tailReply.senderUserID || undefined,
                    lastReplyBody: tailReply.body || undefined,
                  }
                : x,
            ),
          };
        }
      }

      return {
        ...state,
        messages: liveBumpMessages,
        threadMessages: nextThreadMessages,
      };
    }

    case "history_loaded": {
      // history_loaded carries messages in descending seq order from
      // the server. Merge with any existing (live-pushed) messages,
      // dedup by id, sort ascending.
      const existing = state.messages[action.channelID] ?? [];
      const byID = new Map<string, Message>();
      for (const m of existing) byID.set(m.id, m);
      for (const m of action.messages) byID.set(m.id, m);
      const merged = Array.from(byID.values()).sort((a, b) => a.seq - b.seq);
      return {
        ...state,
        messages: { ...state.messages, [action.channelID]: merged },
        historyLoaded: { ...state.historyLoaded, [action.channelID]: true },
      };
    }

    case "friends_loaded":
      return {
        ...state,
        friends: action.friends,
        friendsLoaded: true,
        // Phase 9.6a: if the server sent pending buckets, store them.
        pendingIncoming: action.pendingIncoming ?? state.pendingIncoming,
        pendingOutgoing: action.pendingOutgoing ?? state.pendingOutgoing,
      };

    case "open_create_modal":
      return { ...state, createModalOpen: true };

    case "close_create_modal":
      return { ...state, createModalOpen: false };

    // ---- Phase 09c-2: in-chat panel toggles ---------------------------

    case "open_panel":
      // Opening a panel: clear any stale form state from the OTHER
      // panel category so re-opens are predictable. Specifically:
      // opening "invites" clears any in-flight revoke error; opening
      // "profile" leaves email-change pendingSummary alone (we want
      // the user to see "your verification is pending" on revisits
      // until either dismissed or completed).
      //
      // Phase 9.6a hotfix: previously this case had an implicit
      // "anything-not-invites is profile" fallback, which mis-routed
      // the new "friends" panel into the profile slot. Now we
      // dispatch on action.panel explicitly so each value lands
      // where it belongs.
      if (action.panel === "invites") {
        return {
          ...state,
          openPanel: "invites",
          myInvites: {
            ...state.myInvites,
            revokeError: null,
          },
        };
      }
      if (action.panel === "friends") {
        return {
          ...state,
          openPanel: "friends",
          // Clear any stale add-flow error so a re-open starts clean.
          friendsPanel: {
            ...state.friendsPanel,
            addError: null,
          },
        };
      }
      if (action.panel === "members") {
        // Phase 23e: channel-members + key-status panel. No reducer-owned
        // form state; App fetches the recipient set via ChannelCrypto.
        return { ...state, openPanel: "members" };
      }
      // Default: profile. Same behavior as before the hotfix for the
      // profile case specifically.
      return { ...state, openPanel: "profile" };

    case "close_panel":
      // Closing the panel: clear transient form state but preserve
      // the loaded items list (faster re-open). Specifically:
      //   - invites: clear create-form errors + revoke errors, but
      //     keep items[] and createForm draft text (user may
      //     re-open to finish typing).
      //   - profile: clear pendingSummary so re-open doesn't show
      //     stale "we sent X" copy from days ago.
      return {
        ...state,
        openPanel: null,
        profileRefreshing: false,
        myInvites: {
          ...state.myInvites,
          createForm: {
            ...state.myInvites.createForm,
            errorCode: null,
            errorMessage: null,
          },
          revokeError: null,
        },
        emailChange: {
          ...state.emailChange,
          errorCode: null,
          errorMessage: null,
          // Note: pendingSummary cleared on close so a future open
          // starts fresh; the actual change still happens via the
          // verify link.
          pendingSummary: null,
        },
      };

    case "profile_refresh_start":
      return { ...state, profileRefreshing: true };

    case "profile_refresh_done":
      return { ...state, profileRefreshing: false };

    // ---- Phase 09b sub-step 4/5b: auth-flow actions -------------------

    case "auth_config_loaded":
      // Config arrived. Only flip stage if we're still bootstrapping
      // AND we don't already have a /me result that says we're authed.
      // (Sub-step 5b: bootstrap goes through /me first; config is
      // fetched lazily by RegisterScreen, so by the time it lands we
      // may already be on "registering" or "login".)
      return {
        ...state,
        authConfig: action.config,
      };

    case "auth_config_failed":
      // Couldn't reach /api/auth/config. Surface the message via the
      // registration form's error slot so something visible happens.
      return {
        ...state,
        registration: {
          ...state.registration,
          errorCode: "config_failed",
          errorMessage: `cannot reach server: ${action.message}`,
        },
      };

    case "auth_form_change":
      return {
        ...state,
        registration: {
          ...state.registration,
          [action.field]: action.value,
          // Typing clears any previous error on the touched field's
          // category. Simpler: any input clears the error banner.
          errorCode: null,
          errorMessage: null,
        },
      };

    case "auth_form_submit_start":
      return {
        ...state,
        registration: {
          ...state.registration,
          busy: true,
          errorCode: null,
          errorMessage: null,
        },
      };

    case "auth_form_submit_error":
      return {
        ...state,
        registration: {
          ...state.registration,
          busy: false,
          errorCode: action.code,
          errorMessage: action.message,
        },
      };

    case "auth_registered":
      // Registration succeeded. Hold the result (incl. recovery words)
      // so RecoveryScreen can render. Clear the form so a back-button
      // accident doesn't leak it.
      //
      // Sub-step 5b: register/finish now Set-Cookies, so we ARE logged
      // in at this point. The recovery screen is just a notice; on
      // confirm we go straight to authed (no transitional-handoff).
      //
      // Phase 09d-2a: also clear adminBootstrap here because the
      // admin-bootstrap flow funnels success into this same action.
      // Stale token in state would be harmless but messy.
      return {
        ...state,
        authStage: "confirming-recovery",
        registrationResult: action.result,
        registration: {
          ...state.registration,
          busy: false,
          errorCode: null,
          errorMessage: null,
        },
        adminBootstrap: null,
      };

    case "auth_recovery_confirmed":
      // User has confirmed they saved the recovery code. Recovery
      // words are cleared NOW (they MUST NOT linger in state any
      // longer). Stage flips straight to authed; the cookie was set
      // back on register/finish, so the WS will connect successfully.
      return {
        ...state,
        authStage: "authed",
        registrationResult: null,
      };

    // ---- Phase 09b sub-step 5b: login + session ----------------------

    case "auth_login_form_change":
      return {
        ...state,
        login: {
          ...state.login,
          [action.field]: action.value,
          errorCode: null,
          errorMessage: null,
        },
      };

    case "auth_login_submit_start":
      return {
        ...state,
        login: {
          ...state.login,
          busy: true,
          errorCode: null,
          errorMessage: null,
        },
      };

    case "auth_login_submit_error":
      return {
        ...state,
        login: {
          ...state.login,
          busy: false,
          errorCode: action.code,
          errorMessage: action.message,
        },
      };

    case "auth_logged_in":
      // Authentication ceremony completed. Server has set the cookie;
      // we hold the identity in `me` for display. Flip stage to authed
      // so the chat UI renders and the WS connects with our cookie.
      return {
        ...state,
        authStage: "authed",
        login: {
          ...state.login,
          busy: false,
          errorCode: null,
          errorMessage: null,
        },
        me: {
          userID: action.result.userID,
          username: action.result.username,
          displayName: action.result.displayName,
          role: action.result.role,
          // /authenticate/finish doesn't return email; left empty.
          // Bootstrap /me call (next refresh) will fill it.
          email: "",
          emailVerifiedAt: "",
          sessionExpiresAt: action.result.sessionExpiresAt,
        },
      };

    case "auth_me_loaded":
      // Bootstrap /me returned a valid session. Go directly to authed;
      // skip login + registration entirely. The WS will use the
      // existing cookie.
      return {
        ...state,
        authStage: "authed",
        me: action.me,
      };

    case "auth_me_absent":
      // Bootstrap /me returned 401 (no session). Show LoginScreen by
      // default; the screen has a link to RegisterScreen for users
      // without an account.
      return {
        ...state,
        authStage: "login",
        me: null,
      };

    case "auth_logged_out":
      // User initiated logout (or server invalidated the session).
      // Clear me + every form + recovery state and return to
      // LoginScreen.
      return {
        ...state,
        authStage: "login",
        me: null,
        login: {
          username: "",
          busy: false,
          errorCode: null,
          errorMessage: null,
        },
        registration: {
          username: "",
          displayName: "",
          email: "",
          inviteToken: "",
          showAdvanced: false,
          busy: false,
          errorCode: null,
          errorMessage: null,
        },
        registrationResult: null,
        recoveryLogin: {
          username: "",
          phrase: "",
          busy: false,
          errorCode: null,
          errorMessage: null,
        },
        pendingRegenerateWords: null,
        // Phase 09c-2: clear URL-driven and panel-driven state so a
        // subsequent re-login from the same tab starts clean.
        inviteContext: null,
        verifyEmailChange: null,
        myInvites: {
          items: null,
          loading: false,
          loadError: null,
          createForm: {
            email: "",
            note: "",
            busy: false,
            errorCode: null,
            errorMessage: null,
          },
          revokingToken: null,
          revokeError: null,
        },
        emailChange: {
          draft: "",
          busy: false,
          errorCode: null,
          errorMessage: null,
          pendingSummary: null,
        },
        openPanel: null,
        profileRefreshing: false,
      };

    case "auth_go_register":
      // User clicked "no account? register" on LoginScreen.
      return {
        ...state,
        authStage: "registering",
        login: {
          ...state.login,
          errorCode: null,
          errorMessage: null,
        },
      };

    case "auth_go_login":
      // User clicked "have an account? log in" on RegisterScreen.
      return {
        ...state,
        authStage: "login",
        registration: {
          ...state.registration,
          errorCode: null,
          errorMessage: null,
        },
      };

    // ---- Phase 09b sub-step 6: recovery login + regenerate ----------

    case "auth_go_recovery":
      // User clicked "lost your passkey? recover" on LoginScreen.
      return {
        ...state,
        authStage: "recovery-login",
        // Pre-fill the username so the user doesn't retype.
        recoveryLogin: {
          ...state.recoveryLogin,
          username: state.login.username,
          phrase: "",
          errorCode: null,
          errorMessage: null,
        },
      };

    case "auth_recovery_login_form_change":
      return {
        ...state,
        recoveryLogin: {
          ...state.recoveryLogin,
          [action.field]: action.value,
          errorCode: null,
          errorMessage: null,
        },
      };

    case "auth_recovery_login_submit_start":
      return {
        ...state,
        recoveryLogin: {
          ...state.recoveryLogin,
          busy: true,
          errorCode: null,
          errorMessage: null,
        },
      };

    case "auth_recovery_login_submit_error":
      return {
        ...state,
        recoveryLogin: {
          ...state.recoveryLogin,
          busy: false,
          errorCode: action.code,
          errorMessage: action.message,
        },
      };

    case "auth_recovered":
      // Recovery validated. Server has set the cookie, marked the old
      // recovery code as consumed, and returned regenerate_required.
      // Move to the regenerate stage; RegenerateScreen will auto-call
      // /recovery/regenerate on mount.
      //
      // We populate `me` here (similar to auth_logged_in) so the
      // identity is available for StatusBar copy if the user gets
      // stuck on RegenerateScreen and somehow sees the chat shell.
      // (They shouldn't — authStage gates that.)
      return {
        ...state,
        authStage: "regenerate-after-recovery",
        recoveryLogin: {
          ...state.recoveryLogin,
          busy: false,
          phrase: "", // clear the words from memory ASAP
          errorCode: null,
          errorMessage: null,
        },
        me: {
          userID: action.result.userID,
          username: action.result.username,
          displayName: action.result.displayName,
          role: action.result.role,
          email: "",
          emailVerifiedAt: "",
          sessionExpiresAt: action.result.sessionExpiresAt,
        },
      };

    case "auth_regenerate_words_loaded":
      // /recovery/regenerate returned. Hold the new words for display
      // on the RecoveryScreen (intent=regenerated). They live in state
      // ONLY until auth_regenerate_confirmed, when they're cleared.
      return {
        ...state,
        pendingRegenerateWords: action.words,
      };

    case "auth_regenerate_confirmed":
      // User acknowledged the new recovery words. Clear them from
      // state and flip to authed. The cookie was set back on
      // /recovery so the WS will connect successfully.
      return {
        ...state,
        authStage: "authed",
        pendingRegenerateWords: null,
      };

    // ---- Phase 09c-2: URL-driven flows ------------------------------

    case "auth_invite_detected":
      // AuthGate parsed ?invite=<token> from the URL at boot. Flip
      // to the new stage; RegisterFromInviteScreen will trigger the
      // peek and render accordingly.
      return {
        ...state,
        authStage: "registering-from-invite",
        inviteContext: {
          token: action.token,
          peekStatus: "loading",
          peek: null,
          errorMessage: "",
        },
        // Pre-fill the registration form's invite token so a submit
        // carries it. Email will be pre-filled from the peek response
        // when it lands.
        registration: {
          ...state.registration,
          inviteToken: action.token,
          errorCode: null,
          errorMessage: null,
        },
      };

    case "auth_invite_peek_loaded": {
      // Peek returned. Status from the server: active = usable;
      // used/revoked/expired = display-only with "this invite has
      // been X" copy and a "register normally / log in" escape.
      // Pre-fill the registration form's email from the peek.
      const prev = state.inviteContext;
      if (!prev) return state;
      return {
        ...state,
        inviteContext: {
          ...prev,
          peekStatus: action.status,
          peek: action.peek,
          errorMessage: "",
        },
        registration: {
          ...state.registration,
          email: action.status === "active" ? action.peek.email : state.registration.email,
          errorCode: null,
          errorMessage: null,
        },
      };
    }

    case "auth_invite_peek_failed": {
      // Peek failed: malformed token (400), unknown token (404),
      // server error (500), or network failure. Show an error
      // screen with the "register normally" escape.
      const prev = state.inviteContext;
      if (!prev) return state;
      return {
        ...state,
        inviteContext: {
          ...prev,
          peekStatus: "error",
          peek: null,
          errorMessage: action.message,
        },
      };
    }

    case "auth_invite_dismissed":
      // User clicked the escape link. Clear inviteContext and the
      // pre-filled invite token; flip to login so they can decide
      // what to do next (register normally, log in, recover).
      return {
        ...state,
        authStage: "login",
        inviteContext: null,
        registration: {
          ...state.registration,
          inviteToken: "",
          email: "",
          errorCode: null,
          errorMessage: null,
        },
      };

    case "auth_verify_email_detected":
      // AuthGate parsed ?verify_email=<token> from the URL at boot.
      // Flip to the verifying stage; VerifyEmailChangeScreen will
      // fire the verify call on mount.
      return {
        ...state,
        authStage: "verifying-email-change",
        verifyEmailChange: {
          token: action.token,
          phase: "loading",
          newEmail: "",
          errorCode: "",
          errorMessage: "",
        },
      };

    case "auth_verify_email_succeeded":
      // The verify call returned 200; users.email was updated server-
      // side. Flip phase so the screen can render the success copy.
      // If the user is currently authed in this tab, also mutate
      // state.me.email so any panel that re-renders sees the new
      // value without a /me refresh.
      return {
        ...state,
        verifyEmailChange: state.verifyEmailChange
          ? {
              ...state.verifyEmailChange,
              phase: "success",
              newEmail: action.newEmail,
              errorCode: "",
              errorMessage: "",
            }
          : null,
        me: state.me
          ? { ...state.me, email: action.newEmail }
          : state.me,
      };

    case "auth_verify_email_failed":
      return {
        ...state,
        verifyEmailChange: state.verifyEmailChange
          ? {
              ...state.verifyEmailChange,
              phase: "failure",
              errorCode: action.code,
              errorMessage: action.message,
            }
          : null,
      };

    case "auth_verify_email_dismissed":
      // User clicked through the success/failure card. Clear the
      // verify state and decide where to send them: if they were
      // already authed (me is set), close the modal-equivalent by
      // returning to authed; otherwise to login.
      return {
        ...state,
        authStage: state.me ? "authed" : "login",
        verifyEmailChange: null,
      };

    // ---- Phase 09d-2a: admin bootstrap (URL-driven) -----------------

    case "auth_admin_bootstrap_detected":
      // AuthGate parsed ?admin_bootstrap=<token> from the URL at
      // boot. Flip to the new stage; AdminBootstrapScreen waits for
      // the operator to click "Register admin passkey" before the
      // ceremony runs. Mutually exclusive with the other URL-driven
      // flows: AuthGate checks admin_bootstrap AFTER invite and
      // verify_email, so a URL with both is treated as belonging to
      // whichever AuthGate saw first.
      return {
        ...state,
        authStage: "admin-bootstrap",
        adminBootstrap: {
          token: action.token,
          busy: false,
          errorCode: null,
          errorMessage: null,
        },
      };

    case "auth_admin_bootstrap_submit_start":
      if (!state.adminBootstrap) return state;
      return {
        ...state,
        adminBootstrap: {
          ...state.adminBootstrap,
          busy: true,
          errorCode: null,
          errorMessage: null,
        },
      };

    case "auth_admin_bootstrap_submit_error":
      if (!state.adminBootstrap) return state;
      return {
        ...state,
        adminBootstrap: {
          ...state.adminBootstrap,
          busy: false,
          errorCode: action.code,
          errorMessage: action.message,
        },
      };

    case "auth_admin_bootstrap_dismissed":
      // User clicked the "Go to login" escape after a terminal
      // error (admin_already_enrolled, no_admin_row). Clear the
      // bootstrap state and route to the normal login screen.
      return {
        ...state,
        authStage: "login",
        adminBootstrap: null,
      };

    // ---- Phase 09c-2: InvitesPanel data -----------------------------

    case "invites_load_start":
      return {
        ...state,
        myInvites: {
          ...state.myInvites,
          loading: true,
          loadError: null,
        },
      };

    case "invites_load_succeeded":
      return {
        ...state,
        myInvites: {
          ...state.myInvites,
          items: action.items,
          loading: false,
          loadError: null,
        },
      };

    case "invites_load_failed":
      return {
        ...state,
        myInvites: {
          ...state.myInvites,
          loading: false,
          loadError: action.message,
        },
      };

    case "invites_create_form_change":
      return {
        ...state,
        myInvites: {
          ...state.myInvites,
          createForm: {
            ...state.myInvites.createForm,
            [action.field]: action.value,
            errorCode: null,
            errorMessage: null,
          },
        },
      };

    case "invites_create_submit_start":
      return {
        ...state,
        myInvites: {
          ...state.myInvites,
          createForm: {
            ...state.myInvites.createForm,
            busy: true,
            errorCode: null,
            errorMessage: null,
          },
        },
      };

    case "invites_create_submit_error":
      return {
        ...state,
        myInvites: {
          ...state.myInvites,
          createForm: {
            ...state.myInvites.createForm,
            busy: false,
            errorCode: action.code,
            errorMessage: action.message,
          },
        },
      };

    case "invites_create_submit_succeeded":
      // Prepend the new invite to the items list so it appears at
      // the top of the panel. Clear the form for the next create.
      return {
        ...state,
        myInvites: {
          ...state.myInvites,
          items: [action.invite, ...(state.myInvites.items ?? [])],
          createForm: {
            email: "",
            note: "",
            busy: false,
            errorCode: null,
            errorMessage: null,
          },
        },
      };

    case "invites_revoke_start":
      return {
        ...state,
        myInvites: {
          ...state.myInvites,
          revokingToken: action.token,
          revokeError: null,
        },
      };

    case "invites_revoke_succeeded":
      // Server returned 204. Update the local row's status to
      // "revoked" rather than removing it -- users find it
      // disorienting when revoking makes the row vanish, and the
      // server actually keeps the row for audit anyway.
      return {
        ...state,
        myInvites: {
          ...state.myInvites,
          items: (state.myInvites.items ?? []).map((inv) =>
            inv.token === action.token
              ? { ...inv, status: "revoked", revoked_at: new Date().toISOString(), url: undefined }
              : inv
          ),
          revokingToken: null,
          revokeError: null,
        },
      };

    case "invites_revoke_failed":
      return {
        ...state,
        myInvites: {
          ...state.myInvites,
          revokingToken: null,
          revokeError: {
            token: action.token,
            code: action.code,
            message: action.message,
          },
        },
      };

    case "invites_revoke_error_cleared":
      return {
        ...state,
        myInvites: {
          ...state.myInvites,
          revokeError: null,
        },
      };

    // ---- Phase 09c-2: ProfilePanel email-change ---------------------

    case "email_change_draft_change":
      return {
        ...state,
        emailChange: {
          ...state.emailChange,
          draft: action.value,
          errorCode: null,
          errorMessage: null,
        },
      };

    case "email_change_submit_start":
      return {
        ...state,
        emailChange: {
          ...state.emailChange,
          busy: true,
          errorCode: null,
          errorMessage: null,
        },
      };

    case "email_change_submit_error":
      return {
        ...state,
        emailChange: {
          ...state.emailChange,
          busy: false,
          errorCode: action.code,
          errorMessage: action.message,
        },
      };

    case "email_change_submit_succeeded":
      return {
        ...state,
        emailChange: {
          ...state.emailChange,
          busy: false,
          draft: "",
          errorCode: null,
          errorMessage: null,
          pendingSummary: {
            newEmail: action.newEmail,
            expiresAt: action.expiresAt,
          },
        },
      };

    case "email_change_dismissed":
      // User clicked "ok" on the pending-change summary; clear it
      // so the form re-renders ready for another draft.
      return {
        ...state,
        emailChange: {
          ...state.emailChange,
          pendingSummary: null,
        },
      };

    case "auth_me_email_updated":
      // Used by VerifyEmailChangeScreen (and the in-panel verify
      // path if we ever add one) to keep `me` in sync locally.
      return {
        ...state,
        me: state.me ? { ...state.me, email: action.newEmail } : state.me,
      };

    // ---- Phase 9.6a: friends panel cases --------------------------------

    case "friends_panel_tab_change":
      return {
        ...state,
        friendsPanel: { ...state.friendsPanel, activeTab: action.tab },
      };

    case "friends_add_input_change":
      return {
        ...state,
        friendsPanel: { ...state.friendsPanel, addInput: action.value },
      };

    case "friends_add_clear_error":
      return {
        ...state,
        friendsPanel: { ...state.friendsPanel, addError: null },
      };

    case "friends_add_start":
      return {
        ...state,
        friendsPanel: { ...state.friendsPanel, addBusy: true, addError: null },
      };

    case "friends_add_failed":
      return {
        ...state,
        friendsPanel: {
          ...state.friendsPanel,
          addBusy: false,
          addError: action.error,
        },
      };

    case "friends_add_succeeded":
      return {
        ...state,
        friendsPanel: {
          ...state.friendsPanel,
          addBusy: false,
          addInput: "",
          addError: null,
          // After a successful add, jump the user to the "pending"
          // tab where the new outgoing request will appear once the
          // friend_list re-fetch lands.
          activeTab: "pending",
        },
      };

    case "friends_action_start":
      return {
        ...state,
        friendsPanel: {
          ...state.friendsPanel,
          pendingActionUserID: action.userID,
        },
      };

    case "friends_action_done":
      return {
        ...state,
        friendsPanel: {
          ...state.friendsPanel,
          pendingActionUserID:
            state.friendsPanel.pendingActionUserID === action.userID
              ? null
              : state.friendsPanel.pendingActionUserID,
        },
      };

    // ---- Phase 9.6b: roster-driven DM creation --------------------------

    case "dm_pending_set":
      return { ...state, dmPendingForUserID: action.userID };

    case "dm_pending_clear":
      return { ...state, dmPendingForUserID: null };

    // ---- Phase 9.6c: presence ---------------------------------------

    case "presence_set":
      return {
        ...state,
        presence: { ...state.presence, [action.userID]: action.state },
      };

    case "presence_clear": {
      // Drop this user_id from the presence map. Used when an
      // ex-friend should no longer have presence tracked.
      if (!(action.userID in state.presence)) return state;
      const next: typeof state.presence = { ...state.presence };
      delete next[action.userID];
      return { ...state, presence: next };
    }

    case "presence_reset":
      // Used on WS disconnect / re-connect: clear all known presence
      // so the next subscribe round-trip rebuilds the map cleanly.
      return { ...state, presence: {} };

    // ---- Phase 9.6j: manual presence override ---------------------------

    case "presence_mode_set":
      return { ...state, myPresenceMode: action.mode };

    case "my_effective_presence_set":
      return { ...state, myEffectivePresence: action.state };

    // ---- Phase 9.7a: preferences --------------------------------------

    case "prefs_loaded":
      // Initial load after prefs_get_ack. Marks prefsLoaded true so
      // effects that wait for prefs (like theme application) can fire.
      return {
        ...state,
        prefs: action.prefs,
        prefsLoaded: true,
      };

    case "prefs_merged":
      // Either prefs_set_ack (echo of our own write) or prefs_changed
      // (push from another device of the same user). Server has
      // already merged; we just replace our cached copy.
      return {
        ...state,
        prefs: action.prefs,
        prefsLoaded: true,
      };

    // ---- Phase 10b: threading -----------------------------------------

    case "open_thread": {
      // No-op if it's already open.
      if (
        state.openThread &&
        state.openThread.channelID === action.channelID &&
        state.openThread.threadID === action.threadID
      ) {
        return state;
      }
      // Phase 10d: bump threadSeen for this thread to the current
      // max reply seq we know about. Sources: threadMessages
      // (replies arrived via push or fetch) + the parent's
      // lastReplySeq from the main feed (covers replies we
      // haven't fetched yet).
      const repliesNow = state.threadMessages[action.threadID] ?? [];
      const localMax = repliesNow.reduce(
        (max, r) => (r.seq > max ? r.seq : max),
        0,
      );
      const channelList = state.messages[action.channelID] ?? [];
      const parent = channelList.find((x) => x.id === action.threadID);
      const remoteMax = parent?.lastReplySeq ?? 0;
      const seenMax = Math.max(localMax, remoteMax);
      return {
        ...state,
        openThread: {
          channelID: action.channelID,
          threadID: action.threadID,
        },
        threadSeen:
          seenMax > (state.threadSeen[action.threadID] ?? 0)
            ? { ...state.threadSeen, [action.threadID]: seenMax }
            : state.threadSeen,
      };
    }

    case "close_thread":
      if (state.openThread === null) return state;
      return { ...state, openThread: null };

    case "thread_seen_bump":
      return {
        ...state,
        threadSeen: { ...state.threadSeen, [action.threadID]: action.seq },
      };

    case "thread_seen_init":
      return { ...state, threadSeen: action.seen };

    case "thread_loaded": {
      // Phase 10c: server returned a thread's replies. Merge with
      // anything we already have (in case a push arrived before the
      // fetch_thread_ack came back) and sort by seq.
      const existing = state.threadMessages[action.threadID] ?? [];
      const existingByID = new Map(existing.map((m) => [m.id, m]));
      for (const m of action.messages) {
        existingByID.set(m.id, m); // server version overwrites local
      }
      const merged = Array.from(existingByID.values()).sort(
        (a, b) => a.seq - b.seq,
      );
      return {
        ...state,
        threadMessages: { ...state.threadMessages, [action.threadID]: merged },
        threadLoaded: { ...state.threadLoaded, [action.threadID]: true },
      };
    }

    // ---- Phase 09d-2b: admin panel routing -------------------------

    case "route_to_admin":
      return { ...state, route: "admin" };

    case "route_to_chat":
      // Reset most of the admin panel on exit so a fresh open
      // starts clean (empty search, page 1, no errors). EXCEPT
      // for the blacklist add form (Phase 9.5 C3): an admin
      // who's typed an email + reason and then accidentally
      // clicked 'back to chat' would lose that work. Preserve
      // the form so it's still there next time they open the
      // panel.
      return {
        ...state,
        route: "chat",
        adminPanel: {
          ...initialAdminPanelState,
          blacklist: {
            ...initialAdminPanelState.blacklist,
            addForm: state.adminPanel.blacklist.addForm,
          },
        },
      };

    // ---- Phase 09d-2b: admin users tab ----------------------------

    case "admin_tab_change":
      return {
        ...state,
        adminPanel: { ...state.adminPanel, activeTab: action.tab },
      };

    case "admin_users_search_change":
      // q changed → reset offset to 0 (new search starts at page 1)
      // AND set searchPending so the data-loading effect knows to
      // debounce.
      return {
        ...state,
        adminPanel: {
          ...state.adminPanel,
          users: {
            ...state.adminPanel.users,
            q: action.q,
            offset: 0,
            searchPending: true,
          },
        },
      };

    case "admin_users_page_change":
      return {
        ...state,
        adminPanel: {
          ...state.adminPanel,
          users: {
            ...state.adminPanel.users,
            offset: action.offset,
            // page change is not a search change; don't debounce.
            searchPending: false,
          },
        },
      };

    case "admin_users_refresh":
      return {
        ...state,
        adminPanel: {
          ...state.adminPanel,
          users: {
            ...state.adminPanel.users,
            refreshTick: state.adminPanel.users.refreshTick + 1,
            searchPending: false,
          },
        },
      };

    case "admin_users_load_start":
      return {
        ...state,
        adminPanel: {
          ...state.adminPanel,
          users: {
            ...state.adminPanel.users,
            loading: true,
            loadError: null,
          },
        },
      };

    case "admin_users_load_succeeded":
      return {
        ...state,
        adminPanel: {
          ...state.adminPanel,
          users: {
            ...state.adminPanel.users,
            users: action.users,
            total: action.total,
            limit: action.limit,
            offset: action.offset,
            loading: false,
            loadError: null,
            searchPending: false,
          },
        },
      };

    case "admin_users_load_failed":
      return {
        ...state,
        adminPanel: {
          ...state.adminPanel,
          users: {
            ...state.adminPanel.users,
            loading: false,
            loadError: action.message,
            searchPending: false,
          },
        },
      };

    case "admin_users_action_start":
      return {
        ...state,
        adminPanel: {
          ...state.adminPanel,
          users: {
            ...state.adminPanel.users,
            pendingActionUserID: action.userID,
            actionError: null,
          },
        },
      };

    case "admin_users_action_succeeded":
      return {
        ...state,
        adminPanel: {
          ...state.adminPanel,
          users: {
            ...state.adminPanel.users,
            pendingActionUserID: null,
            actionError: null,
          },
        },
      };

    case "admin_users_action_failed":
      return {
        ...state,
        adminPanel: {
          ...state.adminPanel,
          users: {
            ...state.adminPanel.users,
            pendingActionUserID: null,
            actionError: `${action.action} failed: ${action.message}`,
          },
        },
      };

    case "admin_users_action_error_dismissed":
      return {
        ...state,
        adminPanel: {
          ...state.adminPanel,
          users: { ...state.adminPanel.users, actionError: null },
        },
      };

    case "admin_users_confirm_open":
      return {
        ...state,
        adminPanel: {
          ...state.adminPanel,
          users: {
            ...state.adminPanel.users,
            confirm: { userID: action.userID, action: action.action },
          },
        },
      };

    case "admin_users_confirm_close":
      return {
        ...state,
        adminPanel: {
          ...state.adminPanel,
          users: { ...state.adminPanel.users, confirm: null },
        },
      };

    // ---- Phase 09d-2b: admin blacklist tab ------------------------

    case "admin_blacklist_page_change":
      return {
        ...state,
        adminPanel: {
          ...state.adminPanel,
          blacklist: {
            ...state.adminPanel.blacklist,
            offset: action.offset,
          },
        },
      };

    case "admin_blacklist_refresh":
      return {
        ...state,
        adminPanel: {
          ...state.adminPanel,
          blacklist: {
            ...state.adminPanel.blacklist,
            refreshTick: state.adminPanel.blacklist.refreshTick + 1,
          },
        },
      };

    case "admin_blacklist_load_start":
      return {
        ...state,
        adminPanel: {
          ...state.adminPanel,
          blacklist: {
            ...state.adminPanel.blacklist,
            loading: true,
            loadError: null,
          },
        },
      };

    case "admin_blacklist_load_succeeded":
      return {
        ...state,
        adminPanel: {
          ...state.adminPanel,
          blacklist: {
            ...state.adminPanel.blacklist,
            entries: action.entries,
            total: action.total,
            limit: action.limit,
            offset: action.offset,
            loading: false,
            loadError: null,
          },
        },
      };

    case "admin_blacklist_load_failed":
      return {
        ...state,
        adminPanel: {
          ...state.adminPanel,
          blacklist: {
            ...state.adminPanel.blacklist,
            loading: false,
            loadError: action.message,
          },
        },
      };

    case "admin_blacklist_add_form_change":
      return {
        ...state,
        adminPanel: {
          ...state.adminPanel,
          blacklist: {
            ...state.adminPanel.blacklist,
            addForm: {
              ...state.adminPanel.blacklist.addForm,
              [action.field]: action.value,
            },
            addError: null,
          },
        },
      };

    case "admin_blacklist_add_start":
      return {
        ...state,
        adminPanel: {
          ...state.adminPanel,
          blacklist: {
            ...state.adminPanel.blacklist,
            addBusy: true,
            addError: null,
          },
        },
      };

    case "admin_blacklist_add_succeeded":
      return {
        ...state,
        adminPanel: {
          ...state.adminPanel,
          blacklist: {
            ...state.adminPanel.blacklist,
            addBusy: false,
            addError: null,
            // Clear the form on success.
            addForm: { email: "", reason: "" },
          },
        },
      };

    case "admin_blacklist_add_failed":
      return {
        ...state,
        adminPanel: {
          ...state.adminPanel,
          blacklist: {
            ...state.adminPanel.blacklist,
            addBusy: false,
            addError: action.message,
          },
        },
      };

    case "admin_blacklist_add_error_dismissed":
      return {
        ...state,
        adminPanel: {
          ...state.adminPanel,
          blacklist: { ...state.adminPanel.blacklist, addError: null },
        },
      };

    case "admin_blacklist_remove_start":
      return {
        ...state,
        adminPanel: {
          ...state.adminPanel,
          blacklist: {
            ...state.adminPanel.blacklist,
            pendingRemoveEmail: action.email,
            removeError: null,
          },
        },
      };

    case "admin_blacklist_remove_succeeded":
      return {
        ...state,
        adminPanel: {
          ...state.adminPanel,
          blacklist: {
            ...state.adminPanel.blacklist,
            pendingRemoveEmail: null,
            removeError: null,
          },
        },
      };

    case "admin_blacklist_remove_failed":
      return {
        ...state,
        adminPanel: {
          ...state.adminPanel,
          blacklist: {
            ...state.adminPanel.blacklist,
            pendingRemoveEmail: null,
            removeError: action.message,
          },
        },
      };

    case "admin_blacklist_remove_error_dismissed":
      return {
        ...state,
        adminPanel: {
          ...state.adminPanel,
          blacklist: { ...state.adminPanel.blacklist, removeError: null },
        },
      };
  }
}
