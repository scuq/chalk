// chalk 112-3 -- one profile picture, drawn wherever one belongs.
//
// The rule this component exists to keep: in the feed it must not cost a
// pixel of vertical space. The box is 1em square and vertically centred in a
// line box that is 1.4em tall, so it cannot make a row taller than the text
// already does. Every other surface passes a size and gets the same square.
//
// A member with no picture still gets the box in the feed -- empty, same
// width -- because otherwise names sit at different indents down the column
// and the feed looks broken. Whether the column has the slot at all is the
// caller's decision (MessageList only reserves it when someone in the channel
// has a picture), so a channel where nobody has one looks exactly as it did
// before 112.
//
// 115-6: the frame. A picture can carry data-frame="<style>", the wearer's
// choice, read from the directory by userID (or handed in as `frame` where
// the caller knows better -- your own, which the directory omits). It is
// drawn by CSS on the <img> itself -- outline, box-shadow, filter -- and only
// under data-flair-frames on <html>, so a reader with flair off sees a plain
// square. Never at the feed's line size: 112's rule stands, and a ring on a
// 1em box down every line is noise, not decoration. 115-7: and it moves only
// while the wearer is online (`live`, data-live) -- a ring that keeps
// glowing around someone who has gone says the wrong thing.

import type { AttachmentController } from "../attachments/pipeline";
import { useAvatarFrame } from "../auth/display-names";
import { normalizeFrame } from "../avatars/frames";
import { useAvatarURL } from "../avatars/use-avatar";

interface Props {
  channelID: string;
  /** the member's picture in this channel, or null/"" for none */
  attachmentID?: string | null;
  controller: AttachmentController | null;
  /** what the picture is of, for screen readers; decorative when omitted */
  alt?: string;
  /** feed: one line tall. roster/members: a fixed small box. card/tile:
   *  whatever the surface passes. */
  size?: "line" | "row" | "card" | "tile";
  /** keep the empty box when there is no picture, so a column stays straight */
  reserve?: boolean;
  /** 115-6: whose picture, for the frame lookup */
  userID?: string;
  /** 115-6: the frame, when the caller knows it (your own); wins over the lookup */
  frame?: string;
  /** 115-7: is this person online right now? A frame moves only while they
   *  are; a surface that cannot know leaves it out and the ring stays still. */
  live?: boolean;
}

export function Avatar({
  channelID,
  attachmentID,
  controller,
  alt,
  size = "line",
  reserve = false,
  userID,
  frame,
  live = false,
}: Props) {
  const url = useAvatarURL(channelID, attachmentID, controller);
  // Called unconditionally (hooks), ignored for the feed line.
  const looked = useAvatarFrame(frame === undefined ? userID : undefined);
  const drawn = size === "line" ? "" : normalizeFrame(frame ?? looked);

  if (!url) {
    if (!reserve) return null;
    return (
      <span
        class={`chalk-avatar chalk-avatar--${size} chalk-avatar--empty`}
        data-testid="avatar-empty"
        aria-hidden="true"
      />
    );
  }
  return (
    <img
      src={url}
      class={`chalk-avatar chalk-avatar--${size}`}
      data-testid="avatar"
      data-frame={drawn || undefined}
      data-live={drawn && live ? "" : undefined}
      alt={alt ?? ""}
      loading="lazy"
      draggable={false}
    />
  );
}
