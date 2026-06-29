import { useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { type PendingAttachment, classifyKind, humanSize } from "../attachments/types";
import {
  imageFilesFromClipboardItems,
  filesFromList,
  dragHasFiles,
} from "../attachments/intake";
import { lazyComponent } from "./LazyComponent";
// Lazy: Giphy is opt-in, so the picker stays out of the initial bundle.
const GiphyPicker = lazyComponent(() =>
  import("./GiphyPicker").then((m) => m.GiphyPicker)
);
import { encodeGiphyBody } from "../giphy/giphy";

// Phase 9.6g: disabledReason distinguishes the two reasons the
// composer might be unusable. "offline" reflects a real connection
// problem; "no_channel" is informational and means "you haven't
// picked a chat yet." `null` means the composer is enabled.
type DisabledReason =
  | "offline"
  | "no_channel"
  | "waiting_for_key"
  | "encryption_initializing"
  | null;

// att-3: the send path can report per-attachment upload progress. onSend may be
// async; it resolves false when the send was blocked (e.g. key vanished) so the
// composer keeps the tray for a retry, and true/void on success (tray cleared).
export interface SendOptions {
  onProgress?: (localID: string, loaded: number, total: number) => void;
}

interface Props {
  disabled?: boolean;
  disabledReason?: DisabledReason;
  onSend: (
    body: string,
    attachments?: PendingAttachment[],
    opts?: SendOptions,
  ) => void | Promise<boolean | void>;
  placeholder?: string;
  // att-2/att-3: opt in to the attachment affordance (paperclip + picker +
  // drag-drop + paste + pending tray with per-item progress). Only the main
  // composer sets this; the thread composer stays text-only.
  enableAttachments?: boolean;
  // att-4c: Giphy composer button. giphyEnabled shows the button (server has
  // an API key); giphyReady means the local viewer's consent pref is
  // "enabled" so the picker can open. When the button is clicked but not
  // ready, onRequestEnableGiphy opens the consent modal instead of the picker.
  giphyEnabled?: boolean;
  giphyReady?: boolean;
  onRequestEnableGiphy?: () => void;
}

const MAX_LEN = 4000;

export function Composer({ disabled, disabledReason, onSend, placeholder, enableAttachments, giphyEnabled, giphyReady, onRequestEnableGiphy }: Props) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [sending, setSending] = useState(false);
  // att-4c: Giphy picker open state.
  const [giphyOpen, setGiphyOpen] = useState(false);
  // att-3: per-item upload fraction (0..1) while sending.
  const [progress, setProgress] = useState<Record<string, number>>({});
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Drag enter/leave fire per child; a depth counter keeps the affordance
  // stable until the pointer actually leaves the composer.
  const dragDepth = useRef(0);

  const effectiveDisabled =
    disabledReason !== null && disabledReason !== undefined
      ? true
      : disabled ?? false;
  const placeholderText =
    disabledReason === "offline"
      ? "offline -- waiting to reconnect"
      : disabledReason === "no_channel"
      ? "select a channel to start chatting"
      : disabledReason === "waiting_for_key"
      ? "waiting for encryption access -- a member needs to grant you the channel key"
      : disabledReason === "encryption_initializing"
      ? "securing channel -- encryption not ready yet"
      : effectiveDisabled
      ? "offline -- waiting to reconnect"
      : "say something...";

  const makeLocalID = (): string =>
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2);

  const addFileArray = (files: File[]) => {
    if (files.length === 0) return;
    const additions: PendingAttachment[] = files.map((file) => {
      const kind = classifyKind(file.type || "application/octet-stream");
      const item: PendingAttachment = { localID: makeLocalID(), file, kind };
      if (kind === "image") {
        try {
          item.previewURL = URL.createObjectURL(file);
        } catch {
          // no in-tray thumbnail; the chip still renders
        }
      }
      return item;
    });
    setPending((prev) => [...prev, ...additions]);
  };

  const removePending = (localID: string) => {
    if (sending) return; // don't yank an item mid-upload
    setPending((prev) => {
      const hit = prev.find((p) => p.localID === localID);
      if (hit?.previewURL) URL.revokeObjectURL(hit.previewURL);
      return prev.filter((p) => p.localID !== localID);
    });
  };

  const clearPending = () => {
    setPending((prev) => {
      for (const p of prev) if (p.previewURL) URL.revokeObjectURL(p.previewURL);
      return [];
    });
  };

  const submit = async () => {
    if (sending) return;
    const body = draft.trim();
    if (!body && pending.length === 0) return;
    if (body.length > MAX_LEN) return;

    // Text-only: send immediately, no progress UI.
    if (pending.length === 0) {
      onSend(body);
      setDraft("");
      return;
    }

    // With attachments: keep the tray visible and render per-item progress
    // until the upload completes, then clear.
    const items = pending;
    setSending(true);
    setProgress({});
    try {
      const result = await onSend(body, items, {
        onProgress: (localID, loaded, total) => {
          setProgress((prev) => ({ ...prev, [localID]: total > 0 ? loaded / total : 0 }));
        },
      });
      if (result === false) {
        // Blocked (e.g. key vanished mid-send): keep the tray for a retry.
        setSending(false);
        return;
      }
      setDraft("");
      clearPending();
      setProgress({});
      setSending(false);
    } catch {
      // Upload failed: keep the tray so the user can retry; surface nothing
      // noisy here (App logs the error).
      setSending(false);
    }
  };

  const onInput = (e: JSX.TargetedEvent<HTMLTextAreaElement>) => {
    setDraft(e.currentTarget.value);
  };

  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const onFileChange = (e: JSX.TargetedEvent<HTMLInputElement>) => {
    addFileArray(filesFromList(e.currentTarget.files));
    e.currentTarget.value = ""; // re-selecting the same file re-triggers change
  };

  // att-3: paste an image (screenshot) straight into the tray.
  const onPaste = (e: JSX.TargetedClipboardEvent<HTMLTextAreaElement>) => {
    if (!enableAttachments || effectiveDisabled || sending) return;
    const imgs = imageFilesFromClipboardItems(e.clipboardData?.items);
    if (imgs.length > 0) {
      e.preventDefault(); // capture the image; don't also paste a path/garbage
      addFileArray(imgs);
    }
    // No image -> let the normal text paste proceed.
  };

  // att-3: drag-drop files onto the composer.
  const dropEnabled = enableAttachments && !effectiveDisabled && !sending;
  const onDragEnter = (e: JSX.TargetedDragEvent<HTMLDivElement>) => {
    if (!dropEnabled || !dragHasFiles(e.dataTransfer?.types)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  };
  const onDragOver = (e: JSX.TargetedDragEvent<HTMLDivElement>) => {
    if (!dropEnabled || !dragHasFiles(e.dataTransfer?.types)) return;
    e.preventDefault(); // required to allow a drop
  };
  const onDragLeave = (e: JSX.TargetedDragEvent<HTMLDivElement>) => {
    if (!dropEnabled) return;
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  };
  const onDrop = (e: JSX.TargetedDragEvent<HTMLDivElement>) => {
    if (!dropEnabled) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    addFileArray(filesFromList(e.dataTransfer?.files));
  };

  const canSend = !effectiveDisabled && !sending && (draft.trim().length > 0 || pending.length > 0);

  return (
    <div
      class={`chalk-composer ${dragActive ? "chalk-composer--drag-active" : ""}`}
      onDragEnter={enableAttachments ? onDragEnter : undefined}
      onDragOver={enableAttachments ? onDragOver : undefined}
      onDragLeave={enableAttachments ? onDragLeave : undefined}
      onDrop={enableAttachments ? onDrop : undefined}
    >
      {/* att-4c: Giphy search picker. Opens only for an enabled viewer (the
          GIF button gates on giphyReady). Picking sends the GIF immediately. */}
      <GiphyPicker
        open={giphyOpen}
        onClose={() => setGiphyOpen(false)}
        onPick={(fullURL) => {
          setGiphyOpen(false);
          void onSend(encodeGiphyBody(fullURL));
        }}
      />
      {enableAttachments && dragActive && (
        <div class="chalk-composer-drop-hint" data-testid="composer-drop-hint">
          drop files to attach
        </div>
      )}
      {enableAttachments && pending.length > 0 && (
        <div class="chalk-composer-tray" data-testid="composer-tray">
          {pending.map((p) => {
            const frac = progress[p.localID];
            return (
              <div class="chalk-composer-chip" key={p.localID} data-testid="composer-chip">
                {p.kind === "image" && p.previewURL ? (
                  <img class="chalk-composer-chip-thumb" src={p.previewURL} alt={p.file.name} />
                ) : (
                  <span class="chalk-composer-chip-icon" aria-hidden="true">📎</span>
                )}
                <span class="chalk-composer-chip-name" title={p.file.name}>
                  {p.file.name}
                </span>
                <span class="chalk-composer-chip-size">{humanSize(p.file.size)}</span>
                {sending && frac !== undefined ? (
                  <span
                    class="chalk-composer-chip-progress"
                    data-testid="composer-chip-progress"
                    title={`${Math.round(frac * 100)}%`}
                  >
                    <span
                      class="chalk-composer-chip-progress-fill"
                      style={{ width: `${Math.round(frac * 100)}%` }}
                    />
                  </span>
                ) : (
                  <button
                    type="button"
                    class="chalk-composer-chip-remove"
                    onClick={() => removePending(p.localID)}
                    title="remove attachment"
                    aria-label={`remove ${p.file.name}`}
                    data-testid="composer-chip-remove"
                  >
                    ✕
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div class="chalk-composer-row">
        {enableAttachments && (
          <>
            <button
              type="button"
              class="chalk-composer-attach"
              onClick={() => fileInputRef.current?.click()}
              disabled={effectiveDisabled || sending}
              title="attach a file"
              aria-label="attach a file"
              data-testid="composer-attach"
            >
              📎
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              class="chalk-composer-file-input"
              style={{ display: "none" }}
              onChange={onFileChange}
              data-testid="composer-file-input"
            />
          </>
        )}
        {giphyEnabled && (
          <button
            type="button"
            class="chalk-composer-giphy"
            onClick={() => {
              if (effectiveDisabled || sending) return;
              // Not yet consented -> open the consent modal instead of the
              // picker. The picker only ever opens for an enabled viewer.
              if (!giphyReady) {
                onRequestEnableGiphy?.();
                return;
              }
              setGiphyOpen(true);
            }}
            disabled={effectiveDisabled || sending}
            title="send a GIF"
            aria-label="send a GIF"
            data-testid="composer-giphy"
          >
            GIF
          </button>
        )}
        <textarea
          class="chalk-composer-input"
          placeholder={(disabled ? (placeholderText) : (placeholder ?? (placeholderText)))}
          value={draft}
          onInput={onInput}
          onKeyDown={onKeyDown}
          onPaste={enableAttachments ? onPaste : undefined}
          disabled={effectiveDisabled || sending}
          rows={2}
          maxLength={MAX_LEN}
          data-testid="composer-input"
          aria-label="message"
        />
        <button
          type="button"
          class="chalk-composer-send"
          onClick={() => void submit()}
          disabled={!canSend}
          data-testid="composer-send"
        >
          {sending ? "sending…" : "send"}
        </button>
      </div>
    </div>
  );
}
