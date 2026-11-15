package store

// 87-7: reminder wake records against a real Postgres (skips without
// CHALK_TEST_PGURL). The properties under test: the set is stored only for a
// user with a push subscription, a replace is idempotent, and the set goes
// away with the last subscription by every path.

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestReminderWakes(t *testing.T) {
	pool := openProbeDB(t, "chalk_reminder_wake_probe")
	ctx := context.Background()
	s := &Store{Pool: pool}

	mkUser := func(handle string) uuid.UUID {
		t.Helper()
		id := uuid.New()
		if _, err := pool.Exec(ctx,
			`INSERT INTO users (id, handle, username, display_name, email)
			 VALUES ($1,$2,$3,$4,$5)`, id, handle, handle, handle, handle+"@x.test"); err != nil {
			t.Fatal(err)
		}
		return id
	}
	mkSession := func(userID uuid.UUID) []byte {
		t.Helper()
		sess, err := s.CreateSession(ctx, userID, "test-agent", net.ParseIP("127.0.0.1"))
		if err != nil {
			t.Fatal(err)
		}
		return sess.Token
	}
	sub := func(token []byte, endpoint string) PushSubscription {
		t.Helper()
		p, err := s.UpsertPushSubscription(ctx, token, endpoint, keyBytes(4, 65), keyBytes(7, 16), PushScopeDMs, "BKEY")
		if err != nil {
			t.Fatalf("upsert %s: %v", endpoint, err)
		}
		return p
	}
	base := time.Date(2026, 11, 20, 9, 0, 0, 0, time.UTC)
	set := func(n int) []ReminderWake {
		out := make([]ReminderWake, n)
		for i := range out {
			out[i] = ReminderWake{ReminderID: uuid.New(), DueAt: base.Add(time.Duration(i) * time.Hour)}
		}
		return out
	}
	replace := func(userID uuid.UUID, wakes []ReminderWake) int {
		t.Helper()
		n, err := s.ReplaceReminderWakes(ctx, userID, wakes)
		if err != nil {
			t.Fatalf("replace: %v", err)
		}
		return n
	}
	stored := func(userID uuid.UUID) int {
		t.Helper()
		got, err := s.ListReminderWakes(ctx, userID)
		if err != nil {
			t.Fatal(err)
		}
		return len(got)
	}

	t.Run("no subscription stores nothing", func(t *testing.T) {
		u := mkUser("nosub")
		if n := replace(u, set(3)); n != 0 || stored(u) != 0 {
			t.Fatalf("stored %d, listed %d", n, stored(u))
		}
	})

	t.Run("replace is idempotent and replaces the whole set", func(t *testing.T) {
		u := mkUser("replace")
		sub(mkSession(u), "https://push.example/r1")
		first := set(3)
		if n := replace(u, first); n != 3 {
			t.Fatalf("stored %d", n)
		}
		if n := replace(u, first); n != 3 || stored(u) != 3 {
			t.Fatalf("second replace: stored %d, listed %d", n, stored(u))
		}
		got, _ := s.ListReminderWakes(ctx, u)
		if got[0].ReminderID != first[0].ReminderID || !got[0].DueAt.Equal(first[0].DueAt) {
			t.Fatalf("first record: %+v want %+v", got[0], first[0])
		}
		next := []ReminderWake{first[2], {ReminderID: uuid.New(), DueAt: base}}
		if n := replace(u, next); n != 2 || stored(u) != 2 {
			t.Fatalf("after shrink: stored %d, listed %d", n, stored(u))
		}
		if n := replace(u, nil); n != 0 || stored(u) != 0 {
			t.Fatalf("after empty: stored %d, listed %d", n, stored(u))
		}
	})

	t.Run("one reminder ID twice is stored once", func(t *testing.T) {
		u := mkUser("twice")
		sub(mkSession(u), "https://push.example/t1")
		w := set(1)
		if n := replace(u, []ReminderWake{w[0], w[0]}); n != 1 {
			t.Fatalf("stored %d", n)
		}
	})

	t.Run("the cap and an unknown user are errors", func(t *testing.T) {
		u := mkUser("cap")
		sub(mkSession(u), "https://push.example/c1")
		if n := replace(u, set(MaxReminderWakesPerUser)); n != MaxReminderWakesPerUser {
			t.Fatalf("a full set: stored %d", n)
		}
		if _, err := s.ReplaceReminderWakes(ctx, u, set(MaxReminderWakesPerUser+1)); err == nil {
			t.Fatal("want an error above the cap")
		}
		if stored(u) != MaxReminderWakesPerUser {
			t.Fatalf("a refused set changed the stored one: %d", stored(u))
		}
		if _, err := s.ReplaceReminderWakes(ctx, uuid.New(), set(1)); !errors.Is(err, ErrNotFound) {
			t.Fatalf("unknown user: %v", err)
		}
	})

	t.Run("the set goes with the last subscription", func(t *testing.T) {
		u := mkUser("last")
		other := mkUser("other")
		sub(mkSession(other), "https://push.example/o1")
		replace(other, set(2))

		tokA, tokB := mkSession(u), mkSession(u)
		sub(tokA, "https://push.example/l1")
		b := sub(tokB, "https://push.example/l2")
		replace(u, set(4))

		// Unsubscribe one of two: the set stays.
		if err := s.DeletePushSubscriptionForSession(ctx, tokA); err != nil {
			t.Fatal(err)
		}
		if stored(u) != 4 {
			t.Fatalf("after one of two: %d", stored(u))
		}
		// A subscribe that replaces the only subscription keeps the set.
		sub(tokB, "https://push.example/l2-new")
		if stored(u) != 4 {
			t.Fatalf("after a replaced subscription: %d", stored(u))
		}
		// The prune of a dead endpoint deletes by ID. It was replaced above,
		// so this deletes nothing and the set stays.
		if err := s.DeletePushSubscription(ctx, b.ID); err != nil {
			t.Fatal(err)
		}
		if stored(u) != 4 {
			t.Fatalf("after a stale prune: %d", stored(u))
		}
		// Logout of the last session with a subscription: the cascade
		// deletes the subscription, and the set goes with it.
		if err := s.DeleteSession(ctx, tokB); err != nil {
			t.Fatal(err)
		}
		if stored(u) != 0 {
			t.Fatalf("after the last subscription: %d", stored(u))
		}
		if stored(other) != 2 {
			t.Fatalf("another user's set changed: %d", stored(other))
		}
	})

	t.Run("unsubscribe and prune of the last subscription", func(t *testing.T) {
		u := mkUser("unsub")
		tok := mkSession(u)
		sub(tok, "https://push.example/u1")
		replace(u, set(2))
		if err := s.DeletePushSubscriptionForSession(ctx, tok); err != nil {
			t.Fatal(err)
		}
		if stored(u) != 0 {
			t.Fatalf("after unsubscribe: %d", stored(u))
		}
		p := sub(tok, "https://push.example/u2")
		replace(u, set(2))
		if err := s.DeletePushSubscription(ctx, p.ID); err != nil {
			t.Fatal(err)
		}
		if stored(u) != 0 {
			t.Fatalf("after prune: %d", stored(u))
		}
	})

	t.Run("a purged user leaves no set", func(t *testing.T) {
		u := mkUser("purge")
		sub(mkSession(u), "https://push.example/p1")
		replace(u, set(2))
		if _, err := pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, u); err != nil {
			t.Fatal(err)
		}
		var n int
		if err := pool.QueryRow(ctx,
			`SELECT count(*) FROM reminder_wakes WHERE user_id = $1`, u).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Fatalf("rows after purge: %d", n)
		}
	})
}
