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
// All crypto/transport goes through the AttachmentController; this component is
// pure rendering + object-URL lifecycle. No node test (DOM/observer heavy); the
// pipeline/controller it drives are covered by the round-trip tests.

import { useEffect, useRef, useState } from "preact/hooks";
import type { AttachmentController } from "../attachments/pipeline";
import { type AttachmentMeta, type AttachmentRef, humanSize } from "../attachments/types";

interface Props {
  channelID: string;
  att: AttachmentRef;
  controller: AttachmentController;
}

type LoadState = "loading" | "ready" | "locked";

export function AttachmentView({ channelID, att, controller }: Props) {
  const [meta, setMeta] = useState<AttachmentMeta | null>(null);
  const [metaState, setMetaState] = useState<LoadState>("loading");
  const [previewURL, setPreviewURL] = useState<string | null>(null);
  const [fullURL, setFullURL] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Track object URLs so we always revoke exactly what we created.
  const urlsRef = useRef<string[]>([]);

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
      const url = trackURL(URL.createObjectURL(new Blob([bytes], { type: meta.mime })));
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
        const url = trackURL(URL.createObjectURL(new Blob([bytes], { type: meta.mime })));
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

  // Lightbox: Escape closes it.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  // Lightbox: if the user opens an image whose full-res hasn't loaded yet
  // (e.g. an off-screen history image clicked before scrolling to it), fetch it
  // now so the modal shows the original rather than the soft preview.
  useEffect(() => {
    if (!expanded || fullURL || metaState !== "ready" || meta?.kind !== "image") return;
    let alive = true;
    void controller.loadFullBytes(channelID, att).then((bytes) => {
      if (!alive || !bytes) return;
      const url = trackURL(URL.createObjectURL(new Blob([bytes], { type: meta.mime })));
      setFullURL(url);
    });
    return () => {
      alive = false;
    };
  }, [expanded, fullURL, metaState, meta, channelID, att, controller]);

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
            style={meta.width ? { maxWidth: `min(${meta.width}px, 720px, 100%)` } : undefined}
            onClick={() => setExpanded(true)}
            data-testid="attachment-img"
          />
        ) : (
          <div class="chalk-attachment-img-placeholder" data-testid="attachment-img-placeholder" />
        )}
        {expanded && shownURL && (
          <div
            class="chalk-attachment-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={meta.name}
            onClick={() => setExpanded(false)}
            data-testid="attachment-lightbox"
          >
            <img
              class="chalk-attachment-lightbox-img"
              src={fullURL ?? shownURL}
              alt={meta.name}
            />
            <div class="chalk-attachment-lightbox-caption">
              {meta.name} ({humanSize(meta.size)}) — click anywhere or press Esc to close
            </div>
          </div>
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
