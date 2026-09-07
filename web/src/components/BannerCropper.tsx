// chalk 111-13 -- choosing what the picture is.
//
// This is the editor's other view. The band preview answers "how does this sit
// in the header"; the cropper answers "what is this a picture of", and it has
// to show the whole image to ask that -- a crop chosen against a cropped
// preview would be a guess.
//
// So: the picture at whatever size the dialog allows, a rectangle over it, and
// everything outside the rectangle dimmed. Drag inside to move it, drag a
// corner to resize it, drag anywhere outside to start a new one. All of it in
// percentages of the image (crop.ts), so the maths does not care what size the
// dialog gave us.
//
// Pointer events rather than mouse events: the same handlers serve a trackpad
// and a phone, and setPointerCapture keeps a drag alive when the finger
// leaves the picture -- which it will, since half of cropping is dragging
// toward an edge.

import { useRef, useState } from "preact/hooks";
import {
  type CropCorner,
  type CropRect,
  FULL_CROP,
  isFullCrop,
  moveRect,
  rectFromCorners,
  resizeRect,
} from "../attachments/crop";

interface Props {
  /** object URL of the picture being cropped */
  url: string;
  /** the region to start from; a re-crop opens on the whole picture again */
  initial?: CropRect;
  busy?: boolean;
  /** 112-7: whether "the whole picture" is a legitimate answer. For a banner
   *  it is not -- applying a crop that removes nothing re-encodes and
   *  re-uploads an identical image, so the button stays disabled until a box
   *  is drawn. For a profile picture it is: the square is taken from
   *  whatever region is chosen, and choosing all of it is a normal thing to
   *  want. Without this the only way to set an avatar was to crop one. */
  allowWhole?: boolean;
  /** what the confirm button says; "crop" reads wrong when nothing is being
   *  cut away. */
  applyLabel?: string;
  onApply: (rect: CropRect) => void;
  onCancel: () => void;
}

type Drag =
  | { kind: "move"; startX: number; startY: number; from: CropRect }
  | { kind: "resize"; corner: CropCorner }
  | { kind: "new"; anchorX: number; anchorY: number };

export function BannerCropper({
  url,
  initial = FULL_CROP,
  busy = false,
  allowWhole = false,
  applyLabel,
  onApply,
  onCancel,
}: Props) {
  const [rect, setRect] = useState<CropRect>(initial);
  const drag = useRef<Drag | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  // Where a pointer is, as a percentage of the picture. Everything below
  // works in these, so none of it has to know the dialog's size.
  const pct = (e: PointerEvent): { x: number; y: number } | null => {
    const el = surfaceRef.current;
    if (!el) return null;
    const box = el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return null;
    return {
      x: ((e.clientX - box.left) / box.width) * 100,
      y: ((e.clientY - box.top) / box.height) * 100,
    };
  };

  const onPointerDown = (e: PointerEvent, d: Drag) => {
    e.stopPropagation();
    drag.current = d;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = pct(e);
    if (!p) return;
    if (d.kind === "move") {
      setRect(moveRect(d.from, p.x - d.startX, p.y - d.startY));
    } else if (d.kind === "resize") {
      setRect((r) => resizeRect(r, d.corner, p.x, p.y));
    } else {
      setRect(rectFromCorners(d.anchorX, d.anchorY, p.x, p.y));
    }
  };

  const endDrag = (e: PointerEvent) => {
    drag.current = null;
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
  };

  const corners: CropCorner[] = ["nw", "ne", "sw", "se"];

  // While the box is the whole picture there is nothing to move it to, and
  // it covers the surface -- so a drag inside it would be swallowed by a
  // no-op move instead of drawing the box the user is trying to draw. Let
  // pointers through the body in that state; the corner handles stay live,
  // because trimming an edge off the whole picture is a real thing to want.
  const full = isFullCrop(rect);

  return (
    <div class="chalk-banner-cropper" data-testid="banner-cropper">
      <div
        ref={surfaceRef}
        class="chalk-banner-cropper-surface"
        data-testid="banner-cropper-surface"
        onPointerDown={(e) => {
          // A drag that starts on the picture (rather than on the rectangle
          // or a handle) draws a new rectangle from that point.
          const p = pct(e as unknown as PointerEvent);
          if (!p) return;
          onPointerDown(e as unknown as PointerEvent, {
            kind: "new",
            anchorX: p.x,
            anchorY: p.y,
          });
          setRect(rectFromCorners(p.x, p.y, p.x, p.y));
        }}
        onPointerMove={(e) => onPointerMove(e as unknown as PointerEvent)}
        onPointerUp={(e) => endDrag(e as unknown as PointerEvent)}
        onPointerCancel={(e) => endDrag(e as unknown as PointerEvent)}
      >
        <img src={url} alt="" class="chalk-banner-cropper-img" draggable={false} />
        {/* The kept region. Its huge outward shadow is what dims everything
            else -- one element instead of four, and it can never disagree
            with the rectangle's own edges. */}
        <div
          class="chalk-banner-cropper-rect"
          data-testid="banner-cropper-rect"
          style={{
            left: `${rect.x}%`,
            top: `${rect.y}%`,
            width: `${rect.w}%`,
            height: `${rect.h}%`,
            pointerEvents: full ? "none" : undefined,
            cursor: full ? "crosshair" : undefined,
          }}
          onPointerDown={(e) => {
            const p = pct(e as unknown as PointerEvent);
            if (!p) return;
            onPointerDown(e as unknown as PointerEvent, {
              kind: "move",
              startX: p.x,
              startY: p.y,
              from: rect,
            });
          }}
          onPointerMove={(e) => onPointerMove(e as unknown as PointerEvent)}
          onPointerUp={(e) => endDrag(e as unknown as PointerEvent)}
          onPointerCancel={(e) => endDrag(e as unknown as PointerEvent)}
        >
          {corners.map((c) => (
            <span
              key={c}
              class={`chalk-banner-cropper-handle chalk-banner-cropper-handle--${c}`}
              data-testid={`banner-cropper-handle-${c}`}
              style={{ pointerEvents: "auto" }}
              onPointerDown={(e) =>
                onPointerDown(e as unknown as PointerEvent, { kind: "resize", corner: c })
              }
              onPointerMove={(e) => onPointerMove(e as unknown as PointerEvent)}
              onPointerUp={(e) => endDrag(e as unknown as PointerEvent)}
              onPointerCancel={(e) => endDrag(e as unknown as PointerEvent)}
            />
          ))}
        </div>
      </div>

      <p class="chalk-profile-hint">
        {allowWhole
          ? "drag a box over what to keep, or use the whole picture as it is."
          : "drag a box over what to keep; drag inside it to move it, or a corner to resize. what falls outside is discarded — the framing controls come after."}
      </p>

      <div class="chalk-banner-editor-row">
        <span class="chalk-banner-editor-value" data-testid="banner-cropper-size">
          {rect.w}×{rect.h}%
        </span>
        <button
          type="button"
          class="chalk-nick-menu-btn"
          data-testid="banner-cropper-all"
          onClick={() => setRect(FULL_CROP)}
        >
          whole picture
        </button>
        <span class="chalk-banner-cropper-actions">
          <button
            type="button"
            class="chalk-button"
            data-testid="banner-cropper-cancel"
            onClick={onCancel}
          >
            back
          </button>
          <button
            type="button"
            class="chalk-button chalk-button--primary"
            data-testid="banner-cropper-apply"
            disabled={busy || (!allowWhole && isFullCrop(rect))}
            title={
              isFullCrop(rect)
                ? allowWhole
                  ? "use the whole picture"
                  : "nothing is being cropped away"
                : "crop to this box"
            }
            onClick={() => onApply(rect)}
          >
            {busy ? "working…" : (applyLabel ?? "crop")}
          </button>
        </span>
      </div>
    </div>
  );
}
