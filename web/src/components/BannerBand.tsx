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
//   bleed   what sits beside the picture -- a wash of its two main colours
//           (111-11), a blurred blow-up of it, or the theme background.
//
// "poster" (111-12) is the third shape and the answer to a picture taller
// than it is wide: the art at band height at one end, the wash across the
// rest. A band is about twelve times wider than it is tall; filling it with a
// poster shows a strip of the poster's middle, fitting it makes a thumbnail
// in the centre, and neither looks like anything anyone chose. Box art on a
// coloured backdrop does, which is what every storefront does with exactly
// this problem.
//
// The bleed is why this component decodes the image a second time: the wash
// colours come off a 32x32 canvas draw (banner-edges.ts). Sampling is an
// effect keyed on the URL and the mode rather than an onLoad handler:
// switching shape re-renders the same <img> with the same src, so no second
// load event ever fires, and the bleed would stay empty for exactly the case
// it exists for.

import { useEffect, useRef, useState } from "preact/hooks";
import { sampleWashColors, washGradient } from "../attachments/banner-edges";
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
  const poster = fit === "poster";
  // Both shapes that leave room beside the picture take a bleed; filling
  // leaves none, so its bleed setting is remembered but not drawn.
  const bled = fitted || poster;
  const [aspect, setAspect] = useState<number | null>(null);
  const [wash, setWash] = useState<[string, string] | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // One decode answers both questions: how wide the picture is relative to
  // its height (for the fitted box) and what colours it is made of (for the
  // wash). Sampling is skipped when nothing would read it.
  useEffect(() => {
    let alive = true;
    setWash(null);
    if (!url) {
      setAspect(null);
      return;
    }
    const wantWash = bled && bleed === "wash";
    const read = (img: HTMLImageElement) => {
      if (!alive) return;
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        setAspect(img.naturalWidth / img.naturalHeight);
      }
      if (wantWash) setWash(sampleWashColors(img));
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
  }, [url, bled, bleed]);

  const focus = `${focusX}% ${focusY}%`;
  const scale = zoom / 100;
  const imgStyle: Record<string, string> = { objectPosition: focus };
  if (poster) {
    // The art is shown whole, at band height, and never cropped -- that is
    // the point of the shape. Zoom and focus have nothing to do here.
    if (aspect) imgStyle.aspectRatio = String(aspect);
  } else if (fitted) {
    // A box wider than the picture's own aspect, under object-fit: cover,
    // scales the picture up and crops it vertically -- which is what zoom
    // means here. max-width in the CSS caps it at the band, where fitted
    // has become filled and further zoom has nothing left to do.
    if (aspect) imgStyle.aspectRatio = String(aspect * scale);
  } else if (scale > 1) {
    imgStyle.transform = `scale(${scale})`;
    imgStyle.transformOrigin = focus;
  }

  // The wash runs from the picture's dominant colour where it meets the art
  // out to the second colour at the far end, mirrored on both sides so the
  // band reads as one surface. Poster art sits at the left, so it has only
  // one side and the gradient simply runs the width of the band.
  const showWash = bled && bleed === "wash" && !!wash;
  const washLeft = showWash ? { backgroundImage: washGradient(wash!, "left") } : undefined;
  const washRight = showWash ? { backgroundImage: washGradient(wash!, "right") } : undefined;

  return (
    <div
      class={`chalk-channel-banner ${fitted ? "chalk-channel-banner--fit" : ""} ${
        poster ? "chalk-channel-banner--poster" : ""
      } ${variant === "preview" ? "chalk-channel-banner--preview" : ""}`}
      data-testid={variant === "preview" ? "banner-preview" : "channel-banner"}
      data-fit={fit}
      data-height={height}
      data-bleed={bleed}
    >
      {/* A blurred blow-up of the same picture, behind everything. Cheap
          (the browser already has the bitmap) and it fills the band edge to
          edge, so the sharp picture appears to float in its own colours. */}
      {bled && bleed === "blur" && (
        <img src={url} alt="" aria-hidden="true" class="chalk-channel-banner-blur" />
      )}
      {showWash && !poster && (
        <span
          class="chalk-channel-banner-fade chalk-channel-banner-fade--left"
          style={washLeft}
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
      {showWash && (
        <span
          class="chalk-channel-banner-fade chalk-channel-banner-fade--right"
          style={washRight}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
