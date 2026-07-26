// chalk-web -- typed-emoticon replacement (":)" -> an emoji), the way every
// Jabber/IRC client did it.
//
// The rule that keeps this from being annoying is the word boundary: an
// emoticon only counts when the character in front of it is whitespace or the
// start of the draft. Without that, "http:/" already ends with ":/" and every
// pasted URL turns into a confused face. With it, the only way to trigger a
// replacement is to actually type an emoticon as its own token.
//
// Tokens are matched longest-first so ">:(" beats ":(" and ":'(" beats ":(".
// Bare "8)" and "B)" are deliberately NOT in the table: "see step 8)" is far
// more common in a chat about software than a cool face, and the hyphenated
// forms cover the intent.

export interface Emoticon {
  text: string;
  emoji: string;
}

// Case matters: ":P" and ":p" are both listed rather than lowercasing the
// draft, because "XD" must not fire on the letters of a longer word and
// case-insensitive matching would make ":x" swallow ":X" style typos.
export const EMOTICONS: Emoticon[] = [
  { text: ":)", emoji: "😀" },
  { text: ":-)", emoji: "😀" },
  { text: "=)", emoji: "😀" },
  { text: ":D", emoji: "😃" },
  { text: ":-D", emoji: "😃" },
  { text: "=D", emoji: "😃" },
  { text: "XD", emoji: "😆" },
  { text: "xD", emoji: "😆" },
  { text: ";)", emoji: "😉" },
  { text: ";-)", emoji: "😉" },
  { text: ":(", emoji: "🙁" },
  { text: ":-(", emoji: "🙁" },
  { text: "=(", emoji: "🙁" },
  { text: ":'(", emoji: "😢" },
  { text: ">:(", emoji: "😠" },
  { text: ">:-(", emoji: "😠" },
  { text: ":@", emoji: "😡" },
  { text: ":P", emoji: "😛" },
  { text: ":-P", emoji: "😛" },
  { text: ":p", emoji: "😛" },
  { text: ":-p", emoji: "😛" },
  { text: ";P", emoji: "😜" },
  { text: ";p", emoji: "😜" },
  { text: ":o", emoji: "😮" },
  { text: ":O", emoji: "😮" },
  { text: ":-o", emoji: "😮" },
  { text: ":-O", emoji: "😮" },
  { text: ":|", emoji: "😐" },
  { text: ":-|", emoji: "😐" },
  { text: "-_-", emoji: "😑" },
  { text: ":/", emoji: "😕" },
  { text: ":-/", emoji: "😕" },
  { text: ":\\", emoji: "😕" },
  { text: ":-\\", emoji: "😕" },
  { text: ":S", emoji: "😖" },
  { text: ":-S", emoji: "😖" },
  { text: ":s", emoji: "😖" },
  { text: ":*", emoji: "😘" },
  { text: ":-*", emoji: "😘" },
  { text: ":x", emoji: "🤐" },
  { text: ":-x", emoji: "🤐" },
  { text: ":$", emoji: "😳" },
  { text: "8-)", emoji: "😎" },
  { text: "B-)", emoji: "😎" },
  { text: "^^", emoji: "😊" },
  { text: "^_^", emoji: "😊" },
  { text: "<3", emoji: "❤️" },
  { text: "</3", emoji: "💔" },
  { text: "o/", emoji: "👋" },
];

// Longest-first so a prefix token can never win over a longer one that also
// matches. Built once at module load.
const BY_LENGTH: Emoticon[] = [...EMOTICONS].sort((a, b) => b.text.length - a.text.length);

export interface EmoticonReplacement {
  value: string;
  caret: number;
  // The text that was swapped out, so the caller can offer an undo.
  text: string;
  emoji: string;
}

// replaceEmoticonBefore looks at the text immediately left of the caret and,
// if it ends in an emoticon standing on its own, returns the draft with that
// emoticon swapped for its emoji. Returns null when there is nothing to do.
// Pure, so the caret arithmetic is testable without a DOM.
export function replaceEmoticonBefore(
  value: string,
  caret: number,
): EmoticonReplacement | null {
  if (caret <= 0 || caret > value.length) return null;
  const left = value.slice(0, caret);
  for (const { text, emoji } of BY_LENGTH) {
    if (!left.endsWith(text)) continue;
    const start = caret - text.length;
    // The boundary rule. Also rejects a second emoticon typed straight onto
    // the first (":):)"), which is almost always a typo rather than intent.
    if (start > 0 && !/\s/.test(value[start - 1])) return null;
    return {
      value: value.slice(0, start) + emoji + value.slice(caret),
      caret: start + emoji.length,
      text,
      emoji,
    };
  }
  return null;
}
