package auth

// Phase 09d-1: admin bootstrap passkey enrollment.
//
// The endpoints in this file complete the first-run admin setup that
// began at chalkd startup. Startup:
//
//   1. The operator set CHALK_ADMIN_USERNAME + CHALK_ADMIN_EMAIL.
//   2. chalkd noticed no users.role='admin' row existed yet, inserted
//      one with no passkey (BootstrapAdminUser), and minted a one-
//      time 32-byte bootstrap token (CreateAdminBootstrapToken),
//      printing the URL to stderr.
//
// This file's endpoints take it from there:
//
//   POST /api/admin/bootstrap/begin  — accept token, start WebAuthn
//                                       attestation ceremony
//   POST /api/admin/bootstrap/finish — finish attestation, attach
//                                       passkey to the admin row,
//                                       store recovery code, consume
//                                       the token, mint a session
//
// Both endpoints are UNAUTHENTICATED in the session sense. The
// bootstrap token IS the auth credential. The token is single-use,
// expires 24h after creation, and unlocks exactly one capability:
// enrolling the passkey on the admin row that already exists.

import (
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/protocol"

	"github.com/scuq/chalk/internal/store"
)

// MountAdminBootstrap registers the two admin-bootstrap endpoints
// on mux. Separate from MountAdmin because these are unauthenticated
// (the bootstrap token is the credential); mixing them with the
// admin-only endpoints risks a routing mistake exposing
// /api/admin/users without RequireAdmin.
func (d *HTTPDeps) MountAdminBootstrap(mux *http.ServeMux) error {
	if d.Store == nil || d.Service == nil || d.Cache == nil {
		return fmt.Errorf("auth.MountAdminBootstrap: Store, Service, Cache required")
	}
	if d.Logger == nil {
		d.Logger = log.Default()
	}
	mux.HandleFunc("POST /api/admin/bootstrap/begin", d.handleAdminBootstrapBegin)
	mux.HandleFunc("POST /api/admin/bootstrap/finish", d.handleAdminBootstrapFinish)
	return nil
}

// ---- request / response shapes -----------------------------------------

// adminBootstrapBeginRequest is the body of /begin. The token is
// the base64url-encoded 32 bytes printed to stderr at startup.
type adminBootstrapBeginRequest struct {
	Token string `json:"token"`
}

// adminBootstrapBeginResponse echoes the WebAuthn options to the
// SPA, exactly like registerBeginResponse.
type adminBootstrapBeginResponse struct {
	Options *protocol.CredentialCreation `json:"options"`
}

// adminBootstrapFinishRequest mirrors registerFinishRequest. The raw
// JSON credential is parsed by go-webauthn.
type adminBootstrapFinishRequest struct {
	Credential json.RawMessage `json:"credential"`
}

// adminBootstrapFinishResponse returns the freshly-minted session +
// recovery words. Same shape as registerFinishResponse with the
// role echoed back for clarity (always "admin" here).
type adminBootstrapFinishResponse struct {
	UserID           string    `json:"user_id"`
	Username         string    `json:"username"`
	DisplayName      string    `json:"display_name"`
	Role             string    `json:"role"`
	RecoveryWords    []string  `json:"recovery_words"`
	SessionExpiresAt time.Time `json:"session_expires_at"`
}

// ---- handlers ----------------------------------------------------------

// handleAdminBootstrapBegin validates the bootstrap token, resolves
// the admin row, and starts a WebAuthn attestation ceremony for the
// admin's first passkey.
//
// The token is NOT consumed here. A network glitch between begin and
// finish would burn the token if we consumed it now. Token
// consumption is deferred to /finish.
func (d *HTTPDeps) handleAdminBootstrapBegin(w http.ResponseWriter, r *http.Request) {
	var req adminBootstrapBeginRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	tokenBytes, err := decodeBootstrapToken(req.Token)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_token",
			"bootstrap token is malformed")
		return
	}

	// Resolve the active token. The active-token getter is a
	// "find any active" lookup; we compare its bytes against the
	// submitted token to confirm THIS specific token is the active
	// one. A constant-time compare ensures we don't leak a timing
	// oracle (the token is 32 bytes of secret).
	active, err := d.Store.GetActiveAdminBootstrapToken(r.Context())
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusGone, "no_active_token",
				"no active admin bootstrap token; ask the operator to reissue")
			return
		}
		d.Logger.Printf("admin/bootstrap/begin: GetActiveAdminBootstrapToken: %v", err)
		writeError(w, http.StatusInternalServerError, "lookup_failed",
			"could not look up bootstrap token")
		return
	}
	if subtle.ConstantTimeCompare(active.Token, tokenBytes) != 1 {
		writeError(w, http.StatusForbidden, "token_mismatch",
			"that bootstrap token is not the active one")
		return
	}

	// Resolve the admin row. It must exist because startup mints
	// the token AFTER inserting the admin row; the only way to be
	// here without an admin row is if a human deleted the row via
	// raw SQL (the trigger blocks normal DELETE).
	adminUser, err := d.Store.GetAdminUser(r.Context())
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusInternalServerError, "no_admin_row",
				"bootstrap token exists but admin row is missing; operator intervention required")
			return
		}
		d.Logger.Printf("admin/bootstrap/begin: GetAdminUser: %v", err)
		writeError(w, http.StatusInternalServerError, "lookup_failed",
			"could not look up admin user")
		return
	}

	// Refuse if the admin already has a passkey. The bootstrap is
	// for the FIRST passkey; subsequent passkey enrollment goes
	// through the normal authenticated flow. A token that's still
	// active but the admin is enrolled implies the operator never
	// completed the bootstrap (e.g. lost the URL); the right
	// response is to direct them to regular login + recovery rather
	// than re-bootstrapping.
	passkeys, err := d.Store.GetPasskeysForUser(r.Context(), adminUser.ID)
	if err != nil {
		d.Logger.Printf("admin/bootstrap/begin: GetPasskeysForUser: %v", err)
		writeError(w, http.StatusInternalServerError, "lookup_failed",
			"could not list admin passkeys")
		return
	}
	if len(passkeys) > 0 {
		writeError(w, http.StatusConflict, "admin_already_enrolled",
			"the admin already has a passkey; use the regular login flow")
		return
	}

	// Standard WebAuthn attestation flow, but with the existing
	// admin user identity rather than a fresh PendingUser.
	wauthUser := &User{
		ID:          adminUser.ID,
		Name:        adminUser.Username,
		DisplayName: adminUser.DisplayName,
		Credentials: nil,
	}
	options, sess, err := d.Service.BeginRegistration(wauthUser)
	if err != nil {
		d.Logger.Printf("admin/bootstrap/begin: BeginRegistration: %v", err)
		writeError(w, http.StatusInternalServerError, "ceremony_failed",
			"could not start ceremony")
		return
	}

	// Stash the ceremony with the admin's existing identity.
	// IsAdminBootstrap distinguishes this from a regular
	// registration so /finish takes the bootstrap path (attach
	// passkey on existing row + consume token) instead of the full
	// RegisterUser transactional insert (which would refuse on
	// username/email collision against our own admin row).
	d.Cache.Put(sess.Challenge, CeremonyEntry{
		Kind:    KindRegistration,
		Session: *sess,
		PendingUser: PendingUser{
			ID:               adminUser.ID,
			Username:         adminUser.Username,
			DisplayName:      adminUser.DisplayName,
			Email:            adminUser.Email,
			IsAdminBootstrap: true,
			BootstrapToken:   append([]byte(nil), active.Token...),
		},
	})

	writeJSON(w, http.StatusOK, adminBootstrapBeginResponse{Options: options})
}

// handleAdminBootstrapFinish completes the WebAuthn attestation,
// inserts the passkey on the admin row, installs the recovery code,
// consumes the bootstrap token, and mints a session.
//
// This is the ONE chance to view the recovery words; cache-control
// no-store prevents intermediate caching.
//
// Partial-failure handling: between AddPasskey and
// ConsumeAdminBootstrapToken, a failure of either of the latter two
// is logged but doesn't fail the response. Rationale:
//   - If AddPasskey succeeded but SetRecoveryCode fails, the admin
//     has a passkey but no recovery code. They can regenerate via
//     /api/auth/recovery/regenerate after logging in.
//   - If both above succeeded but ConsumeAdminBootstrapToken fails,
//     the token remains active but the "admin already enrolled"
//     guard in /begin fires on any further attempt.
//
// Neither state is dangerous.
func (d *HTTPDeps) handleAdminBootstrapFinish(w http.ResponseWriter, r *http.Request) {
	var req adminBootstrapFinishRequest
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
				"bootstrap ceremony expired; start over")
			return
		}
		writeError(w, http.StatusNotFound, "ceremony_not_found",
			"no matching bootstrap ceremony")
		return
	}
	if entry.Kind != KindRegistration || !entry.PendingUser.IsAdminBootstrap {
		writeError(w, http.StatusBadRequest, "wrong_ceremony",
			"that challenge is not an admin bootstrap")
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
		d.Logger.Printf("admin/bootstrap/finish: FinishRegistration: %v", err)
		writeError(w, http.StatusBadRequest, "ceremony_validation_failed",
			err.Error())
		return
	}

	// Recovery words. Same hash-then-store pattern as
	// register/finish. Done OUTSIDE any transaction because argon2id
	// is slow (~100ms) and the writes after this are independent.
	words, err := GenerateRecoveryWords()
	if err != nil {
		d.Logger.Printf("admin/bootstrap/finish: GenerateRecoveryWords: %v", err)
		writeError(w, http.StatusInternalServerError, "recovery_gen_failed",
			"could not generate recovery code")
		return
	}
	hash, err := HashRecoveryWords(words)
	if err != nil {
		d.Logger.Printf("admin/bootstrap/finish: HashRecoveryWords: %v", err)
		writeError(w, http.StatusInternalServerError, "recovery_hash_failed",
			"could not hash recovery code")
		return
	}

	transports := make([]string, 0, len(cred.Transport))
	for _, t := range cred.Transport {
		transports = append(transports, string(t))
	}

	// Three writes: passkey, recovery code, token-consumption.
	// Sequential (not one tx) because the store doesn't expose
	// shared-tx variants for these methods today. The recovery
	// states are documented in the function header.
	if _, err := d.Store.AddPasskey(r.Context(),
		cred.ID, entry.PendingUser.ID, cred.PublicKey,
		uint64(cred.Authenticator.SignCount), transports,
		"Primary passkey",
	); err != nil {
		d.Logger.Printf("admin/bootstrap/finish: AddPasskey: %v", err)
		writeError(w, http.StatusInternalServerError, "persist_failed",
			"could not persist passkey")
		return
	}
	if err := d.Store.SetRecoveryCode(r.Context(),
		entry.PendingUser.ID, hash,
	); err != nil {
		d.Logger.Printf("admin/bootstrap/finish: SetRecoveryCode FAILED (admin enrolled "+
			"but no recovery code): %v", err)
		// Continue; the passkey is in place. Words are still shown.
	}
	if err := d.Store.ConsumeAdminBootstrapToken(r.Context(),
		entry.PendingUser.BootstrapToken,
	); err != nil {
		d.Logger.Printf("admin/bootstrap/finish: ConsumeAdminBootstrapToken FAILED "+
			"(non-fatal; admin is enrolled): %v", err)
	}

	sess, err := MintSession(r.Context(), d.Store, w,
		entry.PendingUser.ID,
		UserAgentFromRequest(r),
		IPFromRequest(r),
	)
	if err != nil {
		d.Logger.Printf("admin/bootstrap/finish: MintSession FAILED: %v", err)
		// Continue; the admin IS enrolled. They can log in normally.
	}

	w.Header().Set("Cache-Control", "no-store, private")
	writeJSON(w, http.StatusOK, adminBootstrapFinishResponse{
		UserID:           entry.PendingUser.ID.String(),
		Username:         entry.PendingUser.Username,
		DisplayName:      entry.PendingUser.DisplayName,
		Role:             "admin",
		RecoveryWords:    words,
		SessionExpiresAt: sess.ExpiresAt,
	})
}

// ---- helpers -----------------------------------------------------------

// decodeBootstrapToken accepts the base64url-encoded form printed at
// startup and returns the raw 32 bytes. Strips whitespace (operators
// sometimes paste with a newline) and accepts the padded form too.
func decodeBootstrapToken(s string) ([]byte, error) {
	// Strip whitespace.
	clean := strings.Map(func(r rune) rune {
		switch r {
		case ' ', '\n', '\r', '\t':
			return -1
		}
		return r
	}, s)
	tok, err := base64.RawURLEncoding.DecodeString(clean)
	if err != nil {
		// Fallback to the padded form for clipboard helpers that
		// added '='. The two encodings differ only in padding so
		// the byte-level result is the same.
		var err2 error
		tok, err2 = base64.URLEncoding.DecodeString(clean)
		if err2 != nil {
			return nil, fmt.Errorf("decode token: %w", err)
		}
	}
	if len(tok) != 32 {
		return nil, fmt.Errorf("token length = %d, want 32", len(tok))
	}
	return tok, nil
}

// PrintBootstrapURL formats and writes the bootstrap message to the
// given writer (typically stderr). Pulled out of cmd/chalkd so the
// test suite can verify the exact format without spawning a process.
//
// The Postgres init "password is in stderr" message inspired the
// shape: a clear banner, the URL, and an explicit "won't be shown
// again" hint. PublicURL is the externally-visible origin (e.g.
// "https://chalk.example.com"); empty publicURL falls back to
// "<HOST>" as a placeholder.
func PrintBootstrapURL(
	w interface {
		Write(p []byte) (n int, err error)
	},
	publicURL string,
	token []byte,
	expiresAt time.Time,
) (int, error) {
	encoded := base64.RawURLEncoding.EncodeToString(token)
	origin := strings.TrimRight(publicURL, "/")
	if origin == "" {
		origin = "<HOST>"
	}
	msg := fmt.Sprintf(
		"\n"+
			"========================================================================\n"+
			"  CHALK ADMIN BOOTSTRAP\n"+
			"  Visit this URL within 24 hours to register your admin passkey:\n"+
			"\n"+
			"    %s/?admin_bootstrap=%s\n"+
			"\n"+
			"  This URL expires at %s and will NOT be shown again.\n"+
			"  To reissue: restart chalkd with no active token (TODO: CLI subcommand).\n"+
			"========================================================================\n\n",
		origin, encoded, expiresAt.UTC().Format(time.RFC3339),
	)
	return w.Write([]byte(msg))
}
