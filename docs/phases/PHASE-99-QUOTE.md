# Phase 99 — quoting a message

**Status:** shipped. 99-1 the rules, 99-2 the render, 99-3 the action, 99-4
this record. Nothing left open beyond [Left open](#left-open).

**Tag:** `#quote` → `tools/where.sh -g quote`.

## The problem

A message answers an older one and nothing on screen says which. chalk's row
menu offers *react*, *reply in thread*, *copy text*, *edit* and *delete* —
five actions, none of which is "answer this here, in the channel, so everyone
can see what I am answering". Thread replies exist, but a thread is a
different gesture: it moves the exchange out of the feed into a side panel,
with its own read cursor and its own inbox. Sometimes the answer belongs in
the room.

The universal fix is quoting, and chalk did not have it — not by oversight but
by two written decisions:

- Phase 77 (*nano markdown*) restricted itself to three inline marks and no
  block construct, on the grounds that "headings, lists, quotes and link
  syntax" are each "a way for a message to restructure someone else's screen".
- Phase 86 (*ties*, designed but never built) rejected quoting outright: "the
  duplicated body breaks the reading flow… a channel where quoting catches on
  is twice as long as the conversation in it."

Both are reasonable and neither survived contact with wanting the feature. See
[What changed about 77 and 86](#what-changed-about-77-and-86).

## The design

Two halves that meet in the middle at a run of `> ` lines, and are otherwise
independent.

**Composing.** The row menu gains **quote**. Picking it splices the message
into the composer as an attribution line plus the body, every line prefixed
with `> `, followed by a blank line with the caret on it.

```
> alice wrote:
> the deploy script still points at staging
> can someone check?

█
```

**Reading.** With nano markdown on, a run of `> ` lines renders as an indented
block with a left rule. With it off — the default — the reader sees the literal
`> ` characters, which is still perfectly legible as a quote. That is not a
degraded mode; it is the same asymmetry phase 77 built the pref around.

### The send side is a paste, not a transformation

This is the load-bearing distinction. `buildQuote` runs **once, on a user
action**, and what it produces is ordinary draft text: visible in the box,
editable, deletable, and sent verbatim. Nothing rewrites the message at send
time, the composer still previews nothing, and the wire still carries exactly
the characters that were in the field. Phase 77's rule — "what you typed is
never touched" — is intact, because the `> ` was typed, by a button, on your
behalf, into a box you can see.

### Attribution, not a timestamp

The first quoted line is `> alice wrote:`. A timestamp was considered and
dropped: rendering one needs `display_.timestampFormat`, which is the
*reader's* pref, and the quote travels to people whose clock format is not
yours. A name is portable; `14:02` is a claim about a clock the recipient does
not share.

Falling back is the row's own logic: your own messages quote as your handle
(or `you`), and a purged sender quotes as the device-id slice the feed already
shows. There is one `senderLabelOf` in `MessageList.tsx` now, and the menu, the
row and the sender-column measurement all call it — the expression used to
exist twice and this would have made three.

### One toggle, not two

The block construct rides the existing `nanoMarkdown` pref rather than getting
its own. A second checkbox would ask the reader a question they have no basis
to answer ("do you want *some* of the markdown?") and would double the state
the renderer branches on. The pref's hint text and its `settings-nav.ts`
keywords change to name quotes; "three markers and nothing more" is retired
as the pref's description.

### The marker is strict

A quote line starts with `>` **at column 0**. Real markdown tolerates up to
three leading spaces; this does not, deliberately. `buildQuote` never emits
them, so nothing round-trips worse, and accepting them means an indented line
someone typed as prose silently becomes a quote for readers with the pref on
and stays prose for everyone else — exactly the kind of split-brain rendering
the per-reader pref is supposed to make harmless.

One level is `>` plus at most one following space, and the space is consumed.
So quoting a quote produces `> > alice wrote:` and nests, rather than leaving a
stray marker in the text.

### Caps, re-applied on parse

- `QUOTE_MAX_DEPTH = 4` — deeper `>` runs stay literal. Applied when
  *reading*, not only when writing: the sender's bytes do not get to decide how
  many nested elements we put in the DOM. Same reasoning as the link-preview
  cap re-applied at `web/src/linkpreview/linkpreview.ts:121-123`.
- `QUOTE_MAX_LINES = 12`, `QUOTE_MAX_CHARS = 800` — a quote of a 4000-character
  message would fill the composer's own `MAX_LEN` and leave no room for the
  answer. Past either cap the quote stops and says so with a final `> …`.

### Rejected

- **A `>` that tolerates leading whitespace.** Above.
- **A separate "quoted lines" pref.** Above.
- **Markdown escapes**, so a sender could write a literal `>` at column 0.
  Still out, for phase 77's R5 reason: the pref defaults off, so a `\>` typed
  by a sender is a stray backslash to the majority who never turned rendering
  on. A line that must start with a literal `>` can start with a space.
- **Rendering the attribution line specially** (a caption, a different
  weight). It is one of the quoted lines and behaves like one. Anything else
  means parsing our own output back out of a message that anybody could have
  typed by hand.
- **A `<blockquote>` element.** The body container is
  `<span class="chalk-message-body">`; the quote is a `span` with
  `display: block` so the inline tree stays valid.

## Slices

- **99-1 — the rules, pure.** `web/src/chat/quote.ts` + `quote.test.ts`:
  `buildQuote`, `quoteDepth`, `stripQuote`, `splitQuoteRuns`, `hasQuoteLine`
  and the four caps. No wire, no UI, no DOM.
- **99-2 — the render.** `splitBodyBlocks` in `chat/nanomd.ts` as a layer
  *above* the existing inline scan, `MessageBody` rendering blocks,
  `.chalk-body-quote`, and the pref copy.
- **99-3 — the action.** The menu item, `onQuoteMessage`, the composer's
  `quote` prop, and the `App`/`ThreadPanel` wiring. First slice a user can
  see, so the `CHANGELOG.md` bullets land here.
- **99-4 — the record.** This doc finished, the notes on 77 and 86,
  `docs/tags.md`, `docs/phase-log.md`, `docs/open-items.md`.

## Where it lives

`web/src/chat/quote.ts` (and `quote.test.ts`), `web/src/chat/nanomd.ts`,
`web/src/chat/message-menu.ts`, `web/src/components/MessageList.tsx`,
`web/src/components/MessageMenu.tsx`, `web/src/components/Composer.tsx`,
`web/src/components/App.tsx`, `web/src/components/ThreadPanel.tsx`,
`web/src/components/ProfilePanel.tsx`, `web/src/settings-nav.ts`,
`web/src/theme.css`.

**No server change.** A quote is ordinary message text — no migration, no wire
frame, nothing under `internal/`, no new `CHALK_*` env var.

## What changed about 77 and 86

Both phase docs carried claims this contradicts, and both have been corrected
in place rather than left standing.

**Phase 77** said "no headings, lists, quotes or link syntax, because each of
those is a way for a message to restructure someone else's screen". That
argument holds for the other three and does not hold for a quote. A heading
resizes text; a list renumbers and re-indents; link syntax hides where a link
goes. A quote indents a run of lines that were already there, in the order they
were already in, and removes nothing — the worst a malicious sender achieves is
a left rule beside their own words. It is also the one construct chat actually
uses, which the other three are not.

**Phase 86** (*ties*) opens "chalk is not doing that" about quoting. It is now.
Ties remain a live design and were not retired: a tie says *which message this
belongs to* across hundreds of rows of scrollback, without reprinting anything,
and a quote cannot do that — it can only carry a copy of what is near enough to
find. What changed is the framing. 86 was written as *the alternative to*
quoting; it is now a complement to it, and its "the paper is quoting; chalk is
not doing that" passage reads as a comparison rather than a decision. Its
status is unchanged: planned, not started.

## Left open

- **The `(edited)` marker after a trailing quote.** A body that *ends* in a
  quote block puts `(edited)` on the line below rather than trailing the text,
  because the block element ends the line. Accepted rather than worked around;
  the alternatives are floating the marker (which then overlaps a wrapped
  quote) or making the last block inline (which loses the rule).
- **Quoting an attachment or a reaction.** Neither is text, so neither is
  quotable; the menu item is simply absent on a row with nothing to say.
- **No quote in search.** `searchableText` sees the `> ` characters as part of
  the body, so searching for a phrase finds both the original and every quote
  of it. That is arguably right and definitely untested.

## Verification

The full chain — `go build ./... && go vet ./... && gofmt -l .`,
`go test ./...`, and from `web/`: `npx tsc --noEmit`, `node test.mjs`,
`node build.mjs`.

**Ran live**, three users (two desktop, one on an iPhone 14 profile) in one
channel, through the `run-chalk` skill, 9 August 2026 — 11 checks, no page
errors:

- The row menu offers **quote**, and the draft it produces starts
  `> alice wrote:` with every line prefixed and a blank line under it.
- With the pref **off** the sent message shows the literal `> ` characters;
  turning it **on** renders the same message as a quote block and the markers
  disappear from the text.
- Quoting a quote produces `> > ` and renders two nested levels.
- Splicing into a half-written draft keeps what was already typed.
- On the phone the block renders with its rule inside the narrow body column,
  and **quote** is reachable from the touch row menu.

Two frames were captured for the pull request: the desktop one with rendered
quotes in the feed and a live quote sitting in the composer, and the phone
one. They are **not** in `docs/screenshots/` — those three are the README's
and `readme-shots.mjs` regenerates them together.

Still unexercised by any run: the gif and snippet menu gates (asserted in
`quote.test.ts` instead), and the `(edited)` placement under
[Left open](#left-open).
