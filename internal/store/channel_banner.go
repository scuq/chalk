package store

// 111-5 / 111-7: the channel banner's layout -- everything about how the
// pinned image meets the band, and nothing about the image itself.
//
// The server does not interpret any of it: fit, focus, zoom, height and bleed
// are read only by the renderer in the SPA. What lives here is the fence.
// Every value is normalized and range-checked before it reaches a column, so
// a bad write is refused at the handler instead of being pushed to every
// member's browser -- migration 0058's CHECKs say the same thing a second
// time, and neither is allowed to be the only one saying it.
//
// Defaults are the pre-111-7 behaviour exactly: centred, unzoomed, normal
// height, edge bleed. A channel that has never opened the editor and one that
// opened it and changed nothing are the same row.

import (
	"fmt"
	"strings"

	"github.com/google/uuid"
)

// trim is the one spelling of "a value with spaces around it is that value".
func trim(s string) string { return strings.TrimSpace(s) }

// Banner fit modes (111-5, 111-12), mirroring migration 0057/0059's CHECK.
const (
	BannerFitFill = "fill"
	BannerFitFit  = "fit"
	// BannerFitPoster shows the picture at band height at one end and
	// fills the rest with the wash -- box art on a coloured backdrop,
	// which is what a band twelve times wider than it is tall can do with
	// a portrait picture and still look deliberate.
	BannerFitPoster = "poster"
)

// Banner heights (111-7). Names, not pixels: what a "tall" band measures is
// the client's business and differs between the desktop and the phone.
const (
	BannerHeightShort  = "short"
	BannerHeightNormal = "normal"
	BannerHeightTall   = "tall"
)

// Banner bleeds (111-7, 111-11): how a banner fills the space beside its
// picture. 'edge' (the picture's own edge columns, stretched sideways) was
// replaced by 'wash' in 111-11 -- it streaked on any picture with a hard
// horizontal edge in it, and migration 0059 rewrote the rows.
const (
	BannerBleedWash = "wash" // an even gradient of the picture's two main colours
	BannerBleedBlur = "blur" // a blurred blow-up of the picture behind it
	BannerBleedNone = "none" // theme background, nothing else
)

// Zoom bounds (111-7), percent. 100 is the picture at its natural fit for
// the mode; the ceiling is where a band-height crop stops being a picture.
const (
	BannerZoomMin = 100
	BannerZoomMax = 300
)

// BannerLayout is the full set, as stored on the channels row. The zero
// value is not valid -- use DefaultBannerLayout.
type BannerLayout struct {
	// AttachmentID is the image, or nil when the channel has no banner.
	// The rest still has values in that case: clearing a picture is not a
	// reason to forget how the last one was framed.
	AttachmentID *uuid.UUID
	Fit          string
	FocusX       int
	FocusY       int
	Zoom         int
	Height       string
	Bleed        string
}

// DefaultBannerLayout is what migration 0058's column defaults spell.
func DefaultBannerLayout() BannerLayout {
	return BannerLayout{
		Fit:    BannerFitFill,
		FocusX: 50,
		FocusY: 50,
		Zoom:   100,
		Height: BannerHeightNormal,
		Bleed:  BannerBleedWash,
	}
}

// Errors for the fences below. Each is mapped to invalid_channel by the
// handler, so a client learns which value it got wrong.
var (
	ErrBannerFitInvalid = fmt.Errorf("banner fit must be %q, %q or %q",
		BannerFitFill, BannerFitFit, BannerFitPoster)
	ErrBannerHeightInvalid = fmt.Errorf("banner height must be %q, %q or %q",
		BannerHeightShort, BannerHeightNormal, BannerHeightTall)
	ErrBannerBleedInvalid = fmt.Errorf("banner bleed must be %q, %q or %q",
		BannerBleedWash, BannerBleedBlur, BannerBleedNone)
	ErrBannerZoomRange  = fmt.Errorf("banner zoom must be %d-%d", BannerZoomMin, BannerZoomMax)
	ErrBannerFocusRange = fmt.Errorf("banner focus must be 0-100")
)

// NormalizeBannerFit fences the fit mode. "" means the default, so a client
// that omits it is not an error.
func NormalizeBannerFit(s string) (string, error) {
	switch trim(s) {
	case "":
		return BannerFitFill, nil
	case BannerFitFill:
		return BannerFitFill, nil
	case BannerFitFit:
		return BannerFitFit, nil
	case BannerFitPoster:
		return BannerFitPoster, nil
	default:
		return "", ErrBannerFitInvalid
	}
}

// NormalizeBannerHeight fences the band height. "" means the default.
func NormalizeBannerHeight(s string) (string, error) {
	switch trim(s) {
	case "":
		return BannerHeightNormal, nil
	case BannerHeightShort, BannerHeightNormal, BannerHeightTall:
		return trim(s), nil
	default:
		return "", ErrBannerHeightInvalid
	}
}

// NormalizeBannerBleed fences the bleed style. "" means the default.
func NormalizeBannerBleed(s string) (string, error) {
	switch trim(s) {
	case "":
		return BannerBleedWash, nil
	case BannerBleedWash, BannerBleedBlur, BannerBleedNone:
		return trim(s), nil
	case "edge":
		// 111-11 replaced the edge bleed with the wash. A client built
		// before that still says "edge"; answer with what it meant rather
		// than refusing an update over a renamed style.
		return BannerBleedWash, nil
	default:
		return "", ErrBannerBleedInvalid
	}
}

// CheckBannerZoom fences the zoom percent. Out of range is refused rather
// than clamped: a client asking for 900 has a bug, and silently answering
// 300 hides it.
func CheckBannerZoom(z int) error {
	if z < BannerZoomMin || z > BannerZoomMax {
		return ErrBannerZoomRange
	}
	return nil
}

// CheckBannerFocus fences one focal-point coordinate (percent).
func CheckBannerFocus(v int) error {
	if v < 0 || v > 100 {
		return ErrBannerFocusRange
	}
	return nil
}
