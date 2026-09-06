// chalk 112-3 -- the hook every surface that draws a picture uses.
//
// Thin on purpose: the work and the caching live in the store, and this is
// what turns "a resolution landed" into a render. A component asks for one
// attachment id and gets a URL or nothing; it never learns about refs, keys,
// or the fetch.

import { useEffect, useState } from "preact/hooks";
import type { AttachmentController } from "../attachments/pipeline";
import { peekAvatar, resolveAvatar, subscribeAvatars } from "./store";

/**
 * useAvatarURL resolves one picture. Returns null while it is loading, and
 * null forever if it cannot be had -- callers draw nothing in both cases,
 * because a broken-picture icon in a message row is worse than no picture.
 */
export function useAvatarURL(
  channelID: string,
  attachmentID: string | null | undefined,
  controller: AttachmentController | null,
): string | null {
  const [, bump] = useState(0);

  // Re-render when any picture resolves. One subscription per component that
  // draws an avatar is cheap: the callback is a counter bump, and the set is
  // walked only when a decrypt actually finishes.
  useEffect(() => subscribeAvatars(() => bump((n) => n + 1)), []);

  useEffect(() => {
    if (!attachmentID || !controller) return;
    if (peekAvatar(attachmentID) !== undefined) return;
    void resolveAvatar(controller, channelID, attachmentID);
  }, [channelID, attachmentID, controller]);

  if (!attachmentID) return null;
  return peekAvatar(attachmentID) ?? null;
}
