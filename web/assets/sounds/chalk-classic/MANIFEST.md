# Chalk Classic Sound Theme — the original synthesizer, rendered

Format: stereo WAV, 48 kHz, 16-bit PCM. Unlike the other four themes, these
cues were not authored in a DAW: they are phase 40 and 71's chalk-stroke
*synthesizer* — deleted from the client in 102-1 — run once offline and
written to files. `tools/render-classic-theme.mjs` is that run, and holds the
spec table and the signal path; the render is deterministic, so the tool
reproduces these ten files byte for byte.

Every sound is pink noise through a bandpass that sweeps while it sounds,
under an attack/drag/lift envelope, rasped by a random stick-slip grain
modulator, with a quieter octave-down band for mass and a short contact tick
where the chalk lands. There is no oscillator anywhere in it: an early
version put a sine under the noise and it made every sound peep. Categories
are told apart by brightness, length, sweep direction and stroke count, the
way you tell two real chalk strokes apart.

| File | Event | Duration | Sonic cue |
|---|---|---:|---|
| 01_friend_online.wav | Friend online | 355 ms | Two soft low-contrast strokes rising; a friend appearing is information, not a summons. |
| 02_you_join_call.wav | You join a call | 365 ms | Two warm strokes rising, with the most mass in the theme — the one call event that happens *to* you. |
| 03_you_leave_call.wav | You leave a call | 355 ms | The same pair walked backwards; falling, but as warm and wide as the arrival. |
| 04_someone_joins.wav | Someone joins your call | 185 ms | One short bright stroke rising, deliberately light — in a room of eight this fires eight times. |
| 05_someone_leaves.wav | Someone leaves your call | 185 ms | Its mirror: same place on the board, same length, falling. |
| 06_connected.wav | Connected | 340 ms | Two strokes rising, mid and warm. The board is back. |
| 07_disconnected.wav | Disconnected | 570 ms | Not a stroke but an eraser sweep — the widest, dullest, longest thing here, and the only one that falls hard. |
| 08_send_confirmed.wav | Send confirmed | 165 ms | One very short bright swish. You asked for confirmation, not an announcement. |
| 09_error.wav | Error | 515 ms | Dark and heavy: chalk dragged hard, low on the board, falling away. Still warm — an error is not a reason to make the screech. |
| 10_new_message.wav | New message | 200 ms | One short swish, the shortest and quietest cue here; it is the one that can fire all day. |

Grammar: rising sweeps are arrival or connection, falling ones departure or
loss; the tick at the front of a stroke is the chalk touching down. Nothing
here has a pitch, and nothing reaches the 2–8 kHz stick-slip band that makes
chalk screech — `--spectrum` in the render tool checks that on the audio.

Levels: one trim for the whole theme, so the specs' hand-tuned balance
between the ten sounds survives. It puts the loudest cue at −6.4 dBFS, which
is the *chalk* theme's ceiling to the decibel, and lands the mean per-cue RMS
within 0.2 dB of it — the volume slider means the same thing in both.

Seven of chalk's seventeen sound categories have no cue of their own (see
`CUE_FOR` in `web/src/notify/themes.ts`): mention, dm, thread reply, voice,
channel added, friend request and governance all play *new message*. The
synth had a distinct spec for each of those, and those specs are still in the
render tool — unrendered, since nothing would play them.
