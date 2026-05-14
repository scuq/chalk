package auth

// Phase 09c: invite HTTP handlers.
//
// Endpoints in this file:
//
//   POST   /api/invites               (session) Create invite + send email
//   GET    /api/invites/mine          (session) List my invites
//   DELETE /api/invites/{token}       (session) Revoke my invite
//   GET    /api/auth/invite/{token}   (no auth) Peek invite for SPA
//
// The peek endpoint is intentionally public: it's how the invitee's
// SPA renders the pre-filled registration screen ("you've been invited
// by @scuq as alice@example.com"). It reveals only the invite's
// minimal display fields, never the inviter's email or other PII.

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/scuq/chalk/internal/store"
)

// ---- request / response shapes -----------------------------------------

// createInviteRequest is the SPA's input at POST /api/invites.
type createInviteRequest struct {
	Email string `json:"email"`
	Note  string `json:"note,omitempty"`
}

// inviteDTO is the wire shape of an invite in API responses. We send
// the token in encoded form (base64url, no padding) so the SPA can
// drop it directly into ?invite= URLs.
type inviteDTO struct {
	Token           string    `json:"token"`
	Email           string    `json:"email"`
	InviterID       string    `json:"inviter_id"`
	InviterUsername string    `json:"inviter_username,omitempty"`
	Note            string    `json:"note,omitempty"`
	CreatedAt       time.Time `json:"created_at"`
	ExpiresAt       time.Time `json:"expires_at"`
	UsedAt          *time.Time `json:"used_at,omitempty"`
	RevokedAt       *time.Time `json:"revoked_at,omitempty"`
	Status          string    `json:"status"` // "active"|"used"|"revoked"|"expired"
	URL             string    `json:"url,omitempty"` // BuildInviteURL output; nice-to-have
}

// inviteToDTO converts a store.Invite (+ optional inviter username +
// public URL) into the wire shape. Pointers for nullable timestamps
// so JSON omits them when zero.
func (d *HTTPDeps) inviteToDTO(inv store.Invite, inviterUsername string) inviteDTO {
	dto := inviteDTO{
		Token:           EncodeInviteToken(inv.Token),
		Email:           inv.Email,
		InviterID:       inv.InviterID.String(),
		InviterUsername: inviterUsername,
		Note:            inv.Note,
		CreatedAt:       inv.CreatedAt,
		ExpiresAt:       inv.ExpiresAt,
		Status:          inv.Status(),
	}
	if !inv.UsedAt.IsZero() {
		t := inv.UsedAt
		dto.UsedAt = &t
	}
	if !inv.RevokedAt.IsZero() {
		t := inv.RevokedAt
		dto.RevokedAt = &t
	}
	// Include the share URL only for invites in a state where it's
	// still meaningful (active). Used/revoked/expired invites get
	// no URL because the SPA shouldn't be encouraging re-share of
	// dead tokens.
	if inv.IsActive() {
		dto.URL = BuildInviteURL(d.PublicURL, dto.Token)
	}
	return dto
}

// peekInviteResponse is the public response shape at GET /api/auth/invite/{token}.
// Deliberately minimal: just enough for the SPA to render the
// "you've been invited" screen. NO inviter PII beyond the public
// username.
type peekInviteResponse struct {
	Email           string    `json:"email"`
	InviterUsername string    `json:"inviter_username"`
	ExpiresAt       time.Time `json:"expires_at"`
	Status          string    `json:"status"`
}

// ---- handlers ---------------------------------------------------------

// handleCreateInvite issues a new invite. Requires an authenticated
// session.
//
// Validation:
//   - email shape (looksLikeEmail; same as registration)
//   - email not currently in users.email
//   - email not currently in users.pending_email
//   - email not blacklisted
//   - inviter has no active invite to this email already (enforced by
//     the partial unique index; surfaces as ErrInviteEmailActive)
//
// On success:
//   - Persists the invite row
//   - Sends an email to the invitee (or logs to stderr if no SMTP host
//     is configured) with the invite URL
//   - Returns the full inviteDTO so the SPA's InvitesPanel can render
//     it immediately
func (d *HTTPDeps) handleCreateInvite(w http.ResponseWriter, r *http.Request) {
	RequireSession(d.Store, func(w http.ResponseWriter, r *http.Request, su *SessionUser) {
		var req createInviteRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "bad_json", err.Error())
			return
		}
		email := strings.ToLower(strings.TrimSpace(req.Email))
		note := strings.TrimSpace(req.Note)
		if !looksLikeEmail(email) {
			writeError(w, http.StatusBadRequest, "bad_email",
				"email must contain @ and a domain")
			return
		}
		if len(note) > 500 {
			writeError(w, http.StatusBadRequest, "note_too_long",
				"note must be 500 characters or fewer")
			return
		}

		// Validation: email must not be already-in-use or blacklisted.
		if _, err := d.Store.GetUserByEmail(r.Context(), email); err == nil {
			writeError(w, http.StatusConflict, "email_taken",
				"that email already belongs to a user")
			return
		} else if !errors.Is(err, store.ErrNotFound) {
			d.Logger.Printf("invites/create: GetUserByEmail: %v", err)
			writeError(w, http.StatusInternalServerError, "lookup_failed", "internal error")
			return
		}
		blocked, err := d.Store.IsEmailBlacklisted(r.Context(), email)
		if err != nil {
			d.Logger.Printf("invites/create: blacklist check: %v", err)
			writeError(w, http.StatusInternalServerError, "lookup_failed", "internal error")
			return
		}
		if blocked {
			writeError(w, http.StatusForbidden, "email_blacklisted",
				"that email cannot be invited")
			return
		}

		// Generate token + persist.
		tok, err := GenerateInviteToken()
		if err != nil {
			d.Logger.Printf("invites/create: GenerateInviteToken: %v", err)
			writeError(w, http.StatusInternalServerError, "gen_failed",
				"could not generate invite token")
			return
		}
		expiresAt := time.Now().Add(InviteTTL())
		inv, err := d.Store.CreateInvite(r.Context(), store.CreateInviteParams{
			Token:     tok,
			Email:     email,
			InviterID: su.UserID,
			Note:      note,
			ExpiresAt: expiresAt,
		})
		if errors.Is(err, store.ErrInviteEmailActive) {
			writeError(w, http.StatusConflict, "invite_active",
				"an active invite already exists for this email")
			return
		}
		if err != nil {
			d.Logger.Printf("invites/create: CreateInvite: %v", err)
			writeError(w, http.StatusInternalServerError, "persist_failed",
				"could not persist invite")
			return
		}

		// Send the email. The Mailer interface handles SMTP vs stderr
		// fallback internally. Best-effort: if mail fails, the invite
		// row stays (the inviter can copy-share the URL from the
		// response).
		dto := d.inviteToDTO(inv, su.Username)
		if d.Mailer != nil {
			body := buildInviteEmailBody(su.Username, su.DisplayName, dto.URL, note, expiresAt)
			if mailErr := d.Mailer.Send(r.Context(), email,
				"You've been invited to chalk", body); mailErr != nil {
				// Don't fail the request; surface to logs only.
				d.Logger.Printf("invites/create: Mailer.Send: %v", mailErr)
			}
		} else {
			d.Logger.Printf("invites/create: NO MAILER CONFIGURED; invite URL: %s", dto.URL)
		}

		writeJSON(w, http.StatusCreated, dto)
	})(w, r)
}

// handleListMyInvites returns the caller's invites, newest first.
// Includes every status; the SPA filters/groups as it sees fit.
func (d *HTTPDeps) handleListMyInvites(w http.ResponseWriter, r *http.Request) {
	RequireSession(d.Store, func(w http.ResponseWriter, r *http.Request, su *SessionUser) {
		invites, err := d.Store.ListInvitesByInviter(r.Context(), su.UserID)
		if err != nil {
			d.Logger.Printf("invites/list: %v", err)
			writeError(w, http.StatusInternalServerError, "lookup_failed",
				"could not list invites")
			return
		}
		dtos := make([]inviteDTO, 0, len(invites))
		for _, inv := range invites {
			dtos = append(dtos, d.inviteToDTO(inv, su.Username))
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"invites": dtos,
		})
	})(w, r)
}

// handleRevokeInvite revokes a pending invite. The token is in the URL
// path. Owner-checked at the store layer; non-owners get 404 rather
// than 403 (don't disclose token existence).
func (d *HTTPDeps) handleRevokeInvite(w http.ResponseWriter, r *http.Request) {
	RequireSession(d.Store, func(w http.ResponseWriter, r *http.Request, su *SessionUser) {
		encodedToken := r.PathValue("token")
		tokenBytes, err := DecodeInviteToken(encodedToken)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invite_invalid_shape",
				"invite token is malformed")
			return
		}
		err = d.Store.RevokeInvite(r.Context(), tokenBytes, su.UserID)
		switch {
		case err == nil:
			w.WriteHeader(http.StatusNoContent)
			return
		case errors.Is(err, store.ErrNotFound):
			writeError(w, http.StatusNotFound, "invite_not_found",
				"invite not found")
			return
		case errors.Is(err, store.ErrInviteNotUsable):
			writeError(w, http.StatusConflict, "invite_not_active",
				"invite is no longer active (already used, revoked, or expired)")
			return
		default:
			d.Logger.Printf("invites/revoke: %v", err)
			writeError(w, http.StatusInternalServerError, "revoke_failed",
				"could not revoke invite")
			return
		}
	})(w, r)
}

// handlePeekInvite is the public lookup the invitee's SPA calls at
// boot when ?invite=<token> is in the URL. Returns minimal display
// info; 404 for unknown tokens; 410 Gone for known-but-inactive
// tokens (used / revoked / expired) so the SPA can show an
// appropriate message ("this invite has been used") rather than the
// pre-fill screen.
func (d *HTTPDeps) handlePeekInvite(w http.ResponseWriter, r *http.Request) {
	encodedToken := r.PathValue("token")
	tokenBytes, err := DecodeInviteToken(encodedToken)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invite_invalid_shape",
			"invite token is malformed")
		return
	}
	inv, err := d.Store.GetInvite(r.Context(), tokenBytes)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "invite_not_found",
			"invite not found")
		return
	}
	if err != nil {
		d.Logger.Printf("invites/peek: %v", err)
		writeError(w, http.StatusInternalServerError, "lookup_failed",
			"could not look up invite")
		return
	}
	// Look up inviter for the display name. If the inviter was
	// hard-deleted between issuance and peek, the FK CASCADE would
	// have removed the invite row — so a successful GetInvite means
	// the inviter row still exists. Edge case: if the lookup fails
	// transiently, surface as 500 rather than 404.
	inviter, err := d.Store.GetUserByID(r.Context(), inv.InviterID)
	if err != nil {
		d.Logger.Printf("invites/peek: GetUserByID(inviter %s): %v",
			inv.InviterID, err)
		writeError(w, http.StatusInternalServerError, "lookup_failed",
			"could not look up inviter")
		return
	}

	resp := peekInviteResponse{
		Email:           inv.Email,
		InviterUsername: inviter.Username,
		ExpiresAt:       inv.ExpiresAt,
		Status:          inv.Status(),
	}
	// Active → 200; everything else → 410 Gone with the resp so the
	// SPA can distinguish "still works" from "exists but unusable".
	if inv.IsActive() {
		writeJSON(w, http.StatusOK, resp)
		return
	}
	writeJSON(w, http.StatusGone, resp)
}

// buildInviteEmailBody constructs the plaintext body of the invite
// email. Plain text only — chalk's email needs are simple and text
// renders consistently across every client.
func buildInviteEmailBody(inviterUsername, inviterDisplayName, url, note string, expiresAt time.Time) string {
	var b strings.Builder
	inviterLine := "@" + inviterUsername
	if inviterDisplayName != "" && inviterDisplayName != inviterUsername {
		inviterLine = inviterDisplayName + " (@" + inviterUsername + ")"
	}
	b.WriteString("Hi,\r\n\r\n")
	b.WriteString(inviterLine)
	b.WriteString(" has invited you to chalk.\r\n\r\n")
	if note != "" {
		b.WriteString("They left this note:\r\n  ")
		b.WriteString(note)
		b.WriteString("\r\n\r\n")
	}
	b.WriteString("To accept, open this link in your browser:\r\n\r\n  ")
	b.WriteString(url)
	b.WriteString("\r\n\r\n")
	b.WriteString("The invite expires on ")
	b.WriteString(expiresAt.Format(time.RFC1123))
	b.WriteString(".\r\n\r\n")
	b.WriteString("If you weren't expecting this invitation, you can ignore this email; the link will lapse on its own.\r\n\r\n")
	b.WriteString("— chalk\r\n")
	return b.String()
}

// buildInviteEmailBody is documented above; this file ends here.
