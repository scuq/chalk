// 74-3: the received code card.
//
// Everything on it comes from the decrypted body -- there is no fetch, no
// attachment, and no viewer pref to consult. The snippet goes in as a TEXT
// child of <code>, never as markup, which is the same discipline the rest of
// the message path keeps.
//
// No syntax highlighting by design (see code/code.ts): the language label is
// cosmetic. That is also why the card leans on shape rather than colour --
// the header, the accent rule and the monospace ground are what make it read
// as code in a UI that is already monospace by default.

import { useState } from "preact/hooks";
import { codeLineCount, type CodePayload } from "../code/code";

interface Props {
  payload: CodePayload;
}

// Above this many lines the card collapses. A snippet worth pasting is
// usually worth seeing whole, but a 400-line file should not push the rest of
// the conversation off the screen.
const COLLAPSE_OVER = 15;

export function CodeBlockView({ payload }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const lines = codeLineCount(payload.code);
  const collapsible = lines > COLLAPSE_OVER;

  const copy = () => {
    if (!navigator.clipboard?.writeText) return;
    void navigator.clipboard
      .writeText(payload.code)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {
        // The snippet is selectable text either way; a failed copy is not
        // worth an error banner.
      });
  };

  return (
    <div class="chalk-codecard" data-testid="message-code">
      <div class="chalk-codecard-head">
        <span class="chalk-codecard-lang">{payload.lang === "" ? "code" : payload.lang}</span>
        <span class="chalk-codecard-lines">
          {lines} {lines === 1 ? "line" : "lines"}
        </span>
        <button
          type="button"
          class="chalk-codecard-copy"
          onClick={copy}
          data-testid="message-code-copy"
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre
        class={`chalk-codecard-body ${collapsible && !expanded ? "chalk-codecard-body--clipped" : ""}`}
        data-testid="message-code-body"
      >
        <code>{payload.code}</code>
      </pre>
      {collapsible && (
        <button
          type="button"
          class="chalk-codecard-expand"
          onClick={() => setExpanded((v) => !v)}
          data-testid="message-code-expand"
        >
          {expanded ? "show less" : `show all ${lines} lines`}
        </button>
      )}
    </div>
  );
}
