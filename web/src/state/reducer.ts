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

    // ---- Phase 09b sub-step 4: auth-flow actions ----------------------

    case "auth_config_loaded":
      // On config arrival, transition from bootstrapping to registering.
      // Sub-step 09b-5 will add the "is the user already authed?" check
      // here and skip registration when a session exists.
      return {
        ...state,
        authConfig: action.config,
        authStage: state.authStage === "bootstrapping" ? "registering" : state.authStage,
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
      // User has confirmed they saved the recovery code. Move to the
      // transitional handoff stage; recovery words are NOT cleared
      // here because the handoff screen may want to show the username
      // back to the user. They ARE cleared on auth_handoff_continue.
      return { ...state, authStage: "transitional-handoff" };

    case "auth_handoff_continue":
      // User has clicked the "continue to chat" button. Clear the
      // registration form (incl. any leftover error state) and the
      // recovery words; flip to authed.
      return {
        ...state,
        authStage: "authed",
        registration: state.registration, // keep username for any UI that wants it
        registrationResult: null,
      };
  }
}
