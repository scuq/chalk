// 57-4: the received link-preview card.
//
// Everything on the card comes from the E2E-encrypted message: the text from
// the sanitized payload, the thumbnail from the attachment the sender
// uploaded alongside (recognized by the "linkpreview." filename convention).
// Rendering costs ZERO network requests beyond what the attachment pipeline
// already does for any image attachment -- and the thumbnail only ever uses
// the inline preview bytes that ride in the ref, so not even a blob fetch.
//
// The card is sender-asserted content (title/description/thumb can lie), so
// the real destination host is always shown -- that line is the one thing a
// reader can trust before clicking.
//
// This component owns ALL of a preview message's attachments: the thumb goes
// inside the card, everything else renders as a normal attachment row below
// it (MessageList suppresses its own row for preview messages so the thumb
// can't double-render).

import { useEffect, useRef, useState } from "preact/hooks";
import type { AttachmentController } from "../attachments/pipeline";
import type { AttachmentRef } from "../attachments/types";
import type { LinkPreviewPayload } from "../linkpreview/linkpreview";
import { LINKPREVIEW_THUMB_PREFIX } from "../linkpreview/fetch";
import { AttachmentGroup } from "./AttachmentGroup";
import { asBytes } from "../crypto/bytes";

interface Props {
  payload: LinkPreviewPayload;
  channelID: string;
  attachments?: AttachmentRef[];
  controller?: AttachmentController;
}

export function LinkPreviewView({ payload, channelID, attachments, controller }: Props) {
  // null = metas still resolving; the card renders its text immediately and
  // the thumb / remaining attachments pop in when known.
  const [split, setSplit] = useState<{ thumb: AttachmentRef | null; rest: AttachmentRef[] } | null>(
    null,
  );
  const [thumbURL, setThumbURL] = useState<string | null>(null);
  const urlsRef = useRef<string[]>([]);

  useEffect(() => {
    const atts = attachments ?? [];
    if (!controller || atts.length === 0) {
      setSplit({ thumb: null, rest: atts });
      return;
    }
    let alive = true;
    void Promise.all(atts.map((att) => controller.decryptMeta(channelID, att))).then((metas) => {
      if (!alive) return;
      let thumb: AttachmentRef | null = null;
      const rest: AttachmentRef[] = [];
      atts.forEach((att, i) => {
        const meta = metas[i];
        if (
          thumb === null &&
          meta !== null &&
          meta.kind === "image" &&
          meta.name.startsWith(LINKPREVIEW_THUMB_PREFIX)
        ) {
          thumb = att;
        } else {
          rest.push(att);
        }
      });
      setSplit({ thumb, rest });
    });
    return () => {
      alive = false;
    };
  }, [attachments, channelID, controller]);

  // The thumb renders from the inline preview bytes only -- small, already in
  // the ref, no fetch. A locked key degrades to a text-only card.
  const thumbRef = split?.thumb ?? null;
  useEffect(() => {
    if (!thumbRef || !controller) return;
    let alive = true;
    void controller.loadPreviewBytes(channelID, thumbRef).then((bytes) => {
      if (!alive || !bytes) return;
      const url = URL.createObjectURL(new Blob([asBytes(bytes)]));
      urlsRef.current.push(url);
      setThumbURL(url);
    });
    return () => {
      alive = false;
    };
  }, [thumbRef, channelID, controller]);

  useEffect(
    () => () => {
      for (const u of urlsRef.current) URL.revokeObjectURL(u);
    },
    [],
  );

  return (
    <>
      <a
        class="chalk-linkpreview-card"
        href={payload.url}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="message-linkpreview"
      >
        {thumbURL && (
          <img class="chalk-linkpreview-thumb" src={thumbURL} alt="" draggable={false} />
        )}
        <span class="chalk-linkpreview-text">
          {payload.site_name !== "" && (
            <span class="chalk-linkpreview-site">{payload.site_name}</span>
          )}
          {payload.title !== "" && (
            <span class="chalk-linkpreview-title">{payload.title}</span>
          )}
          {payload.description !== "" && (
            <span class="chalk-linkpreview-desc">{payload.description}</span>
          )}
          <span class="chalk-linkpreview-host">{hostOf(payload.url)}</span>
        </span>
      </a>
      {/* 101-1: the leftover attachments group the same way as a plain
          message's -- extra images tile, files stay rows. */}
      {controller && split !== null && split.rest.length > 0 && (
        <div class="chalk-message-attachments" data-testid="message-attachments">
          <AttachmentGroup channelID={channelID} attachments={split.rest} controller={controller} />
        </div>
      )}
    </>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
