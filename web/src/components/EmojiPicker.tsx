// Phase 9.7g: emoji picker for the composer.
//
// Mirrors GiphyPicker's shape (open/onClose/onPick, renders null when closed,
// Esc + click-outside dismiss) so the two composer pickers behave the same.
// Unlike Giphy this needs no network and no consent gate -- it's static data.
//
// The picker does NOT insert the emoji itself; it reports the pick and the
// Composer splices it in at the caret. Keeping the caret arithmetic in the
// Composer (which owns the textarea ref and the draft state) avoids passing a
// ref down and keeps insertAtCursor unit-testable.

import { useEffect, useRef, useState } from "preact/hooks";
import { EMOJI_CATEGORIES, searchEmoji, type Emoji } from "../emoji/emoji";

interface Props {
  open: boolean;
  onClose: () => void;
  onPick: (char: string) => void;
}

export function EmojiPicker({ open, onClose, onPick }: Props) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(EMOJI_CATEGORIES[0]?.id ?? "smileys");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus the search box on open and reset state on close, so reopening
  // doesn't strand the previous query.
  useEffect(() => {
    if (open) {
      // Defer: the element isn't mounted yet on the tick `open` flips.
      const id = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
    setQuery("");
    setCategory(EMOJI_CATEGORIES[0]?.id ?? "smileys");
    return undefined;
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const searching = query.trim().length > 0;
  const results: Emoji[] = searching
    ? searchEmoji(query)
    : (EMOJI_CATEGORIES.find((c) => c.id === category)?.emoji ?? []);

  return (
    <div
      class="chalk-emoji-picker-backdrop"
      onClick={onClose}
      data-testid="emoji-picker-backdrop"
    >
      <div
        class="chalk-emoji-picker"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="emoji picker"
        data-testid="emoji-picker"
      >
        <div class="chalk-emoji-picker-search">
          <input
            ref={inputRef}
            type="text"
            class="chalk-emoji-picker-input"
            placeholder="search emoji..."
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            aria-label="search emoji"
            data-testid="emoji-search"
          />
          <button
            type="button"
            class="chalk-emoji-picker-close"
            onClick={onClose}
            aria-label="close emoji picker"
          >
            ✕
          </button>
        </div>

        {/* Category tabs are hidden while searching: results span every
            category, so a highlighted tab would be lying. */}
        {!searching && (
          <div class="chalk-emoji-picker-tabs" role="tablist">
            {EMOJI_CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                role="tab"
                aria-selected={c.id === category}
                class={`chalk-emoji-picker-tab ${
                  c.id === category ? "chalk-emoji-picker-tab--active" : ""
                }`}
                onClick={() => setCategory(c.id)}
                data-testid={`emoji-tab-${c.id}`}
              >
                {c.emoji[0]?.c ?? c.label}
              </button>
            ))}
          </div>
        )}

        <div class="chalk-emoji-picker-body">
          {results.length === 0 ? (
            <p class="chalk-emoji-picker-hint">no emoji match that.</p>
          ) : (
            <div class="chalk-emoji-picker-grid">
              {results.map((e) => (
                <button
                  key={`${e.c}-${e.n}`}
                  type="button"
                  class="chalk-emoji-picker-item"
                  title={e.n}
                  aria-label={e.n}
                  onClick={() => onPick(e.c)}
                  data-testid="emoji-item"
                >
                  {e.c}
                </button>
              ))}
            </div>
          )}
        </div>

        <div class="chalk-emoji-picker-footer">
          {searching
            ? `${results.length} match${results.length === 1 ? "" : "es"}`
            : (EMOJI_CATEGORIES.find((c) => c.id === category)?.label ?? "")}
        </div>
      </div>
    </div>
  );
}
