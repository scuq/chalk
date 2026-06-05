package server

// Phase 11c-5: KeyPackage low-stock detection + push.
//
// After any KP claim, the server checks whether the claimed device's
// remaining unused-KP count fell below the low-water mark. If so, it
// publishes a "kp_low" pubsub event addressed to the device owner, so
// that user's connected devices (on any instance) republish their
// stock. This closes the gap where the depleted party (whose KP was
// claimed by someone else) had no signal to replenish and would
// eventually hit zero -> OrphanWelcome for every future add.

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/pubsub"
)

// kpLowThreshold is the unused-KP count at or below which we push a
// replenish signal. Chosen above zero so replenishment happens with
// headroom: the next claim (before the client's republish lands)
// still finds stock.
const kpLowThreshold = 5

// kpLowClaim is the minimal info the notifier needs about one claimed
// KeyPackage: which device lost a KP, who owns it, and the suite.
type kpLowClaim struct {
	UserID      uuid.UUID
	DeviceID    uuid.UUID
	Ciphersuite int
}

// maybeNotifyKeyPackageLow checks each claimed device's remaining
// stock and pushes a kp_low event for any that fell below the
// threshold. Best-effort: errors are logged, never returned -- a
// claim must never fail because the low-stock check hiccuped.
//
// Dedup across multiple claims for the same device in one call: a
// single fetch_key_packages can claim KPs for several users but only
// ever one per device, so we don't expect duplicates here; we still
// guard with a seen-set to be safe.
func (h *WSHandler) maybeNotifyKeyPackageLow(ctx context.Context, claims []kpLowClaim) {
	if h.store == nil || len(claims) == 0 {
		return
	}
	seen := make(map[uuid.UUID]struct{}, len(claims))
	for _, cl := range claims {
		if _, dup := seen[cl.DeviceID]; dup {
			continue
		}
		seen[cl.DeviceID] = struct{}{}

		cs := cl.Ciphersuite
		if cs == 0 {
			cs = 1
		}
		remaining, err := h.store.CountUnusedKeyPackages(ctx, cl.DeviceID, cs)
		if err != nil {
			h.logger.Printf("kp_low: count for device %s: %v", cl.DeviceID, err)
			continue
		}
		if remaining > kpLowThreshold {
			continue
		}
		if err := h.publishKeyPackageLow(ctx, cl.UserID, cs, remaining); err != nil {
			h.logger.Printf("kp_low: publish to user %s: %v", cl.UserID, err)
		}
	}
}

// publishKeyPackageLow emits a "kp_low" pubsub event for the given
// user. Delivered to the user's devices in handleKeyPackageLowEvent
// (server.go dispatcher), cross-instance via LISTEN/NOTIFY just like
// channel events.
func (h *WSHandler) publishKeyPackageLow(
	ctx context.Context,
	userID uuid.UUID,
	ciphersuite int,
	remaining int,
) error {
	// Carry the ciphersuite + remaining in the channel-payload byte
	// field (reused as an opaque JSON blob; pubsub doesn't import
	// proto to avoid a cycle).
	blob, err := json.Marshal(proto.KeyPackageLowPayload{
		Ciphersuite: ciphersuite,
		Remaining:   remaining,
	})
	if err != nil {
		return err
	}
	return pgxBegin(ctx, h.store, func(tx pgx.Tx) error {
		return pubsub.PublishWithTx(ctx, tx, pubsub.Event{
			Kind:                "kp_low",
			UserID:              userID,
			ChannelEventPayload: blob, // reused opaque payload field
			InstanceID:          h.instanceID,
		})
	})
}
