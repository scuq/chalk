// Phase 9.7 -- user preferences wire types.
//
// prefs_get      (client → server)     no body
// prefs_get_ack  (server → client)     { prefs: <obj> }
// prefs_set      (client → server)     { patch: <obj> }
// prefs_set_ack  (server → client)     { prefs: <merged obj> }
// prefs_changed  (server → client)     { prefs: <merged obj> }    [push]
//
// The prefs body is intentionally an opaque object. The server stores
// it as JSONB and enforces only a size cap. Typed fields are the
// SPA's concern -- the server doesn't validate individual keys, so
// adding a new pref is a SPA-only change.

package proto

const (
	TypePrefsGet     = "prefs_get"
	TypePrefsGetAck  = "prefs_get_ack"
	TypePrefsSet     = "prefs_set"
	TypePrefsSetAck  = "prefs_set_ack"
	TypePrefsChanged = "prefs_changed" // push
)

// PrefsGetPayload is empty -- the calling user is identified by the
// connection's authenticated user_id.
type PrefsGetPayload struct{}

// PrefsSetPayload carries a JSON object that is shallow-merged into
// the stored prefs server-side. Keys missing from the patch are
// preserved unchanged.
type PrefsSetPayload struct {
	Patch map[string]any `json:"patch"`
}

// PrefsAckPayload carries the merged result back to clients. Used by
// both prefs_get_ack, prefs_set_ack, and prefs_changed -- same shape
// keeps the SPA's handler logic tight.
type PrefsAckPayload struct {
	Prefs map[string]any `json:"prefs"`
}
