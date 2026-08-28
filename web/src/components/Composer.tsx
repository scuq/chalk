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
// 74-2: lazy for the same reason -- most sends carry no snippet.
const CodeModal = lazyComponent(() =>
  import("./CodeModal").then((m) => m.CodeModal)
);
import { encodeGiphyBody } from "../giphy/giphy";
import { type CodePayload, codeLineCount, encodeCodeBody } from "../code/code";
import {
  type LinkPreviewPayload,
  type LinkPreviewPref,
  decideLinkPreviewOffer,
  encodeLinkPreviewBody,
} from "../linkpreview/linkpreview";
import {
  fetchLinkPreview,
  fetchLinkPreviewThumb,
  linkPreviewThumbFilename,
} from "../linkpreview/fetch";
import { insertAtCursor } from "../emoji/emoji";
import { replaceEmoticonBefore } from "../emoji/emoticons";
import {
  isMacPlatform,
  matchComposerShortcut,
  shortcutLabel,
} from "../chat/composer-keys";
import {
  type MentionToken,
  activeMentionToken,
  applyMention,
  matchMentionHandles,
} from "../chat/mention-complete";
import { useIsMobile } from "../mobile";

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
  // drag-drop + paste + pending tray with per-item progress). Both the feed
  // and thread composers set this.
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
  //
  // 94-1: on a phone the text style renders the initials instead (F / G / E /
  // C) -- see TOOL_LABELS.
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
  // 107-3: a quote the parent wants spliced in at the caret. `key` changes on
  // every pick rather than identifying the quoted message, because quoting
  // the same message twice has to insert twice -- keying on the message id
  // would make the second pick a no-op. Nothing here rewrites the draft: the
  // text arrives as ordinary characters the user can edit or delete.
  quote?: { key: string; text: string } | null;
  // 43-7: called on every keystroke with "the draft has text in it". The
  // parent decides whether that becomes a ping -- it owns the rate limit and
  // the pref. Only the feed composer passes this; a thread reply doesn't
  // announce itself (nothing renders a thread indicator yet).
  onTyping?: (active: boolean) => void;
  // 56-1: handles offered by the @mention autocomplete -- the members of
  // whatever this composer sends into. Absent or empty disables the popup;
  // typed @handles still work, they just aren't completed.
  mentionHandles?: string[];
  // 57-3: sender-side link previews. linkPreviewEnabled mirrors the server
  // flag (fetcher available); linkPreviewPref is the viewer's tri-state
  // consent; linkPreviewDomains is the effective whitelist (server default +
  // user overrides). When a whitelisted URL is in the draft and the pref is
  // "unset", the card slot offers consent instead -- accepting goes through
  // onRequestEnableLinkPreview (App owns the modal), mirroring Giphy.
  linkPreviewEnabled?: boolean;
  linkPreviewPref?: LinkPreviewPref;
  linkPreviewDomains?: string[];
  onRequestEnableLinkPreview?: () => void;
}

// 57-3: the preview card's lifecycle. "consent" and "loading" render as thin
// rows; "ready" is the dismissible card whose payload rides into the send.
type PreviewCard =
  | { state: "consent"; url: string }
  | { state: "loading"; url: string }
  | {
      state: "ready";
      url: string;
      payload: LinkPreviewPayload;
      thumb: { blob: Blob; objectURL: string } | null;
    };

const MAX_LEN = 4000;

// 94-1: the word labels are the desktop presentation. On a phone the four of
// them are a 110px block taken out of a 360px screen, so the text style drops
// to initials there -- the same four buttons in the width of the icon rail,
// still readable without knowing what the glyphs mean. The aria-label and the
// title carry the full name in both, so nothing about the button is lost.
const TOOL_LABELS: Record<"file" | "gif" | "emoji" | "code", [string, string]> = {
  file: ["FILE", "F"],
  gif: ["GIF", "G"],
  emoji: ["EMOJI", "E"],
  code: ["CODE", "C"],
};

// 57-3: the card always names the real destination host -- preview text is
// sender-asserted, the host is what the reader can trust.
function hostOfURL(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

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

// 74-2: the angle brackets every editor uses for "code". No slash between
// them -- at 14px the third stroke turns the glyph into a smudge.
function IconCode() {
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
      <path d="M8 6l-6 6 6 6" />
      <path d="M16 6l6 6-6 6" />
    </svg>
  );
}

export function Composer({ disabled, disabledReason, onSend, placeholder, enableAttachments, giphyEnabled, giphyReady, onRequestEnableGiphy, toolStyle, emoticons, editing, onEditSubmit, onEditCancel, onEditLast, focusKey, quote, onTyping, mentionHandles, linkPreviewEnabled, linkPreviewPref, linkPreviewDomains, onRequestEnableLinkPreview }: Props) {
  const icons = toolStyle === "icons";
  // 94-1/94-3: the phone differs from the desktop in two ways the composer
  // owns -- the tool labels are initials, and Enter is a newline.
  const isMobile = useIsMobile();
  const toolLabel = (tool: keyof typeof TOOL_LABELS): string =>
    TOOL_LABELS[tool][isMobile ? 1 : 0];
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
  // 74-2: the CODE modal, and the snippet it has staged for the next send.
  // Staged rather than sent on its own, so a snippet can carry a caption.
  const [codeOpen, setCodeOpen] = useState(false);
  const [stagedCode, setStagedCode] = useState<CodePayload | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // 42-1: the last emoticon we swapped for an emoji, so an immediate
  // Backspace can put the typed characters back. Cleared by any other edit.
  const undoEmoticon = useRef<{ caret: number; text: string; emoji: string } | null>(null);
  // 56-1: the partial @token under the caret; null means the popup is
  // closed. Escape remembers the token's start position so the popup stays
  // down while the user keeps typing that same mention by hand -- moving or
  // finishing the token forgets the dismissal.
  const [mention, setMention] = useState<MentionToken | null>(null);
  const [mentionSel, setMentionSel] = useState(0);
  const mentionDismissed = useRef<number | null>(null);

  // att-3: per-item upload fraction (0..1) while sending.
  const [progress, setProgress] = useState<Record<string, number>>({});
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Drag enter/leave fire per child; a depth counter keeps the affordance
  // stable until the pointer actually leaves the composer.
  const dragDepth = useRef(0);

  // 57-3: the link-preview card. previewDismissed remembers per-URL "no"s so
  // a dismissed card doesn't pop back on the next keystroke; it forgets on a
  // successful send. previewSeq staleness-guards the async fetch: a newer
  // draft supersedes an in-flight one, and its late result is dropped.
  const [previewCard, setPreviewCard] = useState<PreviewCard | null>(null);
  const previewDismissed = useRef<Set<string>>(new Set());
  const previewSeq = useRef(0);

  const clearPreviewCard = () => {
    previewSeq.current++;
    setPreviewCard((cur) => {
      if (cur === null) return cur;
      if (cur.state === "ready" && cur.thumb) URL.revokeObjectURL(cur.thumb.objectURL);
      return null;
    });
  };

  const dismissPreview = () => {
    setPreviewCard((cur) => {
      if (cur) previewDismissed.current.add(cur.url);
      if (cur?.state === "ready" && cur.thumb) URL.revokeObjectURL(cur.thumb.objectURL);
      return null;
    });
    previewSeq.current++;
    textareaRef.current?.focus();
  };

  // Debounced URL detection. The deps use a joined key for the domains list
  // so a parent re-render with an equal-but-new array doesn't re-arm the
  // timer on every frame.
  const domainsKey = (linkPreviewDomains ?? []).join(",");
  useEffect(() => {
    // 74-2: both riders are a sentinel PREFIX on the body, so only one can be
    // outermost. A staged snippet wins -- it was an explicit action, where the
    // preview merely noticed a URL.
    if (!linkPreviewEnabled || editing || stagedCode) {
      clearPreviewCard();
      return;
    }
    const offer = decideLinkPreviewOffer(
      draft,
      linkPreviewPref ?? "unset",
      linkPreviewDomains ?? [],
    );
    if (offer.mode === "none" || previewDismissed.current.has(offer.url)) {
      clearPreviewCard();
      return;
    }
    // Already showing (or fetching) this URL in the right mode: leave it be.
    if (
      previewCard &&
      previewCard.url === offer.url &&
      (offer.mode === "consent") === (previewCard.state === "consent")
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      if (offer.mode === "consent") {
        previewSeq.current++;
        setPreviewCard({ state: "consent", url: offer.url });
        return;
      }
      const seq = ++previewSeq.current;
      setPreviewCard({ state: "loading", url: offer.url });
      void (async () => {
        const fp = await fetchLinkPreview(offer.url);
        if (seq !== previewSeq.current) return;
        if (!fp) {
          // Nothing usable (or the fetch failed): stop asking for this URL
          // so a dead page doesn't re-trigger on every keystroke.
          previewDismissed.current.add(offer.url);
          setPreviewCard(null);
          return;
        }
        let thumb: { blob: Blob; objectURL: string } | null = null;
        if (fp.imageURL) {
          const blob = await fetchLinkPreviewThumb(fp.imageURL);
          if (seq !== previewSeq.current) return;
          if (blob) {
            try {
              thumb = { blob, objectURL: URL.createObjectURL(blob) };
            } catch {
              thumb = null; // card still renders text-only
            }
          }
        }
        setPreviewCard({ state: "ready", url: offer.url, payload: fp.payload, thumb });
      })();
    }, 500);
    return () => window.clearTimeout(timer);
    // previewCard is intentionally read but not a dep: the guard above only
    // prevents re-fetching the URL already on screen; the card's own state
    // changes must not re-arm the debounce timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, linkPreviewEnabled, linkPreviewPref, domainsKey, editing, stagedCode]);

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
    // 56-1: entering or leaving edit mode swaps the whole draft; any mention
    // popup belonged to the old text.
    mentionDismissed.current = null;
    setMention(null);
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

  // 107-3: splice a quote in at the caret, the emoji path with two
  // differences -- it starts on its own line, and it leaves a blank line
  // under itself with the caret on it, because the point of quoting is to
  // then write the answer.
  //
  // Keyed on quote.key rather than on the object: the parent rebuilds props
  // every render, and depending on identity would re-insert forever.
  const quoteKey = quote?.key ?? null;
  const quotedFor = useRef<string | null>(null);
  useEffect(() => {
    if (quoteKey === null || !quote || quote.text === "") return;
    if (quotedFor.current === quoteKey) return;
    quotedFor.current = quoteKey;
    const el = textareaRef.current;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? draft.length;
    // A quote is a block: it may not begin halfway along someone's sentence.
    const lead = start > 0 && draft[start - 1] !== "\n" ? "\n" : "";
    const { value, caret } = insertAtCursor(draft, lead + quote.text + "\n\n", start, end);
    if (value.length > MAX_LEN) return; // don't silently blow the cap
    undoEmoticon.current = null;
    setDraft(value);
    setCaretSoon(caret);
    // quoteKey alone: the draft is read here, not tracked. Listing it would
    // re-run the effect on every keystroke, and the ref guard would be the
    // only thing between that and a composer that quotes forever.
  }, [quoteKey]);

  // 56-1: re-derive the mention token from the draft and caret. Called from
  // every path that moves either: typing (onInput), clicking, and the
  // caret-movement keys the popup doesn't own (onKeyUp for arrows/Home/End).
  const syncMention = (value: string, caret: number) => {
    const token =
      mentionHandles && mentionHandles.length > 0
        ? activeMentionToken(value, caret)
        : null;
    if (!token) {
      mentionDismissed.current = null;
      if (mention) setMention(null);
      return;
    }
    if (mentionDismissed.current !== null && mentionDismissed.current !== token.start) {
      mentionDismissed.current = null;
    }
    if (mentionDismissed.current === token.start) {
      if (mention) setMention(null);
      return;
    }
    if (!mention || mention.start !== token.start || mention.prefix !== token.prefix) {
      setMention(token);
      setMentionSel(0);
    }
  };

  // Matches are derived per render rather than stored: the roster can change
  // under an open popup (someone joins), and stale state would offer them
  // a beat late or a ghost a beat long.
  const mentionMatches =
    mention && mentionHandles
      ? matchMentionHandles(mention.prefix, mentionHandles).slice(0, 8)
      : [];
  const mentionOpen = mentionMatches.length > 0 && !effectiveDisabled && !sending;
  const mentionCursor = Math.min(mentionSel, mentionMatches.length - 1);

  const acceptMention = (handle: string) => {
    const el = textareaRef.current;
    if (!mention || !el) return;
    const caret = el.selectionStart ?? draft.length;
    const r = applyMention(draft, mention, caret, handle);
    if (r.value.length > MAX_LEN) return; // don't silently blow the cap
    undoEmoticon.current = null;
    setMention(null);
    setDraft(r.value);
    setCaretSoon(r.caret);
  };

  // 42-1: the tool buttons, reachable from the keyboard as well as the rail.
  // Kept as one function so a shortcut and a click cannot diverge.
  //
  // 74-2: "code" is click-only -- every ctrl/meta combo that reads as "code"
  // is already spoken for by the browser (ctrl+c copies, ctrl+shift+c is the
  // element inspector, ctrl+shift+k is Firefox's console). It is a parameter
  // here rather than a ComposerAction so the shortcut table stays honest.
  const openTool = (action: "emoji" | "gif" | "file" | "code") => {
    if (effectiveDisabled || sending) return;
    if (action === "emoji") {
      setEmojiOpen(true);
      return;
    }
    if (action === "code") {
      if (editing) return;
      setCodeOpen(true);
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
    // The draft is about to be replaced wholesale; a token parsed from the
    // old text must not leave the popup floating over the new one.
    mentionDismissed.current = null;
    setMention(null);
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

    // 74-2: a staged snippet is content in its own right, so it can be sent
    // with no caption and no attachments.
    if (!body && pending.length === 0 && !stagedCode) return;
    if (body.length > MAX_LEN) return;

    // 57-3: a ready preview card rides along -- the payload is folded into
    // the body (encrypted like any other text) and the thumbnail becomes a
    // leading attachment the renderer recognizes by filename convention. The
    // MAX_LEN check above ran on the TYPED text; the marker + payload are
    // wire framing, not the user "typing more". 74-2: a staged snippet folds
    // in the same way, and the two are mutually exclusive -- the effect above
    // clears the preview card while a snippet is staged, so at most one of
    // these branches can be live.
    let sendText = body;
    let items = pending;
    const snippet = stagedCode;
    const card = previewCard;
    const cardActive = card !== null && card.state === "ready";
    if (snippet !== null) {
      sendText = encodeCodeBody(snippet, body);
    } else if (card !== null && card.state === "ready") {
      sendText = encodeLinkPreviewBody(card.payload, body);
      if (card.thumb) {
        const mime = card.thumb.blob.type;
        const file = new File([card.thumb.blob], linkPreviewThumbFilename(mime), { type: mime });
        items = [{ localID: makeLocalID(), file, kind: "image" }, ...pending];
      }
    }
    const sentPreview = () => {
      if (snippet !== null) setStagedCode(null);
      if (!cardActive) return;
      previewDismissed.current.clear();
      clearPreviewCard();
    };

    // Text-only: no progress UI. The box clears synchronously so rapid
    // typing never fights a disabled textarea -- but onSend resolves false
    // when the send was blocked (socket just dropped, key not here yet), and
    // losing the message silently would be worse than a moment of surprise.
    // On refusal the draft is put back, unless the user has already started
    // typing something new in the meantime.
    if (items.length === 0) {
      setDraft("");
      // The draft is gone, so we are no longer typing -- and the next
      // character should ping at once rather than wait out the old window.
      onTyping?.(false);
      let result: boolean | void;
      try {
        result = await onSend(sendText);
      } catch {
        result = false;
      }
      if (result === false) {
        setDraft((cur) => (cur === "" ? body : cur));
        return;
      }
      sentPreview();
      return;
    }

    // With attachments: keep the tray visible and render per-item progress
    // until the upload completes, then clear.
    setSending(true);
    setProgress({});
    try {
      const result = await onSend(sendText, items, {
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
      onTyping?.(false);
      clearPending();
      sentPreview();
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
    // 43-7: first thing, ahead of the emoticon branch below -- that one
    // returns early, and every keystroke that completes an emoticon would
    // otherwise go unannounced. Editing an existing message is not composing,
    // so it never pings.
    if (!editing) onTyping?.(value.length > 0);
    // 42-1: emoticon replacement runs on the text left of the caret, so it
    // only ever fires on the token the user just finished typing -- pasting a
    // wall of text with a ":)" in the middle is left alone.
    // 48-2: never during an IME composition -- swapping text and moving the
    // caret mid-composition aborts or garbles the candidate on Chromium and
    // WebKit. The finished token gets its chance on the post-commit input.
    const composing = (e as unknown as { isComposing?: boolean }).isComposing === true;
    if (emoticonsOn && !composing) {
      const caret = el.selectionStart ?? value.length;
      const hit = replaceEmoticonBefore(value, caret);
      if (hit) {
        undoEmoticon.current = { caret: hit.caret, text: hit.text, emoji: hit.emoji };
        setDraft(hit.value);
        setCaretSoon(hit.caret);
        syncMention(hit.value, hit.caret);
        return;
      }
    }
    undoEmoticon.current = null;
    setDraft(value);
    syncMention(value, el.selectionStart ?? value.length);
  };

  // 56-1: arrow/Home/End move the caret without an input event; a click can
  // land it anywhere. Both re-derive the token so the popup follows the
  // caret rather than the last keystroke. keyup only for the movement keys
  // the popup branch in onKeyDown doesn't already own -- the keyup of an
  // accepting Enter arrives while the DOM still holds the pre-splice text,
  // and a blanket sync would reopen the popup over it.
  const onCaretKeyUp = (e: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    const el = e.currentTarget;
    syncMention(el.value, el.selectionStart ?? el.value.length);
  };
  const onCaretClick = (e: JSX.TargetedMouseEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    syncMention(el.value, el.selectionStart ?? el.value.length);
  };

  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) => {
    // 48-2: while an IME composition is active, every key belongs to the IME.
    // Without this, the Enter that commits a CJK candidate would send the
    // uncommitted draft. keyCode 229 covers engines that deliver the commit
    // keydown before flipping isComposing off.
    if (e.isComposing || e.keyCode === 229) return;
    // 42-1: tool shortcuts first -- they carry a modifier, so they can never
    // be the plain Enter/Escape/Up keys handled below.
    const action = matchComposerShortcut(e);
    if (action) {
      e.preventDefault();
      openTool(action);
      return;
    }
    // 56-1: with the mention popup open, the navigation keys belong to it.
    // Everything else falls through -- ordinary typing narrows the matches
    // via onInput, and Shift+Enter keeps meaning "newline" (the break ends
    // the token, so the popup closes on its own).
    if (mentionOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = mentionMatches.length;
        const step = e.key === "ArrowDown" ? 1 : -1;
        setMentionSel((mentionCursor + step + n) % n);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
        e.preventDefault();
        acceptMention(mentionMatches[mentionCursor]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        mentionDismissed.current = mention?.start ?? null;
        setMention(null);
        return;
      }
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
    // 94-3: Enter sends on the desktop, where it is the fastest thing on the
    // keyboard and Shift+Enter is right there for a newline. On a phone the
    // same key is the on-screen keyboard's return key with no shift to pair
    // with it, so it types a newline and the send button is the only way out
    // -- a half-typed message posted by a stray return is the worse mistake.
    if (e.key === "Enter" && !e.shiftKey && !isMobile) {
      e.preventDefault();
      void submit();
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
    : !effectiveDisabled &&
      !sending &&
      (draft.trim().length > 0 || pending.length > 0 || stagedCode !== null);
  // In edit mode the composer is replacing one message's text, so the
  // attachment, GIF and code affordances are hidden rather than disabled:
  // they'd imply you can add a file to an existing message, which you can't.
  //
  // 74-2: CODE needs no server support and no consent, so it is the one tool
  // every composer has -- which is why these two no longer gate on the
  // per-caller flags.
  const showTools = !editing;
  // 44-5: the tool block sits immediately left of the input. It used to live
  // in the roster's column, which put the buttons a screen-width away from
  // the field they act on.
  const railed = true;
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
      {/* 74-2: the code modal stages a snippet for the next send rather than
          sending it, so a caption can go with it. `initial` makes reopening
          it an edit of what is already staged. */}
      {codeOpen && (
        <CodeModal
          initial={stagedCode ?? undefined}
          onClose={() => {
            setCodeOpen(false);
            textareaRef.current?.focus();
          }}
          onInsert={(payload) => {
            setStagedCode(payload);
            setCodeOpen(false);
            textareaRef.current?.focus();
          }}
        />
      )}
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
        {/* 57-3: link-preview card. Three shapes: a consent ask (pref still
            unset), a thin loading row, and the ready card that will ride the
            next send. All dismissible; dismissing remembers the URL so the
            card doesn't reappear while the link is still in the draft. */}
        {previewCard && !editing && (
          <div
            class={`chalk-composer-linkpreview chalk-composer-linkpreview--${previewCard.state}`}
            data-testid="composer-linkpreview"
          >
            {previewCard.state === "consent" ? (
              <>
                <span class="chalk-composer-linkpreview-ask">
                  preview this link for everyone?
                </span>
                <button
                  type="button"
                  class="chalk-composer-linkpreview-enable"
                  onClick={() => onRequestEnableLinkPreview?.()}
                  data-testid="composer-linkpreview-enable"
                >
                  enable previews
                </button>
              </>
            ) : previewCard.state === "loading" ? (
              <span class="chalk-composer-linkpreview-loading">building preview…</span>
            ) : (
              <>
                {previewCard.thumb && (
                  <img
                    class="chalk-composer-linkpreview-thumb"
                    src={previewCard.thumb.objectURL}
                    alt=""
                  />
                )}
                <span class="chalk-composer-linkpreview-text">
                  {previewCard.payload.site_name !== "" && (
                    <span class="chalk-composer-linkpreview-site">
                      {previewCard.payload.site_name}
                    </span>
                  )}
                  <span class="chalk-composer-linkpreview-title">
                    {previewCard.payload.title}
                  </span>
                  {previewCard.payload.description !== "" && (
                    <span class="chalk-composer-linkpreview-desc">
                      {previewCard.payload.description}
                    </span>
                  )}
                  <span class="chalk-composer-linkpreview-host">
                    {hostOfURL(previewCard.payload.url)}
                  </span>
                </span>
              </>
            )}
            <button
              type="button"
              class="chalk-composer-linkpreview-dismiss"
              onClick={dismissPreview}
              title="send without preview"
              aria-label="send without preview"
              data-testid="composer-linkpreview-dismiss"
            >
              ✕
            </button>
          </div>
        )}
        {/* 74-2: the staged snippet. Clicking the body reopens the modal to
            edit it; the ✕ drops it. Deliberately shaped like the link-preview
            card above -- both are "this rides the next send". */}
        {stagedCode && !editing && (
          <div class="chalk-composer-code" data-testid="composer-code-staged">
            <button
              type="button"
              class="chalk-composer-code-open"
              onClick={() => setCodeOpen(true)}
              title="edit this snippet"
              data-testid="composer-code-edit"
            >
              <span class="chalk-composer-code-label">
                {stagedCode.lang === "" ? "code" : stagedCode.lang}
              </span>
              <span class="chalk-composer-code-lines">
                {codeLineCount(stagedCode.code)} lines
              </span>
            </button>
            <button
              type="button"
              class="chalk-composer-code-dismiss"
              onClick={() => {
                setStagedCode(null);
                textareaRef.current?.focus();
              }}
              title="drop this snippet"
              aria-label="drop this snippet"
              data-testid="composer-code-dismiss"
            >
              ✕
            </button>
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
        {/* 56-1: the @mention autocomplete. Anchored above the composer so
            it never covers what's being typed. mousedown is swallowed so a
            click doesn't blur the textarea before it can accept. */}
        {mentionOpen && (
          <div
            class="chalk-composer-mentions"
            role="listbox"
            aria-label="mention a member"
            data-testid="composer-mentions"
          >
            {mentionMatches.map((h, i) => (
              <button
                type="button"
                role="option"
                aria-selected={i === mentionCursor}
                class={`chalk-composer-mention-item ${i === mentionCursor ? "chalk-composer-mention-item--active" : ""}`}
                key={h}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => acceptMention(h)}
                onMouseEnter={() => setMentionSel(i)}
                data-testid="composer-mention-item"
              >
                @{h}
              </button>
            ))}
          </div>
        )}
        <div class="chalk-composer-row">
          {/* 44-5: the tool block, immediately left of the field it acts on.
              A 2x2 grid rather than a row or a column: a row stole width from
              the field, a column of four made the footer twice as tall. The
              block is rendered (empty) during an edit to hold its width, so
              the field does not slide sideways mid-edit. The old per-button
              classes are kept alongside chalk-composer-tool so the existing
              hover/disabled rules still apply.
              74-2: still four cells -- CODE took the "?" one, and the sheet
              moved down beside the send button. Keeping it 2x2 is what keeps
              the rail the same height as the two-row input. */}
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
                      {icons ? <IconFile /> : toolLabel("file")}
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
                      {icons ? <IconGif /> : toolLabel("gif")}
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
                    {icons ? "🙂" : toolLabel("emoji")}
                  </button>
                  {/* 74-2: no shortcut in the title -- see openTool.
                      94-4: the class is -code-tool, not -code: .chalk-composer-code
                      is the staged-snippet chip below, and the collision made this
                      button a flex container, which is what stopped `text-align:
                      center` from centring the phone's "C". */}
                  <button
                    type="button"
                    class="chalk-composer-tool chalk-composer-code-tool"
                    onClick={() => openTool("code")}
                    disabled={effectiveDisabled || sending}
                    title="paste code"
                    aria-label="paste code"
                    data-testid="composer-code"
                  >
                    {icons ? <IconCode /> : toolLabel("code")}
                  </button>
                </div>
              )}
            </div>
          )}
          <textarea
            ref={textareaRef}
            class="chalk-composer-input"
            placeholder={(disabled ? (placeholderText) : (placeholder ?? (placeholderText)))}
            value={draft}
            onInput={onInput}
            onKeyDown={onKeyDown}
            onKeyUp={onCaretKeyUp}
            onClick={onCaretClick}
            onBlur={() => setMention(null)}
            onPaste={enableAttachments ? onPaste : undefined}
            disabled={effectiveDisabled || sending}
            rows={2}
            maxLength={MAX_LEN}
            data-testid="composer-input"
            aria-label="message"
          />
          {/* 76-1: the shortcut sheet used to live here, behind a "?" beside
              send. On a phone that cell was width the composer did not have,
              and a cheat sheet is something you read once -- so it is a
              settings section now (ProfilePanel, "keyboard shortcuts"). */}
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
