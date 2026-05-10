package proto

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestNewFrameRejectsEmptyType(t *testing.T) {
	if _, err := NewFrame("", "", nil); err == nil {
		t.Fatal("expected error for empty type")
	}
}

func TestNewFrameRoundTrip(t *testing.T) {
	in := HelloPayload{DeviceID: "dev-123"}
	f, err := NewFrame(TypeHello, "r-1", in)
	if err != nil {
		t.Fatalf("NewFrame: %v", err)
	}
	if f.Type != TypeHello {
		t.Errorf("type: %q", f.Type)
	}
	if f.Ref != "r-1" {
		t.Errorf("ref: %q", f.Ref)
	}

	// Wire-decode round trip.
	wire, err := json.Marshal(f)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded Frame
	if err := json.Unmarshal(wire, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	var out HelloPayload
	if err := decoded.DecodePayload(&out); err != nil {
		t.Fatalf("DecodePayload: %v", err)
	}
	if out.DeviceID != in.DeviceID {
		t.Errorf("device_id: %q", out.DeviceID)
	}
}

func TestNewFrameNilPayloadOK(t *testing.T) {
	f, err := NewFrame(TypeError, "", nil)
	if err != nil {
		t.Fatalf("NewFrame: %v", err)
	}
	if len(f.Payload) != 0 {
		t.Errorf("expected empty payload, got %s", f.Payload)
	}
	// And it should marshal without "payload" appearing at all (omitempty).
	wire, _ := json.Marshal(f)
	if strings.Contains(string(wire), "payload") {
		t.Errorf("payload key should be omitted, got: %s", wire)
	}
}

func TestDecodePayloadEmptyErrors(t *testing.T) {
	f := Frame{Type: TypeError}
	var out HelloPayload
	if err := f.DecodePayload(&out); err == nil {
		t.Fatal("expected error for empty payload")
	}
}

func TestDecodePayloadBadJSON(t *testing.T) {
	f := Frame{Type: TypeHello, Payload: json.RawMessage(`{not-json`)}
	var out HelloPayload
	if err := f.DecodePayload(&out); err == nil {
		t.Fatal("expected decode error")
	}
}
