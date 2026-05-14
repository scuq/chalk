// chalk SPA -- auth state types.
//
// Phase 09b sub-step 4 lands the registration flow. The SPA boots in
// "bootstrapping" stage, fetches GET /api/auth/config, then transitions:
//
//   bootstrapping
//        │
//        ▼  (config loaded)
//   registering ──── (user submits, succeeds) ────▶ confirming-recovery
//        │                                                  │
//        │                                                  ▼  (confirmed)
//        │                                          transitional-handoff
//        │                                                  │
//        │                                                  ▼  (clicks continue)
//        ▼                                                authed
//   (errors stay on registering with error in state)
//
// "transitional-handoff" is a stop-gap until sub-step 09b-5: post-
// registration we don't have a session yet, so we cannot actually
// auth the WS connection. The screen explains this and offers a
// "Continue (legacy alice path)" button that flips authStage to
// "authed", at which point App renders the chat UI which connects
// the WS the same way it did pre-09b.
//
// In 09b-5 the handoff stage either:
//   - becomes the session-handoff: server returned Set-Cookie, SPA
//     proceeds to authed automatically
//   - is removed entirely, replaced by direct authStage='authed' on
//     register-finish success

// AuthStage drives which screen renders. authed = show chat.
export type AuthStage =
  | "bootstrapping"
  | "registering"
  | "confirming-recovery"
  | "transitional-handoff"
  | "authed";

// AuthConfig mirrors the GET /api/auth/config response body. See
// internal/auth/http.go::configResponse for the wire shape.
export interface AuthConfig {
  rp_id: string;
  rp_name: string;
  open_registration: boolean;
  dev_mode: boolean;
  recovery_word_count: number;
}

// RegistrationForm is the SPA-side draft state of the registration
// form. Lives in the reducer so re-renders preserve typing.
export interface RegistrationForm {
  username: string;
  displayName: string;
  email: string;
  inviteToken: string;
  showAdvanced: boolean;
  busy: boolean;
  // error is set when the most recent submit attempt failed. The
  // server's error code drives field-level vs general placement;
  // RegisterScreen branches on errorCode to render inline.
  errorCode: string | null;
  errorMessage: string | null;
}

export const initialRegistrationForm: RegistrationForm = {
  username: "",
  displayName: "",
  email: "",
  inviteToken: "",
  showAdvanced: false,
  busy: false,
  errorCode: null,
  errorMessage: null,
};

// RegistrationResult is what register/finish gave us back. We hold
// it for the duration of the recovery screen so the user can see
// their identity AND copy the words. After the user confirms, this
// is cleared (the words MUST NOT linger in state any longer).
export interface RegistrationResult {
  userID: string;
  username: string;
  displayName: string;
  recoveryWords: string[];
}

// AuthState is the auth-related slice of AppState. It's spread into
// AppState so existing reducers keep working without restructuring.
export interface AuthState {
  authStage: AuthStage;
  authConfig: AuthConfig | null;
  registration: RegistrationForm;
  registrationResult: RegistrationResult | null;
}

export const initialAuthState: AuthState = {
  authStage: "bootstrapping",
  authConfig: null,
  registration: initialRegistrationForm,
  registrationResult: null,
};

// AuthAction is the union of all auth-related reducer actions.
// Kept in its own type so we can compose with AppState's Action.
export type AuthAction =
  | { kind: "auth_config_loaded"; config: AuthConfig }
  | { kind: "auth_config_failed"; message: string }
  | { kind: "auth_form_change"; field: keyof RegistrationForm; value: string | boolean }
  | { kind: "auth_form_submit_start" }
  | { kind: "auth_form_submit_error"; code: string; message: string }
  | { kind: "auth_registered"; result: RegistrationResult }
  | { kind: "auth_recovery_confirmed" }
  | { kind: "auth_handoff_continue" };
