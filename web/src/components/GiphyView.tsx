// att-4c: gated render of a Giphy message in the feed.
//
// The parent (MessageList) calls decideGiphyRender(body, pref) and renders
// this component only for giphy messages (mode !== "text"). GiphyView turns
// that decision into UI:
//   - image:    an <img> from the Giphy CDN. This is the ONE sanctioned
//               third-party fetch, reached only because the LOCAL viewer
//               enabled Giphy AND the host is allowlisted. On load failure it
//               degrades to an inert notice (no retry loop, no re-fetch).
//   - unset:    inert chip + an "enable" affordance that opens the consent
//               modal. Nothing is fetched.
//   - disabled: inert chip; Giphy is off for this viewer. Nothing is fetched.
//   - bad_host: the raw URL as inert, selectable text (a smuggled non-Giphy
//               link); shown plainly, never fetched.

import { useState } from "preact/hooks";
import type { GiphyRender } from "../giphy/giphy";

interface Props {
  // Never "text": MessageList renders plain body text itself for that case.
  render: Exclude<GiphyRender, { mode: "text" }>;
  onRequestEnableGiphy?: () => void;
}

export function GiphyView({ render, onRequestEnableGiphy }: Props) {
  const [failed, setFailed] = useState(false);

  if (render.mode === "image" && !failed) {
    return (
      <span class="chalk-giphy" data-testid="giphy-image">
        <img
          class="chalk-giphy-img"
          src={render.url}
          alt="Giphy GIF"
          loading="lazy"
          onError={() => setFailed(true)}
        />
        <span class="chalk-giphy-tag" aria-hidden="true">via Giphy</span>
      </span>
    );
  }

  // Blocked, or an image that failed to load -> inert; no (further) fetch.
  const reason = render.mode === "image" ? "load_failed" : render.reason;
  return (
    <span
      class="chalk-giphy-blocked"
      data-testid="giphy-blocked"
      data-reason={reason}
    >
      <span class="chalk-giphy-blocked-icon" aria-hidden="true">▦</span>
      <span class="chalk-giphy-blocked-text">
        {reason === "unset" && "Giphy GIF — hidden until you enable Giphy"}
        {reason === "disabled" && "Giphy GIF — Giphy is off"}
        {reason === "bad_host" && render.url}
        {reason === "load_failed" && "Giphy GIF failed to load"}
      </span>
      {reason === "unset" && onRequestEnableGiphy && (
        <button
          type="button"
          class="chalk-giphy-enable"
          onClick={onRequestEnableGiphy}
          data-testid="giphy-enable"
        >
          enable
        </button>
      )}
    </span>
  );
}
