// md-4: add a passkey to the authenticated account.
//
// Background: chalk's account auth is WebAuthn passkeys; the 24-word
// decryption phrase is a separate, client-only secret. A passkey is
// bound to its authenticator. If the user's passkeys do not sync
// (no iCloud Keychain / Google Password Manager, no hybrid/caBLE),
// a second device has no usable credential and the only way in is the
// one-time recovery code -- which is consumed per use and contended
// across devices. This file lets an ALREADY-AUTHENTICATED session
// enroll an additional passkey on the current device, so each device
// can hold its own credential.
//
// Flow (mirrors register/begin+finish and the admin-bootstrap handler,
// but attaches to the existing user instead of creating one):
//
//	POST /api/auth/passkeys/add/begin   (session)  -> WebAuthn options
//	POST /api/auth/passkeys/add/finish  (session)  -> persists the passkey
//	GET  /api/auth/passkeys             (session)  -> lists the account's passkeys
//
// Security notes:
//   - Both add endpoints are behind RequireSession; the ceremony is
//     bound to the session user's ID at begin time and re-checked at
//     finish time (a ceremony begun by user A cannot be completed by
//     a session authenticated as user B).
//   - The user's existing credentials are passed to BeginRegistration
//     as the exclude list, so the same authenticator cannot be
//     double-enrolled.
//   - No recovery code is minted (the account already has one) and no
//     new session is created (the caller is already authenticated).

package auth

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/scuq/chalk/internal/store"
)

// maxPasskeyNameLen caps the user-supplied label for a passkey. Empty
// names are allowed (stored NULL; the SPA shows a default).
const maxPasskeyNameLen = 64

// addPasskeyFinishRequest is the SPA's input at add/finish: the raw
// PublicKeyCredential from the authenticator plus an optional label.
type addPasskeyFinishRequest struct {
	Credential json.RawMessage `json:"credential"`
	Name       string          `json:"name"`
}

// passkeyDTO is the wire shape for a single passkey in list/finish
// responses. CredentialID is base64url-encoded; timestamps are unix
// millis (last_used_at omitted when the passkey has never been used).
type passkeyDTO struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Transports []string `json:"transports"`
	CreatedAt  int64    `json:"created_at"`
	LastUsedAt int64    `json:"last_used_at,omitempty"`
}

type addPasskeyFinishResponse struct {
	Passkey passkeyDTO `json:"passkey"`
}

type listPasskeysResponse struct {
	Passkeys []passkeyDTO `json:"passkeys"`
}

// passkeyToDTO converts a stored passkey into the wire shape.
func passkeyToDTO(pk store.Passkey) passkeyDTO {
	dto := passkeyDTO{
		ID:         base64.RawURLEncoding.EncodeToString(pk.CredentialID),
		Name:       pk.Name,
		Transports: pk.Transports,
		CreatedAt:  pk.CreatedAt.UnixMilli(),
	}
	if dto.Transports == nil {
		dto.Transports = []string{}
	}
	if !pk.LastUsedAt.IsZero() {
		dto.LastUsedAt = pk.LastUsedAt.UnixMilli()
	}
	return dto
}

// sanitizePasskeyName trims and length-caps a user-supplied label. An
// empty result is valid (the store persists it as NULL).
func sanitizePasskeyName(raw string) string {
	n := strings.TrimSpace(raw)
	if len(n) > maxPasskeyNameLen {
		n = n[:maxPasskeyNameLen]
	}
	return n
}

// handleAddPasskeyBegin starts an add-passkey ceremony for the
// authenticated user. The user's existing credentials become the
// WebAuthn exclude list so the same authenticator is not enrolled
// twice. The pending ceremony is cached under its challenge, tagged
// IsAddPasskey and bound to the session user's ID.
func (d *HTTPDeps) handleAddPasskeyBegin(w http.ResponseWriter, r *http.Request, su *SessionUser) {
	passkeys, err := d.Store.GetPasskeysForUser(r.Context(), su.UserID)
	if err != nil {
		d.Logger.Printf("passkeys/add/begin: list passkeys: %v", err)
		writeError(w, http.StatusInternalServerError, "lookup_failed", "internal error")
		return
	}
	creds := make([]webauthn.Credential, 0, len(passkeys))
	for _, pk := range passkeys {
		creds = append(creds, passkeyToWebauthnCredential(pk))
	}

	wauthUser := &User{
		ID:          su.UserID,
		Name:        su.Username,
		DisplayName: su.DisplayName,
		Credentials: creds, // -> excludeCredentials
	}
	options, sess, err := d.Service.BeginRegistration(wauthUser)
	if err != nil {
		d.Logger.Printf("passkeys/add/begin: BeginRegistration: %v", err)
		writeError(w, http.StatusInternalServerError, "ceremony_failed",
			"could not start ceremony")
		return
	}

	d.Cache.Put(sess.Challenge, CeremonyEntry{
		Kind:    KindRegistration,
		Session: *sess,
		PendingUser: PendingUser{
			ID:           su.UserID,
			Username:     su.Username,
			DisplayName:  su.DisplayName,
			IsAddPasskey: true,
		},
	})

	writeJSON(w, http.StatusOK, registerBeginResponse{Options: options})
}

// handleAddPasskeyFinish completes an add-passkey ceremony and persists
// the new credential against the authenticated user. No recovery code
// is minted and no session is created.
func (d *HTTPDeps) handleAddPasskeyFinish(w http.ResponseWriter, r *http.Request, su *SessionUser) {
	var req addPasskeyFinishRequest
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
				"add-passkey ceremony expired; start over")
			return
		}
		writeError(w, http.StatusNotFound, "ceremony_not_found",
			"no matching add-passkey ceremony")
		return
	}
	if entry.Kind != KindRegistration || !entry.PendingUser.IsAddPasskey {
		writeError(w, http.StatusBadRequest, "wrong_ceremony",
			"that challenge is not an add-passkey ceremony")
		return
	}
	// The ceremony must belong to the authenticated user. begin binds
	// the session user's ID; re-check it here so a ceremony cannot be
	// completed under a different session.
	if entry.PendingUser.ID != su.UserID {
		writeError(w, http.StatusForbidden, "ceremony_user_mismatch",
			"that ceremony belongs to a different account")
		return
	}

	wauthUser := &User{
		ID:          su.UserID,
		Name:        su.Username,
		DisplayName: su.DisplayName,
		Credentials: nil,
	}
	cred, err := d.Service.FinishRegistration(wauthUser, entry.Session, parsed)
	if err != nil {
		d.Logger.Printf("passkeys/add/finish: FinishRegistration: %v", err)
		writeError(w, http.StatusBadRequest, "ceremony_validation_failed",
			err.Error())
		return
	}

	transports := make([]string, 0, len(cred.Transport))
	for _, t := range cred.Transport {
		transports = append(transports, string(t))
	}

	pk, err := d.Store.AddPasskey(r.Context(),
		cred.ID, su.UserID, cred.PublicKey,
		uint64(cred.Authenticator.SignCount), transports,
		sanitizePasskeyName(req.Name),
	)
	if err != nil {
		d.Logger.Printf("passkeys/add/finish: AddPasskey: %v", err)
		writeError(w, http.StatusInternalServerError, "persist_failed",
			"could not persist passkey")
		return
	}

	writeJSON(w, http.StatusOK, addPasskeyFinishResponse{Passkey: passkeyToDTO(pk)})
}

// handleListPasskeys returns the authenticated user's passkeys.
func (d *HTTPDeps) handleListPasskeys(w http.ResponseWriter, r *http.Request, su *SessionUser) {
	passkeys, err := d.Store.GetPasskeysForUser(r.Context(), su.UserID)
	if err != nil {
		d.Logger.Printf("passkeys/list: %v", err)
		writeError(w, http.StatusInternalServerError, "lookup_failed", "internal error")
		return
	}
	dtos := make([]passkeyDTO, 0, len(passkeys))
	for _, pk := range passkeys {
		dtos = append(dtos, passkeyToDTO(pk))
	}
	writeJSON(w, http.StatusOK, listPasskeysResponse{Passkeys: dtos})
}

// handleDeletePasskey removes a passkey from the authenticated account.
// The {id} path segment is the base64url credential id. The user's last
// passkey is protected: deleting it would strand the account on
// recovery-code-only, so it is refused (409 last_passkey) until another
// passkey is enrolled.
func (d *HTTPDeps) handleDeletePasskey(w http.ResponseWriter, r *http.Request, su *SessionUser) {
	idParam := r.PathValue("id")
	if idParam == "" {
		writeError(w, http.StatusBadRequest, "bad_id", "passkey id required")
		return
	}
	credID, err := base64.RawURLEncoding.DecodeString(idParam)
	if err != nil || len(credID) == 0 {
		writeError(w, http.StatusBadRequest, "bad_id", "malformed passkey id")
		return
	}

	switch err := d.Store.DeletePasskeyForUser(r.Context(), credID, su.UserID); {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "passkey_not_found",
			"no such passkey on this account")
	case errors.Is(err, store.ErrLastPasskey):
		writeError(w, http.StatusConflict, "last_passkey",
			"can't remove your only passkey; add another first")
	default:
		d.Logger.Printf("passkeys/delete: %v", err)
		writeError(w, http.StatusInternalServerError, "delete_failed",
			"could not delete passkey")
	}
}
