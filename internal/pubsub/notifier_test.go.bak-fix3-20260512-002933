package pubsub

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestEventEncodeRoundTrip(t *testing.T) {
	ev := Event{
		Kind:           "message",
		MessageID:      uuid.MustParse("11111111-2222-3333-4444-555555555555"),
		TS:             time.Date(2026, 5, 10, 17, 0, 0, 0, time.UTC),
		ChannelID:      uuid.MustParse("00000000-0000-0000-0000-000000000c01"),
		SenderDeviceID: uuid.MustParse("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
		InstanceID:     "inst-1",
	}
	b, err := ev.Encode()
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}

	var got Event
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if got != ev {
		t.Errorf("round trip differs:\n got = %+v\nwant = %+v", got, ev)
	}
}

func TestEventEncodeIsCompact(t *testing.T) {
	// Sanity check on payload size. With short JSON keys ("k","m","t","c","s","i")
	// a fully-populated event should land well under 400 bytes.
	ev := Event{
		Kind:           "message",
		MessageID:      uuid.New(),
		TS:             time.Now().UTC(),
		ChannelID:      uuid.New(),
		SenderDeviceID: uuid.New(),
		InstanceID:     "instance-with-a-fairly-long-name-1234",
	}
	b, err := ev.Encode()
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	if len(b) > 400 {
		t.Errorf("payload unexpectedly large: %d bytes (%s)", len(b), b)
	}
}

func TestEventEncodeRejectsOversize(t *testing.T) {
	ev := Event{
		Kind:       "message",
		InstanceID: strings.Repeat("x", 8000),
	}
	if _, err := ev.Encode(); err == nil {
		t.Fatal("expected oversize payload error")
	}
}
