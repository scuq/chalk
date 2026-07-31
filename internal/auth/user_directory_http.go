package auth

// Phase 59-1: server-wide user directory for the sidebar's add-friend
// flow.
//
// Endpoint:
//
//	GET /api/users/directory
//
// Auth: requires a session (RequireSession). Returns every active
// (not admin-blocked, not soft-deleted) user except the caller, so
// the client can render an "everyone on this server" list with an
// add-friend button per row.
//
// This deliberately relaxes the exact-match-only stance of
// /api/users/lookup: chalk is a self-hosted server where every
// account got in through an invite or the admin, so members
// discovering each other is the point, not a leak. The lookup
// endpoint keeps its privacy posture for anything that still uses it.
//
// 200 body: {"users": [{"user_id": "...", "username": "...",
// "display_name": "..."}, ...]} — sorted by username, [] when the
// caller is the only account.

import "net/http"

type userDirectoryResponse struct {
	Users []userLookupResponse `json:"users"`
}

// handleUserDirectory implements GET /api/users/directory. Registered
// by MountUserLookup alongside the exact-match lookup.
func (d *HTTPDeps) handleUserDirectory(
	w http.ResponseWriter, r *http.Request, su *SessionUser,
) {
	users, err := d.Store.ListDirectoryUsers(r.Context(), su.UserID)
	if err != nil {
		d.Logger.Printf("user directory: ListDirectoryUsers: %v", err)
		writeError(w, http.StatusInternalServerError, "directory_failed",
			"internal error")
		return
	}
	resp := userDirectoryResponse{Users: []userLookupResponse{}}
	for _, u := range users {
		resp.Users = append(resp.Users, userLookupResponse{
			UserID:      u.ID.String(),
			Username:    u.Username,
			DisplayName: u.DisplayName,
		})
	}
	writeJSON(w, http.StatusOK, resp)
}
