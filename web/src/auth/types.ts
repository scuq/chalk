// chalk SPA -- auth state types.
//
// Phase 09b sub-step 5b: full session-aware auth flow.
//
// State machine:
//
//   bootstrapping ─── (fetch /me)
//        │
//        ├─── 200 (already logged in) ─────────────────────────▶ authed
//        │
//        ├─── 401 (no session) ────▶ login ◀───────┐
//        │                              │           │
//        │                              ▼           │ ("no account?
//        │                          (submit         │   register" link)
//        │                           login          │
//        │                           ceremony)      │
//        │                              │           │
//        │                              ▼           │
//        │                            authed        │
//        │                                          │
//        └─── (user clicks "register" link) ──▶ registering ──┘
//                                                  │
//                                                  ▼ (submit)
//                                          (register ceremony,
//                                           register/finish
//                                           Set-Cookies)
//                                                  │
//                                                  ▼
//                                          confirming-recovery
//                                                  │
//                                                  ▼ (clicks continue)
//                                                authed
//
// Notable changes from 09b-4:
//   - "transitional-handoff" stage is GONE. register/finish now
//     Set-Cookies, so after confirming recovery we go straight to
//     authed.
//   - "login" stage added. AuthGate renders LoginScreen here.
//   - "bootstrapping" now fetches /api/auth/me. The /me response
//     decides login vs authed. AuthConfig is fetched lazily by the
//     screen that needs it (RegisterScreen reads it for the dev/open
//     badges).

// AuthStage drives which screen renders. authed = show chat.
export type AuthStage =
  | "bootstrapping"
  | "login"
  | "registering"
  | "confirming-recovery"
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

// LoginForm: SPA-side draft state of the login form.
export interface LoginForm {
  username: string;
  busy: boolean;
  errorCode: string | null;
  errorMessage: string | null;
}

export const initialLoginForm: LoginForm = {
  username: "",
  busy: false,
  errorCode: null,
  errorMessage: null,
};

// RegistrationResult: what register/finish returned. Held for the
// duration of the recovery screen so the user can see their identity
// AND copy the words. After auth_recovery_confirmed it's cleared
// (the words MUST NOT linger in state any longer).
//
// sessionExpiresAt is the cookie's TTL boundary, useful for UI
// "your session expires in X days" copy.
export interface RegistrationResult {
  userID: string;
  username: string;
  displayName: string;
  recoveryWords: string[];
  sessionExpiresAt: string;
}

// LoginResult: what authenticate/finish returned. Cookie is set by
// the server in the response headers; the SPA never sees the raw
// token, just the identity for display purposes.
export interface LoginResult {
  userID: string;
  username: string;
  displayName: string;
  role: string;
  sessionExpiresAt: string;
}

// MeResponse: GET /api/auth/me when a valid session exists. Mirrors
// the server's meResponse shape.
export interface MeResponse {
  userID: string;
  username: string;
  displayName: string;
  role: string;
  email: string;
  emailVerifiedAt: string; // zero value: "0001-01-01T00:00:00Z"
  sessionExpiresAt: string;
}

// AuthState is the auth-related slice of AppState. It's spread into
// AppState so existing reducers keep working without restructuring.
export interface AuthState {
  authStage: AuthStage;
  authConfig: AuthConfig | null;
  registration: RegistrationForm;
  registrationResult: RegistrationResult | null;
  login: LoginForm;
  // me holds the resolved identity once the user is authed. Drives
  // StatusBar display, app title bar, future settings panel. Null
  // when not authed.
  me: MeResponse | null;
}

export const initialAuthState: AuthState = {
  authStage: "bootstrapping",
  authConfig: null,
  registration: initialRegistrationForm,
  registrationResult: null,
  login: initialLoginForm,
  me: null,
};

// AuthAction is the union of all auth-related reducer actions.
// Kept in its own type so we can compose with AppState's Action.
export type AuthAction =
  | { kind: "auth_config_loaded"; config: AuthConfig }
  | { kind: "auth_config_failed"; message: string }
  // Registration:
  | { kind: "auth_form_change"; field: keyof RegistrationForm; value: string | boolean }
  | { kind: "auth_form_submit_start" }
  | { kind: "auth_form_submit_error"; code: string; message: string }
  | { kind: "auth_registered"; result: RegistrationResult }
  | { kind: "auth_recovery_confirmed" }
  // Login:
  | { kind: "auth_login_form_change"; field: keyof LoginForm; value: string }
  | { kind: "auth_login_submit_start" }
  | { kind: "auth_login_submit_error"; code: string; message: string }
  | { kind: "auth_logged_in"; result: LoginResult }
  // Session bootstrap + teardown:
  | { kind: "auth_me_loaded"; me: MeResponse }
  | { kind: "auth_me_absent" }
  | { kind: "auth_logged_out" }
  // Navigation:
  | { kind: "auth_go_register" }
  | { kind: "auth_go_login" };
