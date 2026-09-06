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

// 111-1/111-7: the banner's three states on the wire. The whole layout is
// one optional object, and inside it every field is a pointer -- absent
// leaves it alone, "" on the id clears the picture. A rename must be able to
// say nothing at all about the banner, which a flat non-pointer field could
// not.
func TestUpdateChannelBannerThreeStates(t *testing.T) {
	cases := []struct {
		name    string
		wire    string
		banner  bool
		present bool
		value   string
	}{
		{"no banner object", `{"channel_id":"c1"}`, false, false, ""},
		{"object, no id", `{"channel_id":"c1","banner":{"fit":"fit"}}`, true, false, ""},
		{"clear", `{"channel_id":"c1","banner":{"attachment_id":""}}`, true, true, ""},
		{"set", `{"channel_id":"c1","banner":{"attachment_id":"a-1"}}`, true, true, "a-1"},
	}
	for _, c := range cases {
		var p UpdateChannelPayload
		if err := json.Unmarshal([]byte(c.wire), &p); err != nil {
			t.Fatalf("%s: unmarshal: %v", c.name, err)
		}
		if (p.Banner != nil) != c.banner {
			t.Errorf("%s: banner object present = %v, want %v", c.name, p.Banner != nil, c.banner)
			continue
		}
		if !c.banner {
			continue
		}
		if (p.Banner.AttachmentID != nil) != c.present {
			t.Errorf("%s: id present = %v, want %v", c.name, p.Banner.AttachmentID != nil, c.present)
			continue
		}
		if c.present && *p.Banner.AttachmentID != c.value {
			t.Errorf("%s: id = %q, want %q", c.name, *p.Banner.AttachmentID, c.value)
		}
	}

	// A rename that says nothing about the banner must not serialize one:
	// an empty object would read as "clear nothing but touch everything".
	name := "lounge"
	out, err := json.Marshal(UpdateChannelPayload{ChannelID: "c1", Name: &name})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(out), "banner") {
		t.Errorf("name-only update carried a banner: %s", out)
	}
}

// 111-7: every layout field round-trips, and each one is independently
// omittable -- the editor saves what changed, not the whole dial.
func TestBannerPatchFieldsAreIndependent(t *testing.T) {
	var p UpdateChannelPayload
	wire := `{"channel_id":"c1","banner":{"focus_x":20,"focus_y":80,"zoom":150,"height":"tall","bleed":"blur"}}`
	if err := json.Unmarshal([]byte(wire), &p); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	b := p.Banner
	if b == nil {
		t.Fatal("banner absent")
	}
	if b.AttachmentID != nil || b.Fit != nil {
		t.Errorf("fields not mentioned came back set: %v %v", b.AttachmentID, b.Fit)
	}
	if *b.FocusX != 20 || *b.FocusY != 80 || *b.Zoom != 150 {
		t.Errorf("numbers: %d %d %d", *b.FocusX, *b.FocusY, *b.Zoom)
	}
	if *b.Height != "tall" || *b.Bleed != "blur" {
		t.Errorf("enums: %q %q", *b.Height, *b.Bleed)
	}

	// Zero is a real focus value (the very left/top edge), so it must
	// survive the round trip rather than being omitted as empty.
	zero := 0
	out, err := json.Marshal(UpdateChannelPayload{
		ChannelID: "c1",
		Banner:    &BannerPatchWire{FocusX: &zero},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(out), `"focus_x":0`) {
		t.Errorf("focus_x 0 was dropped: %s", out)
	}
}

// A channel with no banner carries no banner object: the client treats
// presence as "there is a picture" and would fetch a ref for "".
func TestChannelSummaryOmitsAbsentBanner(t *testing.T) {
	out, err := json.Marshal(ChannelSummary{ID: "c1", Name: "general"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(out), "banner") {
		t.Errorf("summary carried an empty banner: %s", out)
	}

	// And when there is one, the layout rides with it -- including values
	// equal to their defaults, so the renderer never has to guess.
	out, err = json.Marshal(ChannelSummary{
		ID:   "c1",
		Name: "general",
		Banner: &BannerWire{
			AttachmentID: "a-1", Fit: "fill", FocusX: 50, FocusY: 50,
			Zoom: 100, Height: "normal", Bleed: "edge",
		},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, want := range []string{`"attachment_id":"a-1"`, `"fit":"fill"`, `"focus_x":50`, `"zoom":100`, `"height":"normal"`, `"bleed":"edge"`} {
		if !strings.Contains(string(out), want) {
			t.Errorf("summary missing %s: %s", want, out)
		}
	}
}

// 112-1: an avatar frame carries ids and nothing else -- the picture is
// ciphertext fetched separately. Clearing one is an empty attachment id, so
// the field must survive the round trip as "" rather than vanishing into an
// omitempty on the way in.
func TestAvatarFrames(t *testing.T) {
	var set SetAvatarPayload
	if err := json.Unmarshal([]byte(`{"channel_id":"c1","attachment_id":""}`), &set); err != nil {
		t.Fatalf("unmarshal set: %v", err)
	}
	if set.ChannelID != "c1" || set.AttachmentID != "" {
		t.Errorf("set: %+v", set)
	}

	// The ack and the push both omit an empty id: a receiver reads presence
	// as "there is a picture", and "" would be a picture at no address.
	out, err := json.Marshal(AvatarUpdatePayload{ChannelID: "c1", UserID: "u1"})
	if err != nil {
		t.Fatalf("marshal update: %v", err)
	}
	if strings.Contains(string(out), "attachment_id") {
		t.Errorf("a removal carried an attachment id: %s", out)
	}

	// A listing of a channel with no pictures is an empty list, never null:
	// the client iterates it without checking.
	listed, err := json.Marshal(ListAvatarsAckPayload{
		ChannelID: "c1",
		Avatars:   []AvatarWire{},
	})
	if err != nil {
		t.Fatalf("marshal list: %v", err)
	}
	if !strings.Contains(string(listed), `"avatars":[]`) {
		t.Errorf("empty listing did not serialize as a list: %s", listed)
	}
}
