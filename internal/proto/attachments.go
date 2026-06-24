package proto

// att-1: AttachmentRef is the server->client descriptor for one encrypted
// attachment carried alongside a message. It carries only what a client needs
// to render a placeholder and decrypt: the id (to fetch the ciphertext over the
// HTTP download endpoint), the declared length, the channel key version the
// blob is encrypted under, and the server-opaque enc_meta / enc_preview blobs
// (E2E; the server never inspects them). The heavy ciphertext is fetched
// out-of-band via GET /api/attachments/{id}, never inlined here.
type AttachmentRef struct {
	ID         string `json:"id"`
	ByteLen    int64  `json:"byte_len"`
	KeyVersion int    `json:"key_version"`
	EncMeta    []byte `json:"enc_meta"`              // base64 in JSON; {name,mime,kind,...}
	EncPreview []byte `json:"enc_preview,omitempty"` // base64 in JSON; image kinds only
	PreviewLen int    `json:"preview_len,omitempty"`
}
