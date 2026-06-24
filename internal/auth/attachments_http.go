package auth

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/store"
)

// att-1: attachment upload/download HTTP surface.
//
// Why HTTP and not the WebSocket: a single WS frame is capped at
// proto.MaxFrameBytes (1 MiB), so a multi-MB encrypted blob can't ride the WS.
// Uploads are chunked over plain authenticated HTTP instead, reusing the same
// session cookie the SPA already holds. The message that references an
// attachment still travels over the WS (send frame), carrying only the
// attachment id; the bytes move out-of-band here.
//
// Lifecycle (all gated by RequireSession; ownership re-checked in the store):
//
//	POST   /api/attachments/init             -> create 'uploading' row, returns id + chunk size
//	PUT    /api/attachments/{id}/chunk?seq=N -> stage one ciphertext chunk (octet-stream body)
//	POST   /api/attachments/{id}/finalize    -> assemble + verify + mark complete
//	GET    /api/attachments/{id}             -> stream ciphertext (member-of-channel only)
//	GET    /api/attachments?channel_id=&since_hours= -> list recent refs in a channel
//
// The server is a blind store: name/mime/kind/dimensions live inside the
// E2E-encrypted enc_meta blob, never in a column or header. Download responses
// are application/octet-stream; the client decrypts and recovers the real type.

// attachInitMaxBody bounds the JSON init request. Larger than the shared 64 KiB
// decodeJSON cap because enc_preview (an encrypted low-res thumbnail, base64 in
// JSON) can be tens of KiB; 256 KiB leaves comfortable headroom while still
// fencing an abusive body.
const attachInitMaxBody = 256 * 1024

// attachChunkSlack is added to the configured chunk size when sizing the chunk
// PUT body limit, to absorb the AEAD tag / framing overhead the client adds on
// top of a plaintext chunk.
const attachChunkSlack = 64 * 1024

// MountAttachments registers the attachment endpoints on mux. Requires Store to
// be set (the chunked endpoints are pure persistence; no WebAuthn service is
// involved). Returns an error if Store is nil so a misconfigured server fails
// at construction rather than at first upload.
func (d *HTTPDeps) MountAttachments(mux *http.ServeMux) error {
	if d.Store == nil {
		return fmt.Errorf("auth: MountAttachments requires Store")
	}
	if d.Logger == nil {
		d.Logger = log.Default()
	}
	mux.HandleFunc("POST /api/attachments/init", RequireSession(d.Store, d.handleAttachInit))
	mux.HandleFunc("PUT /api/attachments/{id}/chunk", RequireSession(d.Store, d.handleAttachChunk))
	mux.HandleFunc("POST /api/attachments/{id}/finalize", RequireSession(d.Store, d.handleAttachFinalize))
	mux.HandleFunc("GET /api/attachments/{id}", RequireSession(d.Store, d.handleAttachDownload))
	mux.HandleFunc("GET /api/attachments", RequireSession(d.Store, d.handleAttachList))
	return nil
}

// ---- init -------------------------------------------------------------

type attachInitRequest struct {
	ChannelID  string `json:"channel_id"`
	DeviceID   string `json:"device_id"`
	KeyVersion int    `json:"key_version"`
	ByteLen    int64  `json:"byte_len"`
	EncMeta    []byte `json:"enc_meta"`              // base64 in JSON; required, server-opaque
	EncPreview []byte `json:"enc_preview,omitempty"` // base64 in JSON; image kinds only
	PreviewLen int    `json:"preview_len,omitempty"`
}

type attachInitResponse struct {
	AttachmentID string `json:"attachment_id"`
	ChunkBytes   int    `json:"chunk_bytes"`
}

func (d *HTTPDeps) handleAttachInit(w http.ResponseWriter, r *http.Request, su *SessionUser) {
	var req attachInitRequest
	if err := decodeJSONLimited(r, &req, attachInitMaxBody); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}

	channelID, err := uuid.Parse(req.ChannelID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_channel_id", "channel_id must be a UUID")
		return
	}
	deviceID, err := uuid.Parse(req.DeviceID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_device_id", "device_id must be a UUID")
		return
	}
	if req.ByteLen <= 0 {
		writeError(w, http.StatusBadRequest, "bad_byte_len", "byte_len must be > 0")
		return
	}
	if d.AttachMaxBytes > 0 && req.ByteLen > d.AttachMaxBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large",
			fmt.Sprintf("byte_len %d exceeds limit %d", req.ByteLen, d.AttachMaxBytes))
		return
	}
	if len(req.EncMeta) == 0 {
		writeError(w, http.StatusBadRequest, "missing_enc_meta", "enc_meta is required")
		return
	}
	if req.KeyVersion < 1 {
		writeError(w, http.StatusBadRequest, "bad_key_version", "key_version must be >= 1")
		return
	}

	ctx := r.Context()

	// Membership: only a member of the channel may upload to it.
	isMember, err := d.Store.IsMember(ctx, channelID, su.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "membership_check_failed", "internal error")
		d.Logger.Printf("attach init: membership: %v", err)
		return
	}
	if !isMember {
		// 404 not 403: don't confirm the channel exists to a non-member.
		writeError(w, http.StatusNotFound, "not_found", "channel not found")
		return
	}

	// Key version may not be ahead of the channel's current version (the
	// client can't encrypt under a version that doesn't exist yet). Older
	// versions are allowed: an upload begun just before a rotation stays
	// valid under its retained key.
	curVer, err := d.Store.CurrentKeyVersion(ctx, channelID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "key_version_check_failed", "internal error")
		d.Logger.Printf("attach init: key version: %v", err)
		return
	}
	if req.KeyVersion > curVer {
		writeError(w, http.StatusConflict, "stale_key_version",
			"key_version is ahead of the channel's current version")
		return
	}

	// Bind the client-supplied device_id to this session's user before we
	// stamp it as uploader_device_id (the HTTP path has no WS hello-time
	// ensure to lean on).
	if err := d.Store.EnsureDeviceForUser(ctx, deviceID, su.UserID); err != nil {
		writeError(w, http.StatusInternalServerError, "device_ensure_failed", "internal error")
		d.Logger.Printf("attach init: ensure device: %v", err)
		return
	}

	a, err := d.Store.CreateAttachment(ctx, store.CreateAttachmentInput{
		ChannelID:        channelID,
		UploaderDeviceID: deviceID,
		KeyVersion:       req.KeyVersion,
		ByteLen:          req.ByteLen,
		EncMeta:          req.EncMeta,
		EncPreview:       req.EncPreview,
		PreviewLen:       req.PreviewLen,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "create_failed", "internal error")
		d.Logger.Printf("attach init: create: %v", err)
		return
	}

	chunkBytes := d.AttachChunkBytes
	if chunkBytes <= 0 {
		chunkBytes = 512 * 1024
	}
	writeJSON(w, http.StatusOK, attachInitResponse{
		AttachmentID: a.ID.String(),
		ChunkBytes:   chunkBytes,
	})
}

// ---- chunk ------------------------------------------------------------

func (d *HTTPDeps) handleAttachChunk(w http.ResponseWriter, r *http.Request, su *SessionUser) {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_id", "attachment id must be a UUID")
		return
	}
	seqStr := r.URL.Query().Get("seq")
	seq, err := strconv.Atoi(seqStr)
	if err != nil || seq < 0 {
		writeError(w, http.StatusBadRequest, "bad_seq", "seq must be a non-negative integer")
		return
	}

	// Bound the chunk body. The client's encrypted chunk is the configured
	// chunk size plus AEAD overhead; the slack absorbs that. A body past the
	// cap trips MaxBytesReader, which surfaces as a read error below.
	limit := d.AttachChunkBytes
	if limit <= 0 {
		limit = 512 * 1024
	}
	limit += attachChunkSlack
	r.Body = http.MaxBytesReader(w, r.Body, int64(limit))
	data, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "chunk_too_large",
			"chunk exceeds the permitted size")
		return
	}
	if len(data) == 0 {
		writeError(w, http.StatusBadRequest, "empty_chunk", "chunk body is empty")
		return
	}

	if err := d.Store.AppendChunk(r.Context(), id, su.UserID, seq, data); err != nil {
		d.writeAttachStoreErr(w, "append chunk", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- finalize ---------------------------------------------------------

type attachFinalizeResponse struct {
	ByteLen int64  `json:"byte_len"`
	Status  string `json:"status"`
}

func (d *HTTPDeps) handleAttachFinalize(w http.ResponseWriter, r *http.Request, su *SessionUser) {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_id", "attachment id must be a UUID")
		return
	}
	a, err := d.Store.FinalizeAttachment(r.Context(), id, su.UserID)
	if err != nil {
		d.writeAttachStoreErr(w, "finalize", err)
		return
	}
	writeJSON(w, http.StatusOK, attachFinalizeResponse{
		ByteLen: a.ByteLen,
		Status:  a.Status,
	})
}

// ---- download ---------------------------------------------------------

func (d *HTTPDeps) handleAttachDownload(w http.ResponseWriter, r *http.Request, su *SessionUser) {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_id", "attachment id must be a UUID")
		return
	}
	a, err := d.Store.GetAttachmentForDownload(r.Context(), id, su.UserID)
	if err != nil {
		d.writeAttachStoreErr(w, "download", err)
		return
	}
	// Opaque ciphertext: the client decrypts and recovers the true mime from
	// enc_meta. Never advertise a guessable type or a filename here.
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.Itoa(len(a.Ciphertext)))
	w.Header().Set("Cache-Control", "private, no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(a.Ciphertext)
}

// ---- list -------------------------------------------------------------

type attachRefJSON struct {
	ID         string `json:"id"`
	ChannelID  string `json:"channel_id"`
	MessageID  string `json:"message_id,omitempty"`
	KeyVersion int    `json:"key_version"`
	ByteLen    int64  `json:"byte_len"`
	EncMeta    []byte `json:"enc_meta"`              // base64 in JSON
	EncPreview []byte `json:"enc_preview,omitempty"` // base64 in JSON
	PreviewLen int    `json:"preview_len,omitempty"`
	CreatedAt  int64  `json:"created_at"` // unix millis
}

type attachListResponse struct {
	Attachments []attachRefJSON `json:"attachments"`
}

func (d *HTTPDeps) handleAttachList(w http.ResponseWriter, r *http.Request, su *SessionUser) {
	channelID, err := uuid.Parse(r.URL.Query().Get("channel_id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_channel_id", "channel_id must be a UUID")
		return
	}

	// since_hours bounds the lookback; clamp to the server's configured fetch
	// window so a client can't widen it past policy. Default to the full
	// window when absent or unparseable.
	window := d.AttachFetchWindow
	if window <= 0 {
		window = 24 * time.Hour
	}
	if v := r.URL.Query().Get("since_hours"); v != "" {
		if h, perr := strconv.Atoi(v); perr == nil && h > 0 {
			req := time.Duration(h) * time.Hour
			if req < window {
				window = req
			}
		}
	}
	since := time.Now().UTC().Add(-window)

	rows, err := d.Store.ListAttachmentsForChannelWindow(r.Context(), channelID, su.UserID, since, 0)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list_failed", "internal error")
		d.Logger.Printf("attach list: %v", err)
		return
	}

	out := attachListResponse{Attachments: make([]attachRefJSON, 0, len(rows))}
	for _, a := range rows {
		out.Attachments = append(out.Attachments, attachToRefJSON(a))
	}
	writeJSON(w, http.StatusOK, out)
}

// ---- helpers ----------------------------------------------------------

func attachToRefJSON(a store.Attachment) attachRefJSON {
	ref := attachRefJSON{
		ID:         a.ID.String(),
		ChannelID:  a.ChannelID.String(),
		KeyVersion: a.KeyVersion,
		ByteLen:    a.ByteLen,
		EncMeta:    a.EncMeta,
		EncPreview: a.EncPreview,
		PreviewLen: a.PreviewLen,
		CreatedAt:  a.CreatedAt.UnixMilli(),
	}
	if a.MessageID != nil {
		ref.MessageID = a.MessageID.String()
	}
	return ref
}

// writeAttachStoreErr maps a store attachment error to an HTTP response. Unknown
// errors are 500 and logged; the known sentinels carry their own status so the
// SPA can branch on a stable code.
func (d *HTTPDeps) writeAttachStoreErr(w http.ResponseWriter, op string, err error) {
	switch {
	case errors.Is(err, store.ErrAttachmentNotFound):
		writeError(w, http.StatusNotFound, "not_found", "attachment not found")
	case errors.Is(err, store.ErrAttachmentNotUploading):
		writeError(w, http.StatusConflict, "not_uploading", "attachment is not in the uploading state")
	case errors.Is(err, store.ErrAttachmentIncomplete):
		writeError(w, http.StatusBadRequest, "incomplete", "attachment chunks are incomplete or length mismatched")
	case errors.Is(err, store.ErrAttachmentTooLarge):
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "attachment exceeds its declared length")
	default:
		writeError(w, http.StatusInternalServerError, "internal", "internal error")
		d.Logger.Printf("attach %s: %v", op, err)
	}
}

// decodeJSONLimited is decodeJSON with a caller-chosen body cap. The init
// endpoint needs a larger cap than the shared 64 KiB decodeJSON because of the
// embedded enc_preview thumbnail.
func decodeJSONLimited(r *http.Request, v any, max int64) error {
	limited := io.LimitReader(r.Body, max)
	dec := json.NewDecoder(limited)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return fmt.Errorf("decode body: %w", err)
	}
	if dec.More() {
		return fmt.Errorf("decode body: trailing content")
	}
	return nil
}
