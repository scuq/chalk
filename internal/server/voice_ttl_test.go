package server

// 80-10: the TURN credential TTL clamp.

import (
	"testing"
	"time"
)

func TestClampTurnTTL(t *testing.T) {
	now := time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)
	hour := time.Hour
	at := func(d time.Duration) *time.Time { ts := now.Add(d); return &ts }

	cases := []struct {
		name    string
		session time.Time
		channel *time.Time
		want    time.Duration
	}{
		{"unclamped", time.Time{}, nil, hour},
		{"session sooner", now.Add(10 * time.Minute), nil, 10 * time.Minute},
		{"channel sooner", time.Time{}, at(5 * time.Minute), 5 * time.Minute},
		{"tightest of both wins", now.Add(10 * time.Minute), at(5 * time.Minute), 5 * time.Minute},
		{"session tighter than channel", now.Add(2 * time.Minute), at(5 * time.Minute), 2 * time.Minute},
		{"later expiries never stretch", now.Add(48 * time.Hour), at(48 * time.Hour), hour},
		{"floor for near-dead room", time.Time{}, at(3 * time.Second), 30 * time.Second},
		{"floor for expired session", now.Add(-time.Minute), nil, 30 * time.Second},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := clampTurnTTL(hour, now, tc.session, tc.channel); got != tc.want {
				t.Errorf("clampTurnTTL = %v, want %v", got, tc.want)
			}
		})
	}
}
