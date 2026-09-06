// chalk 111-8 -- the band itself: one picture, framed the way the layout says.
//
// Presentational and shared on purpose. The channel header draws it, and so
// does the editor's preview -- if the preview were its own markup it would
// drift from the real thing, and an editor that lies about the result is
// worse than no editor.
//
// The four knobs, and how each is spent:
//
//   fit     "fill" gives the picture the whole band and crops it; "fit" gives
//           it band height at its own aspect and leaves the sides to bleed.
//   focus   object-position (and the transform origin), so cropping keeps the
//           part of the picture that matters instead of always the middle.
//   zoom    fill scales the image over the band; fit widens its box past its
//           own aspect ratio, which under object-fit: cover is the same thing
//           -- the picture grows and the band crops it vertically. Nothing is
//           measured for either: the aspect ratio comes off the decoded image
//           and CSS does the arithmetic.
//   bleed   what sits beside a fitted picture -- its own edge columns
//           (111-6), a blurred blow-up of it, or the theme background.
//
// The edge bleed is why this component decodes the image a second time: the
// columns are read off a 24x24 canvas draw (banner-edges.ts) and become two
// vertical gradients, so where the bleed meets the picture it IS the picture's
// edge and there is no seam. Sampling is an effect keyed on the URL and the
// mode rather than an onLoad handler: switching fill -> fit re-renders the
// same <img> with the same src, so no second load event ever fires, and the
// bleed would stay empty for exactly the case it exists for.

import { useEffect, useRef, useState } from "preact/hooks";
import {
  type EdgeColumns,
  columnGradient,
  sampleEdgeColumns,
} from "../attachments/banner-edges";
import type { BannerLayout } from "../state/banner";

interface Props {
  /** object URL of the decrypted picture */
  url: string;
  layout: BannerLayout;
  alt?: string;
  /** clicking the picture (the header opens a lightbox; the editor does not) */
  onClick?: () => void;
  /** the editor renders the same band inside its dialog */
  variant?: "header" | "preview";
}

export function BannerBand({ url, layout, alt = "channel banner", onClick, variant = "header" }: Props) {
  const { fit, focusX, focusY, zoom, height, bleed } = layout;
  const fitted = fit === "fit";
  const [aspect, setAspect] = useState<number | null>(null);
  const [edges, setEdges] = useState<EdgeColumns | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // One decode answers both questions: how wide the picture is relative to
  // its height (for the fitted box) and what its edges look like (for the
  // bleed). Sampling is skipped when nothing would read it.
  useEffect(() => {
    let alive = true;
    setEdges(null);
    if (!url) {
      setAspect(null);
      return;
    }
    const wantEdges = fitted && bleed === "edge";
    const read = (img: HTMLImageElement) => {
      if (!alive) return;
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        setAspect(img.naturalWidth / img.naturalHeight);
      }
      if (wantEdges) setEdges(sampleEdgeColumns(img));
    };
    const el = imgRef.current;
    if (el && el.complete && el.naturalWidth > 0) {
      read(el);
      return;
    }
    const probe = new Image();
    probe.onload = () => read(probe);
    probe.src = url;
    return () => {
      alive = false;
      probe.onload = null;
    };
  }, [url, fitted, bleed]);

  const focus = `${focusX}% ${focusY}%`;
  const scale = zoom / 100;
  const imgStyle: Record<string, string> = { objectPosition: focus };
  if (fitted) {
    // A box wider than the picture's own aspect, under object-fit: cover,
    // scales the picture up and crops it vertically -- which is what zoom
    // means here. max-width in the CSS caps it at the band, where fitted
    // has become filled and further zoom has nothing left to do.
    if (aspect) imgStyle.aspectRatio = String(aspect * scale);
  } else if (scale > 1) {
    imgStyle.transform = `scale(${scale})`;
    imgStyle.transformOrigin = focus;
  }

  const fadeLeft = edges ? { backgroundImage: columnGradient(edges.left) } : undefined;
  const fadeRight = edges ? { backgroundImage: columnGradient(edges.right) } : undefined;
  const showEdges = fitted && bleed === "edge";

  return (
    <div
      class={`chalk-channel-banner ${fitted ? "chalk-channel-banner--fit" : ""} ${
        variant === "preview" ? "chalk-channel-banner--preview" : ""
      }`}
      data-testid={variant === "preview" ? "banner-preview" : "channel-banner"}
      data-fit={fit}
      data-height={height}
      data-bleed={bleed}
    >
      {/* A blurred blow-up of the same picture, behind everything. Cheap
          (the browser already has the bitmap) and it fills the band edge to
          edge, so the sharp picture appears to float in its own colours. */}
      {fitted && bleed === "blur" && (
        <img src={url} alt="" aria-hidden="true" class="chalk-channel-banner-blur" />
      )}
      {showEdges && (
        <span
          class="chalk-channel-banner-fade chalk-channel-banner-fade--left"
          style={fadeLeft}
          aria-hidden="true"
        />
      )}
      <img
        ref={imgRef}
        src={url}
        alt={alt}
        class="chalk-channel-banner-img"
        style={imgStyle}
        onClick={onClick}
        title={onClick ? "open the full image" : undefined}
      />
      {showEdges && (
        <span
          class="chalk-channel-banner-fade chalk-channel-banner-fade--right"
          style={fadeRight}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
