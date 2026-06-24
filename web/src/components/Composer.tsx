import { useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { type PendingAttachment, classifyKind, humanSize } from "../attachments/types";

// Phase 9.6g: disabledReason distinguishes the two reasons the
// composer might be unusable. "offline" reflects a real connection
// problem; "no_channel" is informational and means "you haven't
// picked a chat yet." `null` means the composer is enabled.
//
// We keep the existing `disabled` prop as an alternative for
// callers that don't care about the reason; the component renders
// from whichever is more specific.
type DisabledReason =
  | "offline"
  | "no_channel"
  | "waiting_for_key"
  | "encryption_initializing"
  | null;

interface Props {
  // Legacy boolean. When provided AND disabledReason is null, we
  // fall back to a generic placeholder ("offline -- waiting to
  // reconnect") to preserve old behavior for callers that haven't
  // been updated to pass disabledReason.
  disabled?: boolean;
  // Phase 9.6g: prefer this over `disabled` for accurate UX.
  disabledReason?: DisabledReason;
  // att-2: the second arg carries any pending attachments. Optional so callers
  // that don't deal in attachments (e.g. ThreadPanel) stay assignable with a
  // 1-arg handler.
  onSend: (body: string, attachments?: PendingAttachment[]) => void;
  // Phase 10c: optional placeholder override (defaults to channel-aware
  // text from disabledReason mapping). The thread composer passes
  // "reply...". When disabled, the disabled-reason text still wins.
  placeholder?: string;
  // att-2: opt in to the attachment affordance (paperclip + file picker +
  // pending tray). Only the main composer sets this; threads stay text-only
  // until att-3. This is the deliberately MINIMAL att-2 input -- att-3 enriches
  // it with drag-drop, paste, per-item upload progress, and richer thumbnails.
  enableAttachments?: boolean;
}

const MAX_LEN = 4000;

export function Composer({ disabled, disabledReason, onSend, placeholder, enableAttachments }: Props) {
  const [draft, setDraft] = useState("");
  // att-2: files selected but not yet sent. Cleared on send.
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Phase 9.6g: derive the effective disabled boolean + the
  // placeholder text from disabledReason (preferred) or fall back
  // to the legacy `disabled` prop.
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

  const addFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const additions: PendingAttachment[] = [];
    for (const file of Array.from(files)) {
      const kind = classifyKind(file.type || "application/octet-stream");
      const item: PendingAttachment = { localID: makeLocalID(), file, kind };
      if (kind === "image") {
        try {
          item.previewURL = URL.createObjectURL(file);
        } catch {
          // no in-tray thumbnail; the chip still renders
        }
      }
      additions.push(item);
    }
    setPending((prev) => [...prev, ...additions]);
  };

  const removePending = (localID: string) => {
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

  const submit = () => {
    const body = draft.trim();
    // att-2: send if there's text OR at least one attachment.
    if (!body && pending.length === 0) return;
    if (body.length > MAX_LEN) return;
    onSend(body, pending.length > 0 ? pending : undefined);
    setDraft("");
    clearPending();
  };

  const onInput = (e: JSX.TargetedEvent<HTMLTextAreaElement>) => {
    setDraft(e.currentTarget.value);
  };

  // Enter to send, Shift+Enter for newline. The Composer is a textarea
  // not a form because we don't want a browser submit + page reload.
  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const onFileChange = (e: JSX.TargetedEvent<HTMLInputElement>) => {
    addFiles(e.currentTarget.files);
    // Reset so selecting the same file again re-triggers change.
    e.currentTarget.value = "";
  };

  const canSend = !effectiveDisabled && (draft.trim().length > 0 || pending.length > 0);

  return (
    <div class="chalk-composer">
      {enableAttachments && pending.length > 0 && (
        <div class="chalk-composer-tray" data-testid="composer-tray">
          {pending.map((p) => (
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
            </div>
          ))}
        </div>
      )}
      <div class="chalk-composer-row">
        {enableAttachments && (
          <>
            <button
              type="button"
              class="chalk-composer-attach"
              onClick={() => fileInputRef.current?.click()}
              disabled={effectiveDisabled}
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
        <textarea
          class="chalk-composer-input"
          placeholder={(disabled ? (placeholderText) : (placeholder ?? (placeholderText)))}
          value={draft}
          onInput={onInput}
          onKeyDown={onKeyDown}
          disabled={effectiveDisabled}
          rows={2}
          maxLength={MAX_LEN}
          data-testid="composer-input"
          aria-label="message"
        />
        <button
          type="button"
          class="chalk-composer-send"
          onClick={submit}
          disabled={!canSend}
          data-testid="composer-send"
        >
          send
        </button>
      </div>
    </div>
  );
}
