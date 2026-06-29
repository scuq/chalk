// att-4c: Giphy search picker. A small overlay with a search box and a grid of
// preview tiles backed by the server proxy (searchGiphy -> att-4a). Picking a
// tile calls onPick(full_url); the parent (Composer) sends it as a giphy
// message. Renders only when open. Esc / click-outside / pick closes it.
//
// Privacy note: the preview tiles ARE fetched from Giphy's CDN while the picker
// is open -- but the picker only opens for a viewer who already enabled Giphy
// (Composer gates the button on the consent pref), so this is consistent with
// their choice.

import { useEffect, useRef, useState } from "preact/hooks";
import { searchGiphy, type GiphyResult } from "../giphy/search";

interface Props {
  open: boolean;
  onClose: () => void;
  onPick: (fullURL: string) => void;
}

const DEBOUNCE_MS = 300;

export function GiphyPicker({ open, onClose, onPick }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GiphyResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus the search box on open; reset all state on close.
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    } else {
      setQuery("");
      setResults([]);
      setError(false);
      setLoading(false);
    }
  }, [open]);

  // Debounced search on query change; aborts the prior in-flight request so a
  // stale response can't overwrite a newer one.
  useEffect(() => {
    if (!open) return undefined;
    const q = query.trim();
    if (q === "") {
      setResults([]);
      setError(false);
      setLoading(false);
      return undefined;
    }
    const ctrl = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      searchGiphy(q, ctrl.signal)
        .then((r) => {
          setResults(r);
          setError(false);
        })
        .catch(() => {
          if (ctrl.signal.aborted) return;
          setError(true);
          setResults([]);
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [open, query]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const trimmed = query.trim();
  return (
    <div
      class="chalk-giphy-picker-backdrop"
      data-testid="giphy-picker-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        class="chalk-giphy-picker"
        role="dialog"
        aria-modal="true"
        aria-label="search Giphy"
        data-testid="giphy-picker"
      >
        <div class="chalk-giphy-picker-search">
          <input
            ref={inputRef}
            type="text"
            class="chalk-giphy-picker-input"
            placeholder="search Giphy..."
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            data-testid="giphy-picker-input"
          />
          <button
            type="button"
            class="chalk-giphy-picker-close"
            onClick={onClose}
            aria-label="close"
          >
            ✕
          </button>
        </div>
        <div class="chalk-giphy-picker-body">
          {loading && <p class="chalk-giphy-picker-hint">searching...</p>}
          {error && (
            <p class="chalk-giphy-picker-hint chalk-giphy-picker-error">
              search failed — try again
            </p>
          )}
          {!loading && !error && trimmed === "" && (
            <p class="chalk-giphy-picker-hint">
              type to search Giphy. picking a GIF sends it to everyone in this channel.
            </p>
          )}
          {!loading && !error && trimmed !== "" && results.length === 0 && (
            <p class="chalk-giphy-picker-hint">no results</p>
          )}
          <div class="chalk-giphy-picker-grid">
            {results.map((r) => (
              <button
                key={r.id}
                type="button"
                class="chalk-giphy-picker-tile"
                onClick={() => onPick(r.full_url)}
                title={r.title || "GIF"}
                data-testid="giphy-picker-tile"
              >
                <img src={r.preview_url} alt={r.title || "GIF"} loading="lazy" />
              </button>
            ))}
          </div>
        </div>
        <p class="chalk-giphy-picker-attribution" aria-hidden="true">Powered by GIPHY</p>
      </div>
    </div>
  );
}
