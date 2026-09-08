package auth

// 115-5: the avatar frame -- the decorative ring a member chooses for their
// own profile picture, seen by everyone who has flair on.
//
// Endpoint:
//
//	PUT /api/auth/avatar-frame
//	{"avatar_frame": "ember"}        -- one of AvatarFrames, "" to clear
//
// Auth: a session (RequireSession); guests are refused there, and have no
// picture to frame. 200 body echoes the stored value:
//
//	{"avatar_frame": "ember"}
//
// 4xx codes:
//
//	400 bad_json     -- body is not the shape above
//	400 bad_frame    -- not a known frame name
//	401              -- no/expired session (RequireSession)
//
// The value is public by design and plaintext on purpose (see migration
// 0061). It reaches other clients on the user directory, which they fetch
// once per session and again on every reconnect -- so a changed frame is
// eventually consistent, the same way a display name is, and there is no
// websocket push for it.

import (
	"errors"
	"net/http"

	"github.com/scuq/chalk/internal/store"
)

// AvatarFrames is the allowlist, "" first. The client's list
// (web/src/avatars/frames.ts) names the same set in the same order; a new
// style is a CSS rule plus a line in each. Order matters only for the
// picker, which is why the two lists are kept identical rather than merely
// equal as sets.
var AvatarFrames = []string{"", "ember", "aurora", "pulse"}

// ValidAvatarFrame reports whether v is a frame the server will store.
func ValidAvatarFrame(v string) bool {
	for _, f := range AvatarFrames {
		if f == v {
			return true
		}
	}
	return false
}

type avatarFrameRequest struct {
	AvatarFrame string `json:"avatar_frame"`
}

type avatarFrameResponse struct {
	AvatarFrame string `json:"avatar_frame"`
}

func (d *HTTPDeps) handleAvatarFramePut(w http.ResponseWriter, r *http.Request, su *SessionUser) {
	var req avatarFrameRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	if !ValidAvatarFrame(req.AvatarFrame) {
		writeError(w, http.StatusBadRequest, "bad_frame",
			"avatar_frame must be one of the known frame names, or empty for none")
		return
	}
	if err := d.Store.UpdateAvatarFrame(r.Context(), su.UserID, req.AvatarFrame); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			// A session for a user row that no longer exists: the session
			// layer's problem, but not worth a 500 here.
			writeError(w, http.StatusUnauthorized, "no_session", "session user not found")
			return
		}
		d.Logger.Printf("avatar frame: UpdateAvatarFrame: %v", err)
		writeError(w, http.StatusInternalServerError, "update_failed", "internal error")
		return
	}
	writeJSON(w, http.StatusOK, avatarFrameResponse{AvatarFrame: req.AvatarFrame})
}
