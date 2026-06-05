package server

// Phase 11a: WS handlers for MLS KeyPackage publish/fetch.
//
// Security invariant: every KeyPackage published by a connection
// must carry a client_id_claimed of the form "<conn.UserID>:<conn.DeviceID>".
// This prevents alice2 from publishing KPs that claim to be bob2's
// device, which would otherwise let alice2 intercept future MLS
// messages addressed to bob2.

import (
	"context"
	"encoding/base64"
	"fmt"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/store"
)

// handlePublishKeyPackages stores a batch of KPs for the publishing
// device. Validates client_id_claimed before insertion.
func (h *WSHandler) handlePublishKeyPackages(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	var p proto.PublishKeyPackagesPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	deviceID, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id invalid")
		return
	}
	expectedClientID := fmt.Sprintf("%s:%s", conn.UserID, conn.DeviceID)

	rows := make([]store.KeyPackageRow, 0, len(p.KeyPackages))
	for i, entry := range p.KeyPackages {
		if entry.ClientIDClaimed != expectedClientID {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeKPClientIDMismatch,
				fmt.Sprintf("kp[%d]: client_id_claimed=%q expected=%q",
					i, entry.ClientIDClaimed, expectedClientID))
			return
		}
		if entry.KeyPackageData == "" {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeKPMalformed,
				fmt.Sprintf("kp[%d]: empty key_package_data", i))
			return
		}
		data, derr := base64.StdEncoding.DecodeString(entry.KeyPackageData)
		if derr != nil {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeKPMalformed,
				fmt.Sprintf("kp[%d]: base64 decode: %v", i, derr))
			return
		}
		if len(data) == 0 || len(data) > 16384 {
			// Sanity bound. Real KPs for the X25519 suite are ~600
			// bytes; cap at 16KB so we don't store nonsense.
			h.sendError(ctx, c, f.Ref, proto.ErrCodeKPMalformed,
				fmt.Sprintf("kp[%d]: data size %d out of [1, 16384]", i, len(data)))
			return
		}
		rows = append(rows, store.KeyPackageRow{
			DeviceID:        deviceID,
			Ciphersuite:     entry.Ciphersuite,
			CredentialType:  entry.CredentialType,
			ClientIDClaimed: entry.ClientIDClaimed,
			KeyPackageData:  data,
		})
	}

	accepted, err := h.store.InsertKeyPackages(ctx, deviceID, rows)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "insert KPs: "+err.Error())
		return
	}
	ack, _ := proto.NewFrame(proto.TypePublishKeyPackagesAck, f.Ref,
		proto.PublishKeyPackagesAckPayload{Accepted: accepted})
	if err := writeFrame(ctx, c, ack, h.cfg.WriteTimeout); err != nil {
		h.logger.Printf("publish_key_packages_ack write: %v", err)
	}
}

// handleFetchKeyPackages claims one unused KP per requested user.
// Membership-style auth: we currently allow any authenticated user
// to fetch KPs for any other user. This is intentional -- to DM
// bob2 for the first time you must be able to look up his KP. We
// rely on the existing friendship / blacklist model for abuse
// prevention. A stricter check (e.g. "only friends can fetch your
// KP") is a future hardening, not 11a scope.
func (h *WSHandler) handleFetchKeyPackages(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	var p proto.FetchKeyPackagesPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	if conn.UserID == "" {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeNotHelloed, "not authenticated")
		return
	}
	ciphersuite := p.Ciphersuite
	if ciphersuite == 0 {
		ciphersuite = 1 // MLS suite 0x0001 default
	}
	userIDs := make([]uuid.UUID, 0, len(p.UserIDs))
	for _, s := range p.UserIDs {
		uid, err := uuid.Parse(s)
		if err != nil {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload,
				"user_id "+s+" not a UUID")
			return
		}
		userIDs = append(userIDs, uid)
	}
	claimed, err := h.store.ClaimKeyPackagesForUsers(ctx, userIDs, ciphersuite)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "claim KPs: "+err.Error())
		return
	}
	// Phase 11c-5: collect claims for the low-stock check (best-effort,
	// after we've built the response).
	lowClaims := make([]kpLowClaim, 0, len(claimed))
	out := make([]proto.FetchedKeyPackage, 0, len(claimed))
	for _, ck := range claimed {
		lowClaims = append(lowClaims, kpLowClaim{
			UserID:      ck.UserID,
			DeviceID:    ck.DeviceID,
			Ciphersuite: ck.Ciphersuite,
		})
		out = append(out, proto.FetchedKeyPackage{
			UserID:         ck.UserID.String(),
			DeviceID:       ck.DeviceID.String(),
			ClientID:       ck.ClientIDClaimed,
			Ciphersuite:    ck.Ciphersuite,
			CredentialType: ck.CredentialType,
			KeyPackageData: base64.StdEncoding.EncodeToString(ck.KeyPackageData),
		})
	}
	ack, _ := proto.NewFrame(proto.TypeFetchKeyPackagesAck, f.Ref,
		proto.FetchKeyPackagesAckPayload{KeyPackages: out})
	if err := writeFrame(ctx, c, ack, h.cfg.WriteTimeout); err != nil {
		h.logger.Printf("fetch_key_packages_ack write: %v", err)
	}
	// Phase 11c-5: replenish-on-drain. After serving the claim, nudge
	// any depleted device's owner to republish.
	h.maybeNotifyKeyPackageLow(ctx, lowClaims)
}

// handleKeyPackageCount tells the connecting device how many unused
// KPs it has on file. The client uses this to decide whether to
// publish more (typical: target 10, refill below 3).
func (h *WSHandler) handleKeyPackageCount(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	var p proto.KeyPackageCountPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	deviceID, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id invalid")
		return
	}
	// Default ciphersuite = 1 for now. Future: take it as a payload field.
	n, err := h.store.CountUnusedKeyPackages(ctx, deviceID, 1)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "count KPs: "+err.Error())
		return
	}
	ack, _ := proto.NewFrame(proto.TypeKeyPackageCountAck, f.Ref,
		proto.KeyPackageCountAckPayload{Count: n})
	if err := writeFrame(ctx, c, ack, h.cfg.WriteTimeout); err != nil {
		h.logger.Printf("key_package_count_ack write: %v", err)
	}
}
