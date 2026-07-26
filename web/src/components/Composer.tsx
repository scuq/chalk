import { useEffect, useRef, useState } from "preact/hooks";
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
// Lazy for the same reason as Giphy: the catalogue is static data most
// sessions never open.
const EmojiPicker = lazyComponent(() =>
  import("./EmojiPicker").then((m) => m.EmojiPicker)
);
import { encodeGiphyBody } from "../giphy/giphy";
import { insertAtCursor } from "../emoji/emoji";
import { replaceEmoticonBefore } from "../emoji/emoticons";
import {
  composerHelp,
  isMacPlatform,
  matchComposerShortcut,
  shortcutLabel,
} from "../chat/composer-keys";

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
  // Phase 9.7h: tool row presentation. "text" (default) renders FILE / GIF /
  // EMOJI labels; "icons" renders glyphs. The emoji button keeps its 🙂 in
  // both -- it already is an icon.
  toolStyle?: "text" | "icons";
  // 42-1: replace typed emoticons with emoji as you type. Defaults to on;
  // the profile pref turns it off.
  emoticons?: boolean;
  // Phase 37-3: edit mode. When `editing` is non-null the composer is standing
  // in for one existing message: the draft is that message's text and Enter
  // routes to onEditSubmit instead of onSend. The parent owns the state so the
  // message row can highlight itself, and so opening a thread or switching
  // channel can cancel it.
  //
  // onEditLast is the cursor-up entry point: pressing Up on an empty composer
  // asks the parent for its most recent editable message. The parent answers by
  // setting `editing` (or not, if there is nothing to edit).
  editing?: { id: string; body: string } | null;
  onEditSubmit?: (body: string) => void | Promise<boolean | void>;
  onEditCancel?: () => void;
  onEditLast?: () => void;
  // Identifies what this composer is currently attached to -- the channel for
  // the feed composer, the thread for a reply composer. A new value means the
  // user just arrived somewhere new, so the caret moves here and they can type
  // without reaching for the mouse. `null` means "not this composer's turn"
  // (a thread panel is open, or the viewport is a phone where stealing focus
  // would throw up the on-screen keyboard); it also re-arms the focus, so
  // closing a thread hands the cursor back.
  focusKey?: string | null;
}

const MAX_LEN = 4000;

// Phase 9.7h: inline SVG glyphs for the "icons" tool style. Stroked with
// currentColor so they inherit the button's colour (and therefore the theme
// and hover state) without any per-theme rules. 14px to sit inside the 22px
// tool button with room to breathe.
function IconFile() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

// A framed play triangle: reads as "animated image" rather than "video",
// which is the closest unambiguous glyph for a GIF at this size.
function IconGif() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="4" width="20" height="16" rx="3" />
      <path d="M10 9.2l5.2 2.8-5.2 2.8z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function Composer({ disabled, disabledReason, onSend, placeholder, enableAttachments, giphyEnabled, giphyReady, onRequestEnableGiphy, toolStyle, emoticons, editing, onEditSubmit, onEditCancel, onEditLast, focusKey }: Props) {
  const icons = toolStyle === "icons";
  const emoticonsOn = emoticons !== false;
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [sending, setSending] = useState(false);
  // att-4c: Giphy picker open state.
  const [giphyOpen, setGiphyOpen] = useState(false);
  // Phase 9.7g: emoji picker open state. The textarea ref lets us splice the
  // pick in at the caret and restore focus, rather than appending.
  const [emojiOpen, setEmojiOpen] = useState(false);
  // 42-1: the shortcut cheat sheet behind the "?" button.
  const [helpOpen, setHelpOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const helpRef = useRef<HTMLDivElement | null>(null);
  // 42-1: the last emoticon we swapped for an emoji, so an immediate
  // Backspace can put the typed characters back. Cleared by any other edit.
  const undoEmoticon = useRef<{ caret: number; text: string; emoji: string } | null>(null);

  // 42-1: the help sheet is a popover, so it closes the way popovers do --
  // Escape or a click anywhere else. Without this it would sit over the
  // message list until you found the "?" again.
  useEffect(() => {
    if (!helpOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const el = helpRef.current;
      if (el && e.target instanceof Node && !el.contains(e.target)) setHelpOpen(false);
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHelpOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onEscape);
    };
  }, [helpOpen]);
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

  // Phase 37-3: entering edit mode loads the message's text into the draft and
  // puts the caret at the end -- you pressed Up to fix a typo, so the cursor
  // belongs where you were typing. Leaving edit mode clears the draft; cursor-up
  // only fires on an empty composer, so there is never unsent text to restore.
  const editingID = editing?.id ?? null;
  useEffect(() => {
    if (!editing) {
      setDraft("");
      return;
    }
    setDraft(editing.body);
    const el = textareaRef.current;
    if (!el) return;
    // The DOM value lands on the next render, so defer the caret move.
    window.setTimeout(() => {
      el.focus();
      try {
        el.setSelectionRange(el.value.length, el.value.length);
      } catch {
        // Caret position is cosmetic; the text is already correct.
      }
    }, 0);
    // Keyed on the message id: re-running on every keystroke would fight the
    // user by resetting the draft to the original text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingID]);

  // Focus follows arrival: entering a channel (or opening a thread) puts the
  // caret in the box you type into. Deferred until the composer is actually
  // usable -- a channel switch leaves it disabled for a moment while the
  // encryption key resolves, and a disabled textarea cannot take focus.
  // Recorded per focusKey so a reconnect, a key arriving late or any other
  // enable/disable flip in a place you are already sitting does not yank the
  // caret back out of a picker or off a message you were reacting to.
  const focusedFor = useRef<string | null>(null);
  useEffect(() => {
    if (focusKey === null || focusKey === undefined) {
      focusedFor.current = null;
      return;
    }
    if (effectiveDisabled || focusedFor.current === focusKey) return;
    focusedFor.current = focusKey;
    textareaRef.current?.focus();
  }, [focusKey, effectiveDisabled]);

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

  // The DOM value updates on the next render, so the caret has to be moved
  // after it -- doing it synchronously would position against the stale value.
  const setCaretSoon = (caret: number) => {
    const el = textareaRef.current;
    if (!el) return;
    window.setTimeout(() => {
      el.focus();
      try {
        el.setSelectionRange(caret, caret);
      } catch {
        // Some browsers throw if the element isn't focusable yet; the text
        // is already correct, only the caret position is lost.
      }
    }, 0);
  };

  // Phase 9.7g: splice an emoji in at the caret (or over the selection),
  // then put the caret after it and return focus to the textarea so typing
  // continues naturally. Falls back to appending if the ref is somehow gone.
  const insertEmoji = (char: string) => {
    const el = textareaRef.current;
    if (!el) {
      setDraft((d) => d + char);
      return;
    }
    const { value, caret } = insertAtCursor(
      draft,
      char,
      el.selectionStart ?? draft.length,
      el.selectionEnd ?? draft.length,
    );
    if (value.length > MAX_LEN) return; // don't silently blow the cap
    undoEmoticon.current = null;
    setDraft(value);
    setCaretSoon(caret);
  };

  // 42-1: the three tool buttons, reachable from the keyboard as well as the
  // rail. Kept as one function so a shortcut and a click cannot diverge.
  const openTool = (action: "emoji" | "gif" | "file") => {
    if (effectiveDisabled || sending) return;
    if (action === "emoji") {
      setEmojiOpen(true);
      return;
    }
    if (action === "file") {
      if (!enableAttachments || editing) return;
      fileInputRef.current?.click();
      return;
    }
    if (!giphyEnabled || editing) return;
    // Not yet consented -> open the consent modal instead of the picker. The
    // picker only ever opens for an enabled viewer.
    if (!giphyReady) {
      onRequestEnableGiphy?.();
      return;
    }
    setGiphyOpen(true);
  };

  const submit = async () => {
    if (sending) return;
    undoEmoticon.current = null;
    const body = draft.trim();

    // Phase 37-3: in edit mode the composer is standing in for one existing
    // message, so there is no attachment path here -- an edit only ever
    // replaces text. An empty edit is refused rather than treated as a delete:
    // deleting is a separate, confirmed action, and it would be a nasty
    // surprise to lose a message by clearing the box and hitting Enter.
    if (editing) {
      if (!body || body.length > MAX_LEN) return;
      if (body === editing.body) {
        onEditCancel?.(); // nothing changed; just close the editor
        return;
      }
      setSending(true);
      try {
        await onEditSubmit?.(body);
      } finally {
        setSending(false);
      }
      return;
    }

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
    const el = e.currentTarget;
    const value = el.value;
    // 42-1: emoticon replacement runs on the text left of the caret, so it
    // only ever fires on the token the user just finished typing -- pasting a
    // wall of text with a ":)" in the middle is left alone.
    if (emoticonsOn) {
      const caret = el.selectionStart ?? value.length;
      const hit = replaceEmoticonBefore(value, caret);
      if (hit) {
        undoEmoticon.current = { caret: hit.caret, text: hit.text, emoji: hit.emoji };
        setDraft(hit.value);
        setCaretSoon(hit.caret);
        return;
      }
    }
    undoEmoticon.current = null;
    setDraft(value);
  };

  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) => {
    // 42-1: tool shortcuts first -- they carry a modifier, so they can never
    // be the plain Enter/Escape/Up keys handled below.
    const action = matchComposerShortcut(e);
    if (action) {
      e.preventDefault();
      openTool(action);
      return;
    }
    // 42-1: Backspace straight after an automatic emoticon swap puts the
    // characters back, for the times you actually meant to write ":)".
    if (e.key === "Backspace") {
      const undo = undoEmoticon.current;
      const el = e.currentTarget;
      if (
        undo &&
        el.selectionStart === el.selectionEnd &&
        el.selectionStart === undo.caret &&
        draft.slice(undo.caret - undo.emoji.length, undo.caret) === undo.emoji
      ) {
        e.preventDefault();
        const start = undo.caret - undo.emoji.length;
        const restored = draft.slice(0, start) + undo.text + draft.slice(undo.caret);
        undoEmoticon.current = null;
        setDraft(restored);
        setCaretSoon(start + undo.text.length);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
      return;
    }
    // 42-1: with the help sheet open, Escape closes that first -- dismissing a
    // popover should not also throw away the edit behind it.
    if (e.key === "Escape" && helpOpen) {
      e.preventDefault();
      setHelpOpen(false);
      return;
    }
    // Phase 37-3: Escape leaves edit mode. Only when editing -- otherwise
    // Escape belongs to whatever else is listening (pickers, panels).
    if (e.key === "Escape" && editing) {
      e.preventDefault();
      onEditCancel?.();
      return;
    }
    // Cursor-up on an EMPTY composer opens your last message for editing.
    // Guarded on empty so Up keeps its normal caret-movement meaning the
    // moment there is any text -- including a multi-line draft, where moving
    // between lines is what the key is for. Attachments in the tray mean the
    // composer is mid-compose too, even with no text yet.
    if (
      e.key === "ArrowUp" &&
      !editing &&
      draft === "" &&
      pending.length === 0 &&
      !effectiveDisabled &&
      !sending &&
      onEditLast
    ) {
      e.preventDefault();
      onEditLast();
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

  const canSend = editing
    ? !effectiveDisabled && !sending && draft.trim().length > 0
    : !effectiveDisabled && !sending && (draft.trim().length > 0 || pending.length > 0);
  // In edit mode the composer is replacing one message's text, so the
  // attachment and GIF affordances are hidden rather than disabled: they'd
  // imply you can add a file to an existing message, which you can't.
  const showTools = !editing && (enableAttachments || giphyEnabled);
  // 42-1: the main composer gets a left rail under the roster column; the
  // thread composer has no tools and stays a plain stacked box. The rail
  // element is rendered even while editing (when its buttons are hidden) so
  // the input does not jump a column's width sideways mid-edit.
  const railed = enableAttachments || giphyEnabled;
  const mac = isMacPlatform();

  return (
    <div
      class={`chalk-composer ${railed ? "chalk-composer--railed" : ""} ${editing ? "chalk-composer--editing" : ""} ${dragActive ? "chalk-composer--drag-active" : ""}`}
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
      {/* Phase 9.7g: emoji picker. Picking inserts at the caret and keeps the
          picker open, so several emoji can be added in one go. */}
      <EmojiPicker
        open={emojiOpen}
        onClose={() => setEmojiOpen(false)}
        onPick={(char) => insertEmoji(char)}
      />
      {enableAttachments && (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          class="chalk-composer-file-input"
          style={{ display: "none" }}
          onChange={onFileChange}
          data-testid="composer-file-input"
        />
      )}
      {/* 42-1: tool rail. On desktop this sits in the roster's column, beside
          the input rather than above it, so the field keeps its full height
          and the tools stop pushing the message list around. Rendered (empty)
          during an edit to hold the column open. The old per-button classes
          are kept alongside chalk-composer-tool so the existing
          hover/disabled rules still apply. */}
      {railed && (
        <div
          class={`chalk-composer-rail ${icons ? "chalk-composer-rail--icons" : "chalk-composer-rail--text"}`}
          data-testid="composer-rail"
        >
          {showTools && (
            <div class="chalk-composer-tools" data-testid="composer-tools">
              {enableAttachments && (
                <button
                  type="button"
                  class="chalk-composer-tool chalk-composer-attach"
                  onClick={() => openTool("file")}
                  disabled={effectiveDisabled || sending}
                  title={`attach a file (${shortcutLabel("file", mac)})`}
                  aria-label="attach a file"
                  data-testid="composer-attach"
                >
                  {icons ? <IconFile /> : "FILE"}
                </button>
              )}
              {giphyEnabled && (
                <button
                  type="button"
                  class="chalk-composer-tool chalk-composer-giphy"
                  onClick={() => openTool("gif")}
                  disabled={effectiveDisabled || sending}
                  title={`send a GIF (${shortcutLabel("gif", mac)})`}
                  aria-label="send a GIF"
                  data-testid="composer-giphy"
                >
                  {icons ? <IconGif /> : "GIF"}
                </button>
              )}
              <button
                type="button"
                class="chalk-composer-tool chalk-composer-emoji"
                onClick={() => openTool("emoji")}
                disabled={effectiveDisabled || sending}
                title={`insert emoji (${shortcutLabel("emoji", mac)})`}
                aria-label="insert emoji"
                data-testid="composer-emoji"
              >
                {icons ? "🙂" : "EMOJI"}
              </button>
              <div class="chalk-composer-help" ref={helpRef}>
                <button
                  type="button"
                  class="chalk-composer-tool chalk-composer-help-toggle"
                  onClick={() => setHelpOpen((v) => !v)}
                  title="keyboard shortcuts"
                  aria-label="keyboard shortcuts"
                  aria-expanded={helpOpen}
                  data-testid="composer-help-toggle"
                >
                  ?
                </button>
                {helpOpen && (
                  <div
                    class="chalk-composer-help-sheet"
                    role="dialog"
                    aria-label="composer keyboard shortcuts"
                    data-testid="composer-help-sheet"
                  >
                    <div class="chalk-composer-help-title">shortcuts</div>
                    <dl class="chalk-composer-help-list">
                      {composerHelp(mac).map((row) => (
                        <div class="chalk-composer-help-row" key={row.keys}>
                          <dt>
                            <kbd>{row.keys}</kbd>
                          </dt>
                          <dd>{row.what}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
      <div class="chalk-composer-main">
        {enableAttachments && dragActive && (
          <div class="chalk-composer-drop-hint" data-testid="composer-drop-hint">
            drop files to attach
          </div>
        )}
        {editing && (
          <div class="chalk-composer-editing" data-testid="composer-editing">
            <span class="chalk-composer-editing-label">editing message</span>
            <button
              type="button"
              class="chalk-composer-editing-cancel"
              onClick={() => onEditCancel?.()}
              data-testid="composer-edit-cancel"
            >
              cancel
            </button>
            <span class="chalk-composer-editing-hint">escape to cancel</span>
          </div>
        )}
        {enableAttachments && !editing && pending.length > 0 && (
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
          <textarea
            ref={textareaRef}
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
            {sending ? (editing ? "saving…" : "sending…") : editing ? "save" : "send"}
          </button>
        </div>
      </div>
    </div>
  );
}
