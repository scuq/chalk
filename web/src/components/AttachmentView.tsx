// chalk att-2 -- per-attachment feed renderer.
//
// Render strategy (spec S3):
//   * image kinds: paint the decrypted PREVIEW immediately (cheap, inline in
//     the ref). When the row scrolls into view (IntersectionObserver), fetch +
//     decrypt the FULL blob (cache-first) and swap it in. Click opens the full
//     image larger (a lightbox). Object URLs are minted from decrypted bytes
//     and revoked on unmount / swap.
//   * file kinds: a row with name + size + a download control (fetch + decrypt
//     + browser "save as" with the real filename).
//   * fail-closed: if the channel key isn't held (decrypt returns null), show a
//     "locked attachment" placeholder, never raw bytes.
//
// 110-1: the expanded view moved out to Lightbox.tsx, which shows a *set*.
// In a tile grid AttachmentGroup owns the gallery and passes `onOpen`, so a
// tile only reports which image was clicked; a lone image has no group above
// it and opens its own one-image gallery, which behaves exactly as before.
//
// All crypto/transport goes through the AttachmentController; this component is
// pure rendering + object-URL lifecycle. No node test (DOM/observer heavy); the
// pipeline/controller it drives are covered by the round-trip tests.

import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { AttachmentController } from "../attachments/pipeline";
import { type AttachmentMeta, type AttachmentRef, humanSize } from "../attachments/types";
import { asBytes } from "../crypto/bytes";
import { Lightbox } from "./Lightbox";

interface Props {
  channelID: string;
  att: AttachmentRef;
  controller: AttachmentController;
  /** 101-1: rendered as a grid tile -- the tile's CSS crop owns the box, so
   *  the inline natural-size style must stay off. Lightbox is unchanged. */
  tile?: boolean;
  /** 110-1: a group above us owns the gallery -- report the click instead of
   *  opening a lightbox of our own. */
  onOpen?: () => void;
}

type LoadState = "loading" | "ready" | "locked";

export function AttachmentView({ channelID, att, controller, tile, onOpen }: Props) {
  const [meta, setMeta] = useState<AttachmentMeta | null>(null);
  const [metaState, setMetaState] = useState<LoadState>("loading");
  const [previewURL, setPreviewURL] = useState<string | null>(null);
  const [fullURL, setFullURL] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Track object URLs so we always revoke exactly what we created.
  const urlsRef = useRef<string[]>([]);
  const closeLightbox = useCallback(() => setExpanded(false), []);

  const trackURL = (url: string): string => {
    urlsRef.current.push(url);
    return url;
  };

  // Decrypt meta once (drives both image + file rendering).
  useEffect(() => {
    let alive = true;
    setMetaState("loading");
    void controller.decryptMeta(channelID, att).then((m) => {
      if (!alive) return;
      setMeta(m);
      setMetaState(m ? "ready" : "locked");
    });
    return () => {
      alive = false;
    };
  }, [channelID, att, controller]);

  // Image kinds: decrypt the inline preview immediately (no network).
  useEffect(() => {
    if (metaState !== "ready" || meta?.kind !== "image") return;
    let alive = true;
    void controller.loadPreviewBytes(channelID, att).then((bytes) => {
      if (!alive || !bytes) return;
      const url = trackURL(URL.createObjectURL(new Blob([asBytes(bytes)], { type: meta.mime })));
      setPreviewURL(url);
    });
    return () => {
      alive = false;
    };
  }, [metaState, meta, channelID, att, controller]);

  // Image kinds: when the row scrolls into view, fetch+decrypt the full image
  // and swap it in over the preview.
  useEffect(() => {
    if (metaState !== "ready" || meta?.kind !== "image") return;
    const el = containerRef.current;
    if (!el) return;
    let alive = true;
    let fetched = false;

    const fetchFull = () => {
      if (fetched) return;
      fetched = true;
      void controller.loadFullBytes(channelID, att).then((bytes) => {
        if (!alive || !bytes) return;
        const url = trackURL(URL.createObjectURL(new Blob([asBytes(bytes)], { type: meta.mime })));
        setFullURL(url);
      });
    };

    // IntersectionObserver may be unavailable in some embedded webviews;
    // fall back to fetching eagerly so the image still upgrades.
    if (typeof IntersectionObserver === "undefined") {
      fetchFull();
      return () => {
        alive = false;
      };
    }

    // If the row is ALREADY on-screen at mount (the common case for a message
    // you just sent, which lands at the bottom of the feed), fetch the full
    // image immediately rather than waiting on the observer's first callback --
    // that callback isn't reliably delivered for an element that's visible
    // before the observer attaches, which would otherwise strand it on the
    // blurred preview.
    const nearViewport = (): boolean => {
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      const m = 200; // mirror the observer's rootMargin
      return r.bottom >= -m && r.top <= vh + m && r.right >= -m && r.left <= vw + m;
    };
    if (nearViewport()) {
      fetchFull();
      return () => {
        alive = false;
      };
    }

    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            fetchFull();
            obs.disconnect();
            break;
          }
        }
      },
      { rootMargin: "200px" },
    );
    obs.observe(el);
    return () => {
      alive = false;
      obs.disconnect();
    };
  }, [metaState, meta, channelID, att, controller]);

  // Revoke every object URL we minted on unmount.
  useEffect(() => {
    return () => {
      for (const u of urlsRef.current) URL.revokeObjectURL(u);
      urlsRef.current = [];
    };
  }, []);

  const onDownload = () => {
    if (downloading) return;
    setDownloading(true);
    void controller.download(channelID, att).finally(() => setDownloading(false));
  };

  if (metaState === "loading") {
    return (
      <div class="chalk-attachment chalk-attachment--loading" data-testid="attachment-loading">
        <span class="chalk-attachment-spinner" aria-hidden="true" />
        <span class="chalk-attachment-label">decrypting attachment…</span>
      </div>
    );
  }

  if (metaState === "locked" || !meta) {
    // Fail-closed: key not available -> never show bytes.
    return (
      <div class="chalk-attachment chalk-attachment--locked" data-testid="attachment-locked">
        <span class="chalk-attachment-lock" aria-hidden="true">🔒</span>
        <span class="chalk-attachment-label">locked attachment — key not available</span>
      </div>
    );
  }

  if (meta.kind === "image") {
    const shownURL = fullURL ?? previewURL;
    // 33-5: one box size shared by the placeholder and the image itself, so
    // the swap costs no layout. Without it the placeholder's fixed 200x120
    // grew to a full-width screenshot the moment the preview decrypted,
    // shoving the feed down under whoever was reading it.
    const imageBox =
      meta.width && meta.height
        ? {
            width: "100%",
            maxWidth: `min(${meta.width}px, 720px, 100%)`,
            aspectRatio: `${meta.width} / ${meta.height}`,
          }
        : meta.width
        ? { maxWidth: `min(${meta.width}px, 720px, 100%)` }
        : undefined;
    return (
      <div
        class="chalk-attachment chalk-attachment--image"
        data-testid="attachment-image"
        ref={containerRef}
      >
        {shownURL ? (
          <img
            class={`chalk-attachment-img ${fullURL ? "chalk-attachment-img--full" : "chalk-attachment-img--preview"}`}
            src={shownURL}
            alt={meta.name}
            title={`${meta.name} (${humanSize(meta.size)}) — click to enlarge`}
            // Never upscale past the image's real pixel width: cap at the
            // smallest of natural width, 720px, and the column width (responsive).
            //
            // 33-5: when both dimensions are known the box is sized before
            // the bytes decode (see imageBox). width:100% doesn't enlarge
            // anything -- max-width already caps at the natural width.
            // 101-1: in a tile the grid cell is the box; cover-crop via CSS.
            style={tile ? undefined : imageBox}
            onClick={() => (onOpen ? onOpen() : setExpanded(true))}
            // 64-9: with the CSS -webkit-user-drag opt-out, keeps a drag
            // that starts on the picture from stealing the swipe-back touch.
            draggable={false}
            data-testid="attachment-img"
          />
        ) : (
          <div
            class="chalk-attachment-img-placeholder"
            data-testid="attachment-img-placeholder"
            style={tile ? undefined : imageBox}
          />
        )}
        {expanded && (
          <Lightbox
            channelID={channelID}
            images={[att]}
            index={0}
            controller={controller}
            onIndex={() => undefined}
            onClose={closeLightbox}
          />
        )}
      </div>
    );
  }

  // File kind: name + size + download.
  return (
    <div class="chalk-attachment chalk-attachment--file" data-testid="attachment-file">
      <span class="chalk-attachment-file-icon" aria-hidden="true">📎</span>
      <span class="chalk-attachment-file-name" title={meta.name}>
        {meta.name}
      </span>
      <span class="chalk-attachment-file-size">{humanSize(meta.size)}</span>
      <button
        type="button"
        class="chalk-attachment-download"
        onClick={onDownload}
        disabled={downloading}
        data-testid="attachment-download"
      >
        {downloading ? "…" : "download"}
      </button>
    </div>
  );
}
