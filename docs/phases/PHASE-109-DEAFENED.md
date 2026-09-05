# Phase 109 — the room can see you are deafened

**Status:** built, 109-1 (2026-09-05). Unreleased.
**Tags:** `#voice` → `tools/where.sh -g voice`

## Why

Deafening has been local since 41-5. The dock's `AudioSinks` read a flag, every
remote track goes silent, and — because staying audible in a conversation you
have stopped listening to is worse than being off entirely — you are muted with
it. Nothing was signaled: `toggleDeafen`'s comment said so outright, on the
reasoning that no peer needs to *act* on it.

That reasoning holds and is unchanged. What it missed is that the room still
sees something, just the wrong thing. The self-mute goes out, so the tile shows
**m**, and **m** means "their mic is off" — a person who is listening and
choosing not to talk. The one thing the room cannot tell from it is the thing
that matters: that this person is not there. So people kept talking to someone
who had stepped away from the conversation, and the deafened person came back
to ten minutes of room addressed to them.

## What it is

`deafened` becomes a fourth broadcast media flag beside `muted`, `video_on` and
`screen_on` — same table column, same `voice_state` frame, same push, same
reset on the join upsert. On a call tile it draws as **d**.

It is a **courtesy indicator and nothing else**. No peer changes its behaviour
on it; the silencing happens entirely in the deafened browser, on the receive
side, exactly as before. So a client that lies about the flag, or an old one
that never sets it, costs nobody anything — which is what makes broadcasting it
acceptable at all under a design whose per-viewer local controls (Addendum A1)
deliberately never touch the server. Deafen was never one of those: it is self
state, like mute, and it is now broadcast like mute.

## Decisions

**d replaces m on the tile; it does not join it.** Deafening mutes you, so a
deafened participant always broadcasts both flags, and rendering both would put
two overlapping claims in a row that is already carrying a name, a pop-out
button and up to three other letters. **d** is the stronger claim and the title
attribute carries the rest ("they cannot hear the room, and are muted with
it"). One consequence worth knowing: nothing in the tile distinguishes a
deafened person who was muted beforehand from one who was not, and nothing
needs to.

**Warn, not alert.** The flag row already uses the alert colour for the
uppercase **M** — *your* local mute of *them*, your doing. Deafen is theirs, and
the colour is there to be noticed before you start talking, not to say
something is wrong. It takes the warn amber that the connection-state line
uses.

**The sidebar and the phone shelf are unchanged.** Both draw a mic-off icon
from the same roster, and a deafened person is muted, so what they already show
is true. The tile is where you look at a person while deciding whether to
address them; a channel list is not.

**Rejoin resets it, like every other media flag.** Someone who reconnects while
deafened is briefly shown as hearing the room, until their client's first
`voice_state` corrects it. That is the existing contract of the join upsert and
it was not worth a special case: the window is one round trip, and the
alternative is a server that remembers a client-side audio setting across
sessions.

## Slices

- **109-1** (2026-09-05) — the whole vertical: migration 0055 adds
  `voice_participants.deafened`; `VoiceParticipant`, `VoiceParticipantView`,
  `VoiceStatePayload` and `VoiceParticipantStatePayload` carry it;
  `UpdateVoiceState` takes and writes it; the client mirrors it through
  `proto.ts`, the roster reducer and `VoiceParticipant` state; `VoiceCall`
  gains `setAudioState(muted, deafened)` so the pair that always moves together
  moves in one broadcast, and `VoiceSession`'s two toggles use it; the tile
  draws **d** in place of **m**.

## Where it lives

`migrations/0055_voice_deafened.sql`, `internal/store/voice.go` (and
`voice_deafened_test.go`), `internal/proto/voice.go`,
`internal/server/voice_ws.go`, `web/src/proto.ts`, `web/src/voice/call.ts`,
`web/src/voice/session.ts`, `web/src/state/` (and
`reducer-voice-deafened.test.ts`), `web/src/components/App.tsx`,
`web/src/components/VoiceCallPanel.tsx`, `web/src/theme.css`.

## Notes

The voice occupancy path had **no test at all** before this, which is why
`internal/store/voice_deafened_test.go` exists: adding a column to it meant
touching four `SELECT`/`RETURNING` lists, one scan and one `UPDATE`, and the
SELECT/scan three-site rule is invisible to `go build`. That test needs a live
Postgres (`CHALK_TEST_PGURL`) and skips without one, so the default
`go test ./...` still proves nothing about this SQL — run it with the dev
container's URL when touching the voice store.

`setAudioState` exists because mute and deafen never move independently:
deafening mutes, un-deafening restores the mute you had before, and unmuting
lifts the deafen. Setting them one at a time would put a frame on the wire
describing a state that existed for no time at all.
