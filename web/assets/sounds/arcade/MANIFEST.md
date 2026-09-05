# Arcade Sound Theme — from romainsimon/uisfx

**Not authored for chalk.** These ten cues are the *arcade* pack from
[romainsimon/uisfx](https://github.com/romainsimon/uisfx), MIT licensed and
shipped here exactly as upstream publishes them — byte for byte, not
transcoded, not re-levelled. Thanks to Romain Simon and the uisfx project for
putting a complete, coherent UI sound set out under a licence that lets a
small self-hosted chat app just use it.

The upstream licence is beside this file as `LICENSE.uisfx`; its terms require
that notice to travel with the files, which is why it is in the repo and in
the image rather than only linked.

Format: MP3, MPEG-1 Layer III, 64 kbps, 44.1 kHz, mono — upstream's own
encode. Every other theme here is 48 kHz WAV; the player does not care,
because both reach it through the same `decodeAudioData`, which resamples to
the `AudioContext`'s rate. Keeping the files unmodified is the point: it is
what makes the attribution above cover the actual bytes chalk serves.

`uisfx` names its sounds for a shopping-and-dashboard vocabulary chalk does
not have, so each cue below records which upstream file it is. That mapping is
scuq's, and it is the only editorial decision in this folder.

| File | Event | Upstream | Duration |
|---|---|---|---:|
| 01_friend_online.mp3 | Friend online | `success.mp3` | 679 ms |
| 02_you_join_call.mp3 | You join a call | `add-to-cart.mp3` | 549 ms |
| 03_you_leave_call.mp3 | You leave a call | `remove-from-cart.mp3` | 496 ms |
| 04_someone_joins.mp3 | Someone joins your call | `wake.mp3` | 496 ms |
| 05_someone_leaves.mp3 | Someone leaves your call | `sleep.mp3` | 496 ms |
| 06_connected.mp3 | Connected | `connect.mp3` | 627 ms |
| 07_disconnected.mp3 | Disconnected | `disconnect.mp3` | 627 ms |
| 08_send_confirmed.mp3 | Send confirmed | `typing.mp3` | 183 ms |
| 09_error.mp3 | Error | `error.mp3` | 627 ms |
| 10_new_message.mp3 | New message | `notification.mp3` | 575 ms |

The pack calls the connection cue `connect`, not `connected`; that is the file
named in the mapping request and it is the one here.

Grammar, inherited from upstream rather than imposed: the cart pair is the
mirrored gesture for your own call state, wake/sleep is the mirrored pair for
other people arriving and leaving, and connect/disconnect mirror each other
for the socket. Same up-is-arrival shape the other themes use, arrived at
independently.

Durations are measured from the MPEG frame headers by `themes.test.ts`, which
also holds every cue to the two-second ceiling; they include the encoder's
delay and padding, so the audible sound is a little shorter than the number.

Seven of chalk's seventeen sound categories have no cue of their own (see
`CUE_FOR` in `web/src/notify/themes.ts`): mention, dm, thread reply, voice,
channel added, friend request and governance all play *new message*. uisfx
does publish a `mention.mp3`, so this is the theme where the "distinct mention
cue" follow-up would cost one download.
