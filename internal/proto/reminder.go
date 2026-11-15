package proto

// Phase 87-7: the reminder wake frame. It exists only on the WebSocket,
// inside the sealed channel of phase 83, as the push frames do. A guest
// connection never reaches it.

const (
	// reminder_wakes_set replaces the wake set of the user: the ID and the
	// due time of each pending reminder, so the server can send a push while
	// chalk is closed. The payload is a ReminderWakesSetPayload. The server
	// answers with a reminder_wakes_set_ack frame that holds a
	// ReminderWakesAckPayload. A refused frame gets an error frame, and the
	// stored set stays as it was. The codes are push_unsealed,
	// push_no_session, push_disabled, and bad_payload.
	TypeReminderWakesSet    = "reminder_wakes_set"
	TypeReminderWakesSetAck = "reminder_wakes_set_ack"
)

// MaxReminderWakes is the largest number of records in one
// reminder_wakes_set frame.
const MaxReminderWakes = 25

// A ReminderWake is one record of the wake set. ID is the random UUID of the
// reminder. DueAt is the due time in milliseconds since the Unix epoch.
type ReminderWake struct {
	ID    string `json:"id"`
	DueAt int64  `json:"due_at"`
}

// ReminderWakesSetPayload is the full wake set of the user. An empty list
// deletes the stored set.
type ReminderWakesSetPayload struct {
	Wakes []ReminderWake `json:"wakes"`
}

// ReminderWakesAckPayload answers reminder_wakes_set. Stored is the number
// of records the server holds now. It is 0 if the user has no push
// subscription, because the server then stores no wake set.
type ReminderWakesAckPayload struct {
	Stored int `json:"stored"`
}
