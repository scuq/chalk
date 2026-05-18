// Phase 9.7 -- user preferences WS handlers.
//
// Frames:
//   prefs_get      -> prefs_get_ack { prefs }
//   prefs_set      -> prefs_set_ack { prefs }  (and prefs_changed push to other devices)
//
// Push:
//   prefs_changed  { prefs }   to all of the same user's other conns
//
// Validation:
//   The server keeps prefs as opaque JSONB but caps payload size to
//   8 KiB after marshal. Individual key validation lives in the SPA
//   (which knows the typed shape); the server only enforces "valid
//   JSON object" and "not too big".

package server

import (
	"context"
	"encoding/json"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/proto"
)

const prefsMaxBytes = 8 * 1024

func (h *WSHandler) handlePrefsGet(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	deviceID, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id not a UUID")
		return
	}
	userID := h.lookupUserForDevice(ctx, deviceID)
	if userID == uuid.Nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "unknown user")
		return
	}
	prefs, err := h.store.GetPreferences(ctx, userID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "fetch prefs: "+err.Error())
		return
	}
	ack, _ := proto.NewFrame(proto.TypePrefsGetAck, f.Ref, proto.PrefsAckPayload{
		Prefs: prefs,
	})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)
}

func (h *WSHandler) handlePrefsSet(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	var p proto.PrefsSetPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	if p.Patch == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "patch must be an object")
		return
	}
	// Size guard. Marshal first; if it's too big, reject before
	// touching the DB.
	patchJSON, err := json.Marshal(p.Patch)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "patch must be JSON object")
		return
	}
	if len(patchJSON) > prefsMaxBytes {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "patch too large")
		return
	}
	deviceID, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id not a UUID")
		return
	}
	userID := h.lookupUserForDevice(ctx, deviceID)
	if userID == uuid.Nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "unknown user")
		return
	}
	merged, err := h.store.UpsertPreferences(ctx, userID, p.Patch)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "save prefs: "+err.Error())
		return
	}
	// Ack to the caller with the merged result.
	ack, _ := proto.NewFrame(proto.TypePrefsSetAck, f.Ref, proto.PrefsAckPayload{
		Prefs: merged,
	})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)

	// Fan out to this user's OTHER conns (other tabs / devices) so
	// they update their local cache. The publisher hook is the same
	// shape as the friend/presence ones.
	if h.publishPrefsChange != nil {
		if perr := h.publishPrefsChange(ctx, userID, conn.ID); perr != nil {
			h.logger.Printf("publish prefs change: %v", perr)
		}
	}
}

// PrefsChangePublisher is the hook called from handlePrefsSet to
// emit a per-user pubsub event. The Server wires this up in main.
type PrefsChangePublisher func(ctx context.Context, userID uuid.UUID, originConnID string) error

// handlePrefsEvent (on the Server side) re-fetches the prefs and
// fans out a prefs_changed frame to the user's local conns,
// skipping the originating conn so it doesn't get its own echo.
//
// Lives on the Server side because it needs s.hub access; the
// dispatcher is in server.go's handlePubsubEvent. This file just
// notes the contract.
