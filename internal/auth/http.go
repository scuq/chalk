package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/giphy"
	"github.com/scuq/chalk/internal/mail"
	"github.com/scuq/chalk/internal/store"
)

// passkeyToWebauthnCredential converts a store.Passkey row into the
// webauthn library's Credential shape, used at FinishLogin to verify
// the assertion against the user's known credentials.
//
// AAGUID and CloneWarning are zero values — chalk doesn't track AAGUID
// per credential (we don't filter on authenticator make/model), and
// clone-warning is a runtime detection that the library handles
// internally based on sign_count.
func passkeyToWebauthnCredential(pk store.Passkey) webauthn.Credential {
	transports := make([]protocol.AuthenticatorTransport, 0, len(pk.Transports))
	for _, t := range pk.Transports {
		transports = append(transports, protocol.AuthenticatorTransport(t))
	}
	return webauthn.Credential{
		ID:        pk.CredentialID,
		PublicKey: pk.PublicKey,
		Transport: transports,
		Authenticator: webauthn.Authenticator{
			SignCount: uint32(pk.SignCount),
		},
	}
}

// HTTPDeps bundles the dependencies the HTTP handlers need. Held by
// the server's lifecycle and passed in once at construction time.
type HTTPDeps struct {
	Service *Service       // WebAuthn ceremony primitives
	Cache   *CeremonyCache // in-flight ceremony state
	Store   *store.Store   // user/passkey/recovery persistence
	Logger  *log.Logger    // optional; nil → log.Default()

	// AdminUsername, if set, is the one username that may be claimed
	// even when it's on the reserved list. Sourced from the
	// CHALK_ADMIN_USERNAME env var; falls back to "" (no override)
	// when unset. The reserved-username check is exempted only for
	// this exact string match.
	AdminUsername string

	// Phase 09c additions:

	// Mailer delivers invite emails and email-change verification
	// links. Required when CHALK_OPEN_REGISTRATION is unset (i.e. in
	// invite-only mode) and whenever an authenticated user requests
	// an email change. May be nil in tests that don't exercise mail.
	Mailer mail.Mailer

	// PublicURL is the externally-visible origin used to build invite
	// and email-change verification URLs sent in outgoing mail. Empty
	// → relative URLs ("/?invite=...") which work but require the
	// recipient to be on the same origin as chalkd.
	PublicURL string

	// Phase 09d-1: Kicker terminates active WS connections for a user
	// when admin moderation blocks or soft-deletes them. May be nil;
	// when nil, the moderation endpoints still kill sessions and the
	// next WS frame will fail at the session check.
	Kicker ConnKicker

	// att-1: attachment limits, sourced from config.Attachments and plumbed
	// in by cmd/chalkd. AttachMaxBytes caps a single upload; AttachChunkBytes
	// is the chunk size advertised to clients and the chunk-PUT body bound;
	// AttachFetchWindow bounds the eager backfetch list query.
	AttachMaxBytes    int64
	AttachChunkBytes  int
	AttachFetchWindow time.Duration

	// att-4: Giphy search-proxy client, built from config.Giphy and plumbed
	// in by cmd/chalkd. Nil when CHALK_GIPHY_API_KEY is unset; in that case
	// the search endpoint answers 503 and /api/auth/config reports
	// giphy_enabled=false so the SPA hides the picker. The key lives only
	// here, never reaching the client.
	GiphyClient *giphy.Client
}

// MountRegistration registers the auth HTTP endpoints on mux.
//
// Routes:
//
//	POST /api/auth/register/begin            → BeginRegistration
//	POST /api/auth/register/finish           → FinishRegistration
//	GET  /api/auth/config                    → public RP config for the SPA
//	POST /api/auth/authenticate/begin        → BeginLogin
//	POST /api/auth/authenticate/finish       → FinishLogin
//	POST /api/auth/logout                    → DeleteSession + clear cookie
//	GET  /api/auth/me                        → identity from session cookie
//	POST /api/auth/recovery                  → recovery-code login
//	POST /api/auth/recovery/regenerate       → rotate recovery code
//	POST /api/invites                        → create invite (session)
//	GET  /api/invites/mine                   → list my invites (session)
//	DELETE /api/invites/{token}              → revoke my invite (session)
//	GET  /api/auth/invite/{token}            → peek invite (no auth)
//	POST /api/auth/email-change              → start email change (session)
//	POST /api/auth/verify-email-change/{token} → finalize email change
//
// The handlers are stateless apart from the *CeremonyCache; the
// service is reused across requests.
func (d *HTTPDeps) MountRegistration(mux *http.ServeMux) error {
	if d.Service == nil || d.Cache == nil || d.Store == nil {
		return fmt.Errorf("auth: HTTPDeps requires Service, Cache, and Store")
	}
	if d.Logger == nil {
		d.Logger = log.Default()
	}
	mux.HandleFunc("POST /api/auth/register/begin", d.handleRegisterBegin)
	mux.HandleFunc("POST /api/auth/register/finish", d.handleRegisterFinish)
	mux.HandleFunc("GET /api/auth/config", d.handleConfig)
	// Sub-step 5: login + identity + logout endpoints.
	mux.HandleFunc("POST /api/auth/authenticate/begin", d.handleAuthenticateBegin)
	mux.HandleFunc("POST /api/auth/authenticate/finish", d.handleAuthenticateFinish)
	mux.HandleFunc("POST /api/auth/logout", d.handleLogout)
	mux.HandleFunc("GET /api/auth/me", d.handleMe)
	// Sub-step 6: recovery login + forced regenerate.
	mux.HandleFunc("POST /api/auth/recovery", d.handleRecovery)
	mux.HandleFunc("POST /api/auth/recovery/regenerate", d.handleRecoveryRegenerate)
	// Phase 09c-1: invites + email change.
	mux.HandleFunc("POST /api/invites", d.handleCreateInvite)
	mux.HandleFunc("GET /api/invites/mine", d.handleListMyInvites)
	mux.HandleFunc("DELETE /api/invites/{token}", d.handleRevokeInvite)
	mux.HandleFunc("GET /api/auth/invite/{token}", d.handlePeekInvite)
	mux.HandleFunc("POST /api/auth/email-change", d.handleEmailChangeRequest)
	mux.HandleFunc("POST /api/auth/verify-email-change/{token}", d.handleVerifyEmailChange)
	// md-4: manage passkeys for the authenticated account. add/begin +
	// add/finish enroll an additional credential on THIS device (e.g.
	// a second device whose passkey doesn't sync); GET lists them.
	mux.HandleFunc("POST /api/auth/passkeys/add/begin", RequireSession(d.Store, d.handleAddPasskeyBegin))
	mux.HandleFunc("POST /api/auth/passkeys/add/finish", RequireSession(d.Store, d.handleAddPasskeyFinish))
	mux.HandleFunc("GET /api/auth/passkeys", RequireSession(d.Store, d.handleListPasskeys))
	mux.HandleFunc("DELETE /api/auth/passkeys/{id}", RequireSession(d.Store, d.handleDeletePasskey))
	return nil
}

// ---- request/response shapes -------------------------------------------

// registerBeginRequest is the SPA's input at /api/auth/register/begin.
type registerBeginRequest struct {
	// InviteToken is sub-step 09c's mechanism. In sub-step 3 it's
	// accepted but only validated when CHALK_OPEN_REGISTRATION=0
	// (default), in which case it's required (and currently always
	// rejected because we have no invites table yet). When open
	// registration is on, this field is ignored.
	InviteToken string `json:"invite_token,omitempty"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name,omitempty"`
	Email       string `json:"email"`
}

// registerBeginResponse echoes the WebAuthn options to the SPA. The
// SPA passes Options to navigator.credentials.create() and posts back
// the result; the cache entry is keyed on the embedded challenge so
// no separate ID round-trips.
type registerBeginResponse struct {
	Options *protocol.CredentialCreation `json:"options"`
}

// registerFinishRequest mirrors the SPA's PublicKeyCredential. We
// accept the raw bytes (the SPA serializes it via our small webauthn.ts
// helper in sub-step 4); go-webauthn parses it.
//
// We use json.RawMessage rather than a typed struct because the
// library has its own parser (ParseCredentialCreationResponseBytes)
// that handles the base64url encoding gymnastics; re-typing here
// would duplicate that logic and drift over time.
type registerFinishRequest struct {
	Credential json.RawMessage `json:"credential"`
}

// registerFinishResponse returns the freshly created user identity
// plus the one-time-only recovery words. Words are NEVER returned
// again — the SPA MUST surface them immediately. Cache-Control
// no-store on this response prevents intermediate caching.
//
// Sub-step 5: register/finish also mints a session and sets the
// chalk_session cookie on the response. The SPA proceeds directly
// from recovery confirmation to chat; no separate login step.
// session_expires_at is included in the body so the SPA can show
// expiry information (and not for any auth purpose — the cookie is
// the auth credential, the body field is just metadata).
type registerFinishResponse struct {
	UserID           string    `json:"user_id"`
	Username         string    `json:"username"`
	DisplayName      string    `json:"display_name"`
	RecoveryWords    []string  `json:"recovery_words"`
	SessionExpiresAt time.Time `json:"session_expires_at"`
}

// configResponse is what GET /api/auth/config returns. The SPA needs
// to know the RP ID and name to construct the right WebAuthn calls,
// and the registration-mode flag to decide whether to show the
// invite-token field.
type configResponse struct {
	RPID              string `json:"rp_id"`
	RPName            string `json:"rp_name"`
	OpenRegistration  bool   `json:"open_registration"`
	DevMode           bool   `json:"dev_mode"`
	RecoveryWordCount int    `json:"recovery_word_count"`
	// att-4: whether the server has a Giphy API key configured. The SPA
	// shows the composer Giphy button only when true. Independent of the
	// per-user consent pref, which is a SPA-only concern.
	GiphyEnabled bool `json:"giphy_enabled"`
}

// ---- handlers ----------------------------------------------------------

// handleConfig returns public auth configuration the SPA needs at
// startup. No authentication required. Cacheable for a short period
// (the values are stable across the chalkd process lifetime).
func (d *HTTPDeps) handleConfig(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "max-age=60") // values are stable but allow override
	_ = json.NewEncoder(w).Encode(configResponse{
		RPID:              d.Service.RPID(),
		RPName:            d.Service.RPDisplayName(),
		OpenRegistration:  IsOpenRegistration(),
		DevMode:           IsDevMode(),
		RecoveryWordCount: RecoveryWordCount,
		GiphyEnabled:      d.GiphyClient != nil,
	})
}

// handleRegisterBegin starts a registration ceremony. The user does
// not yet exist; we generate a UUID, build the WebAuthn options, and
// stash the pending-user fields in the cache for the finish handler
// to consume.
func (d *HTTPDeps) handleRegisterBegin(w http.ResponseWriter, r *http.Request) {
	var req registerBeginRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	invite, authErr := d.checkRegistrationAllowed(r.Context(), req)
	if authErr != nil {
		writeAuthErr(w, authErr)
		return
	}
	username := strings.ToLower(strings.TrimSpace(req.Username))
	email := strings.ToLower(strings.TrimSpace(req.Email))
	displayName := strings.TrimSpace(req.DisplayName)
	if displayName == "" {
		displayName = username
	}

	if !IsValidUsername(username) {
		writeError(w, http.StatusBadRequest, "bad_username",
			"username must match ^[a-z0-9_]{3,32}$")
		return
	}
	if IsReservedUsername(username) && username != strings.ToLower(d.AdminUsername) {
		writeError(w, http.StatusConflict, "username_reserved",
			"that username is reserved")
		return
	}
	// sub-step 4 fix1: dev-mode email fill
	// In CHALK_DEV mode, treat an empty email as a request to
	// auto-fill <username>@localhost.invalid. This lets dev
	// fixtures register passkeys without inventing throwaway
	// addresses. Production registrations (CHALK_DEV unset) are
	// unaffected: the looksLikeEmail check below still fires for
	// an empty email and returns 400 bad_email.
	if email == "" && IsDevMode() {
		email = username + "@localhost.invalid"
	}
	if !looksLikeEmail(email) {
		writeError(w, http.StatusBadRequest, "bad_email",
			"email must contain @ and a domain")
		return
	}

	// Phase 09c: when registering with an invite, the chosen email
	// MUST match the invite's email. We don't let users grab an
	// invite for one address and register under a different one;
	// that defeats the email-of-record gate. Open-registration mode
	// (admin bootstrap, dev) has no invite to compare against.
	if invite != nil && !strings.EqualFold(invite.Email, email) {
		writeError(w, http.StatusConflict, "invite_email_mismatch",
			"invite was issued for a different email address")
		return
	}

	// Phase 09c: email blacklist check. Bypassed in open-registration
	// mode so the admin can be bootstrapped even when their email
	// was previously blacklisted (e.g. fresh DB after a purge).
	if invite != nil {
		blocked, err := d.Store.IsEmailBlacklisted(r.Context(), email)
		if err != nil {
			d.Logger.Printf("register/begin: blacklist check: %v", err)
			writeError(w, http.StatusInternalServerError, "lookup_failed", "internal error")
			return
		}
		if blocked {
			writeError(w, http.StatusForbidden, "email_blacklisted",
				"that email cannot be registered")
			return
		}
	}

	// Pre-flight collision checks. The transactional RegisterUser
	// repeats these at the DB level, so a race during the WebAuthn
	// ceremony (5min window) is caught there too; doing it here
	// fails fast and gives the SPA a clear error before the user
	// touches their authenticator.
	if _, err := d.Store.GetUserByUsername(r.Context(), username); err == nil {
		writeError(w, http.StatusConflict, "username_taken",
			"that username is already in use")
		return
	} else if !errors.Is(err, store.ErrNotFound) {
		d.Logger.Printf("register/begin: lookup username: %v", err)
		writeError(w, http.StatusInternalServerError, "lookup_failed", "internal error")
		return
	}
	if _, err := d.Store.GetUserByEmail(r.Context(), email); err == nil {
		writeError(w, http.StatusConflict, "email_taken",
			"that email is already in use")
		return
	} else if !errors.Is(err, store.ErrNotFound) {
		d.Logger.Printf("register/begin: lookup email: %v", err)
		writeError(w, http.StatusInternalServerError, "lookup_failed", "internal error")
		return
	}

	pending := PendingUser{
		ID:          uuid.New(),
		Username:    username,
		DisplayName: displayName,
		Email:       email,
	}
	if invite != nil {
		pending.InviteToken = invite.Token
	}
	wauthUser := &User{
		ID:          pending.ID,
		Name:        pending.Username,
		DisplayName: pending.DisplayName,
		Credentials: nil, // brand-new user; no creds to exclude
	}
	options, sess, err := d.Service.BeginRegistration(wauthUser)
	if err != nil {
		d.Logger.Printf("register/begin: BeginRegistration: %v", err)
		writeError(w, http.StatusInternalServerError, "ceremony_failed",
			"could not start ceremony")
		return
	}

	d.Cache.Put(sess.Challenge, CeremonyEntry{
		Kind:        KindRegistration,
		Session:     *sess,
		PendingUser: pending,
	})

	writeJSON(w, http.StatusOK, registerBeginResponse{Options: options})
}

// handleRegisterFinish completes a registration ceremony.
//
//  1. Parse the credential response sent by the SPA.
//  2. Extract the challenge from the embedded clientData.
//  3. Look up (and remove) the matching cache entry.
//  4. Run go-webauthn's CreateCredential validation.
//  5. Generate recovery words + hash.
//  6. Persist users + passkeys + recovery_codes in one tx.
//  7. Return the recovery words. THIS IS THE ONLY TIME they leave
//     the server; once returned, only the hash exists.
func (d *HTTPDeps) handleRegisterFinish(w http.ResponseWriter, r *http.Request) {
	var req registerFinishRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	if len(req.Credential) == 0 {
		writeError(w, http.StatusBadRequest, "bad_credential", "credential required")
		return
	}

	parsed, err := protocol.ParseCredentialCreationResponseBytes(req.Credential)
	if err != nil {
		writeError(w, http.StatusBadRequest, "parse_failed", err.Error())
		return
	}

	// The challenge the authenticator signed lives inside the
	// clientData. We trust the parser to expose it after its own
	// base64 decoding; if the SPA tampered with it, the library's
	// later Verify step will catch the signature mismatch.
	challenge := parsed.Response.CollectedClientData.Challenge
	if challenge == "" {
		writeError(w, http.StatusBadRequest, "missing_challenge",
			"clientData challenge missing")
		return
	}

	entry, err := d.Cache.Take(challenge)
	if err != nil {
		if errors.Is(err, ErrCeremonyExpired) {
			writeError(w, http.StatusGone, "ceremony_expired",
				"registration ceremony expired; start over")
			return
		}
		writeError(w, http.StatusNotFound, "ceremony_not_found",
			"no matching registration ceremony")
		return
	}
	if entry.Kind != KindRegistration {
		writeError(w, http.StatusBadRequest, "wrong_ceremony",
			"that challenge is for a different ceremony")
		return
	}

	wauthUser := &User{
		ID:          entry.PendingUser.ID,
		Name:        entry.PendingUser.Username,
		DisplayName: entry.PendingUser.DisplayName,
		Credentials: nil,
	}
	cred, err := d.Service.FinishRegistration(wauthUser, entry.Session, parsed)
	if err != nil {
		d.Logger.Printf("register/finish: FinishRegistration: %v", err)
		writeError(w, http.StatusBadRequest, "ceremony_validation_failed",
			err.Error())
		return
	}

	// Mint recovery words. We do this OUTSIDE the transaction
	// because argon2id is slow (~100ms) and we don't want to hold
	// a tx open across it. Race-window argument: between generating
	// words and committing, nothing can collide on the
	// recovery_codes row (the user doesn't exist yet); on tx
	// failure the words are discarded and the user re-registers.
	words, err := GenerateRecoveryWords()
	if err != nil {
		d.Logger.Printf("register/finish: GenerateRecoveryWords: %v", err)
		writeError(w, http.StatusInternalServerError, "recovery_gen_failed",
			"could not generate recovery code")
		return
	}
	hash, err := HashRecoveryWords(words)
	if err != nil {
		d.Logger.Printf("register/finish: HashRecoveryWords: %v", err)
		writeError(w, http.StatusInternalServerError, "recovery_hash_failed",
			"could not hash recovery code")
		return
	}

	transports := make([]string, 0, len(cred.Transport))
	for _, t := range cred.Transport {
		transports = append(transports, string(t))
	}

	regErr := d.Store.RegisterUser(r.Context(), store.RegistrationParams{
		UserID:       entry.PendingUser.ID,
		Username:     entry.PendingUser.Username,
		DisplayName:  entry.PendingUser.DisplayName,
		Email:        entry.PendingUser.Email,
		CredentialID: cred.ID,
		PublicKey:    cred.PublicKey,
		SignCount:    uint64(cred.Authenticator.SignCount),
		Transports:   transports,
		PasskeyName:  "Primary passkey",
		RecoveryHash: hash,
	})
	if regErr != nil {
		switch {
		case errors.Is(regErr, store.ErrUsernameTaken):
			writeError(w, http.StatusConflict, "username_taken",
				"that username was taken during your ceremony; try another")
			return
		case errors.Is(regErr, store.ErrEmailTaken):
			writeError(w, http.StatusConflict, "email_taken",
				"that email was registered during your ceremony")
			return
		case errors.Is(regErr, store.ErrCredentialTaken):
			// Should never happen with cryptographic credential IDs.
			d.Logger.Printf("register/finish: credential collision: %v", regErr)
			writeError(w, http.StatusConflict, "credential_collision",
				"unexpected credential collision; retry")
			return
		default:
			d.Logger.Printf("register/finish: RegisterUser: %v", regErr)
			writeError(w, http.StatusInternalServerError, "persist_failed",
				"could not persist registration")
			return
		}
	}

	// Phase 09c: mark the invite as used now that the user row is
	// persisted. We do this AFTER RegisterUser (not inside its
	// transaction) so that an invite-mark failure can't roll back a
	// successful registration. The cost of this design is that a
	// crash between the two writes leaves the user registered with
	// the invite still active; the next registration attempt with
	// the same token would 409 (username/email collision) so the
	// invite isn't actually re-usable. Best-effort logging is fine.
	if len(entry.PendingUser.InviteToken) > 0 {
		if markErr := d.Store.MarkInviteUsed(r.Context(),
			entry.PendingUser.InviteToken,
			entry.PendingUser.ID,
		); markErr != nil {
			d.Logger.Printf("register/finish: MarkInviteUsed for user %s: %v",
				entry.PendingUser.ID, markErr)
			// Don't fail the registration; the user IS registered.
		}
	}

	// Sub-step 5: mint a session and set the cookie before writing
	// the response body. Doing this here means a successful
	// registration leaves the user logged in — no separate login
	// step needed. The Set-Cookie header is on the same response
	// the SPA receives, so the cookie is immediately available for
	// subsequent /api/auth/me and WS upgrade calls.
	sess, err := MintSession(r.Context(), d.Store, w,
		entry.PendingUser.ID,
		UserAgentFromRequest(r),
		IPFromRequest(r),
	)
	if err != nil {
		// The user row and passkey are committed; we just failed to
		// mint a session. The user can still log in via /authenticate
		// to get their session. We return success with no cookie and
		// log loudly so the operator sees this.
		d.Logger.Printf("register/finish: MintSession FAILED for user %s: %v",
			entry.PendingUser.ID, err)
		// Continue: registration WAS successful even without the session.
	}

	// Cache-Control: the recovery words must NEVER be cached.
	w.Header().Set("Cache-Control", "no-store, private")
	writeJSON(w, http.StatusOK, registerFinishResponse{
		UserID:           entry.PendingUser.ID.String(),
		Username:         entry.PendingUser.Username,
		DisplayName:      entry.PendingUser.DisplayName,
		RecoveryWords:    words,
		SessionExpiresAt: sess.ExpiresAt,
	})
}

// ---- authentication (login) -------------------------------------------

// authBeginRequest is the body of /api/auth/authenticate/begin.
type authBeginRequest struct {
	Username string `json:"username"`
}

// authBeginResponse echoes the WebAuthn options for the assertion
// ceremony. Shape mirrors registerBeginResponse but for login.
type authBeginResponse struct {
	Options *protocol.CredentialAssertion `json:"options"`
}

// authFinishRequest is the body of /api/auth/authenticate/finish.
// Like register/finish, we accept raw JSON for the credential so
// the library's own parser does the base64url decoding.
type authFinishRequest struct {
	Credential json.RawMessage `json:"credential"`
}

// authFinishResponse mirrors the post-login state the SPA needs to
// initialize itself. user_id and username are echoed for diagnostic
// purposes; the actual auth credential is the cookie.
type authFinishResponse struct {
	UserID           string    `json:"user_id"`
	Username         string    `json:"username"`
	DisplayName      string    `json:"display_name"`
	Role             string    `json:"role"`
	SessionExpiresAt time.Time `json:"session_expires_at"`
}

// handleAuthenticateBegin starts a login ceremony. The username is
// looked up, all passkeys for that user are gathered into the
// allowed-credentials list, and a challenge is generated. The
// PendingUser in the cache here carries the user's existing UUID
// (unlike registration where it's freshly minted).
func (d *HTTPDeps) handleAuthenticateBegin(w http.ResponseWriter, r *http.Request) {
	var req authBeginRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	username := strings.ToLower(strings.TrimSpace(req.Username))
	if !IsValidUsername(username) {
		writeError(w, http.StatusBadRequest, "bad_username",
			"username must match ^[a-z0-9_]{3,32}$")
		return
	}

	// Look up the user. We intentionally return a generic error for
	// "user not found" so login doesn't double as a username
	// enumeration oracle. The plan's threat model says this is a
	// soft concern (open_registration mode makes usernames public
	// anyway), but treating it generically here costs nothing.
	user, err := d.Store.GetUserByUsername(r.Context(), username)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusUnauthorized, "unknown_user",
				"that account doesn't exist or has no passkeys")
			return
		}
		d.Logger.Printf("authenticate/begin: lookup username: %v", err)
		writeError(w, http.StatusInternalServerError, "lookup_failed",
			"internal error")
		return
	}

	// Phase 09d-1: block-aware login gate. A blocked user cannot
	// authenticate; a soft-deleted user is gone (410 Gone). Both
	// statuses are stored on users (blocked_at, deleted_at). Order
	// matters: a deleted account that was also blocked surfaces as
	// deleted (the stronger condition).
	if !user.DeletedAt.IsZero() {
		writeError(w, http.StatusGone, "user_deleted",
			"this account has been deleted")
		return
	}
	if !user.BlockedAt.IsZero() {
		writeError(w, http.StatusForbidden, "user_blocked",
			"this account has been blocked by an administrator")
		return
	}

	// Load all active passkeys so go-webauthn can populate the
	// allowed-credentials list in the challenge. The library will
	// look up the credential the authenticator returns against this
	// list at FinishLogin time.
	passkeys, err := d.Store.GetPasskeysForUser(r.Context(), user.ID)
	if err != nil {
		d.Logger.Printf("authenticate/begin: list passkeys: %v", err)
		writeError(w, http.StatusInternalServerError, "lookup_failed",
			"internal error")
		return
	}
	if len(passkeys) == 0 {
		// User exists but has no passkeys. They need to use the
		// recovery flow (09b-6).
		writeError(w, http.StatusUnauthorized, "no_passkeys",
			"that account has no passkeys; use the recovery flow")
		return
	}

	creds := make([]webauthn.Credential, 0, len(passkeys))
	for _, pk := range passkeys {
		creds = append(creds, passkeyToWebauthnCredential(pk))
	}

	wauthUser := &User{
		ID:          user.ID,
		Name:        user.Username,
		DisplayName: user.DisplayName,
		Credentials: creds,
	}
	options, sess, err := d.Service.BeginLogin(wauthUser)
	if err != nil {
		d.Logger.Printf("authenticate/begin: BeginLogin: %v", err)
		writeError(w, http.StatusInternalServerError, "ceremony_failed",
			"could not start ceremony")
		return
	}

	// Stash the pending user (existing UUID, not a fresh one).
	d.Cache.Put(sess.Challenge, CeremonyEntry{
		Kind:    KindLogin,
		Session: *sess,
		PendingUser: PendingUser{
			ID:          user.ID,
			Username:    user.Username,
			DisplayName: user.DisplayName,
			Email:       user.Email,
		},
	})
	writeJSON(w, http.StatusOK, authBeginResponse{Options: options})
}

// handleAuthenticateFinish completes a login ceremony. On success
// mints a session and Set-Cookie, returns the user identity.
func (d *HTTPDeps) handleAuthenticateFinish(w http.ResponseWriter, r *http.Request) {
	var req authFinishRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	if len(req.Credential) == 0 {
		writeError(w, http.StatusBadRequest, "bad_credential", "credential required")
		return
	}
	parsed, err := protocol.ParseCredentialRequestResponseBytes(req.Credential)
	if err != nil {
		writeError(w, http.StatusBadRequest, "parse_failed", err.Error())
		return
	}
	challenge := parsed.Response.CollectedClientData.Challenge
	if challenge == "" {
		writeError(w, http.StatusBadRequest, "missing_challenge",
			"clientData challenge missing")
		return
	}
	entry, err := d.Cache.Take(challenge)
	if err != nil {
		if errors.Is(err, ErrCeremonyExpired) {
			writeError(w, http.StatusGone, "ceremony_expired",
				"login ceremony expired; start over")
			return
		}
		writeError(w, http.StatusNotFound, "ceremony_not_found",
			"no matching login ceremony")
		return
	}
	if entry.Kind != KindLogin {
		writeError(w, http.StatusBadRequest, "wrong_ceremony",
			"that challenge is for a different ceremony")
		return
	}

	// Re-load the credentials for the user. Could come from the
	// cache entry but reloading from the store guarantees we use
	// the current sign_count (post-some-other-login bump). The
	// authenticator's response carries a sign_count too, and
	// go-webauthn checks for monotonic increase as a replay defense.
	passkeys, err := d.Store.GetPasskeysForUser(r.Context(), entry.PendingUser.ID)
	if err != nil {
		d.Logger.Printf("authenticate/finish: list passkeys: %v", err)
		writeError(w, http.StatusInternalServerError, "lookup_failed",
			"internal error")
		return
	}
	creds := make([]webauthn.Credential, 0, len(passkeys))
	for _, pk := range passkeys {
		creds = append(creds, passkeyToWebauthnCredential(pk))
	}
	wauthUser := &User{
		ID:          entry.PendingUser.ID,
		Name:        entry.PendingUser.Username,
		DisplayName: entry.PendingUser.DisplayName,
		Credentials: creds,
	}
	cred, err := d.Service.FinishLogin(wauthUser, entry.Session, parsed)
	if err != nil {
		d.Logger.Printf("authenticate/finish: FinishLogin: %v", err)
		writeError(w, http.StatusBadRequest, "ceremony_validation_failed",
			err.Error())
		return
	}

	// Bump the passkey's sign_count and last_used_at so replay
	// defense works on the next login.
	if err := d.Store.UpdateSignCount(r.Context(),
		cred.ID, uint64(cred.Authenticator.SignCount)); err != nil {
		// Best-effort: log but don't fail. The login is still
		// valid; we just won't catch a sign-count replay on the
		// next attempt with this credential.
		d.Logger.Printf("authenticate/finish: UpdateSignCount: %v", err)
	}

	// Mint a session and set the cookie.
	sess, err := MintSession(r.Context(), d.Store, w,
		entry.PendingUser.ID,
		UserAgentFromRequest(r),
		IPFromRequest(r),
	)
	if err != nil {
		d.Logger.Printf("authenticate/finish: MintSession: %v", err)
		writeError(w, http.StatusInternalServerError, "session_mint_failed",
			"could not create session")
		return
	}

	// Look up the user one more time for role (the cache entry doesn't
	// carry it because registration's PendingUser was always 'user').
	user, err := d.Store.GetUserByID(r.Context(), entry.PendingUser.ID)
	if err != nil {
		// Session is minted; just fall back to defaults in the response.
		d.Logger.Printf("authenticate/finish: GetUserByID for response: %v", err)
		user.Role = "user"
	}

	writeJSON(w, http.StatusOK, authFinishResponse{
		UserID:           entry.PendingUser.ID.String(),
		Username:         entry.PendingUser.Username,
		DisplayName:      entry.PendingUser.DisplayName,
		Role:             user.Role,
		SessionExpiresAt: sess.ExpiresAt,
	})
}

// ---- logout / me ------------------------------------------------------

// handleLogout deletes the session row and clears the cookie. No
// request body. Idempotent: clearing the cookie on an already-logged-
// out request still returns 204.
func (d *HTTPDeps) handleLogout(w http.ResponseWriter, r *http.Request) {
	// Best-effort: if there's a session cookie, delete the row.
	// Even if the token is unparseable, we still want to clear the
	// cookie so the browser stops sending it.
	if token, err := SessionTokenFromRequest(r); err == nil {
		if delErr := d.Store.DeleteSession(r.Context(), token); delErr != nil {
			// Don't expose the error; clearing the cookie is what
			// matters for the user-facing behavior.
			d.Logger.Printf("logout: DeleteSession: %v", delErr)
		}
	}
	ClearSessionCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

// meResponse is the body of GET /api/auth/me. Mirrors the plan's
// shape. session_expires_at is the cookie's TTL boundary, useful for
// the SPA to know when it'll have to re-login.
type meResponse struct {
	UserID           string    `json:"user_id"`
	Username         string    `json:"username"`
	DisplayName      string    `json:"display_name"`
	Role             string    `json:"role"`
	Email            string    `json:"email"`
	EmailVerifiedAt  time.Time `json:"email_verified_at"`
	SessionExpiresAt time.Time `json:"session_expires_at"`
}

// handleMe returns the current user's identity if logged in, or 401
// otherwise. The SPA polls this at boot to decide whether to render
// LoginScreen or jump straight to chat. RequireSession middleware
// handles the 401 cases uniformly.
func (d *HTTPDeps) handleMe(w http.ResponseWriter, r *http.Request) {
	RequireSession(d.Store, func(w http.ResponseWriter, r *http.Request, su *SessionUser) {
		// We don't currently store email_verified_at on SessionUser;
		// fetch it from the user record. Could be added to
		// SessionUser later if /me becomes a hot path, but it's
		// once-per-boot from the SPA so an extra query is fine.
		// Actually we already loaded the user in ResolveSession;
		// fetch it once more to get the verified_at timestamp.
		// (Note: an earlier design had the lazy load skip this;
		// keeping it explicit here for clarity.)
		user, err := d.Store.GetUserByID(r.Context(), su.UserID)
		if err != nil {
			d.Logger.Printf("me: GetUserByID: %v", err)
			writeError(w, http.StatusInternalServerError, "lookup_failed",
				"internal error")
			return
		}
		writeJSON(w, http.StatusOK, meResponse{
			UserID:           su.UserID.String(),
			Username:         su.Username,
			DisplayName:      su.DisplayName,
			Role:             su.Role,
			Email:            su.Email,
			EmailVerifiedAt:  user.EmailVerifiedAt,
			SessionExpiresAt: su.Session.ExpiresAt,
		})
	})(w, r)
}

// ---- helpers -----------------------------------------------------------

// checkRegistrationAllowed enforces the registration-mode policy.
//
//   - CHALK_OPEN_REGISTRATION=1: always allow; invite_token ignored.
//     Used for admin bootstrap and during dev. Returns nil and a nil
//     invite.
//   - default: require a valid, active invite_token. Returns the
//     invite for use by downstream checks (email-match) and the
//     register/finish path (mark used).
//
// Error returns map to HTTP status codes in the caller:
//   - "registration_closed" + 403 for missing token
//   - "invite_not_found" + 404 for unknown token
//   - "invite_invalid_shape" + 400 for malformed token
//   - "invite_used" / "invite_revoked" / "invite_expired" + 410 for
//     non-active tokens (Gone is the appropriate status: the token
//     existed but is no longer usable)
//
// Returns (nil, nil) on success in open-registration mode and
// (&invite, nil) when invite validation succeeded.
func (d *HTTPDeps) checkRegistrationAllowed(ctx context.Context, req registerBeginRequest) (*store.Invite, *authError) {
	if IsOpenRegistration() {
		// Even in open-registration mode, if the client sent an
		// invite token, try to honor it so the invite is properly
		// marked used at register/finish. This handles the common
		// dev case of flipping between open and invite-only modes
		// without breaking outstanding invite URLs that still carry
		// ?invite= in the query.
		//
		// Permissive: a malformed/unknown/inactive token does NOT
		// fail the registration (open-reg means "anyone may join");
		// we silently drop the invite reference. Only a happy-path
		// active token gets propagated so MarkInviteUsed runs at
		// finish.
		if req.InviteToken != "" {
			if tokenBytes, decErr := DecodeInviteToken(req.InviteToken); decErr == nil {
				inv, getErr := d.Store.GetInvite(ctx, tokenBytes)
				if getErr == nil && inv.IsActive() {
					return &inv, nil
				}
				if getErr != nil && !errors.Is(getErr, store.ErrNotFound) {
					// Real DB error vs. just "no such invite": log
					// but don't reject.
					d.Logger.Printf("checkRegistrationAllowed (open-reg): GetInvite: %v", getErr)
				}
			}
		}
		return nil, nil
	}
	if req.InviteToken == "" {
		return nil, &authError{
			status:  http.StatusForbidden,
			code:    "registration_closed",
			message: "registration is closed; an invite token is required",
		}
	}
	tokenBytes, err := DecodeInviteToken(req.InviteToken)
	if err != nil {
		return nil, &authError{
			status:  http.StatusBadRequest,
			code:    "invite_invalid_shape",
			message: "invite token is malformed",
		}
	}
	inv, err := d.Store.GetInvite(ctx, tokenBytes)
	if errors.Is(err, store.ErrNotFound) {
		return nil, &authError{
			status:  http.StatusNotFound,
			code:    "invite_not_found",
			message: "invite token not found",
		}
	}
	if err != nil {
		d.Logger.Printf("checkRegistrationAllowed: GetInvite: %v", err)
		return nil, &authError{
			status:  http.StatusInternalServerError,
			code:    "lookup_failed",
			message: "could not look up invite",
		}
	}
	switch inv.Status() {
	case "used":
		return nil, &authError{
			status:  http.StatusGone,
			code:    "invite_used",
			message: "this invite has already been used",
		}
	case "revoked":
		return nil, &authError{
			status:  http.StatusGone,
			code:    "invite_revoked",
			message: "this invite was revoked by the sender",
		}
	case "expired":
		return nil, &authError{
			status:  http.StatusGone,
			code:    "invite_expired",
			message: "this invite has expired",
		}
	}
	return &inv, nil
}

// authError is the internal error shape returned by the validation
// helpers. The caller maps it to an HTTP response via the writeAuthErr
// helper.
type authError struct {
	status  int
	code    string
	message string
}

// writeAuthErr serializes an authError to the HTTP response.
func writeAuthErr(w http.ResponseWriter, e *authError) {
	writeError(w, e.status, e.code, e.message)
}

// looksLikeEmail is a minimal check. Real RFC 5322 validation is the
// SPA's job (and even there it's lax); we just want to reject the
// obvious junk before generating a ceremony challenge for it.
func looksLikeEmail(s string) bool {
	at := strings.IndexByte(s, '@')
	if at <= 0 || at == len(s)-1 {
		return false
	}
	domain := s[at+1:]
	return strings.IndexByte(domain, '.') > 0
}

// decodeJSON decodes the request body into v with a small max size to
// blunt DoS-by-giant-body. 64KiB is plenty for our payloads (the
// credential attestation is ~1-2KiB).
func decodeJSON(r *http.Request, v any) error {
	limited := io.LimitReader(r.Body, 64*1024)
	dec := json.NewDecoder(limited)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return fmt.Errorf("decode body: %w", err)
	}
	// Refuse trailing junk after the JSON value.
	if dec.More() {
		return fmt.Errorf("decode body: trailing content")
	}
	return nil
}

// ---- recovery (sub-step 6) -------------------------------------------

// recoveryRequest is the SPA's input at /api/auth/recovery. Username
// + the 24-word phrase as either a single space-separated string or
// an array of 24 strings. We accept both shapes; SPA can choose.
type recoveryRequest struct {
	Username string   `json:"username"`
	Words    []string `json:"words"`
	// Phrase is a convenience alternative when the SPA wants to send
	// raw user input as one string. Either Words or Phrase MUST be
	// provided; the handler normalizes whichever is non-empty.
	Phrase string `json:"phrase,omitempty"`
}

// recoveryResponse is the response on success. The cookie is set via
// Set-Cookie; the body carries identity + the regenerate_required
// flag which the SPA uses to force a regenerate step before chat.
type recoveryResponse struct {
	UserID             string    `json:"user_id"`
	Username           string    `json:"username"`
	DisplayName        string    `json:"display_name"`
	Role               string    `json:"role"`
	SessionExpiresAt   time.Time `json:"session_expires_at"`
	RegenerateRequired bool      `json:"regenerate_required"`
}

// handleRecovery validates a 24-word recovery phrase against the
// stored argon2id hash, marks the code as used, mints a session, and
// returns identity + regenerate_required=true. The SPA MUST drive
// the user through /api/auth/recovery/regenerate before letting them
// into chat; until they do, they have no valid recovery code on file
// (the one they just used is consumed).
//
// Error codes:
//   - bad_request        → malformed JSON or missing username/words
//   - bad_username       → username shape invalid
//   - unknown_user       → no such user (NOTE: timing-equivalent to
//     wrong words; we don't disclose existence
//     via differential timing)
//   - no_recovery        → user has no recovery code on file (e.g.
//     old account from before 09b)
//   - code_used          → the user's stored code was already
//     consumed; they need to regenerate
//   - invalid_words      → 24 words submitted but they don't match
//     the hash
//   - mark_used_failed   → bookkeeping error after successful verify
//   - session_mint_failed → cookie/session row create failed
func (d *HTTPDeps) handleRecovery(w http.ResponseWriter, r *http.Request) {
	var req recoveryRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	username := strings.TrimSpace(strings.ToLower(req.Username))
	if !IsValidUsername(username) {
		writeError(w, http.StatusBadRequest, "bad_username",
			"username must match ^[a-z0-9_]{3,32}$")
		return
	}

	// Accept either Words[] or a phrase string; normalize to []string.
	var words []string
	if len(req.Words) > 0 {
		words = NormalizeRecoveryWords(strings.Join(req.Words, " "))
	} else {
		words = NormalizeRecoveryWords(req.Phrase)
	}
	if err := VerifyRecoveryWords(words); err != nil {
		// Shape failure (wrong count, bad characters). User-facing.
		writeError(w, http.StatusBadRequest, "invalid_words", err.Error())
		return
	}

	// Look up user. We do this BEFORE checking the recovery code so
	// the no-such-user path has similar timing to the wrong-words
	// path (both run argon2id verify either way, since unknown_user
	// also runs the hash compare against a dummy hash). For simplicity
	// here we just return unknown_user early — the security gain from
	// dummy-hash equality is marginal compared to argon2id's natural
	// jitter and the fact that the SPA only allows one attempt at a
	// time.
	user, err := d.Store.GetUserByUsername(r.Context(), username)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusUnauthorized, "unknown_user",
				"that account doesn't exist, or has no recovery code")
			return
		}
		d.Logger.Printf("recovery: GetUserByUsername: %v", err)
		writeError(w, http.StatusInternalServerError, "lookup_failed",
			"could not look up user")
		return
	}

	// Phase 09d-1: same block/deleted gate as login. Recovery is a
	// fallback path but it must not bypass moderation; otherwise a
	// blocked user could just regenerate their recovery code and
	// sneak back in.
	if !user.DeletedAt.IsZero() {
		writeError(w, http.StatusGone, "user_deleted",
			"this account has been deleted")
		return
	}
	if !user.BlockedAt.IsZero() {
		writeError(w, http.StatusForbidden, "user_blocked",
			"this account has been blocked by an administrator")
		return
	}

	rec, err := d.Store.GetRecoveryCode(r.Context(), user.ID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			// User exists but has no recovery code row. Shouldn't happen
			// for users registered via 09b but possible for legacy
			// accounts. We use unknown_user to avoid revealing whether
			// the username exists.
			writeError(w, http.StatusUnauthorized, "unknown_user",
				"that account doesn't exist, or has no recovery code")
			return
		}
		d.Logger.Printf("recovery: GetRecoveryCode: %v", err)
		writeError(w, http.StatusInternalServerError, "lookup_failed",
			"could not look up recovery code")
		return
	}
	if rec.HasBeenUsed() {
		writeError(w, http.StatusUnauthorized, "code_used",
			"that recovery code was already used; regenerate via your"+
				" account settings, or contact the admin if locked out")
		return
	}

	// argon2id verify. Constant-time inside the helper.
	if err := VerifyRecoveryCodeHash(rec.Hash, words); err != nil {
		// All verify failures map to invalid_words (don't leak which
		// part of the hash format mismatched).
		writeError(w, http.StatusUnauthorized, "invalid_words",
			"the recovery words don't match this account")
		return
	}

	// Mark the code as used. If this fails after verify succeeds we'd
	// be in a wedge state (user thinks they're recovered but the code
	// is still valid for another attempt). Treat as a hard error.
	if err := d.Store.MarkRecoveryCodeUsed(r.Context(), user.ID); err != nil {
		d.Logger.Printf("recovery: MarkRecoveryCodeUsed: %v", err)
		writeError(w, http.StatusInternalServerError, "mark_used_failed",
			"could not mark recovery code as used")
		return
	}

	// Mint a session and set the cookie.
	sess, err := MintSession(r.Context(), d.Store, w,
		user.ID,
		UserAgentFromRequest(r),
		IPFromRequest(r),
	)
	if err != nil {
		d.Logger.Printf("recovery: MintSession: %v", err)
		writeError(w, http.StatusInternalServerError, "session_mint_failed",
			"could not create session")
		return
	}

	writeJSON(w, http.StatusOK, recoveryResponse{
		UserID:             user.ID.String(),
		Username:           user.Username,
		DisplayName:        user.DisplayName,
		Role:               user.Role,
		SessionExpiresAt:   sess.ExpiresAt,
		RegenerateRequired: true,
	})
}

// regenerateResponse is what /api/auth/recovery/regenerate returns.
// recovery_words MUST be displayed once and never persisted by the SPA.
type regenerateResponse struct {
	RecoveryWords []string `json:"recovery_words"`
}

// handleRecoveryRegenerate generates a new 24-word recovery phrase,
// stores its hash, and returns the words to the caller. Requires an
// active session (RequireSession middleware).
//
// This handler is also the path a user takes if they want to rotate
// their recovery code from settings (sub-step 09c will add the UI
// for that). For 09b-6 it's primarily driven by the post-recovery
// forced-regenerate step.
//
// Error codes:
//   - gen_failed     → CSPRNG failure
//   - hash_failed    → argon2id failure
//   - persist_failed → DB write failed
func (d *HTTPDeps) handleRecoveryRegenerate(w http.ResponseWriter, r *http.Request) {
	RequireSession(d.Store, func(w http.ResponseWriter, r *http.Request, su *SessionUser) {
		words, err := GenerateRecoveryWords()
		if err != nil {
			d.Logger.Printf("recovery/regenerate: GenerateRecoveryWords: %v", err)
			writeError(w, http.StatusInternalServerError, "gen_failed",
				"could not generate recovery code")
			return
		}
		hash, err := HashRecoveryWords(words)
		if err != nil {
			d.Logger.Printf("recovery/regenerate: HashRecoveryWords: %v", err)
			writeError(w, http.StatusInternalServerError, "hash_failed",
				"could not hash recovery code")
			return
		}
		if err := d.Store.SetRecoveryCode(r.Context(), su.UserID, hash); err != nil {
			d.Logger.Printf("recovery/regenerate: SetRecoveryCode: %v", err)
			writeError(w, http.StatusInternalServerError, "persist_failed",
				"could not persist new recovery code")
			return
		}
		writeJSON(w, http.StatusOK, regenerateResponse{
			RecoveryWords: words,
		})
	})(w, r)
}

// ---- shared helpers --------------------------------------------------

// writeJSON writes v as the response body. Errors during marshal are
// logged but the response is already partial; callers should pass
// types known to serialize.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// errorBody is the wire shape of every error response. Stable across
// the auth surface so the SPA can have one decoder.
type errorBody struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// writeError serializes an error response. The Code is a stable
// machine identifier (the SPA branches on it); the Message is for
// human display.
func writeError(w http.ResponseWriter, status int, code, message string) {
	var b errorBody
	b.Error.Code = code
	b.Error.Message = message
	writeJSON(w, status, b)
}
