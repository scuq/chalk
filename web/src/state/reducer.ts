// Pure reducer for the chalk SPA. (state, action) -> state, no
// side effects, no I/O. Side effects (sending WS frames, fetching
// history) live in App.tsx as useEffect hooks driven by state changes.

import type { Action, AppState, Message } from "./types";

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

    case "channel_added": {
      const ch = action.channel;
      if (state.channels[ch.id]) {
        return state; // already known; idempotent
      }
      // Insert at the top of the order (newest).
      return {
        ...state,
        channels: { ...state.channels, [ch.id]: ch },
        channelOrder: [ch.id, ...state.channelOrder],
        // If nothing is active, jump to the new channel. Otherwise
        // leave the active selection alone (don't yank the user
        // somewhere unexpected).
        activeChannelID: state.activeChannelID ?? ch.id,
      };
    }

    case "set_active_channel":
      // No-op if same. Switching to a channel triggers fetch_history
      // via a useEffect in App.tsx; reducer stays pure.
      if (action.channelID === state.activeChannelID) {
        return state;
      }
      return { ...state, activeChannelID: action.channelID };

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
      return {
        ...state,
        messages: { ...state.messages, [m.channelID]: merged },
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
      return { ...state, friends: action.friends, friendsLoaded: true };

    case "open_create_modal":
      return { ...state, createModalOpen: true };

    case "close_create_modal":
      return { ...state, createModalOpen: false };

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
      // Clear me + login form + registration form (registration form
      // might still hold a username from a prior attempt) and return
      // to LoginScreen.
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
  }
}
