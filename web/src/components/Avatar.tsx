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

import type { AttachmentController } from "../attachments/pipeline";
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
}

export function Avatar({
  channelID,
  attachmentID,
  controller,
  alt,
  size = "line",
  reserve = false,
}: Props) {
  const url = useAvatarURL(channelID, attachmentID, controller);

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
      alt={alt ?? ""}
      loading="lazy"
      draggable={false}
    />
  );
}
