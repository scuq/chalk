package server

// 135-6: the answer to an application-level ping. The handler only writes
// this frame, so the frame is what the test checks.

import (
	"encoding/json"
	"testing"

	"github.com/scuq/chalk/internal/proto"
)

func TestPongFrameCarriesTheRef(t *testing.T) {
	data, err := pongFrame("r1-7")
	if err != nil {
		t.Fatalf("pongFrame: %v", err)
	}
	var f proto.Frame
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if f.Type != proto.TypePong || f.Ref != "r1-7" {
		t.Fatalf("got type=%q ref=%q, want pong r1-7", f.Type, f.Ref)
	}
	if len(f.Payload) != 0 {
		t.Fatalf("pong carries a payload: %s", f.Payload)
	}
}
