package store

// 65-1: push subscriptions against a real Postgres (skips without
// CHALK_TEST_PGURL). The properties under test: a subscription follows its
// session through every way a session ends, a guest cannot hold one, and
// the per-user cap evicts the oldest.

import (
	"context"
	"errors"
	"fmt"
	"net"
	"testing"

	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/presence"
)

func TestPushSubscriptions(t *testing.T) {
	pool := openProbeDB(t, "chalk_push_probe")
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
	const vapidKey = "BKEY"
	p256dh := keyBytes(4, 65)
	auth := keyBytes(7, 16)
	sub := func(token []byte, endpoint string, scope PushScope) PushSubscription {
		t.Helper()
		p, err := s.UpsertPushSubscription(ctx, token, PushKindWebPush, endpoint, p256dh, auth, scope, vapidKey)
		if err != nil {
			t.Fatalf("upsert %s: %v", endpoint, err)
		}
		return p
	}
	count := func(userID uuid.UUID) int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx,
			`SELECT count(*) FROM push_subscriptions WHERE user_id = $1`, userID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}

	alice := mkUser("alice")
	bob := mkUser("bob")

	t.Run("upsert takes the user from the session", func(t *testing.T) {
		tok := mkSession(alice)
		p := sub(tok, "https://push.example/a1", PushScopeDMs)
		if p.UserID != alice || p.Scope != PushScopeDMs || p.Generic || len(p.P256dh) != 65 || len(p.Auth) != 16 {
			t.Fatalf("unexpected row: %+v", p)
		}
		got, err := s.GetPushSubscriptionForSession(ctx, tok)
		if err != nil || got.ID != p.ID {
			t.Fatalf("get: %v %+v", err, got)
		}
		// A second upsert of the same session replaces the row.
		p2 := sub(tok, "https://push.example/a2", PushScopeAll)
		if n := count(alice); n != 1 {
			t.Fatalf("rows after replace = %d, want 1", n)
		}
		got, _ = s.GetPushSubscriptionForSession(ctx, tok)
		if got.ID != p2.ID || got.Endpoint != "https://push.example/a2" || got.Scope != PushScopeAll {
			t.Fatalf("replace kept the old row: %+v", got)
		}
		if err := s.DeletePushSubscriptionForSession(ctx, tok); err != nil {
			t.Fatal(err)
		}
		if _, err := s.GetPushSubscriptionForSession(ctx, tok); !errors.Is(err, ErrNotFound) {
			t.Fatalf("get after delete: %v", err)
		}
	})

	t.Run("an unknown token and bad input are refused", func(t *testing.T) {
		if _, err := s.UpsertPushSubscription(ctx, keyBytes(9, 32), PushKindWebPush, "https://push.example/x", p256dh, auth, PushScopeDMs, vapidKey); !errors.Is(err, ErrNotFound) {
			t.Fatalf("unknown token: %v", err)
		}
		tok := mkSession(alice)
		if _, err := s.UpsertPushSubscription(ctx, tok, PushKindWebPush, "https://push.example/x", p256dh, auth, PushScope("loud"), vapidKey); err == nil {
			t.Fatal("bad scope accepted")
		}
		if _, err := s.UpsertPushSubscription(ctx, tok, PushKindWebPush, "https://push.example/x", keyBytes(4, 64), auth, PushScopeDMs, vapidKey); err == nil {
			t.Fatal("short p256dh accepted")
		}
		if _, err := s.UpsertPushSubscription(ctx, tok, PushKindWebPush, "https://push.example/x", p256dh, keyBytes(7, 15), PushScopeDMs, vapidKey); err == nil {
			t.Fatal("short auth accepted")
		}
		if n := count(alice); n != 0 {
			t.Fatalf("rows after refusals = %d, want 0", n)
		}
	})

	t.Run("an endpoint moves to the session that claims it", func(t *testing.T) {
		at := mkSession(alice)
		bt := mkSession(bob)
		sub(at, "https://push.example/shared", PushScopeDMs)
		p := sub(bt, "https://push.example/shared", PushScopeDMs)
		if p.UserID != bob {
			t.Fatalf("owner = %s, want bob", p.UserID)
		}
		if n := count(alice); n != 0 {
			t.Fatalf("alice still holds the endpoint (%d rows)", n)
		}
		if err := s.DeletePushSubscription(ctx, p.ID); err != nil {
			t.Fatal(err)
		}
		if n := count(bob); n != 0 {
			t.Fatalf("rows after delete by id = %d", n)
		}
	})

	t.Run("the list honours scope and session expiry", func(t *testing.T) {
		at := mkSession(alice)
		bt := mkSession(bob)
		sub(at, "https://push.example/la", PushScopeDMs)
		sub(bt, "https://push.example/lb", PushScopeAll)
		both := []uuid.UUID{alice, bob}

		dm, err := s.ListPushSubscriptionsForUsers(ctx, both, true, []string{vapidKey})
		if err != nil || len(dm) != 2 {
			t.Fatalf("dm list: %v, %d rows", err, len(dm))
		}
		ch, err := s.ListPushSubscriptionsForUsers(ctx, both, false, []string{vapidKey})
		if err != nil || len(ch) != 1 || ch[0].UserID != bob {
			t.Fatalf("channel list: %v, %+v", err, ch)
		}
		if none, err := s.ListPushSubscriptionsForUsers(ctx, nil, true, []string{vapidKey}); err != nil || none != nil {
			t.Fatalf("empty input: %v, %+v", err, none)
		}

		// An expired session stops pushes before the sweep deletes it.
		if _, err := pool.Exec(ctx,
			`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE token = $1`, bt); err != nil {
			t.Fatal(err)
		}
		dm, _ = s.ListPushSubscriptionsForUsers(ctx, both, true, []string{vapidKey})
		if len(dm) != 1 || dm[0].UserID != alice {
			t.Fatalf("expired session still listed: %+v", dm)
		}
		if n := count(bob); n != 1 {
			t.Fatalf("row gone before the sweep (%d)", n)
		}
		if _, err := s.DeleteExpiredSessions(ctx); err != nil {
			t.Fatal(err)
		}
		if n := count(bob); n != 0 {
			t.Fatalf("sweep left the subscription (%d)", n)
		}
		if err := s.DeleteSession(ctx, at); err != nil {
			t.Fatal(err)
		}
		if n := count(alice); n != 0 {
			t.Fatalf("logout left the subscription (%d)", n)
		}
	})

	t.Run("revoking sessions removes their subscriptions", func(t *testing.T) {
		keep := mkSession(alice)
		other := mkSession(alice)
		sub(keep, "https://push.example/keep", PushScopeDMs)
		sub(other, "https://push.example/other", PushScopeDMs)
		if _, err := s.DeleteSessionsForUserExcept(ctx, alice, keep); err != nil {
			t.Fatal(err)
		}
		if _, err := s.GetPushSubscriptionForSession(ctx, other); !errors.Is(err, ErrNotFound) {
			t.Fatalf("revoked session kept its subscription: %v", err)
		}
		if _, err := s.GetPushSubscriptionForSession(ctx, keep); err != nil {
			t.Fatalf("kept session lost its subscription: %v", err)
		}
		if _, err := s.DeleteAllSessionsForUser(ctx, alice); err != nil {
			t.Fatal(err)
		}
		if n := count(alice); n != 0 {
			t.Fatalf("rows after revoke-all = %d", n)
		}
	})

	t.Run("a subscription made with another key is not listed", func(t *testing.T) {
		dave := mkUser("dave")
		tok := mkSession(dave)
		if _, err := s.UpsertPushSubscription(ctx, tok, PushKindWebPush, "https://push.example/old", p256dh, auth, PushScopeDMs, "OLDKEY"); err != nil {
			t.Fatal(err)
		}
		if got, _ := s.ListPushSubscriptionsForUsers(ctx, []uuid.UUID{dave}, true, []string{vapidKey}); len(got) != 0 {
			t.Fatalf("stale subscription listed: %+v", got)
		}
		got, err := s.GetPushSubscriptionForSession(ctx, tok)
		if err != nil || got.VAPIDKey != "OLDKEY" {
			t.Fatalf("get: %v %+v", err, got)
		}
		sub(tok, "https://push.example/new", PushScopeDMs)
		if got, _ := s.ListPushSubscriptionsForUsers(ctx, []uuid.UUID{dave}, true, []string{vapidKey}); len(got) != 1 {
			t.Fatalf("resubscribed row not listed: %+v", got)
		}
	})

	t.Run("an APNs device is listed only under its own key", func(t *testing.T) {
		apnsUser := mkUser("kim")
		phone, laptop := mkSession(apnsUser), mkSession(apnsUser)
		const apnsKey = "at.73c.chalk/production"
		got, err := s.UpsertPushSubscription(ctx, phone, PushKindAPNs, "00fc13ad", p256dh, auth, PushScopeDMs, apnsKey)
		if err != nil || got.Kind != PushKindAPNs || got.Endpoint != "00fc13ad" || got.VAPIDKey != apnsKey {
			t.Fatalf("upsert APNs: %v %+v", err, got)
		}
		if web := sub(laptop, "https://push.example/erin", PushScopeDMs); web.Kind != PushKindWebPush {
			t.Fatalf("web push row has kind %q", web.Kind)
		}
		users := []uuid.UUID{apnsUser}
		if l, _ := s.ListPushSubscriptionsForUsers(ctx, users, true, []string{vapidKey}); len(l) != 1 || l[0].Kind != PushKindWebPush {
			t.Fatalf("web push key lists %+v", l)
		}
		if l, _ := s.ListPushSubscriptionsForUsers(ctx, users, true, []string{apnsKey}); len(l) != 1 || l[0].Kind != PushKindAPNs {
			t.Fatalf("APNs key lists %+v", l)
		}
		if l, _ := s.ListPushSubscriptionsForUsers(ctx, users, true, []string{vapidKey, apnsKey}); len(l) != 2 {
			t.Fatalf("both keys list %d rows", len(l))
		}
		if l, _ := s.ListPushSubscriptionsForUsers(ctx, users, true, nil); l != nil {
			t.Fatalf("no keys lists %+v", l)
		}
		if l, _ := s.ListPushSubscriptionsForUsers(ctx, users, true, []string{"at.73c.chalk/sandbox"}); len(l) != 0 {
			t.Fatalf("sandbox key lists %+v", l)
		}
		if _, err := s.UpsertPushSubscription(ctx, phone, PushKind("fcm"), "x", p256dh, auth, PushScopeDMs, apnsKey); err == nil {
			t.Fatal("an unknown kind was stored")
		}
		if _, err := pool.Exec(ctx, `UPDATE push_subscriptions SET kind = 'fcm' WHERE user_id = $1`, apnsUser); err == nil {
			t.Fatal("the kind check accepted fcm")
		}
		back, err := s.GetPushSubscriptionForSession(ctx, phone)
		if err != nil || back.Kind != PushKindAPNs {
			t.Fatalf("get APNs: %v %+v", err, back)
		}
		if err := s.DeletePushSubscriptionForSession(ctx, phone); err != nil {
			t.Fatal(err)
		}
		if l, _ := s.ListPushSubscriptionsForUsers(ctx, users, true, []string{apnsKey}); len(l) != 0 {
			t.Fatalf("unsubscribed APNs row still listed: %+v", l)
		}
	})

	t.Run("the cap evicts the oldest", func(t *testing.T) {
		carol := mkUser("carol")
		var first []byte
		for i := 0; i <= MaxPushSubscriptionsPerUser; i++ {
			tok := mkSession(carol)
			if i == 0 {
				first = tok
			}
			sub(tok, fmt.Sprintf("https://push.example/c%d", i), PushScopeDMs)
		}
		if n := count(carol); n != MaxPushSubscriptionsPerUser {
			t.Fatalf("rows = %d, want %d", n, MaxPushSubscriptionsPerUser)
		}
		if _, err := s.GetPushSubscriptionForSession(ctx, first); !errors.Is(err, ErrNotFound) {
			t.Fatalf("oldest survived the cap: %v", err)
		}
	})

	t.Run("the badge counts unread DMs and waiting friend requests", func(t *testing.T) {
		erin, frank, gina := mkUser("erin"), mkUser("frank"), mkUser("gina")
		dm1, err := s.CreateChannel(ctx, CreateChannelInput{Name: "dm-a", IsDM: true, CreatedBy: frank, MemberIDs: []uuid.UUID{frank, erin}})
		if err != nil {
			t.Fatal(err)
		}
		dm2, err := s.CreateChannel(ctx, CreateChannelInput{Name: "dm-b", IsDM: true, CreatedBy: gina, MemberIDs: []uuid.UUID{gina, erin}})
		if err != nil {
			t.Fatal(err)
		}
		group, err := s.CreateChannel(ctx, CreateChannelInput{Name: "group", CreatedBy: frank, MemberIDs: []uuid.UUID{frank, erin}})
		if err != nil {
			t.Fatal(err)
		}
		// Each channel holds five messages. erin has read dm2 and nothing else.
		for _, ch := range []uuid.UUID{dm1.ID, dm2.ID, group.ID} {
			if _, err := pool.Exec(ctx,
				`INSERT INTO channel_seq (channel_id, next_seq) VALUES ($1, 6)
				 ON CONFLICT (channel_id) DO UPDATE SET next_seq = 6`, ch); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := pool.Exec(ctx,
			`INSERT INTO channel_reads (user_id, channel_id, last_read_seq) VALUES ($1, $2, 5)`, erin, dm2.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx,
			`INSERT INTO friendships (user_a, user_b, status) VALUES ($1, $2, 'pending'), ($3, $1, 'pending')`,
			gina, erin, frank); err != nil {
			t.Fatal(err)
		}
		got, err := s.PushBadges(ctx, []uuid.UUID{erin, frank})
		if err != nil {
			t.Fatal(err)
		}
		// erin has dm1 unread and one request from gina.
		// dm2 is read, and the group is not a DM.
		// frank has dm1 unread, because he never read it, and no request.
		if got[erin] != 2 || got[frank] != 1 {
			t.Fatalf("badges = %v, want erin 2, frank 1", got)
		}
	})

	t.Run("online users are those with a device in state online", func(t *testing.T) {
		hank, ivy, jo := mkUser("hank"), mkUser("ivy"), mkUser("joan")
		if _, err := pool.Exec(ctx, `INSERT INTO instances (id) VALUES ('push-test')`); err != nil {
			t.Fatal(err)
		}
		for _, row := range []struct {
			user  uuid.UUID
			state string
		}{{hank, "online"}, {hank, "away"}, {ivy, "away"}} {
			dev, err := s.CreateDevice(ctx, row.user, DeviceBrowserUnknown, "probe")
			if err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx,
				`INSERT INTO device_presence (device_id, user_id, instance_id, device_type, state)
				 VALUES ($1, $2, 'push-test', 'desktop', $3)`, dev.ID, row.user, row.state); err != nil {
				t.Fatal(err)
			}
		}
		pr := &presence.Store{Pool: pool}
		got, err := pr.OnlineUsers(ctx, []uuid.UUID{hank, ivy, jo})
		if err != nil {
			t.Fatal(err)
		}
		if !got[hank] || got[ivy] || got[jo] || len(got) != 1 {
			t.Fatalf("online = %v, want only hank", got)
		}
	})

	t.Run("a guest is refused even with a sessions row", func(t *testing.T) {
		room, err := s.CreateChannel(ctx, CreateChannelInput{Name: "room", CreatedBy: alice, ChannelType: "voice"})
		if err != nil {
			t.Fatal(err)
		}
		guest := mkUser("guest")
		if _, err := pool.Exec(ctx,
			`UPDATE users SET guest_channel_id = $2 WHERE id = $1`, guest, room.ID); err != nil {
			t.Fatal(err)
		}
		tok := mkSession(guest)
		if _, err := s.UpsertPushSubscription(ctx, tok, PushKindWebPush, "https://push.example/g", p256dh, auth, PushScopeDMs, vapidKey); !errors.Is(err, ErrNotFound) {
			t.Fatalf("guest upsert: %v", err)
		}
	})
}
