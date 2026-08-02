package chalkctl

import (
	"encoding/json"
	"fmt"
	"os"
	"time"
)

// State is chalkctl's record of what is deployed, at DefaultStatePath. update
// and rollback read/write it; init seeds it. Current is what runs now;
// Previous is the last-good image to roll back to.
type State struct {
	Channel        string    `json:"channel"`
	CurrentVersion string    `json:"current_version"` // e.g. v0.1.0
	CurrentDigest  string    `json:"current_digest"`  // sha256:...
	PreviousDigest string    `json:"previous_digest,omitempty"`
	UpdatedAt      time.Time `json:"updated_at"`

	// 72-5: maintenance mode is deployment state, not operator config -- it
	// says what the Caddyfile currently serves. Kept here so `status` can
	// report it and `init --force` can re-render without silently dropping
	// it (you are in maintenance precisely because work is in progress).
	Maintenance        bool   `json:"maintenance,omitempty"`
	MaintenanceMessage string `json:"maintenance_message,omitempty"`
}

// LoadState reads state; a missing file yields a zero State and ok=false so
// callers can tell "never initialized" from "initialized empty".
func LoadState(path string) (State, bool, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return State{}, false, nil
		}
		return State{}, false, fmt.Errorf("read state %s: %w", path, err)
	}
	var s State
	if err := json.Unmarshal(b, &s); err != nil {
		return State{}, false, fmt.Errorf("parse state %s: %w", path, err)
	}
	return s, true, nil
}

// Save writes state (parent dir 0755, file 0644 -- no secrets).
func (s State) Save(path string) error {
	if err := os.MkdirAll(dirOf(path), 0o755); err != nil {
		return err
	}
	s.UpdatedAt = time.Now().UTC()
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}
