package store

// 111-5 / 111-7: the fences on a banner's layout. Each value the editor can
// send is checked in three places -- the handler, these functions, and
// migration 0057/0058's CHECKs. These are the ones that can be tested without
// a database, and they are what keeps the other two from having to disagree.

import (
	"errors"
	"testing"
)

func TestNormalizeBannerFit(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"", BannerFitFill}, // absent means the default, not an error
		{"  ", BannerFitFill},
		{"fill", BannerFitFill},
		{"fit", BannerFitFit},
		{" fit ", BannerFitFit},
	} {
		got, err := NormalizeBannerFit(c.in)
		if err != nil {
			t.Errorf("%q: unexpected error %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("%q: got %q want %q", c.in, got, c.want)
		}
	}
	// "cover" and "contain" are the CSS words for the same two things and
	// are exactly what a future caller would guess. Still refused: the
	// column's CHECK only knows fill and fit.
	for _, in := range []string{"cover", "contain", "FILL", "stretch", "none"} {
		if _, err := NormalizeBannerFit(in); !errors.Is(err, ErrBannerFitInvalid) {
			t.Errorf("%q: expected ErrBannerFitInvalid, got %v", in, err)
		}
	}
}

func TestNormalizeBannerHeight(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"", BannerHeightNormal},
		{"short", BannerHeightShort},
		{" tall ", BannerHeightTall},
	} {
		got, err := NormalizeBannerHeight(c.in)
		if err != nil {
			t.Errorf("%q: unexpected error %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("%q: got %q want %q", c.in, got, c.want)
		}
	}
	// Pixels are the client's business; a height is a name here.
	for _, in := range []string{"88", "88px", "medium", "huge"} {
		if _, err := NormalizeBannerHeight(in); !errors.Is(err, ErrBannerHeightInvalid) {
			t.Errorf("%q: expected ErrBannerHeightInvalid, got %v", in, err)
		}
	}
}

func TestNormalizeBannerBleed(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"", BannerBleedEdge},
		{"edge", BannerBleedEdge},
		{"blur", BannerBleedBlur},
		{"none", BannerBleedNone},
	} {
		got, err := NormalizeBannerBleed(c.in)
		if err != nil {
			t.Errorf("%q: unexpected error %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("%q: got %q want %q", c.in, got, c.want)
		}
	}
	for _, in := range []string{"mirror", "gradient", "off"} {
		if _, err := NormalizeBannerBleed(in); !errors.Is(err, ErrBannerBleedInvalid) {
			t.Errorf("%q: expected ErrBannerBleedInvalid, got %v", in, err)
		}
	}
}

// Out of range is refused, never clamped: a client asking for 900% has a
// bug, and quietly answering 300 hides it from whoever has to find it.
func TestCheckBannerZoom(t *testing.T) {
	for _, ok := range []int{BannerZoomMin, 150, BannerZoomMax} {
		if err := CheckBannerZoom(ok); err != nil {
			t.Errorf("%d: unexpected error %v", ok, err)
		}
	}
	for _, bad := range []int{0, 99, 301, -100, 10000} {
		if err := CheckBannerZoom(bad); !errors.Is(err, ErrBannerZoomRange) {
			t.Errorf("%d: expected ErrBannerZoomRange, got %v", bad, err)
		}
	}
}

func TestCheckBannerFocus(t *testing.T) {
	// 0 and 100 are the edges of the picture and are both legal.
	for _, ok := range []int{0, 50, 100} {
		if err := CheckBannerFocus(ok); err != nil {
			t.Errorf("%d: unexpected error %v", ok, err)
		}
	}
	for _, bad := range []int{-1, 101, 1000} {
		if err := CheckBannerFocus(bad); !errors.Is(err, ErrBannerFocusRange) {
			t.Errorf("%d: expected ErrBannerFocusRange, got %v", bad, err)
		}
	}
}

// The defaults are the pre-111-7 behaviour, spelled once. A channel that has
// never opened the editor and one that opened it and changed nothing must be
// the same row.
func TestDefaultBannerLayoutIsThePreEditorBehaviour(t *testing.T) {
	d := DefaultBannerLayout()
	if d.AttachmentID != nil {
		t.Error("default layout should carry no picture")
	}
	if d.Fit != BannerFitFill || d.FocusX != 50 || d.FocusY != 50 ||
		d.Zoom != 100 || d.Height != BannerHeightNormal || d.Bleed != BannerBleedEdge {
		t.Errorf("defaults drifted: %+v", d)
	}
	// Every default must survive its own fence.
	if _, err := NormalizeBannerFit(d.Fit); err != nil {
		t.Errorf("default fit refused: %v", err)
	}
	if _, err := NormalizeBannerHeight(d.Height); err != nil {
		t.Errorf("default height refused: %v", err)
	}
	if _, err := NormalizeBannerBleed(d.Bleed); err != nil {
		t.Errorf("default bleed refused: %v", err)
	}
	if err := CheckBannerZoom(d.Zoom); err != nil {
		t.Errorf("default zoom refused: %v", err)
	}
}
