// chalk 111-9 -- the banner editor.
//
// Why a dialog and not more rows in the channel menu: the menu is a list of
// one-click actions beside a sidebar row, and framing a picture is not a
// one-click action. It needs to show you the result while you change it --
// the whole point of a focal point or a zoom is that you cannot predict the
// crop, you have to see it. So the editor is a preview with controls under
// it, and the preview is the real band (BannerBand), not a drawing of one.
//
// It opens two ways (111-9):
//   * straight after picking a file, before anything is saved. The upload has
//     happened by then -- the blob is encrypted and stored, but no channel
//     row points at it, so cancelling leaves an orphan and changes nothing
//     anyone can see.
//   * from the menu's "edit" row, on the picture already pinned.
//
// Nothing is written until Save, which sends one update_channel carrying the
// whole layout. Cancel sends nothing at all.
//
// 111-13: it has a second view. The controls here frame the picture -- they
// choose what the band shows of it -- and none of them change the picture.
// Cropping does, so it gets its own screen (BannerCropper) showing the whole
// image, and applying one uploads the cropped picture as a new attachment.
// The pre-crop picture is held for as long as the dialog is open, so "revert"
// undoes a crop that turned out wrong without a re-upload.
//
// The focal point is dragged on the preview itself rather than set with two
// number fields, because "which part of this picture do I keep" is a question
// about the picture. It only does anything when the band actually crops --
// fill always, fit only once zoomed past the band -- so the drag surface says
// so rather than pretending.

import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { AttachmentController } from "../attachments/pipeline";
import { useBannerImage } from "../attachments/use-banner-image";
import {
  type BannerBleed,
  type BannerFit,
  type BannerHeight,
  type BannerLayout,
  ZOOM_MAX,
  ZOOM_MIN,
} from "../state/banner";
import type { CropRect } from "../attachments/crop";
import { cropImage } from "../attachments/crop";
import { BannerBand } from "./BannerBand";
import { BannerCropper } from "./BannerCropper";

interface Props {
  channelID: string;
  /** the layout being edited: the channel's, or the freshly uploaded one */
  initial: BannerLayout;
  /** a local object URL for a just-picked file; without it the picture is
   *  resolved from the attachment id like the header does */
  localURL?: string | null;
  controller: AttachmentController;
  /** true when this opened straight after an upload -- the wording changes,
   *  and cancelling means the picture was never pinned */
  fresh?: boolean;
  /** 111-13: upload a cropped picture and hand back what it became. The
   *  editor never talks to the network itself -- App holds the channel
   *  crypto, exactly as it does for the first upload. */
  onUpload: (file: File) => Promise<{ id: string; url: string }>;
  onSave: (layout: BannerLayout) => void;
  onCancel: () => void;
}

const FITS: { value: BannerFit; label: string; hint: string }[] = [
  { value: "fill", label: "fill", hint: "crop the picture to span the whole band" },
  { value: "fit", label: "fit", hint: "show all of it, centred, and fill the sides" },
  {
    value: "poster",
    label: "poster",
    hint: "box art at one end, colour across the rest — for pictures taller than they are wide",
  },
];

const HEIGHTS: { value: BannerHeight; label: string }[] = [
  { value: "short", label: "short" },
  { value: "normal", label: "normal" },
  { value: "tall", label: "tall" },
];

const BLEEDS: { value: BannerBleed; label: string; hint: string }[] = [
  { value: "wash", label: "colour", hint: "an even wash of the picture's own colours" },
  { value: "blur", label: "blur", hint: "a blurred blow-up of the picture behind it" },
  { value: "none", label: "plain", hint: "nothing but the theme background" },
];

export function BannerEditor({
  channelID,
  initial,
  localURL,
  controller,
  fresh = false,
  onUpload,
  onSave,
  onCancel,
}: Props) {
  const [layout, setLayout] = useState<BannerLayout>(initial);
  const dragging = useRef(false);
  const previewRef = useRef<HTMLDivElement | null>(null);
  // 111-13: the cropper's screen, and what it produced. `cropped` holds the
  // picture a crop made; `preCrop` is what it replaced, so revert is a swap
  // rather than an upload.
  const [cropping, setCropping] = useState(false);
  const [cropBusy, setCropBusy] = useState(false);
  const [cropError, setCropError] = useState<string | null>(null);
  const [cropped, setCropped] = useState<{ id: string; url: string } | null>(null);
  const [preCrop, setPreCrop] = useState<{ id: string; url: string | null } | null>(null);

  // A fresh upload already has its bytes in hand; an edit resolves them the
  // way the header does. Calling the hook either way keeps the hook order
  // stable -- it simply has nothing to do when a local URL was passed.
  const resolvedID = cropped ? "" : localURL ? "" : layout.attachmentID;
  const resolved = useBannerImage(channelID, resolvedID, controller);
  const url = cropped?.url ?? localURL ?? resolved.url;

  // Cropping needs the decoded pixels of whatever is on screen now, so a
  // second crop crops the first one's result.
  const applyCrop = async (rect: CropRect) => {
    if (!url) return;
    setCropBusy(true);
    setCropError(null);
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("could not read that image"));
        img.src = url;
      });
      const file = await cropImage(img, rect);
      const up = await onUpload(file);
      setPreCrop({ id: layout.attachmentID, url: cropped?.url ?? localURL ?? resolved.url });
      setCropped(up);
      setLayout((l) => ({ ...l, attachmentID: up.id }));
      setCropping(false);
    } catch (err) {
      setCropError(err instanceof Error ? err.message : "crop failed");
    } finally {
      setCropBusy(false);
    }
  };

  const set = (patch: Partial<BannerLayout>) => setLayout((l) => ({ ...l, ...patch }));

  // Esc closes without saving, the same as every other chalk dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  // The drag: a pointer anywhere on the preview names the point of the
  // picture that should stay visible. Clamped to the band, so letting go
  // outside it still lands on a legal value.
  const focusFromEvent = useCallback((e: PointerEvent) => {
    const el = previewRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    const x = Math.round(((e.clientX - box.left) / box.width) * 100);
    const y = Math.round(((e.clientY - box.top) / box.height) * 100);
    set({
      focusX: Math.min(100, Math.max(0, x)),
      focusY: Math.min(100, Math.max(0, y)),
    });
  }, []);

  // Dragging only means something while something is cropped: fill always
  // crops (the band is wider than any picture is short), fit only once zoom
  // has pushed the picture past the band, and poster never -- showing the
  // art whole is the entire point of that shape.
  const poster = layout.fit === "poster";
  const framesCrop = !poster && (layout.fit === "fill" || layout.zoom > 100);

  return (
    <div
      class="chalk-modal-backdrop"
      data-testid="banner-editor-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        class="chalk-modal chalk-modal--wide chalk-banner-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="banner-editor-title"
        data-testid="banner-editor"
      >
        <header class="chalk-modal-header">
          <h2 id="banner-editor-title">{fresh ? "pin an image" : "channel image"}</h2>
          <button
            type="button"
            class="chalk-modal-close"
            aria-label="close"
            data-testid="banner-editor-close"
            onClick={onCancel}
          >
            ×
          </button>
        </header>

        <div class="chalk-modal-body">
        {cropping && url ? (
          <BannerCropper
            url={url}
            busy={cropBusy}
            onApply={(rect) => void applyCrop(rect)}
            onCancel={() => setCropping(false)}
          />
        ) : (
          <>
        {/* The preview is the real band, at the real height, so what is
            agreed here is what every member sees. */}
        <div
          ref={previewRef}
          class={`chalk-banner-editor-preview ${framesCrop ? "chalk-banner-editor-preview--draggable" : ""}`}
          data-testid="banner-editor-preview"
          onPointerDown={(e) => {
            if (!framesCrop) return;
            dragging.current = true;
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            focusFromEvent(e as unknown as PointerEvent);
          }}
          onPointerMove={(e) => {
            if (!dragging.current) return;
            focusFromEvent(e as unknown as PointerEvent);
          }}
          onPointerUp={(e) => {
            dragging.current = false;
            (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
        >
          {url ? (
            <BannerBand url={url} layout={layout} variant="preview" />
          ) : (
            <div class="chalk-banner-editor-loading" data-testid="banner-editor-loading">
              decrypting…
            </div>
          )}
        </div>
        <p class="chalk-profile-hint">
          {poster
            ? "the art is shown whole at one end, with its colours across the rest."
            : framesCrop
              ? "drag the picture to choose what stays in the band."
              : "the whole picture fits, so there is nothing to crop — zoom in to reframe it."}
        </p>

        <div class="chalk-banner-editor-controls">
          <div class="chalk-banner-editor-row">
            <span class="chalk-banner-editor-label">shape</span>
            <span class="chalk-nick-menu-seg">
              {FITS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  class={`chalk-nick-menu-btn ${layout.fit === f.value ? "chalk-nick-menu-btn--on" : ""}`}
                  data-testid={`banner-editor-fit-${f.value}`}
                  aria-pressed={layout.fit === f.value}
                  title={f.hint}
                  onClick={() => set({ fit: f.value })}
                >
                  {f.label}
                </button>
              ))}
            </span>
          </div>

          <div class="chalk-banner-editor-row">
            <span class="chalk-banner-editor-label">height</span>
            <span class="chalk-nick-menu-seg">
              {HEIGHTS.map((h) => (
                <button
                  key={h.value}
                  type="button"
                  class={`chalk-nick-menu-btn ${layout.height === h.value ? "chalk-nick-menu-btn--on" : ""}`}
                  data-testid={`banner-editor-height-${h.value}`}
                  aria-pressed={layout.height === h.value}
                  onClick={() => set({ height: h.value })}
                >
                  {h.label}
                </button>
              ))}
            </span>
          </div>

          {!poster && (
          <div class="chalk-banner-editor-row">
            <span class="chalk-banner-editor-label">zoom</span>
            <input
              type="range"
              class="chalk-banner-editor-range"
              min={ZOOM_MIN}
              max={ZOOM_MAX}
              step={5}
              value={layout.zoom}
              data-testid="banner-editor-zoom"
              aria-label="zoom"
              onInput={(e) => set({ zoom: Number((e.target as HTMLInputElement).value) })}
            />
            <span class="chalk-banner-editor-value" data-testid="banner-editor-zoom-value">
              {layout.zoom}%
            </span>
            {layout.zoom !== 100 && (
              <button
                type="button"
                class="chalk-nick-menu-btn"
                data-testid="banner-editor-zoom-reset"
                title="back to 100%"
                onClick={() => set({ zoom: 100 })}
              >
                reset
              </button>
            )}
          </div>
          )}

          {/* 111-13: the picture itself, as opposed to how it sits. Crop is
              the one control here that changes what everyone downloads, so
              it is a screen of its own and a revert away from permanent. */}
          <div class="chalk-banner-editor-row">
            <span class="chalk-banner-editor-label">picture</span>
            <button
              type="button"
              class="chalk-nick-menu-btn"
              data-testid="banner-editor-crop"
              disabled={!url || cropBusy}
              title="cut away part of the picture"
              onClick={() => {
                setCropError(null);
                setCropping(true);
              }}
            >
              crop
            </button>
            {preCrop && (
              <button
                type="button"
                class="chalk-nick-menu-btn"
                data-testid="banner-editor-uncrop"
                title="back to the picture before the crop"
                onClick={() => {
                  setCropped(null);
                  setLayout((l) => ({ ...l, attachmentID: preCrop.id }));
                  setPreCrop(null);
                }}
              >
                revert
              </button>
            )}
            {cropError && (
              <span class="chalk-nick-menu-hint" data-testid="banner-editor-crop-error">
                {cropError}
              </span>
            )}
          </div>

          {/* Only the shapes that leave room beside the picture have sides
              to fill; in fill mode the row would control nothing. */}
          {(layout.fit === "fit" || poster) && (
            <div class="chalk-banner-editor-row">
              <span class="chalk-banner-editor-label">sides</span>
              <span class="chalk-nick-menu-seg">
                {BLEEDS.map((b) => (
                  <button
                    key={b.value}
                    type="button"
                    class={`chalk-nick-menu-btn ${layout.bleed === b.value ? "chalk-nick-menu-btn--on" : ""}`}
                    data-testid={`banner-editor-bleed-${b.value}`}
                    aria-pressed={layout.bleed === b.value}
                    title={b.hint}
                    onClick={() => set({ bleed: b.value })}
                  >
                    {b.label}
                  </button>
                ))}
              </span>
            </div>
          )}
        </div>
          </>
        )}
        </div>

        {!cropping && (
        <footer class="chalk-modal-footer">
          <button
            type="button"
            class="chalk-button"
            data-testid="banner-editor-cancel"
            onClick={onCancel}
          >
            cancel
          </button>
          <button
            type="button"
            class="chalk-button chalk-button--primary"
            data-testid="banner-editor-save"
            disabled={!url}
            onClick={() => onSave(layout)}
          >
            {fresh ? "pin it" : "save"}
          </button>
        </footer>
        )}
      </div>
    </div>
  );
}
