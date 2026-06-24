// chalk att-2 -- HTTP transport for attachments.
//
// The chunked upload + download endpoints live on the authenticated HTTP layer
// (att-1, internal/auth/attachments_http.go), NOT the WebSocket: a single WS
// frame is capped at 1 MiB (proto.MaxFrameBytes) and an encrypted blob can be
// up to 20 MiB. Every call rides the same session cookie the SPA already holds
// (credentials: "same-origin"), exactly like auth/api.ts.
//
// This module is pure transport: it speaks the wire shapes and knows nothing
// about crypto. Encryption/decryption + the preview/meta packaging happen in
// attachments/pipeline.ts, which calls these.
//
// Endpoints (att-1):
//   POST   /api/attachments/init             -> { attachment_id, chunk_bytes }
//   PUT    /api/attachments/{id}/chunk?seq=N  (octet-stream body) -> 204
//   POST   /api/attachments/{id}/finalize    -> { byte_len, status }
//   GET    /api/attachments/{id}             -> octet-stream ciphertext
//   GET    /api/attachments?channel_id=&since_hours=N -> { attachments: [...] }

import type { AttachmentListItemWire } from "../proto";

/** AttachmentHTTPError carries the server's stable error code + HTTP status. */
export class AttachmentHTTPError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AttachmentHTTPError";
    this.status = status;
    this.code = code;
  }
}

// The server's error envelope is { error: { code, message } } (auth/http.go
// writeError). Parse it best-effort; fall back to the status text.
async function toError(resp: Response): Promise<AttachmentHTTPError> {
  let code = "http_error";
  let message = `HTTP ${resp.status}`;
  try {
    const body = (await resp.json()) as { error?: { code?: string; message?: string } };
    if (body?.error?.code) code = body.error.code;
    if (body?.error?.message) message = body.error.message;
  } catch {
    // non-JSON body; keep the status fallback
  }
  return new AttachmentHTTPError(resp.status, code, message);
}

export interface InitUploadInput {
  channelID: string;
  deviceID: string;
  keyVersion: number;
  /** full ciphertext length in bytes (server rejects oversize here). */
  byteLen: number;
  /** base64 of the encrypted enc_meta blob; required. */
  encMetaB64: string;
  /** base64 of the encrypted preview blob; image kinds only. */
  encPreviewB64?: string;
  previewLen?: number;
}

export interface InitUploadResult {
  attachmentID: string;
  /** the chunk size the server wants us to PUT in (bytes). */
  chunkBytes: number;
}

/** initUpload creates the 'uploading' row and returns the id + chunk size. */
export async function initUpload(input: InitUploadInput): Promise<InitUploadResult> {
  const resp = await fetch("/api/attachments/init", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      channel_id: input.channelID,
      device_id: input.deviceID,
      key_version: input.keyVersion,
      byte_len: input.byteLen,
      enc_meta: input.encMetaB64,
      enc_preview: input.encPreviewB64,
      preview_len: input.previewLen ?? 0,
    }),
  });
  if (!resp.ok) throw await toError(resp);
  const body = (await resp.json()) as { attachment_id: string; chunk_bytes: number };
  return { attachmentID: body.attachment_id, chunkBytes: body.chunk_bytes };
}

/** putChunk uploads one ciphertext chunk (raw octet-stream) at sequence seq. */
export async function putChunk(id: string, seq: number, chunk: Uint8Array): Promise<void> {
  const resp = await fetch(
    `/api/attachments/${encodeURIComponent(id)}/chunk?seq=${seq}`,
    {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/octet-stream" },
      // Copy into a fresh ArrayBuffer view so a subarray's backing buffer
      // isn't sent whole; fetch sends exactly chunk.byteLength bytes.
      body: chunk.slice(),
    },
  );
  if (!resp.ok && resp.status !== 204) throw await toError(resp);
}

export interface FinalizeResult {
  byteLen: number;
  status: string;
}

/** finalizeUpload assembles + verifies the staged chunks and marks complete. */
export async function finalizeUpload(id: string): Promise<FinalizeResult> {
  const resp = await fetch(`/api/attachments/${encodeURIComponent(id)}/finalize`, {
    method: "POST",
    credentials: "same-origin",
  });
  if (!resp.ok) throw await toError(resp);
  const body = (await resp.json()) as { byte_len: number; status: string };
  return { byteLen: body.byte_len, status: body.status };
}

/** downloadCiphertext fetches the full ciphertext blob (member-authz server-side). */
export async function downloadCiphertext(id: string): Promise<Uint8Array> {
  const resp = await fetch(`/api/attachments/${encodeURIComponent(id)}`, {
    method: "GET",
    credentials: "same-origin",
  });
  if (!resp.ok) throw await toError(resp);
  const buf = await resp.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * listAttachments returns the recent attachment refs in a channel within the
 * server's fetch window (clamped server-side). sinceHours is an optional
 * narrower lookback; the server never widens past its configured window.
 */
export async function listAttachments(
  channelID: string,
  sinceHours?: number,
): Promise<AttachmentListItemWire[]> {
  const params = new URLSearchParams({ channel_id: channelID });
  if (sinceHours && sinceHours > 0) params.set("since_hours", String(sinceHours));
  const resp = await fetch(`/api/attachments?${params.toString()}`, {
    method: "GET",
    credentials: "same-origin",
  });
  if (!resp.ok) throw await toError(resp);
  const body = (await resp.json()) as { attachments?: AttachmentListItemWire[] };
  return body.attachments ?? [];
}
