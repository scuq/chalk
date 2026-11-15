package server

// 87-8: the push for a reminder that becomes due while chalk is closed.
//
// A sweep claims the wake records that are due (store.ClaimDueReminderWakes).
// If a user has a device online, the sweep sends nothing for that user,
// because the open client fires the reminder. For every other user, it sends
// one push for each record to each subscription. The push holds the reminder
// ID and nothing else. The server does not know the message, and the service
// worker has no key.

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/store"
	"github.com/scuq/chalk/internal/webpush"
)

const (
	// reminderSweepInterval is the time between two sweeps. A push for a
	// reminder is at most this late.
	reminderSweepInterval = 15 * time.Second
	// reminderSweepBatch is the largest number of records one claim takes.
	reminderSweepBatch = 200
	// reminderSweepTimeout is the time limit for one sweep.
	reminderSweepTimeout = time.Minute
)

// reminderPushPayload is the plaintext of a reminder push. It has these three
// fields and no other. The client has the same shape in ReminderPushPayload
// (web/src/sw-logic.ts).
type reminderPushPayload struct {
	V          int    `json:"v"`
	Kind       string `json:"kind"`
	ReminderID string `json:"reminder_id"`
}

// sweepReminders claims the wake records that are due at or before now, up to
// reminderSweepBatch, and sends their pushes. It returns the number of
// claimed records.
//
// The claim deletes the records. If a push fails, or if an error follows the
// claim, the sweep does not send that push again.
//
// The push goes to each live subscription with the current VAPID key,
// whatever its scope. If the claim fails, the sweep returns the error and
// sends nothing.
func (d *pushDispatcher) sweepReminders(ctx context.Context, now time.Time) (int, error) {
	due, err := d.data.claimReminderWakes(ctx, now, reminderSweepBatch)
	if err != nil || len(due) == 0 {
		return 0, err
	}
	seen := make(map[uuid.UUID]struct{}, len(due))
	var users []uuid.UUID
	for _, w := range due {
		if _, ok := seen[w.UserID]; !ok {
			seen[w.UserID] = struct{}{}
			users = append(users, w.UserID)
		}
	}
	online, err := d.data.online(ctx, users)
	if err != nil {
		return len(due), err
	}
	var away []uuid.UUID
	for _, u := range users {
		if !online[u] {
			away = append(away, u)
		}
	}
	if len(away) == 0 {
		return len(due), nil
	}
	// A reminder is not a channel message, so the scope of a subscription
	// does not apply. The value true for isDM selects the scope dms and the
	// scope all.
	subs, err := d.data.subscriptions(ctx, away, true, d.sender.PublicKey())
	if err != nil {
		return len(due), err
	}
	byUser := make(map[uuid.UUID][]store.PushSubscription, len(away))
	for _, s := range subs {
		byUser[s.UserID] = append(byUser[s.UserID], s)
	}
	// No Topic. Each reminder is pushed once, and the message pushes share one
	// topic. A topic would let pushes replace each other at the push service.
	// There is also no cooldown.
	opts := webpush.Options{TTL: pushTTL, Urgency: webpush.UrgencyHigh}
	for _, w := range due {
		body, _ := json.Marshal(reminderPushPayload{V: 1, Kind: "reminder", ReminderID: w.ReminderID.String()})
		for _, sub := range byUser[w.UserID] {
			d.send(ctx, sub, body, opts)
		}
	}
	return len(due), nil
}

// runReminderSweep sweeps once at the start and then every interval, until
// ctx ends. If an interval of zero or less is given, it uses
// reminderSweepInterval. If a sweep claims a full batch, the next sweep
// starts at once. If a sweep fails, it logs the error, and the next sweep
// runs at the next interval.
func (d *pushDispatcher) runReminderSweep(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = reminderSweepInterval
	}
	sweep := func() {
		for ctx.Err() == nil {
			sctx, cancel := context.WithTimeout(ctx, reminderSweepTimeout)
			n, err := d.sweepReminders(sctx, time.Now())
			cancel()
			if err != nil {
				if ctx.Err() == nil {
					d.logger.Printf("reminder sweep: %v", err)
				}
				return
			}
			if n < reminderSweepBatch {
				return
			}
		}
	}
	sweep()
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			sweep()
		}
	}
}
