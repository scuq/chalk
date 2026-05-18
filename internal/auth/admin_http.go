package auth

// Phase 09d-1: admin moderation HTTP endpoints.
//
// Endpoints in this file:
//
//   GET    /api/admin/users                  paginated user list
//   POST   /api/admin/users/{id}/block       set blocked_at, kick sessions
//   POST   /api/admin/users/{id}/unblock     clear blocked_at
//   POST   /api/admin/users/{id}/soft-delete set deleted_at, kick sessions
//   DELETE /api/admin/users/{id}             hard purge + auto-blacklist
//
//   GET    /api/admin/blacklist              paginated blacklist
//   POST   /api/admin/blacklist              add entry
//   DELETE /api/admin/blacklist/{email}      remove entry
//
// All endpoints are gated by RequireAdmin which wraps RequireSession
// and additionally checks su.Role == "admin". Non-admins (including
// blocked admins, which can never exist by the schema) get 403.
//
// The kick-on-block / kick-on-soft-delete flow uses the ConnKicker
// interface that the *server.Hub satisfies. The auth package can't
// import the server package (server imports auth, not vice versa)
// so dependency injection through HTTPDeps is the cleanest path.

import (
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/store"
)

// ConnKicker is the small subset of *server.Hub the admin endpoints
// need: terminate every active WebSocket connection bound to a user.
// Implementations should be cheap and non-blocking (queue closes,
// don't wait on them).
//
// Defined in this package so the auth-side has its own interface;
// *server.Hub satisfies it by adding a CloseConnsForUser method in
// the same patch that wires admin endpoints.
type ConnKicker interface {
	CloseConnsForUser(userID string, reason error)
}

// MountAdmin registers the admin moderation endpoints on mux. The
// admin bootstrap endpoint (which is unauthenticated and uses the
// bootstrap token) is mounted by MountAdminBootstrap separately,
// because the auth model differs.
//
// Returns an error if HTTPDeps.Store is nil. ConnKicker may be nil
// in tests; when nil, the block / soft-delete handlers still set
// the timestamp and delete sessions but cannot close active WS
// connections (the next message attempt will fail at the session
// check).
func (d *HTTPDeps) MountAdmin(mux *http.ServeMux) error {
	if d.Store == nil {
		return fmt.Errorf("auth.MountAdmin: Store required")
	}
	if d.Logger == nil {
		// Same nil-safe default as MountRegistration. log is already
		// imported by http.go in this package; the import here adds
		// to the import block at the top of this file.
		d.Logger = log.Default()
	}
	mux.HandleFunc("GET /api/admin/users", d.handleAdminListUsers)
	mux.HandleFunc("POST /api/admin/users/{id}/block", d.handleAdminBlockUser)
	mux.HandleFunc("POST /api/admin/users/{id}/unblock", d.handleAdminUnblockUser)
	mux.HandleFunc("POST /api/admin/users/{id}/soft-delete", d.handleAdminSoftDeleteUser)
	mux.HandleFunc("DELETE /api/admin/users/{id}", d.handleAdminPurgeUser)

	mux.HandleFunc("GET /api/admin/blacklist", d.handleAdminListBlacklist)
	mux.HandleFunc("POST /api/admin/blacklist", d.handleAdminAddBlacklist)
	mux.HandleFunc("DELETE /api/admin/blacklist/{email}", d.handleAdminRemoveBlacklist)
	return nil
}

// ---- middleware --------------------------------------------------------

// RequireAdmin wraps RequireSession and additionally enforces that
// the resolved SessionUser has role == "admin". A non-admin session
// gets 403 forbidden (NOT 401, because the user IS authenticated;
// they just lack the privilege). An expired or missing session
// short-circuits via RequireSession with the usual 401.
//
// The admin singleton (migration 0011) guarantees there is at most
// one admin row; this middleware doesn't enforce singleton, only
// "the caller is THAT row." A blocked / soft-deleted admin can
// never exist by trigger (migration 0019), so we don't have to
// guard against it here.
func RequireAdmin(
	st *store.Store,
	next func(http.ResponseWriter, *http.Request, *SessionUser),
) http.HandlerFunc {
	return RequireSession(st, func(w http.ResponseWriter, r *http.Request, su *SessionUser) {
		if su.Role != "admin" {
			writeError(w, http.StatusForbidden, "not_admin",
				"this endpoint requires admin privileges")
			return
		}
		next(w, r, su)
	})
}

// ---- request/response shapes -------------------------------------------

// userSummaryDTO is the per-row admin list payload. JSON-tag names
// mirror the existing /api/auth/me / inviteDTO conventions.
type userSummaryDTO struct {
	ID              string     `json:"id"`
	Username        string     `json:"username"`
	DisplayName     string     `json:"display_name"`
	Email           string     `json:"email"`
	Role            string     `json:"role"`
	CreatedAt       time.Time  `json:"created_at"`
	EmailVerifiedAt *time.Time `json:"email_verified_at,omitempty"`
	BlockedAt       *time.Time `json:"blocked_at,omitempty"`
	DeletedAt       *time.Time `json:"deleted_at,omitempty"`
	// Status is a derived convenience field for the SPA. One of
	// "active" / "blocked" / "deleted" / "admin". Blocked+deleted
	// (shouldn't happen, but defensively) renders as "deleted".
	Status string `json:"status"`
}

func userSummaryToDTO(u store.UserSummary) userSummaryDTO {
	dto := userSummaryDTO{
		ID:          u.ID.String(),
		Username:    u.Username,
		DisplayName: u.DisplayName,
		Email:       u.Email,
		Role:        u.Role,
		CreatedAt:   u.CreatedAt,
	}
	if !u.EmailVerifiedAt.IsZero() {
		t := u.EmailVerifiedAt
		dto.EmailVerifiedAt = &t
	}
	if !u.BlockedAt.IsZero() {
		t := u.BlockedAt
		dto.BlockedAt = &t
	}
	if !u.DeletedAt.IsZero() {
		t := u.DeletedAt
		dto.DeletedAt = &t
	}
	switch {
	case u.Role == "admin":
		dto.Status = "admin"
	case u.IsDeleted():
		dto.Status = "deleted"
	case u.IsBlocked():
		dto.Status = "blocked"
	default:
		dto.Status = "active"
	}
	return dto
}

// listUsersResponse is the GET /api/admin/users wire shape.
type listUsersResponse struct {
	Users  []userSummaryDTO `json:"users"`
	Total  int64            `json:"total"`
	Limit  int              `json:"limit"`
	Offset int              `json:"offset"`
}

// blacklistEntryDTO is the per-row admin blacklist payload.
type blacklistEntryDTO struct {
	Email           string    `json:"email"`
	Reason          string    `json:"reason"`
	AddedAt         time.Time `json:"added_at"`
	AddedBy         string    `json:"added_by,omitempty"`
	FormerUserID    string    `json:"former_user_id,omitempty"`
	FormerUsername  string    `json:"former_username,omitempty"`
}

func blacklistToDTO(e store.BlacklistEntry) blacklistEntryDTO {
	dto := blacklistEntryDTO{
		Email:          e.Email,
		Reason:         e.Reason,
		AddedAt:        e.AddedAt,
		FormerUsername: e.FormerUsername,
	}
	if e.AddedBy != uuid.Nil {
		dto.AddedBy = e.AddedBy.String()
	}
	if e.FormerUserID != uuid.Nil {
		dto.FormerUserID = e.FormerUserID.String()
	}
	return dto
}

// listBlacklistResponse is the GET /api/admin/blacklist wire shape.
type listBlacklistResponse struct {
	Entries []blacklistEntryDTO `json:"entries"`
	Total   int64               `json:"total"`
	Limit   int                 `json:"limit"`
	Offset  int                 `json:"offset"`
}

// addBlacklistRequest is the POST /api/admin/blacklist input.
type addBlacklistRequest struct {
	Email  string `json:"email"`
	Reason string `json:"reason"`
}

// ---- handlers: users -------------------------------------------------

// handleAdminListUsers returns a paginated user list.
//
// Query params:
//   q       — optional search string (substring match, case-insensitive)
//   limit   — page size (default 50, max 200)
//   offset  — starting row (default 0)
func (d *HTTPDeps) handleAdminListUsers(w http.ResponseWriter, r *http.Request) {
	RequireAdmin(d.Store, func(w http.ResponseWriter, r *http.Request, su *SessionUser) {
		q := r.URL.Query()
		limit, _ := strconv.Atoi(q.Get("limit"))
		offset, _ := strconv.Atoi(q.Get("offset"))
		search := strings.TrimSpace(q.Get("q"))

		result, err := d.Store.ListUsers(r.Context(), store.ListUsersParams{
			Search: search,
			Limit:  limit,
			Offset: offset,
		})
		if err != nil {
			d.Logger.Printf("admin/users/list: %v", err)
			writeError(w, http.StatusInternalServerError, "lookup_failed",
				"could not list users")
			return
		}

		// Mirror the requested limit/offset back, snapped to the
		// store's bounds so the SPA can pin pagination state.
		effLimit := limit
		if effLimit <= 0 {
			effLimit = 50
		}
		if effLimit > 200 {
			effLimit = 200
		}
		if offset < 0 {
			offset = 0
		}

		dtos := make([]userSummaryDTO, 0, len(result.Users))
		for _, u := range result.Users {
			dtos = append(dtos, userSummaryToDTO(u))
		}
		writeJSON(w, http.StatusOK, listUsersResponse{
			Users:  dtos,
			Total:  result.Total,
			Limit:  effLimit,
			Offset: offset,
		})
	})(w, r)
}

// handleAdminBlockUser sets users.blocked_at and kicks active state.
//
// Side effects on success:
//   - users.blocked_at = now() (idempotent; preserves first stamp)
//   - all sessions for the user are deleted
//   - all active WS connections for the user are closed (best effort
//     via ConnKicker)
//
// The admin cannot block themselves (the admin singleton + the
// DB-side trigger both prevent it; the application returns 409).
func (d *HTTPDeps) handleAdminBlockUser(w http.ResponseWriter, r *http.Request) {
	RequireAdmin(d.Store, func(w http.ResponseWriter, r *http.Request, su *SessionUser) {
		targetID, perr := parseUserID(r)
		if perr != nil {
			writeAuthErr(w, perr)
			return
		}
		if err := d.Store.BlockUser(r.Context(), targetID); err != nil {
			switch {
			case errors.Is(err, store.ErrNotFound):
				writeError(w, http.StatusNotFound, "user_not_found",
					"no user with that id")
				return
			case errors.Is(err, store.ErrCannotModifyAdmin):
				writeError(w, http.StatusConflict, "cannot_modify_admin",
					"the admin user cannot be blocked")
				return
			default:
				d.Logger.Printf("admin/users/block: %v", err)
				writeError(w, http.StatusInternalServerError, "block_failed",
					"could not block user")
				return
			}
		}
		// Kick sessions + WS conns. Best-effort; a failure here
		// doesn't undo the block (the user's NEXT request will fail
		// at the session lookup even if we couldn't kick them now).
		if n, err := d.Store.DeleteAllSessionsForUser(r.Context(), targetID); err != nil {
			d.Logger.Printf("admin/users/block: kick sessions for %s: %v", targetID, err)
		} else if n > 0 {
			d.Logger.Printf("admin/users/block: kicked %d session(s) for %s", n, targetID)
		}
		if d.Kicker != nil {
			d.Kicker.CloseConnsForUser(targetID.String(),
				fmt.Errorf("blocked by admin %s", su.Username))
		}
		w.WriteHeader(http.StatusNoContent)
	})(w, r)
}

// handleAdminUnblockUser clears users.blocked_at. Idempotent.
func (d *HTTPDeps) handleAdminUnblockUser(w http.ResponseWriter, r *http.Request) {
	RequireAdmin(d.Store, func(w http.ResponseWriter, r *http.Request, su *SessionUser) {
		targetID, perr := parseUserID(r)
		if perr != nil {
			writeAuthErr(w, perr)
			return
		}
		if err := d.Store.UnblockUser(r.Context(), targetID); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				writeError(w, http.StatusNotFound, "user_not_found",
					"no user with that id")
				return
			}
			d.Logger.Printf("admin/users/unblock: %v", err)
			writeError(w, http.StatusInternalServerError, "unblock_failed",
				"could not unblock user")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})(w, r)
}

// handleAdminSoftDeleteUser sets users.deleted_at. Sessions and WS
// conns are kicked just like block. The user row stays so their
// messages can keep their sender_id pointer.
func (d *HTTPDeps) handleAdminSoftDeleteUser(w http.ResponseWriter, r *http.Request) {
	RequireAdmin(d.Store, func(w http.ResponseWriter, r *http.Request, su *SessionUser) {
		targetID, perr := parseUserID(r)
		if perr != nil {
			writeAuthErr(w, perr)
			return
		}
		if err := d.Store.SoftDeleteUser(r.Context(), targetID); err != nil {
			switch {
			case errors.Is(err, store.ErrNotFound):
				writeError(w, http.StatusNotFound, "user_not_found",
					"no user with that id")
				return
			case errors.Is(err, store.ErrCannotModifyAdmin):
				writeError(w, http.StatusConflict, "cannot_modify_admin",
					"the admin user cannot be soft-deleted")
				return
			default:
				d.Logger.Printf("admin/users/soft-delete: %v", err)
				writeError(w, http.StatusInternalServerError, "soft_delete_failed",
					"could not soft-delete user")
				return
			}
		}
		if n, err := d.Store.DeleteAllSessionsForUser(r.Context(), targetID); err != nil {
			d.Logger.Printf("admin/users/soft-delete: kick sessions for %s: %v", targetID, err)
		} else if n > 0 {
			d.Logger.Printf("admin/users/soft-delete: kicked %d session(s) for %s", n, targetID)
		}
		if d.Kicker != nil {
			d.Kicker.CloseConnsForUser(targetID.String(),
				fmt.Errorf("soft-deleted by admin %s", su.Username))
		}
		w.WriteHeader(http.StatusNoContent)
	})(w, r)
}

// handleAdminPurgeUser hard-deletes the user row + cascades.
// Auto-adds the former email to the blacklist with reason
// "purged_user" so the same person can't immediately re-register.
//
// The cascade wipes sessions, passkeys, recovery_codes, invites,
// friends, channel members, presence. Messages have sender_id set
// to NULL via the ON DELETE SET NULL on the FK; the body survives
// and the UI renders "(deleted)" for the sender.
func (d *HTTPDeps) handleAdminPurgeUser(w http.ResponseWriter, r *http.Request) {
	RequireAdmin(d.Store, func(w http.ResponseWriter, r *http.Request, su *SessionUser) {
		targetID, perr := parseUserID(r)
		if perr != nil {
			writeAuthErr(w, perr)
			return
		}
		// Pre-kick WS connections before the row vanishes so the
		// kick reason references the user by id rather than after
		// the cascade has already wiped state. The DELETE itself
		// will also wipe sessions via cascade, so explicit
		// DeleteAllSessionsForUser isn't needed.
		if d.Kicker != nil {
			d.Kicker.CloseConnsForUser(targetID.String(),
				fmt.Errorf("purged by admin %s", su.Username))
		}
		pu, err := d.Store.PurgeUser(r.Context(), targetID)
		if err != nil {
			switch {
			case errors.Is(err, store.ErrNotFound):
				writeError(w, http.StatusNotFound, "user_not_found",
					"no user with that id")
				return
			case errors.Is(err, store.ErrCannotModifyAdmin):
				writeError(w, http.StatusConflict, "cannot_modify_admin",
					"the admin user cannot be purged")
				return
			default:
				d.Logger.Printf("admin/users/purge: %v", err)
				writeError(w, http.StatusInternalServerError, "purge_failed",
					"could not purge user")
				return
			}
		}
		// Add the purged email to the blacklist with the audit
		// trail. The admin's UUID goes into added_by; the purged
		// user's id + username are captured in the former_* fields.
		// AddToBlacklist is idempotent via ON CONFLICT DO NOTHING.
		if blErr := d.Store.AddToBlacklist(r.Context(), store.AddToBlacklistParams{
			Email:          pu.Email,
			Reason:         "purged_user",
			AddedBy:        su.UserID,
			FormerUserID:   pu.UserID,
			FormerUsername: pu.Username,
		}); blErr != nil {
			// The purge committed; we can't easily roll back here.
			// Log loudly so the operator can manually add the entry.
			// The user-facing response is still success — the purge
			// itself worked.
			d.Logger.Printf("admin/users/purge: AddToBlacklist for %q FAILED: %v "+
				"(purge succeeded; add manually)", pu.Email, blErr)
		}
		w.WriteHeader(http.StatusNoContent)
	})(w, r)
}

// ---- handlers: blacklist ----------------------------------------------

// handleAdminListBlacklist returns a paginated blacklist.
func (d *HTTPDeps) handleAdminListBlacklist(w http.ResponseWriter, r *http.Request) {
	RequireAdmin(d.Store, func(w http.ResponseWriter, r *http.Request, su *SessionUser) {
		q := r.URL.Query()
		limit, _ := strconv.Atoi(q.Get("limit"))
		offset, _ := strconv.Atoi(q.Get("offset"))
		result, err := d.Store.ListBlacklist(r.Context(), store.ListBlacklistParams{
			Limit:  limit,
			Offset: offset,
		})
		if err != nil {
			d.Logger.Printf("admin/blacklist/list: %v", err)
			writeError(w, http.StatusInternalServerError, "lookup_failed",
				"could not list blacklist")
			return
		}
		effLimit := limit
		if effLimit <= 0 {
			effLimit = 50
		}
		if effLimit > 200 {
			effLimit = 200
		}
		if offset < 0 {
			offset = 0
		}
		dtos := make([]blacklistEntryDTO, 0, len(result.Entries))
		for _, e := range result.Entries {
			dtos = append(dtos, blacklistToDTO(e))
		}
		writeJSON(w, http.StatusOK, listBlacklistResponse{
			Entries: dtos,
			Total:   result.Total,
			Limit:   effLimit,
			Offset:  offset,
		})
	})(w, r)
}

// handleAdminAddBlacklist inserts a new blacklist entry. The reason
// is free-form text (the convention is short tags like "abuse" or
// "spam" but no enum is enforced). The added_by field is set to the
// current admin's UUID.
func (d *HTTPDeps) handleAdminAddBlacklist(w http.ResponseWriter, r *http.Request) {
	RequireAdmin(d.Store, func(w http.ResponseWriter, r *http.Request, su *SessionUser) {
		var req addBlacklistRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "bad_json", err.Error())
			return
		}
		email := strings.ToLower(strings.TrimSpace(req.Email))
		reason := strings.TrimSpace(req.Reason)
		if !looksLikeEmail(email) {
			writeError(w, http.StatusBadRequest, "bad_email",
				"email must contain @ and a domain")
			return
		}
		if reason == "" {
			reason = "admin_added"
		}
		if len(reason) > 500 {
			writeError(w, http.StatusBadRequest, "reason_too_long",
				"reason must be 500 characters or fewer")
			return
		}
		if err := d.Store.AddToBlacklist(r.Context(), store.AddToBlacklistParams{
			Email:   email,
			Reason:  reason,
			AddedBy: su.UserID,
		}); err != nil {
			d.Logger.Printf("admin/blacklist/add: %v", err)
			writeError(w, http.StatusInternalServerError, "add_failed",
				"could not add blacklist entry")
			return
		}
		w.WriteHeader(http.StatusCreated)
	})(w, r)
}

// handleAdminRemoveBlacklist deletes a blacklist entry. Idempotent:
// removing an entry that doesn't exist returns 204 too (the desired
// post-state is the same).
func (d *HTTPDeps) handleAdminRemoveBlacklist(w http.ResponseWriter, r *http.Request) {
	RequireAdmin(d.Store, func(w http.ResponseWriter, r *http.Request, su *SessionUser) {
		// Path values are not URL-decoded automatically by net/http
		// pre-1.22; 1.22+ DOES decode them. The auth package targets
		// Go 1.23+ (see go.mod) so PathValue returns a decoded value.
		// But emails contain '+' (form-encoded as space if the caller
		// got over-eager) and '@' (must be %40 if not relying on
		// permissive parsers). We re-decode defensively in case the
		// caller still sent encoded bytes.
		raw := r.PathValue("email")
		email, err := url.PathUnescape(raw)
		if err != nil {
			writeError(w, http.StatusBadRequest, "bad_email", "malformed email path")
			return
		}
		email = strings.ToLower(strings.TrimSpace(email))
		if !looksLikeEmail(email) {
			writeError(w, http.StatusBadRequest, "bad_email",
				"email must contain @ and a domain")
			return
		}
		if err := d.Store.RemoveFromBlacklist(r.Context(), email); err != nil {
			d.Logger.Printf("admin/blacklist/remove: %v", err)
			writeError(w, http.StatusInternalServerError, "remove_failed",
				"could not remove blacklist entry")
			return
		}
		_ = su // currently unused; the admin's identity is implicit in the audit log
		w.WriteHeader(http.StatusNoContent)
	})(w, r)
}

// ---- helpers ---------------------------------------------------------

// parseUserID extracts and parses the {id} path value. Returns an
// authError shaped for writeAuthErr on malformed input.
func parseUserID(r *http.Request) (uuid.UUID, *authError) {
	raw := r.PathValue("id")
	if raw == "" {
		return uuid.Nil, &authError{
			status:  http.StatusBadRequest,
			code:    "bad_user_id",
			message: "user id missing from path",
		}
	}
	id, err := uuid.Parse(raw)
	if err != nil {
		return uuid.Nil, &authError{
			status:  http.StatusBadRequest,
			code:    "bad_user_id",
			message: "user id is not a valid UUID",
		}
	}
	return id, nil
}
