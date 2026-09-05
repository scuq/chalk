// chalk 110-1 -- the gallery lightbox.
//
// Before 110 the expanded view lived inside AttachmentView: local `expanded`
// state, one image, no way out but closing. A message that arrives as four
// screenshots (101-1's tile grid) was therefore four separate open/close
// round trips through the feed. The overlay moved here so that the thing it
// shows is a *set* -- AttachmentGroup owns the index and passes every image
// of the message, including the ones still hidden behind the "+N" tile, so
// paging forward reaches them without expanding the grid first.
//
// It loads its own bytes rather than borrowing the tile's. The controller is
// cache-first (ciphertext in IndexedDB) so re-decrypting an image the feed
// already painted costs a WebCrypto call and no network, and it is the only
// arrangement that works for a neighbour whose AttachmentView never mounted.
// Both neighbours are prefetched, so paging is instant in either direction.
//
// 110-2: it zooms. The view is one transform (zoom.ts does the arithmetic,
// this file does the events), and the scale is what arbitrates the gestures --
// at fit, a horizontal drag pages through the set; zoomed, the same drag pans
// the picture. That one rule is why pinch-to-zoom and swipe-to-next can share
// an axis without fighting.
//
// Fail-closed is unchanged: no key, no bytes, a locked placeholder instead.

import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { AttachmentController } from "../attachments/pipeline";
import {
  GALLERY_SETTLE_MS,
  stepIndex,
  swipeActionFor,
  swipeArmedX,
  swipeCancelledX,
  swipeCommitDir,
  swipeOffsetX,
} from "../attachments/gallery";
import { type AttachmentMeta, type AttachmentRef, humanSize } from "../attachments/types";
import {
  type Frame,
  IDENTITY,
  type View,
  clampView,
  isZoomed,
  panBy,
  pinchSpan,
  toggleScale,
  wheelFactor,
  zoomAt,
} from "../attachments/zoom";
import { asBytes } from "../crypto/bytes";

interface Props {
  channelID: string;
  /** every image of the message, in feed order -- hidden "+N" ones included */
  images: AttachmentRef[];
  /** which one is showing; the owner keeps it so it survives a re-render */
  index: number;
  controller: AttachmentController;
  onIndex: (index: number) => void;
  onClose: () => void;
}

interface Entry {
  meta: AttachmentMeta | null;
  /** decrypted inline preview: no network, so it paints first */
  preview: string | null;
  /** the original, swapped in over the preview when it arrives */
  full: string | null;
  locked: boolean;
}

const EMPTY: Entry = { meta: null, preview: null, full: null, locked: false };

/**
 * Which set of hints the caption offers. A phone has no wheel and no Esc key,
 * and the arrows are hidden there, so telling it to "scroll or press Esc" is
 * three quarters wrong. Read once: a pointer does not change mid-lightbox.
 */
function coarsePointer(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(hover: none)").matches;
}

/**
 * What the fingers currently on the glass are doing. Which one a touch
 * becomes is decided once, at touchstart, from the finger count and whether
 * the picture is zoomed -- never re-decided mid-drag, so a gesture cannot
 * change its mind halfway and do both things badly.
 */
type Gesture =
  | { kind: "swipe"; x: number; y: number; t: number; armed: boolean; dead: boolean }
  | { kind: "pan"; x: number; y: number; from: View }
  | { kind: "pinch"; span: number; mx: number; my: number; from: View };

export function Lightbox({ channelID, images, index, controller, onIndex, onClose }: Props) {
  const [entries, setEntries] = useState<Record<string, Entry | undefined>>({});
  // Horizontal travel while a finger is down, and the release animation.
  const [dragX, setDragX] = useState<number | null>(null);
  const [settling, setSettling] = useState(false);
  // 110-2: the zoom/pan transform on the current image.
  const [view, setView] = useState<View>(IDENTITY);
  const aliveRef = useRef(true);
  const urlsRef = useRef<string[]>([]);
  const startedRef = useRef(new Set<string>());
  const gestureRef = useRef<Gesture | null>(null);
  const mouseRef = useRef<{ x: number; y: number; from: View } | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const settleTimerRef = useRef<number | null>(null);

  const coarse = useRef(coarsePointer()).current;
  const count = images.length;
  const att = images[index];
  const entry = att ? entries[att.id] : undefined;

  // Revoke exactly the object URLs we minted, once, when the overlay goes.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
      for (const u of urlsRef.current) URL.revokeObjectURL(u);
      urlsRef.current = [];
    };
  }, []);

  const put = useCallback((id: string, patch: Partial<Entry>) => {
    setEntries((prev) => ({ ...prev, [id]: { ...(prev[id] ?? EMPTY), ...patch } }));
  }, []);

  // Decrypt one image at most once per open, whatever re-renders happen.
  const load = useCallback(
    (ref: AttachmentRef) => {
      if (startedRef.current.has(ref.id)) return;
      startedRef.current.add(ref.id);
      const mint = (bytes: Uint8Array, mime: string): string => {
        const url = URL.createObjectURL(new Blob([asBytes(bytes)], { type: mime }));
        urlsRef.current.push(url);
        return url;
      };
      void controller.decryptMeta(channelID, ref).then((meta) => {
        if (!aliveRef.current) return;
        if (!meta) {
          put(ref.id, { locked: true });
          return;
        }
        put(ref.id, { meta });
        if (meta.kind !== "image") return;
        void controller.loadPreviewBytes(channelID, ref).then((bytes) => {
          if (!aliveRef.current || !bytes) return;
          put(ref.id, { preview: mint(bytes, meta.mime) });
        });
        void controller.loadFullBytes(channelID, ref).then((bytes) => {
          if (!aliveRef.current || !bytes) return;
          put(ref.id, { full: mint(bytes, meta.mime) });
        });
      });
    },
    [channelID, controller, put],
  );

  // The current image and both neighbours, so a page turn shows bytes rather
  // than a spinner. A message's attachment set is small and the feed has
  // usually fetched all of it for the tiles already.
  useEffect(() => {
    for (const i of [index, index + 1, index - 1]) {
      const ref = images[i];
      if (ref) load(ref);
    }
  }, [images, index, load]);

  const settle = useCallback((to: number, done?: () => void) => {
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    setSettling(true);
    setDragX(to);
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null;
      if (!aliveRef.current) return;
      setSettling(false);
      setDragX(null);
      done?.();
    }, GALLERY_SETTLE_MS);
  }, []);

  const go = useCallback(
    (delta: number) => {
      const next = stepIndex(index, count, delta);
      if (next === index) return;
      setDragX(null);
      setSettling(false);
      // Every image opens fitted: carrying one picture's zoom onto the next
      // lands you on an arbitrary corner of a differently-shaped photo.
      setView(IDENTITY);
      onIndex(next);
    },
    [count, index, onIndex],
  );

  // 110-2: the geometry a gesture happens in, measured fresh each time.
  // offsetWidth/Height are the laid-out box (CSS max-width/max-height,
  // object-fit: contain), untouched by the transform we are about to change --
  // so "scale 1" means "fitted to this screen", whatever the screen is.
  const frameOf = useCallback((): Frame | null => {
    const img = imgRef.current;
    if (!img) return null;
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    return { cx: vw / 2, cy: vh / 2, vw, vh, iw: img.offsetWidth, ih: img.offsetHeight };
  }, []);

  // Escape closes; the arrows page. Keyboard is the only way through the set
  // for a pointer that has no gesture to make.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose]);

  // 64-9: the overlay owns its touches (stopPropagation) so the app-level
  // swipe-back can't switch the screen out from under a modal.
  const beginTouch = (e: TouchEvent) => {
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
      setSettling(false);
      setDragX(null);
    }
    if (e.touches.length >= 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      gestureRef.current = {
        kind: "pinch",
        span: pinchSpan(a.clientX, a.clientY, b.clientX, b.clientY),
        mx: (a.clientX + b.clientX) / 2,
        my: (a.clientY + b.clientY) / 2,
        from: view,
      };
      return;
    }
    const t = e.touches[0];
    if (!t) {
      gestureRef.current = null;
      return;
    }
    gestureRef.current = isZoomed(view)
      ? { kind: "pan", x: t.clientX, y: t.clientY, from: view }
      : { kind: "swipe", x: t.clientX, y: t.clientY, t: e.timeStamp, armed: false, dead: false };
  };

  const onTouchStart = (e: TouchEvent) => {
    e.stopPropagation();
    gestureRef.current = null;
    beginTouch(e);
  };

  const onTouchMove = (e: TouchEvent) => {
    e.stopPropagation();
    const g = gestureRef.current;
    if (!g) return;

    if (g.kind === "pinch") {
      const [a, b] = [e.touches[0], e.touches[1]];
      if (!a || !b || g.span <= 0) return;
      const f = frameOf();
      if (!f) return;
      const span = pinchSpan(a.clientX, a.clientY, b.clientX, b.clientY);
      const mx = (a.clientX + b.clientX) / 2;
      const my = (a.clientY + b.clientY) / 2;
      // Grow around the midpoint the pinch started on, then follow that
      // midpoint as it drifts -- so two fingers zoom and pan in one motion.
      const zoomed = zoomAt(g.from, f, g.from.scale * (span / g.span), g.mx, g.my);
      setView(panBy(zoomed, f, mx - g.mx, my - g.my));
      return;
    }

    const t = e.touches[0];
    if (!t) return;

    if (g.kind === "pan") {
      const f = frameOf();
      if (!f) return;
      setView(
        clampView(
          { scale: g.from.scale, tx: g.from.tx + (t.clientX - g.x), ty: g.from.ty + (t.clientY - g.y) },
          f,
        ),
      );
      return;
    }

    if (g.dead) return;
    const dx = t.clientX - g.x;
    const dy = t.clientY - g.y;
    if (swipeCancelledX(dx, dy)) {
      g.dead = true;
      if (g.armed) {
        g.armed = false;
        settle(0);
      }
      return;
    }
    if (!g.armed && !swipeArmedX(dx, dy)) return;
    g.armed = true;
    setDragX(swipeOffsetX(dx, index, count));
  };

  const endTouch = (e: TouchEvent, cancelled: boolean) => {
    e.stopPropagation();
    const g = gestureRef.current;
    gestureRef.current = null;
    // Fingers still down: a pinch that lost one becomes a pan rather than
    // dying, since the browser won't send another touchstart for the one
    // that stayed put.
    if (!cancelled && e.touches.length > 0) {
      beginTouch(e);
      return;
    }
    if (!g || g.kind !== "swipe" || !g.armed) return;
    const t = cancelled ? undefined : e.changedTouches[0];
    if (!t) {
      settle(0);
      return;
    }
    const dir = swipeCommitDir(t.clientX - g.x, t.clientY - g.y, e.timeStamp - g.t);
    const action = swipeActionFor(dir, index, count);
    if (action === "close") {
      // Off the right edge on the way out, so the overlay leaves rather than
      // snapping away -- the same exit the 64-9 gesture always had.
      settle(window.innerWidth, onClose);
    } else if (action === "prev") {
      go(-1);
    } else if (action === "next") {
      go(1);
    } else {
      settle(0);
    }
  };

  // 110-2: mouse. The wheel zooms toward the cursor, a double-click toggles
  // in and out, and a drag pans once there is something to pan.
  const onWheel = (e: WheelEvent) => {
    const f = frameOf();
    if (!f) return;
    e.preventDefault();
    // deltaMode: 0 px, 1 lines, 2 pages. Firefox reports lines.
    const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? f.vh : 1);
    setView((v) => zoomAt(v, f, v.scale * wheelFactor(dy), e.clientX, e.clientY));
  };

  const onDoubleClick = (e: MouseEvent) => {
    const f = frameOf();
    if (!f) return;
    e.preventDefault();
    e.stopPropagation();
    setView((v) => zoomAt(v, f, toggleScale(v), e.clientX, e.clientY));
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== "mouse" || e.button !== 0 || !isZoomed(view)) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    mouseRef.current = { x: e.clientX, y: e.clientY, from: view };
  };

  const onPointerMove = (e: PointerEvent) => {
    const m = mouseRef.current;
    if (!m) return;
    const f = frameOf();
    if (!f) return;
    setView(
      clampView(
        { scale: m.from.scale, tx: m.from.tx + (e.clientX - m.x), ty: m.from.ty + (e.clientY - m.y) },
        f,
      ),
    );
  };

  const endPointer = () => {
    mouseRef.current = null;
  };

  if (!att) return null;

  const shownURL = entry?.full ?? entry?.preview ?? null;
  const name = entry?.meta?.name ?? "image";
  const zoomed = isZoomed(view);

  return (
    <div
      class={`chalk-attachment-lightbox${zoomed ? " chalk-attachment-lightbox--zoomed" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={name}
      onClick={(e) => {
        // The backdrop closes. The picture does not: a click on it is either
        // the first half of a double-click (which zooms) or the end of a pan,
        // and closing on either would make both unusable.
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "IMG" || t.closest("button"))) return;
        onClose();
      }}
      onWheel={onWheel}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={(e) => endTouch(e, false)}
      onTouchCancel={(e) => endTouch(e, true)}
      data-testid="attachment-lightbox"
    >
      <button
        type="button"
        class="chalk-lightbox-close"
        onClick={onClose}
        aria-label="close"
        data-testid="lightbox-close"
      >
        ✕
      </button>
      {count > 1 && (
        <>
          <button
            type="button"
            class="chalk-lightbox-nav chalk-lightbox-nav--prev"
            onClick={() => go(-1)}
            disabled={index === 0}
            aria-label="previous image"
            data-testid="lightbox-prev"
          >
            ‹
          </button>
          <button
            type="button"
            class="chalk-lightbox-nav chalk-lightbox-nav--next"
            onClick={() => go(1)}
            disabled={index === count - 1}
            aria-label="next image"
            data-testid="lightbox-next"
          >
            ›
          </button>
        </>
      )}
      <div
        class={`chalk-lightbox-stage${dragX !== null ? " chalk-lightbox-stage--dragging" : ""}${settling ? " chalk-lightbox-stage--settling" : ""}`}
        style={dragX !== null ? `--chalk-lightbox-x:${dragX}px` : undefined}
      >
        {entry?.locked ? (
          <div class="chalk-lightbox-locked" data-testid="lightbox-locked">
            <span aria-hidden="true">🔒</span> locked attachment — key not available
          </div>
        ) : shownURL ? (
          <img
            ref={imgRef}
            class={`chalk-attachment-lightbox-img${entry?.full ? "" : " chalk-attachment-lightbox-img--preview"}`}
            src={shownURL}
            alt={name}
            draggable={false}
            // Only mid-zoom: a resting transform would pin the box for no
            // reason, and clampView already forces tx/ty to 0 at fit.
            style={
              view.scale !== 1
                ? `transform:translate(${view.tx}px,${view.ty}px) scale(${view.scale})`
                : undefined
            }
            onDblClick={onDoubleClick}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endPointer}
            onPointerCancel={endPointer}
            data-testid="lightbox-img"
          />
        ) : (
          <div class="chalk-lightbox-loading" data-testid="lightbox-loading">
            <span class="chalk-attachment-spinner" aria-hidden="true" /> decrypting…
          </div>
        )}
      </div>
      <div class="chalk-attachment-lightbox-caption" data-testid="lightbox-caption">
        <span class="chalk-lightbox-caption-inner">
        {count > 1 && (
          <span class="chalk-lightbox-counter">
            {index + 1} / {count}
          </span>
        )}
        {entry?.meta ? `${entry.meta.name} (${humanSize(entry.meta.size)})` : name}
        {zoomed
          ? coarse
            ? ` — ${view.scale.toFixed(1)}× · drag to move, pinch back to fit`
            : ` — ${view.scale.toFixed(1)}× · drag to pan, double-click to fit`
          : coarse
          ? count > 1
            ? " — swipe to page, pinch to zoom"
            : " — pinch to zoom, swipe right to close"
          : " — scroll or pinch to zoom, Esc to close"}
        </span>
      </div>
    </div>
  );
}
