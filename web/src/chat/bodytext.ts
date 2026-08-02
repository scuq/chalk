// 74-4: what a decrypted body means when something other than the message
// list is looking at it.
//
// A body is a bare string, but three features smuggle structure into it
// behind a U+0001 sentinel (giphy, link previews, code). Anything that treats
// a body as prose has to unwrap that framing first, or it works on JSON and
// control characters: `@alice` inside a pasted snippet would ping alice, and
// "copy message" would put the marker on the clipboard.
//
// Two questions, two functions, because the right answer differs:
//   messageText   -- "what did this person actually SAY?" Rider content is
//                    not speech, so it drops out entirely.
//   clipboardText -- "what did they mean to hand me?" The rider IS the point
//                    of the message, so it comes along.
//
// previewText (chat/zucker.ts) and searchableText (chat/search.ts) stay
// separate: a row preview needs a placeholder for an empty result, and search
// wants to match the code and the preview metadata too.

import { parseGiphyBody } from "../giphy/giphy";
import { parseLinkPreviewBody } from "../linkpreview/linkpreview";
import { parseCodeBody } from "../code/code";

// messageText returns the human-written text of a body -- the caption of a
// rider message, or the whole body when there is no rider. A giphy message
// has no text at all, so it yields "".
//
// Used by the mention and notification-sound paths, where the distinction is
// load-bearing: an @handle inside a pasted snippet or a preview's JSON is not
// somebody addressing you.
export function messageText(body: string): string {
  const code = parseCodeBody(body);
  if (code) return code.text;
  const lp = parseLinkPreviewBody(body);
  if (lp) return lp.text;
  if (parseGiphyBody(body)) return "";
  return body;
}

// clipboardText returns what "copy message" should put on the clipboard: the
// snippet for a code message (not the caption -- the snippet is what anyone
// copying it wants), the URL for a giphy, and the caption for a preview.
export function clipboardText(body: string): string {
  const code = parseCodeBody(body);
  if (code) return code.payload.code;
  const giphy = parseGiphyBody(body);
  if (giphy) return giphy.url;
  const lp = parseLinkPreviewBody(body);
  if (lp) return lp.text !== "" ? lp.text : lp.preview.url;
  return body;
}
