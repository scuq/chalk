package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// AttachmentConfig holds the server-wide attachment limits (att-1). All knobs
// are env-only (CHALK_ATTACH_*), mirroring the governance defaults model: a
// struct seeded by defaultAttachmentConfig(), overlaid by applyEnv(), and
// fenced by Validate(). The wider Config embeds this as Config.Attachments and
// forwards the three lifecycle calls (default/env/validate) to it.
//
// What each knob bounds:
//
//	MaxBytes        hard ceiling on a single attachment's declared ciphertext
//	                length. The HTTP init endpoint rejects anything larger
//	                before a row is created. CHALK_ATTACH_MAX_BYTES.
//	MaxPerMessage   how many attachment refs one send frame may link.
//	                CHALK_ATTACH_MAX_PER_MESSAGE.
//	ChunkBytes      the upload chunk size the server advertises to the client
//	                at init; the PUT .../chunk endpoint sizes its body limit
//	                from this (plus slack). CHALK_ATTACH_CHUNK_BYTES.
//	FetchWindowHrs  lookback window for the eager attachment backfetch list
//	                query. CHALK_ATTACH_FETCH_WINDOW_HOURS.
//	PreviewMaxEdge  the client-side preview downscale target (longest edge, in
//	                px). Server-opaque to att-1 (the server never decrypts a
//	                preview); carried here so the SPA can read it from
//	                /api/auth/config in a later phase. CHALK_ATTACH_PREVIEW_MAX_EDGE.
//	OrphanHours     age after which a still-'uploading' attachment row (never
//	                finalized/sent) is pruned by the janitor.
//	                CHALK_ATTACH_ORPHAN_HOURS.
type AttachmentConfig struct {
	MaxBytes       int64
	MaxPerMessage  int
	ChunkBytes     int
	FetchWindowHrs int
	PreviewMaxEdge int
	OrphanHours    int
}

// Attachment limit defaults. Exposed as named constants so the values appear
// once and are referenced by both Default and the doc comments above.
const (
	defaultAttachMaxBytes       int64 = 20 * 1024 * 1024 // 20 MiB (== 20971520)
	defaultAttachMaxPerMessage        = 10
	defaultAttachChunkBytes           = 512 * 1024 // 512 KiB (== 524288)
	defaultAttachFetchWindowHrs       = 24
	defaultAttachPreviewMaxEdge       = 320
	defaultAttachOrphanHours          = 24
)

func defaultAttachmentConfig() AttachmentConfig {
	return AttachmentConfig{
		MaxBytes:       defaultAttachMaxBytes,
		MaxPerMessage:  defaultAttachMaxPerMessage,
		ChunkBytes:     defaultAttachChunkBytes,
		FetchWindowHrs: defaultAttachFetchWindowHrs,
		PreviewMaxEdge: defaultAttachPreviewMaxEdge,
		OrphanHours:    defaultAttachOrphanHours,
	}
}

// FetchWindow is the lookback window as a duration.
func (a AttachmentConfig) FetchWindow() time.Duration {
	return time.Duration(a.FetchWindowHrs) * time.Hour
}

// OrphanTTL is the stale-upload age threshold as a duration.
func (a AttachmentConfig) OrphanTTL() time.Duration {
	return time.Duration(a.OrphanHours) * time.Hour
}

// applyEnv overlays CHALK_ATTACH_* env vars onto a. Unset/unparseable vars
// leave the existing (default) value untouched, the same contract as
// Config.applyEnv's envInt helper.
func (a *AttachmentConfig) applyEnv() {
	if n, ok := attachEnvInt64("CHALK_ATTACH_MAX_BYTES"); ok {
		a.MaxBytes = n
	}
	intBinds := []struct {
		dst *int
		key string
	}{
		{&a.MaxPerMessage, "CHALK_ATTACH_MAX_PER_MESSAGE"},
		{&a.ChunkBytes, "CHALK_ATTACH_CHUNK_BYTES"},
		{&a.FetchWindowHrs, "CHALK_ATTACH_FETCH_WINDOW_HOURS"},
		{&a.PreviewMaxEdge, "CHALK_ATTACH_PREVIEW_MAX_EDGE"},
		{&a.OrphanHours, "CHALK_ATTACH_ORPHAN_HOURS"},
	}
	for _, b := range intBinds {
		if n, ok := attachEnvInt(b.key); ok {
			*b.dst = n
		}
	}
}

// Validate fails loudly on nonsensical limits rather than letting chalkd run
// with, say, a zero chunk size (which would make every upload impossible) or a
// per-message cap below 1 (which would forbid all attachments while still
// advertising the feature).
func (a AttachmentConfig) Validate() error {
	if a.MaxBytes <= 0 {
		return fmt.Errorf("CHALK_ATTACH_MAX_BYTES must be > 0 (got %d)", a.MaxBytes)
	}
	if a.MaxPerMessage < 1 {
		return fmt.Errorf("CHALK_ATTACH_MAX_PER_MESSAGE must be >= 1 (got %d)", a.MaxPerMessage)
	}
	if a.ChunkBytes < 1024 {
		return fmt.Errorf("CHALK_ATTACH_CHUNK_BYTES must be >= 1024 (got %d)", a.ChunkBytes)
	}
	if int64(a.ChunkBytes) > a.MaxBytes {
		return fmt.Errorf("CHALK_ATTACH_CHUNK_BYTES (%d) must not exceed CHALK_ATTACH_MAX_BYTES (%d)",
			a.ChunkBytes, a.MaxBytes)
	}
	if a.FetchWindowHrs < 1 {
		return fmt.Errorf("CHALK_ATTACH_FETCH_WINDOW_HOURS must be >= 1 (got %d)", a.FetchWindowHrs)
	}
	if a.PreviewMaxEdge < 1 {
		return fmt.Errorf("CHALK_ATTACH_PREVIEW_MAX_EDGE must be >= 1 (got %d)", a.PreviewMaxEdge)
	}
	if a.OrphanHours < 1 {
		return fmt.Errorf("CHALK_ATTACH_ORPHAN_HOURS must be >= 1 (got %d)", a.OrphanHours)
	}
	return nil
}

// attachEnvInt mirrors config.envInt but is kept local so AttachmentConfig is a
// self-contained unit (its own file added by att-1, with no edits to the
// envInt definition in config.go).
func attachEnvInt(key string) (int, bool) {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return 0, false
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, false
	}
	return n, true
}

// attachEnvInt64 is the int64 variant for the byte-size knob, so a cap above
// 2 GiB is representable even on a 32-bit build.
func attachEnvInt64(key string) (int64, bool) {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return 0, false
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}
