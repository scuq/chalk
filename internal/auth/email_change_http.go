package auth

// Phase 09c: email-change HTTP handlers.
//
// Two endpoints:
//
//   POST /api/auth/email-change                       (session)
//   POST /api/auth/verify-email-change/{token}        (no auth)
//
// Flow:
//   1. Authenticated user POSTs new_email to /email-change.
//   2. Server validates: shape OK, not blacklisted, not in
//      users.email anywhere, not in users.pending_email anywhere.
//   3. Server generates a 32-byte token, stores it via SetPendingEmail
//      with a 24h expiry.
//   4. Server sends a verification email to the NEW address with the
//      verification link. (Per the phase 09 plan, a notification email
//      ALSO goes to the OLD address. Implemented here.)
//   5. User clicks the link in their NEW inbox → SPA detects
//      ?verify_email=<token> in the URL → POSTs to
//      /verify-email-change/{token} → server finalizes the change.
//
// The verification step is session-optional: if the user is logged
// in, great; if their session has expired, the token alone authorizes
// the change. The token is single-use and tied to a specific user
// at SetPendingEmail time.

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/scuq/chalk/internal/store"
)

// EmailChangeTokenSize is the byte count for verification tokens.
// Same security margin as invite and session tokens.
const EmailChangeTokenSize = 32

// EmailChangeTTL is how long the pending email-change is valid. Per
// the phase 09 plan, 24 hours. Shorter than invite TTL because the
// user is already authenticated and can easily restart the flow.
const EmailChangeTTL = 24 * time.Hour

// emailChangeRequest is the SPA's input at POST /api/auth/email-change.
type emailChangeRequest struct {
	NewEmail string `json:"new_email"`
}

// emailChangeResponse is the response on success. The actual change
// isn't complete until the user clicks the verification link, so we
// return only metadata the SPA can use to render "we sent you an
// email" UX.
type emailChangeResponse struct {
	NewEmail  string    `json:"new_email"`
	ExpiresAt time.Time `json:"expires_at"`
}

// handleEmailChangeRequest starts a pending email change. Requires
// session.
//
// Validation:
//   - new email shape (looksLikeEmail)
//   - not the user's CURRENT email (would be a no-op)
//   - not blacklisted
//   - not currently bound to any users.email (active or soft-deleted)
//   - not currently in any users.pending_email
//
// On success, two emails are sent:
//   - verification: to the NEW address, containing the verify URL
//   - notification: to the OLD address, alerting the user that someone
//     initiated the change. If it wasn't them, ignoring the email
//     prevents the change.
func (d *HTTPDeps) handleEmailChangeRequest(w http.ResponseWriter, r *http.Request) {
	RequireSession(d.Store, func(w http.ResponseWriter, r *http.Request, su *SessionUser) {
		var req emailChangeRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "bad_json", err.Error())
			return
		}
		newEmail := strings.ToLower(strings.TrimSpace(req.NewEmail))
		if !looksLikeEmail(newEmail) {
			writeError(w, http.StatusBadRequest, "bad_email",
				"new email must contain @ and a domain")
			return
		}
		if strings.EqualFold(newEmail, su.Email) {
			writeError(w, http.StatusBadRequest, "same_email",
				"new email is the same as your current email")
			return
		}

		blocked, err := d.Store.IsEmailBlacklisted(r.Context(), newEmail)
		if err != nil {
			d.Logger.Printf("email-change: blacklist check: %v", err)
			writeError(w, http.StatusInternalServerError, "lookup_failed", "internal error")
			return
		}
		if blocked {
			writeError(w, http.StatusForbidden, "email_blacklisted",
				"that email cannot be used")
			return
		}

		// Collision with an existing user.email?
		if _, err := d.Store.GetUserByEmail(r.Context(), newEmail); err == nil {
			writeError(w, http.StatusConflict, "email_taken",
				"that email is already in use by another account")
			return
		} else if !errors.Is(err, store.ErrNotFound) {
			d.Logger.Printf("email-change: GetUserByEmail: %v", err)
			writeError(w, http.StatusInternalServerError, "lookup_failed", "internal error")
			return
		}

		// Generate token + persist pending state.
		tok := make([]byte, EmailChangeTokenSize)
		// Reuse the invite token generator's CSPRNG via the same path.
		if random, err := GenerateInviteToken(); err == nil {
			copy(tok, random)
		} else {
			d.Logger.Printf("email-change: GenerateInviteToken (for email-change token): %v", err)
			writeError(w, http.StatusInternalServerError, "gen_failed",
				"could not generate verification token")
			return
		}
		expiresAt := time.Now().Add(EmailChangeTTL)
		err = d.Store.SetPendingEmail(r.Context(), store.SetPendingEmailParams{
			UserID:    su.UserID,
			NewEmail:  newEmail,
			Token:     tok,
			ExpiresAt: expiresAt,
		})
		if errors.Is(err, store.ErrEmailTaken) {
			// Another user has the same pending change in flight.
			writeError(w, http.StatusConflict, "email_pending_elsewhere",
				"that email has a pending change for another account")
			return
		}
		if err != nil {
			d.Logger.Printf("email-change: SetPendingEmail: %v", err)
			writeError(w, http.StatusInternalServerError, "persist_failed",
				"could not persist pending email change")
			return
		}

		// Send the two emails. Mailer can be nil in tests; we log
		// loudly so the operator notices.
		verifyURL := BuildEmailChangeVerifyURL(d.PublicURL, EncodeInviteToken(tok))
		if d.Mailer != nil {
			verifyBody := buildEmailChangeVerifyBody(su.Username, verifyURL, expiresAt)
			if mailErr := d.Mailer.Send(r.Context(), newEmail,
				"Verify your new chalk email", verifyBody); mailErr != nil {
				d.Logger.Printf("email-change: send verify to new addr: %v", mailErr)
			}
			notifyBody := buildEmailChangeNotifyBody(su.Username, newEmail)
			if mailErr := d.Mailer.Send(r.Context(), su.Email,
				"Your chalk email is being changed", notifyBody); mailErr != nil {
				d.Logger.Printf("email-change: send notify to old addr: %v", mailErr)
			}
		} else {
			d.Logger.Printf("email-change: NO MAILER CONFIGURED; verify URL: %s", verifyURL)
		}

		writeJSON(w, http.StatusOK, emailChangeResponse{
			NewEmail:  newEmail,
			ExpiresAt: expiresAt,
		})
	})(w, r)
}

// verifyEmailChangeResponse is the response on successful finalize.
type verifyEmailChangeResponse struct {
	UserID   string `json:"user_id"`
	Email    string `json:"email"`
}

// handleVerifyEmailChange finalizes a pending email change. The
// token is in the URL path. Session-optional — the token alone
// authorizes the change because it was sent to the address being
// verified.
//
// Error codes:
//   - invite_invalid_shape (reused; the same shape-check applies)
//   - verify_failed: token doesn't match, expired, or no pending
//     change. We don't differentiate to avoid leaking which.
//   - email_taken: a race during the verification window where
//     another user grabbed the same email between SetPendingEmail
//     and the click. Vanishingly rare.
func (d *HTTPDeps) handleVerifyEmailChange(w http.ResponseWriter, r *http.Request) {
	encodedToken := r.PathValue("token")
	tokenBytes, err := DecodeInviteToken(encodedToken)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invite_invalid_shape",
			"verification token is malformed")
		return
	}
	userID, newEmail, err := d.Store.FinalizeEmailChange(r.Context(), tokenBytes)
	if errors.Is(err, store.ErrPendingEmailMismatch) {
		writeError(w, http.StatusGone, "verify_failed",
			"verification link is invalid, expired, or already used")
		return
	}
	if errors.Is(err, store.ErrEmailTaken) {
		writeError(w, http.StatusConflict, "email_taken",
			"that email was taken by another account before verification completed")
		return
	}
	if err != nil {
		d.Logger.Printf("email-change/verify: FinalizeEmailChange: %v", err)
		writeError(w, http.StatusInternalServerError, "verify_failed",
			"could not finalize email change")
		return
	}
	writeJSON(w, http.StatusOK, verifyEmailChangeResponse{
		UserID: userID.String(),
		Email:  newEmail,
	})
}

// buildEmailChangeVerifyBody composes the plaintext body sent to the
// NEW email address.
func buildEmailChangeVerifyBody(username, url string, expiresAt time.Time) string {
	var b strings.Builder
	b.WriteString("Hi,\r\n\r\n")
	b.WriteString("Someone (presumably you, @")
	b.WriteString(username)
	b.WriteString(") asked to change their chalk account's email to this address.\r\n\r\n")
	b.WriteString("To confirm, open this link in your browser:\r\n\r\n  ")
	b.WriteString(url)
	b.WriteString("\r\n\r\nThe link expires on ")
	b.WriteString(expiresAt.Format(time.RFC1123))
	b.WriteString(".\r\n\r\n")
	b.WriteString("If this wasn't you, ignore this email — the change will not take effect.\r\n\r\n")
	b.WriteString("— chalk\r\n")
	return b.String()
}

// buildEmailChangeNotifyBody composes the plaintext body sent to the
// OLD email address. Pure heads-up; no action link.
func buildEmailChangeNotifyBody(username, newEmail string) string {
	var b strings.Builder
	b.WriteString("Hi,\r\n\r\n")
	b.WriteString("Your chalk account @")
	b.WriteString(username)
	b.WriteString(" has a pending email change.\r\n\r\n")
	b.WriteString("New address: ")
	b.WriteString(newEmail)
	b.WriteString("\r\n\r\nIf this was you, no action is needed; click the link in the email sent to the new address to complete the change.\r\n\r\n")
	b.WriteString("If this WASN'T you, simply ignore both emails. The change requires confirmation from the new address, so without that click your current email will not change.\r\n\r\n")
	b.WriteString("If you suspect your account is compromised, log in and rotate your recovery code or contact the admin.\r\n\r\n")
	b.WriteString("— chalk\r\n")
	return b.String()
}
