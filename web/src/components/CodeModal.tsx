// 74-2: the CODE modal -- paste a snippet, pick a label, stage it on the
// composer.
//
// It stages rather than sends: unlike the Giphy picker (which fires the
// message on pick), a snippet usually wants a caption, so the composer holds
// the payload until the next send and folds it into the body there. Reopening
// with `initial` set is how "edit the staged snippet" works.
//
// The textarea deliberately does not soft-wrap: what you see in the box is the
// line structure that will appear on the card.

import { useEffect, useRef, useState } from "preact/hooks";
import { CODE_LANGS, CODE_MAX_CHARS, codeLineCount, type CodePayload } from "../code/code";

interface Props {
  // The staged payload when reopening to edit; undefined for a fresh one.
  initial?: CodePayload;
  onClose: () => void;
  onInsert: (payload: CodePayload) => void;
}

// Mounted only while open (the parent guards it), rather than taking an
// `open` prop the way the giphy and emoji pickers do. Those hold no seeded
// state; this one does, and seeding it from `initial` in an effect meant the
// reset could land AFTER the first keystroke and wipe it -- which is exactly
// what happened to a fast paste. Mount-time initial state has no such window.
export function CodeModal({ initial, onClose, onInsert }: Props) {
  const [code, setCode] = useState(initial?.code ?? "");
  const [lang, setLang] = useState(initial?.lang ?? "");
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    areaRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const count = [...code].length;
  const over = count > CODE_MAX_CHARS;
  const canInsert = code.trim() !== "" && !over;

  return (
    <div
      class="chalk-modal-backdrop"
      data-testid="code-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        class="chalk-modal chalk-modal--code"
        role="dialog"
        aria-modal="true"
        aria-labelledby="code-modal-title"
        data-testid="code-modal"
      >
        <header class="chalk-modal-header">
          <h2 id="code-modal-title">paste code</h2>
        </header>
        <div class="chalk-modal-body chalk-code-modal-body">
          <textarea
            ref={areaRef}
            class="chalk-code-modal-input"
            value={code}
            onInput={(e) => setCode((e.target as HTMLTextAreaElement).value)}
            placeholder="paste or type a snippet..."
            spellcheck={false}
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            wrap="off"
            rows={14}
            data-testid="code-modal-input"
            aria-label="code"
          />
          <div class="chalk-code-modal-meta">
            <label class="chalk-code-modal-lang">
              language
              <select
                value={lang}
                onChange={(e) => setLang((e.target as HTMLSelectElement).value)}
                data-testid="code-modal-lang"
              >
                <option value="">none</option>
                {CODE_LANGS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <span
              class={`chalk-code-modal-count ${over ? "chalk-code-modal-count--over" : ""}`}
              data-testid="code-modal-count"
            >
              {codeLineCount(code)} lines · {count}/{CODE_MAX_CHARS}
            </span>
          </div>
        </div>
        <footer class="chalk-modal-footer">
          <button type="button" class="chalk-button" onClick={onClose} data-testid="code-modal-cancel">
            cancel
          </button>
          <button
            type="button"
            class="chalk-button chalk-button--primary"
            disabled={!canInsert}
            onClick={() => onInsert({ code, lang })}
            data-testid="code-modal-insert"
          >
            {over ? "too long" : "attach"}
          </button>
        </footer>
      </div>
    </div>
  );
}
