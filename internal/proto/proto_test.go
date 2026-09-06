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

func TestServerNoticeFrameRoundTrip(t *testing.T) {
	in := ServerNoticePayload{Kind: NoticeRestarting, Version: "v0.3.46", Commit: "abc1234"}
	f, err := NewFrame(TypeServerNotice, "", in)
	if err != nil {
		t.Fatalf("NewFrame: %v", err)
	}
	if f.Ref != "" {
		t.Errorf("server push must carry no ref, got %q", f.Ref)
	}

	wire, err := json.Marshal(f)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded Frame
	if err := json.Unmarshal(wire, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if decoded.Type != TypeServerNotice {
		t.Errorf("type: %q", decoded.Type)
	}

	var out ServerNoticePayload
	if err := decoded.DecodePayload(&out); err != nil {
		t.Fatalf("DecodePayload: %v", err)
	}
	if out != in {
		t.Errorf("round trip: got %+v, want %+v", out, in)
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

// 111-1: update_channel's banner field has three states on the wire and the
// handler reads all three off the pointer, so the JSON shape is what has to
// hold: absent leaves the banner alone, "" clears it, an id sets it. A
// non-pointer field would collapse the first two into each other.
func TestUpdateChannelBannerThreeStates(t *testing.T) {
	cases := []struct {
		name    string
		wire    string
		present bool
		value   string
	}{
		{"absent", `{"channel_id":"c1"}`, false, ""},
		{"clear", `{"channel_id":"c1","banner_attachment_id":""}`, true, ""},
		{"set", `{"channel_id":"c1","banner_attachment_id":"a-1"}`, true, "a-1"},
	}
	for _, c := range cases {
		var p UpdateChannelPayload
		if err := json.Unmarshal([]byte(c.wire), &p); err != nil {
			t.Fatalf("%s: unmarshal: %v", c.name, err)
		}
		if (p.BannerAttachmentID != nil) != c.present {
			t.Errorf("%s: present = %v, want %v", c.name, p.BannerAttachmentID != nil, c.present)
		}
		if c.present && *p.BannerAttachmentID != c.value {
			t.Errorf("%s: value = %q, want %q", c.name, *p.BannerAttachmentID, c.value)
		}
	}

	// A rename that says nothing about the banner must not serialize the
	// field at all -- the server would read a "" as "clear the banner".
	name := "lounge"
	out, err := json.Marshal(UpdateChannelPayload{ChannelID: "c1", Name: &name})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(out), "banner_attachment_id") {
		t.Errorf("name-only update carried a banner field: %s", out)
	}
}

// A channel with no banner must not carry an empty id on the wire: the client
// treats presence as "there is a banner" and would fetch a ref for "".
func TestChannelSummaryOmitsEmptyBanner(t *testing.T) {
	out, err := json.Marshal(ChannelSummary{ID: "c1", Name: "general"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(out), "banner_attachment_id") {
		t.Errorf("summary carried an empty banner field: %s", out)
	}
}
