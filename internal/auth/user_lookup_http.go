package auth

import (
	"errors"
	"net/http"
	"regexp"

	"github.com/scuq/chalk/internal/store"
)

// Phase 09f (9.6): exact-username lookup for the friend-add flow.
//
// Endpoint:
//
//	GET /api/users/lookup?username=<name>
//
// Auth: requires a session (RequireSession). Privacy: exact-match
// only, no prefix listing -- you have to know the full username to
// discover that someone exists. 404 returned for "no match" and
// "match is yourself" alike, so the caller can't even tell whether
// their own username queried-against-themselves exists in the
// system. Subtle, but matters for privacy.
//
// The endpoint mirrors the username regex used at registration time
// to reject inputs that can't possibly match anything (saves a DB
// hit and keeps the error surface uniform).
//
// 4xx codes:
//
//	400 invalid_username  -- username is empty, too long, or fails regex
//	401 (RequireSession)  -- no/expired session
//	404 not_found         -- no matching user, OR match is the caller
//
// 200 body: {"user_id": "...", "username": "...", "display_name": "..."}

// userLookupResponse is the 200 body for a successful lookup.
type userLookupResponse struct {
	UserID      string `json:"user_id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
}

// usernameLookupRegex mirrors the registration-time username
// constraint. Lowercase ASCII alphanumeric + underscore, 3-32 chars.
// (We compile it once at package load; reused by handleUserLookup.)
var usernameLookupRegex = regexp.MustCompile(`^[a-z0-9_]{3,32}$`)

// MountUserLookup registers GET /api/users/lookup. Call from the
// HTTP wiring in cmd/chalkd alongside the other Mount* calls.
// Returns nil unconditionally; the signature matches MountAdmin /
// MountRegistration so the wiring in internal/server/server.go can
// treat them uniformly.
func (d *HTTPDeps) MountUserLookup(mux *http.ServeMux) error {
	mux.Handle("GET /api/users/lookup",
		RequireSession(d.Store, d.handleUserLookup))
	return nil
}

// handleUserLookup implements GET /api/users/lookup. See package doc
// comment above for the contract. Called with a resolved SessionUser
// from RequireSession.
func (d *HTTPDeps) handleUserLookup(
	w http.ResponseWriter, r *http.Request, su *SessionUser,
) {
	username := r.URL.Query().Get("username")
	if username == "" {
		writeError(w, http.StatusBadRequest, "invalid_username",
			"username query param required")
		return
	}
	if !usernameLookupRegex.MatchString(username) {
		writeError(w, http.StatusBadRequest, "invalid_username",
			"username must match ^[a-z0-9_]{3,32}$")
		return
	}

	user, err := d.Store.GetUserByUsername(r.Context(), username)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not_found",
				"no matching user")
			return
		}
		d.Logger.Printf("user lookup: GetUserByUsername: %v", err)
		writeError(w, http.StatusInternalServerError, "lookup_failed",
			"internal error")
		return
	}

	// Privacy: looking up yourself returns 404, same as a real
	// miss. Otherwise the caller could probe their own existence
	// (low-value but easy to avoid). Also: the friend.Request
	// handler rejects self-friend with ErrCodeCannotSelfFriend
	// anyway, so failing fast here is friendlier.
	if user.ID == su.UserID {
		writeError(w, http.StatusNotFound, "not_found",
			"no matching user")
		return
	}

	// Account-status gate. Blocked or soft-deleted users
	// shouldn't be discoverable for friending. Mirrors the
	// gates that Phase 09d-1 applied to authenticate/recovery
	// (admin-blocked → can't log in → certainly can't be
	// befriended). We use BlockedAt/DeletedAt rather than the
	// Phase 06 users.status field because the User struct
	// doesn't carry status (it's accessed via raw SQL where
	// needed); the admin-driven flags are what matter for
	// discoverability anyway.
	if !user.BlockedAt.IsZero() || !user.DeletedAt.IsZero() {
		writeError(w, http.StatusNotFound, "not_found",
			"no matching user")
		return
	}

	writeJSON(w, http.StatusOK, userLookupResponse{
		UserID:      user.ID.String(),
		Username:    user.Username,
		DisplayName: user.DisplayName,
	})
}
