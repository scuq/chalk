package server

// 87-7: the validation of a reminder_wakes_set payload.

import (
	"testing"

	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/proto"
)

func TestParseReminderWakes(t *testing.T) {
	id := uuid.NewString()
	ok := proto.ReminderWakesSetPayload{Wakes: []proto.ReminderWake{
		{ID: id, DueAt: 1_800_000_000_000},
		{ID: uuid.NewString(), DueAt: 1},
	}}
	got, msg := parseReminderWakes(ok)
	if msg != "" || len(got) != 2 {
		t.Fatalf("valid payload: %q %+v", msg, got)
	}
	if got[0].ReminderID.String() != id || got[0].DueAt.UnixMilli() != 1_800_000_000_000 {
		t.Fatalf("first record: %+v", got[0])
	}
	if got, msg := parseReminderWakes(proto.ReminderWakesSetPayload{}); msg != "" || len(got) != 0 {
		t.Fatalf("empty payload: %q %+v", msg, got)
	}

	full := proto.ReminderWakesSetPayload{}
	for i := 0; i < proto.MaxReminderWakes; i++ {
		full.Wakes = append(full.Wakes, proto.ReminderWake{ID: uuid.NewString(), DueAt: 5})
	}
	if _, msg := parseReminderWakes(full); msg != "" {
		t.Fatalf("a full set must pass: %q", msg)
	}
	full.Wakes = append(full.Wakes, proto.ReminderWake{ID: uuid.NewString(), DueAt: 5})

	bad := map[string]proto.ReminderWakesSetPayload{
		"too many":     full,
		"not a uuid":   {Wakes: []proto.ReminderWake{{ID: "nope", DueAt: 5}}},
		"twice":        {Wakes: []proto.ReminderWake{{ID: id, DueAt: 5}, {ID: id, DueAt: 6}}},
		"zero due":     {Wakes: []proto.ReminderWake{{ID: id, DueAt: 0}}},
		"negative due": {Wakes: []proto.ReminderWake{{ID: id, DueAt: -1}}},
		"far due":      {Wakes: []proto.ReminderWake{{ID: id, DueAt: maxReminderWakeDueMs}}},
	}
	for name, p := range bad {
		if _, msg := parseReminderWakes(p); msg == "" {
			t.Errorf("%s: want a refusal", name)
		}
	}
}
