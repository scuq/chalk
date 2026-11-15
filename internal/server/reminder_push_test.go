package server

// 87-8: who gets a reminder push and what it says. The store and the sender
// are the fakes of push_dispatch_test.go.

import (
	"context"
	"errors"
	"sort"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/store"
	"github.com/scuq/chalk/internal/webpush"
)

func TestReminderSweepPushesAwayUsers(t *testing.T) {
	f := newPushFixture()
	r1, r2, r3 := uuid.New(), uuid.New(), uuid.New()
	// bob is away with two subscriptions, carol is online, dave has none.
	f.data.dueWakes = []store.DueReminderWake{
		{UserID: f.bob, ReminderID: r1},
		{UserID: f.carol, ReminderID: r2},
		{UserID: f.dave, ReminderID: r3},
	}
	n, err := f.d.sweepReminders(context.Background(), time.Now())
	if err != nil || n != 3 {
		t.Fatalf("sweep: %d %v", n, err)
	}
	got := f.endpoints()
	sort.Strings(got)
	want := []string{"https://push.cyberdyne.example/bob-laptop", "https://push.cyberdyne.example/bob-phone"}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("pushed to %v, want %v", got, want)
	}
	if !f.data.gotIsDM || f.data.gotKey != "CURKEY" {
		t.Fatalf("subscriptions asked with isDM=%v key=%q", f.data.gotIsDM, f.data.gotKey)
	}
	for _, s := range f.sender.sent {
		if len(s.payload) != 3 || s.payload["v"] != float64(1) || s.payload["kind"] != "reminder" ||
			s.payload["reminder_id"] != r1.String() {
			t.Fatalf("payload: %v", s.payload)
		}
		if s.opts.Topic != "" || s.opts.Urgency != webpush.UrgencyHigh || s.opts.TTL != pushTTL {
			t.Fatalf("options: %+v", s.opts)
		}
	}
	if len(f.data.touched) != 2 {
		t.Fatalf("touched %d subscriptions", len(f.data.touched))
	}
	// The records are gone, so a second sweep sends nothing.
	if n, err := f.d.sweepReminders(context.Background(), time.Now()); err != nil || n != 0 || len(f.sender.sent) != 2 {
		t.Fatalf("second sweep: %d %v, %d sent", n, err, len(f.sender.sent))
	}
}

func TestReminderSweepTwoRemindersNoCooldown(t *testing.T) {
	f := newPushFixture()
	f.data.dueWakes = []store.DueReminderWake{
		{UserID: f.bob, ReminderID: uuid.New()},
		{UserID: f.bob, ReminderID: uuid.New()},
	}
	if _, err := f.d.sweepReminders(context.Background(), time.Now()); err != nil {
		t.Fatal(err)
	}
	if len(f.sender.sent) != 4 {
		t.Fatalf("two reminders on two subscriptions: %d pushes", len(f.sender.sent))
	}
}

func TestReminderSweepPrunesGoneAndReportsClaimError(t *testing.T) {
	f := newPushFixture()
	f.sender.errs["https://push.cyberdyne.example/bob-phone"] = webpush.ErrGone
	f.data.dueWakes = []store.DueReminderWake{{UserID: f.bob, ReminderID: uuid.New()}}
	if _, err := f.d.sweepReminders(context.Background(), time.Now()); err != nil {
		t.Fatal(err)
	}
	if len(f.data.deleted) != 1 || len(f.data.touched) != 1 {
		t.Fatalf("deleted %d, touched %d", len(f.data.deleted), len(f.data.touched))
	}

	f.data.claimErr = errors.New("db down")
	if _, err := f.d.sweepReminders(context.Background(), time.Now()); err == nil {
		t.Fatal("want the claim error")
	}
}

func TestReminderSweepLoopStopsWithContext(t *testing.T) {
	f := newPushFixture()
	f.data.dueWakes = []store.DueReminderWake{{UserID: f.bob, ReminderID: uuid.New()}}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); f.d.runReminderSweep(ctx, time.Hour) }()
	deadline := time.Now().Add(2 * time.Second)
	for {
		f.sender.mu.Lock()
		n := len(f.sender.sent)
		f.sender.mu.Unlock()
		if n == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the first sweep sent %d pushes", n)
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the loop did not stop")
	}
}
