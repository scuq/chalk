# chalk — PHASE 30: Voice/Video (Discord-style rooms, coturn-relayed, E2E)

Status: IMPLEMENTATION-READY design. Architecture: Discord-style persistent voice
channels (click to join, members see who's present), **mesh P2P with coturn as
the mandatory relay** (works WHEN P2P fails -- the common case), identity-bound
DTLS for anti-MITM, fully E2E (coturn relays encrypted SRTP it cannot decrypt).
Mesh hard-capped to small rooms (<=5). Written against the post-attachments tree;
matches chalk's real docker/Makefile/config conventions.

This supersedes the earlier voice-video sketch. Build the slices in order.
Includes SCREEN + GAME sharing (Addendum B): one WebRTC transport, two quality
modes off a single standardized lever -- motion = high-FPS game, detail/text =
crisp screen. The "crisp Discord replacement" target + honest scope is in
Addendum C (parity scorecard). Bandwidth probe + adaptive downscaler (fit a
thin uplink, e.g. ~10 Mbps) is in Addendum D.

---

## 0. The relay-first reality (your requirement, made central)

> "What we need is for it to work if no P2P can be established."

That is EXACTLY what coturn provides. WebRTC connection flow per peer pair:
  1. Try HOST candidates (same LAN).            -- rare across the internet
  2. Try SERVER-REFLEXIVE (srflx) via STUN.     -- works for ~easy NATs
  3. Fall back to RELAY via TURN (coturn).      -- works almost always
If 1-2 fail (restrictive/symmetric NAT, corporate/mobile firewall -- the MAJORITY
of real clients), ICE uses the RELAY candidate and ALL media flows through coturn.
So in chalk's deployment, coturn is NOT optional -- it is the path that makes
calls connect at all. The design treats coturn as REQUIRED infrastructure, with
STUN-only as a degraded mode that will fail for most clients.

coturn still never sees plaintext: it relays DTLS-SRTP ciphertext. Combined with
identity-bound fingerprints (Slice F), the call is E2E even though every media
byte transits the operator's relay.

To force/verify relay during testing: Chrome flag / RTCConfiguration
`iceTransportPolicy: 'relay'` makes the client use ONLY relay candidates -- the
test must pass with this set, proving the no-P2P path works.

---

## 1. Reuse map (what Phase 30 does NOT rebuild)

- Voice channel = a channel row with `channel_type='voice'`: membership,
  governance (dictator/democratic), space keys, add/remove, fan-out -- all reused.
- Real-time fan-out: existing `publishChannelEvent` (per-member) + hub
  `FanOutToUser(userID, exceptConnID, data)` (per-device, except-origin).
- Signaling transport: the existing authenticated WS. New frame types only.
- Anti-MITM: existing Ed25519 identity key (phase 22, non-extractable, usage
  ["sign"]) + verification (phase 24). No new crypto primitive.
- Disconnect cleanup: hub already knows Conn.ID on Unregister.
- Config: CHALK_* env (matches Giphy/governance/attachments precedent).
- Docker: coturn joins docker/docker-compose*.yml + a Makefile dev target,
  mirroring the existing Mailpit dev container pattern exactly.

ONLY new infra: coturn (separate container) + the WebRTC client code.

---

## 2. Topology (decided): mesh + coturn, small rooms

- Mesh: each participant holds N-1 RTCPeerConnections. Bandwidth ~ (N-1) x
  stream. Server HARD-CAPS at CHALK_VOICE_MAX_PARTICIPANTS (default 5); join
  rejected when full.
- coturn: the relay for the no-P2P case (most clients). REQUIRED for reliable
  connectivity.
- NOT an SFU. Big rooms are out of scope; an SFU seam is left open (Slice I) but
  unbuilt.

---

## 3. Schema (migration 0038_voice.sql)

    ALTER TABLE channels
      ADD COLUMN channel_type TEXT NOT NULL DEFAULT 'text'
        CHECK (channel_type IN ('text','voice'));

    -- LIVE room occupancy: who is IN the voice room right now. Ephemeral
    -- session state, distinct from channel_members (allowed) and
    -- device_presence (online/away/offline). The THIRD presence axis.
    CREATE TABLE IF NOT EXISTS voice_participants (
      channel_id  UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id     UUID NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
      device_id   UUID NOT NULL,
      conn_id     TEXT NOT NULL,        -- WS Conn.ID, for teardown on disconnect
      joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      muted       BOOLEAN NOT NULL DEFAULT false,
      video_on    BOOLEAN NOT NULL DEFAULT false,
      screen_on   BOOLEAN NOT NULL DEFAULT false,   -- sharing screen/game (badge)
      PRIMARY KEY (channel_id, user_id, device_id)
    );
    CREATE INDEX IF NOT EXISTS voice_participants_channel_idx
      ON voice_participants(channel_id);
    CREATE INDEX IF NOT EXISTS voice_participants_conn_idx
      ON voice_participants(conn_id);   -- fast disconnect cleanup by Conn.ID

Cleanup: on WS Unregister, DELETE voice_participants WHERE conn_id=$1, fan-out
"left" to channel members. Orphan janitor sweeps rows whose conn is gone past a
TTL (reuse the attachment-janitor pattern).

---

## 4. Wire frames (new; signaling rides the existing WS)

Client -> server:
  voice_join    {channel_id}
  voice_leave   {channel_id}
  voice_roster  {channel_id}
  voice_signal  {channel_id, to_user, to_device, kind, payload}
                 kind in {offer, answer, ice, screen_add, screen_remove};
                 payload = E2E-encrypted SDP/ICE/screen-track-mid (encrypted
                 under the channel space key). Server routes by
                 (to_user, to_device); NEVER inspects payload.
  voice_state   {channel_id, muted, video_on, screen_on}

Server -> client (pushes / acks):
  voice_join_ack {channel_id, roster:[{user_id,device_id,muted,video_on,screen_on}],
                  ice_servers:[{urls, username, credential}]}   -- TURN creds here
  voice_participant_joined {channel_id, user_id, device_id}
  voice_participant_left   {channel_id, user_id, device_id}
  voice_participant_state  {channel_id, user_id, device_id, muted, video_on, screen_on}
  voice_signal  (relayed peer->peer, payload opaque)

Join handshake (glare-free): the JOINER offers to every existing participant;
existing peers only ANSWER. ICE candidates trickle via voice_signal. -> fully
connected mesh, no double-offer.

---

## 5. TURN short-lived credentials (coturn REST/HMAC scheme)

chalkd mints time-limited coturn creds on voice_join (standard coturn
"use-auth-secret" / TURN REST API):
  username   = "<unix_expiry>:<user_id>"          (expiry = now + CHALK_TURN_TTL_SECS)
  credential = base64( HMAC_SHA1( CHALK_TURN_SECRET, username ) )
coturn is configured with the SAME static-auth-secret; it recomputes the HMAC to
auth the client. Creds expire -> not replayable. chalkd uses crypto/hmac +
crypto/sha1 (stdlib; nothing to vendor). Returned in voice_join_ack.ice_servers
alongside CHALK_TURN_URLS.

If CHALK_TURN_URLS is empty -> ice_servers carries STUN only (degraded; most
clients won't connect). Voice is gated behind CHALK_VOICE_ENABLED.

---

## 6. Anti-MITM: identity-bound DTLS fingerprints (Slice F)

1. SDP offer/answer carry the DTLS a=fingerprint (standard).
2. Sender SIGNS the fingerprint string with its Ed25519 identity private key.
3. signature + signer identity pubkey ride in the (already-encrypted) voice_signal
   payload.
4. Receiver verifies the signature against the sender's PUBLISHED identity
   (fetchIdentity, phase 22). Mismatch -> ABORT call (possible MITM).
5. If picture-word verified (phase 24) -> media path is E2E-authenticated.
Binds DTLS keys to chalk identities; a malicious signaling server cannot swap
fingerprints without forging an identity signature it cannot produce.

---

## 7. coturn TEST CONTAINER setup (so we can test the no-P2P path)

### 7a. Compose service (docker/docker-compose.yml dev stack + .test.yml)

    coturn:
      image: coturn/coturn:4.6
      network_mode: host            # TURN needs the real host ports / relay range;
                                    # host networking is simplest for dev/test.
      command: >
        -n
        --listening-port=3478
        --fingerprint
        --use-auth-secret
        --static-auth-secret=devsecret
        --realm=chalk.local
        --min-port=49160 --max-port=49200
        --no-tls --no-dtls
        --log-file=stdout
        --verbose
    # Notes:
    #  * --use-auth-secret + --static-auth-secret must MATCH chalkd's
    #    CHALK_TURN_SECRET (=devsecret in dev).
    #  * relay port range kept small for dev; open these in any firewall.
    #  * --no-tls/--no-dtls for dev only; prod uses turns: with certs.
    #  * host networking avoids docker NAT masking relay candidates. On
    #    Parallels/macOS, host networking has caveats -- if relay candidates
    #    don't appear, fall back to explicit -p port publishing for 3478/udp
    #    + the relay range, and set --external-ip to the VM's reachable IP.

### 7b. Makefile dev target (mirror the Mailpit dev-mail-up/down pattern)

    CHALK_DEV_TURN_NAME  ?= chalk-dev-turn
    CHALK_DEV_TURN_IMAGE ?= coturn/coturn:4.6
    CHALK_DEV_TURN_SECRET ?= devsecret

    dev-turn-up:   ## Start a coturn container for dev (TURN on 3478)
      @if docker inspect $(CHALK_DEV_TURN_NAME) >/dev/null 2>&1; then \
        docker start $(CHALK_DEV_TURN_NAME) >/dev/null; \
      else \
        docker run -d --name $(CHALK_DEV_TURN_NAME) --network host \
          $(CHALK_DEV_TURN_IMAGE) \
          -n --listening-port=3478 --fingerprint --use-auth-secret \
          --static-auth-secret=$(CHALK_DEV_TURN_SECRET) --realm=chalk.local \
          --min-port=49160 --max-port=49200 --no-tls --no-dtls \
          --log-file=stdout --verbose; \
      fi

    dev-turn-down: ## Stop and remove the dev coturn container
      @docker stop $(CHALK_DEV_TURN_NAME) >/dev/null 2>&1 || true
      @docker rm   $(CHALK_DEV_TURN_NAME) >/dev/null 2>&1 || true

    dev-turn-logs: ## Tail the dev coturn logs
      docker logs -f --tail=100 $(CHALK_DEV_TURN_NAME)

### 7c. chalkd dev env (point chalkd at the dev coturn)

    CHALK_VOICE_ENABLED=true
    CHALK_TURN_URLS=turn:127.0.0.1:3478?transport=udp
    CHALK_TURN_SECRET=devsecret      # MUST equal coturn --static-auth-secret
    CHALK_TURN_TTL_SECS=3600

### 7d. Verifying the no-P2P path (the actual test)

  1. make dev-turn-up ; start chalkd with the env above.
  2. Two browsers (alice/bob), both JOIN the voice channel.
  3. In each client set RTCConfiguration.iceTransportPolicy='relay' (force relay;
     no host/srflx). Provide a build flag CHALK_VOICE_FORCE_RELAY for this.
  4. Confirm the call CONNECTS (audio flows) using ONLY relay candidates ->
     proves it works when P2P is impossible.
  5. coturn logs show allocation + relayed traffic; chrome://webrtc-internals
     shows the selected candidate pair is relay/relay.
  6. DB: voice_participants has both; closing one browser removes its row +
     fans out "left".

This is the live gate for Phase 30: relay-only call connects between two clients.

---

## 8. Client (Discord-style, inside the chalk UI)

- Sidebar: voice channels with a headphones/speaker SVG icon; under each, the
  LIVE participant list (handles of who's in the room), updated by joined/left/
  state pushes.
- Join: click -> getUserMedia(audio[,video]) -> voice_join -> ice_servers from
  the ack -> establish mesh -> appear in the roster for all members.
- In-call panel WITHIN the chalk UI (not a separate window): participant tiles
  (remote video; hidden <audio> for sound), mute toggle, camera toggle, leave.
  Plus a SHARE button (screen/game share, Addendum B) -- a shared screen becomes
  the large primary tile, cameras shrink to a filmstrip (Discord layout).
- Permissions: handle mic/cam denial (audio-only if cam denied; clear error if
  mic denied).
- iceTransportPolicy: default 'all'; 'relay' when CHALK_VOICE_FORCE_RELAY (test).

---

## 9. State machine + edges

- join/leave: insert/delete participant + fan-out; idempotent per device.
- disconnect: hub Unregister -> delete by conn_id + fan-out left + peers teardown.
- orphan janitor: sweep stale rows past TTL.
- reconnection (v1): drop from room on WS loss; user re-clicks to rejoin.
- glare: new joiner offers; existing only answer.
- room full: server rejects voice_join past the cap -> client "room full."
- mute/video: voice_state + fan-out.
- removed/blocked member: cascade-removed from the room + fan-out left.
- multi-device same user in one room (v1): reject 2nd device join (avoid
  echo/feedback); PK supports it for the future.

---

## 10. Config (consolidated, CHALK_*)

    CHALK_VOICE_ENABLED            default false  (feature flag)
    CHALK_VOICE_MAX_PARTICIPANTS   default 5      (mesh hard cap)
    CHALK_VOICE_FORCE_RELAY        default false  (test: iceTransportPolicy=relay)
    CHALK_TURN_URLS                coturn URIs (empty -> STUN-only degraded)
    CHALK_TURN_SECRET              static-auth-secret shared with coturn
    CHALK_TURN_TTL_SECS            default 3600
    CHALK_STUN_URLS                optional explicit STUN
    (adaptive quality / probe knobs -- CHALK_VOICE_PROBE_*, _RECHECK_SECS,
     _UPLINK_HEADROOM, _AUDIO_KBPS, _MIN_VIDEO_KBPS -- are defined in Addendum D)

---

## 11. IMPLEMENTATION SLICES (build in order; fresh session per slice)

- **30-1 (server: schema + rooms + TURN creds)**
  migration 0038 (channel_type + voice_participants + indexes); store
  (JoinVoice/LeaveVoice/VoiceRoster/cleanup-by-conn/orphan janitor); the TURN
  HMAC credential minter + CHALK_TURN_*/CHALK_VOICE_* config; voice channel
  creation (channel_type='voice'). NO signaling routing yet. Go.
  Gate: go build/vet/gofmt; voice_participants rows created/cleaned in DB.

- **30-2 (server: signaling relay)**
  proto frames (voice_join/leave/roster/signal/state) + handlers; voice_join
  returns roster + ice_servers; voice_signal routed peer->peer (payload opaque);
  fan-out roster deltas; disconnect cleanup wired into Unregister. Go.
  Gate: go build/vet/gofmt; two WS clients exchange a routed voice_signal.

- **30-3 (coturn test container)**
  docker compose coturn service + Makefile dev-turn-up/down/logs + dev env doc.
  Gate: make dev-turn-up; coturn allocates; chalkd hands valid creds (manual
  ICE test against the relay).

- **30-4 (client: WebRTC mesh + anti-MITM)**
  RTCPeerConnection mesh, getUserMedia, offer/answer/ICE over voice_signal,
  ice_servers wiring, remote stream render; Ed25519 fingerprint SIGN+VERIFY
  (Slice F); iceTransportPolicy + CHALK_VOICE_FORCE_RELAY. TypeScript -- hardest.
  Gate: tsc/test/build; RELAY-ONLY call connects between two browsers (sec 7d).

- **30-5 (client: Discord-style UI)**
  voice channels in sidebar + live participant list + join/leave + in-call panel
  (video tiles, mute/cam/leave) + voice icon SVG. TypeScript.
  Gate: tsc/test/build; visible join/leave + roster updates across two clients.

- **30-6 (polish)**
  reconnection behavior, removed-member cascade, mute/video sync, permission
  denial UX, feature-flag gating, coturn prod notes (turns: + certs).

- **30-7 (client: screen + game share)** -- Addendum B
  getDisplayMedia + the contentHint mode toggle (motion/detail/text), screen
  track on its OWN transceiver (camera stays up), perfect-negotiation
  renegotiation for the mid-call track add/remove, codec preference
  (AV1>VP9>H264) + bitrate/degradationPreference params, shared app/game audio
  track, big-tile + filmstrip UI, per-viewer hide (reuses A1). Server touch is
  tiny (screen_on column + frame field, folded into 30-1/30-2). TypeScript.
  Gate: tsc/test/build; a relay-only screen share renders on the other client;
  webrtc-internals confirms motion holds FPS / detail holds resolution.

- **30-8 (client: adaptive quality -- probe + downscaler)** -- Addendum D
  pre-stream bandwidth probe (starting-tier pick), passive in-call re-checks on
  the +1/+6/+11 min schedule, the mesh budget divider (total uplink / active
  outbound senders, audio reserved, screen>camera priority), the tier ladder +
  hysteresis applied via setParameters (maxBitrate / scaleResolutionDownBy /
  maxFramerate). Minimal per-sender caps + divider should already land in 30-4;
  this slice adds the probe, scheduler, and ladder. Depends on 30-7. TypeScript.
  Gate: tsc/test/build; on a throttled 10 Mbps uplink a 1->4 game share settles
  to ~720p60 while a screen share stays crisp; per-sender caps visible in
  webrtc-internals.

Recommend: 30-1 -> 30-2 -> 30-3 (now relay works end to end server-side) ->
30-4 (the WebRTC + anti-MITM core, tested relay-only) -> 30-5 (the UI) -> 30-6.

---

## 12. Honest scope

Biggest arc in chalk. Real-time media has irreducible complexity (NAT traversal,
mesh state machine, reconnection, getUserMedia, browser WebRTC quirks). But it
reuses channels/membership/governance/keys/fan-out/identity, and coturn is the
one new piece of infra -- run as a separate container, set up for test in 30-3.
The relay-first requirement is satisfied: with coturn, calls connect even when
P2P is impossible, and the relay-only test (7d) is the explicit acceptance gate.
Build server-first; 30-4 (WebRTC client) is where the real engineering lives.

## 13. Dependencies

- Independent of md-1 (multi-device). Either order.
- Anti-MITM relies on phase 22 (identity) + phase 24 (verification) -- both DONE.
- coturn must be provisioned (30-3) before relay works; until then voice is
  STUN-only (fails for most clients) -- which is exactly why 30-3 is early.

---

# ADDENDUM A — Per-viewer controls + gaming-grade audio (added)

User additions: (1) per-remote-user video disable, (2) permanent per-user mute
(for the "partner in the same room, same channel" case), (3) Mumble-grade audio:
mic sensitivity/VAD calibration, full audio adjustability, and open-source voice
isolation / noise suppression. These are CLIENT-LOCAL controls except where noted.
Research current as of 2026.

## A1. Per-viewer remote controls (client-local, never sent to the room)

Crucial design point: these are LOCAL playback/render decisions on the viewer's
machine. They do NOT mute/disable for everyone, and they are NOT signaled to the
server or other peers. (Contrast with self-mute in A4, which IS broadcast so
others see your mic state.)

- **Disable a remote user's video (per viewer):** stop rendering one or more
  remote video tiles locally. Implementation: don't attach that peer's video
  MediaStreamTrack to a <video>, or set the tile hidden; optionally call
  `track.enabled=false` on the *receiver* side (RTCRtpReceiver) so the decoder
  can idle. Saves the viewer's CPU/bandwidth-render, leaves the sender + other
  viewers untouched. Per-user toggle in the participant list; multi-select OK.
- **Permanent per-user mute (per viewer):** locally silence one specific
  participant's audio, and PERSIST it so it survives rejoins. The driving case:
  your partner sits beside you and is in the same voice channel -- you hear them
  twice (once in the room, once in person), so you mute their stream locally
  while still hearing everyone else. Implementation: gain-node = 0 (or detach the
  <audio>) for that peer; store the muted-user-id set in localStorage/IndexedDB
  keyed per channel so it's remembered. A "muted (local)" badge in the roster +
  an unmute control. Never affects what others hear.
- Both are pure client state: no schema, no wire frames, no server involvement.
  They belong to vv-3 (UI) / a new vv-5 (audio) slice, not the server slices.

## A2. Noise suppression / voice isolation -- open-source options (researched)

The landscape (2026): WebRTC ships a built-in suppressor (NS3, the Speex/AEC3
chain) toggled by getUserMedia `noiseSuppression:true` -- fine for moderate
two-way human conversation, weak on non-stationary noise (keyboard, fans, babble)
which is exactly the gaming case. For better quality you run a deep-learning
suppressor client-side in an AudioWorklet over WASM. Options:

- **WebRTC built-in NS3** -- free, zero-integration (`noiseSuppression:true` in
  getUserMedia constraints). Baseline. Use as the default/cheap path.
- **RNNoise** (Xiph; RNN+DSP) -- the classic open-source choice, compiles cleanly
  to WASM, used by Jitsi. Caveat: UNMAINTAINED since ~2024 and showing its age on
  modern noise (mechanical keyboards, fans). Still a solid, license-clean
  (BSD-style) self-hosted option and the pragmatic pick for chalk. Processes
  480-sample/10ms frames at 48kHz.
- **DTLN / dtln-rs** (Datadog open-sourced `dtln-rs`, Apache/MIT) -- DTLN deep
  model, Rust -> WASM, better quality than RNNoise; ~33ms per 1s on M1. Heavier;
  some low-end clients can't keep real-time (workadventu.re found p95 spikes on
  weaker CPUs). A "high quality" tier behind a capability check.
- **Picovoice Koala / NVIDIA Maxine / Krisp SDK** -- better still, but NOT
  open-source / free (Krisp went metered May 2026). Out of scope for a
  self-hosted FOSS app; mention only as the "if you ever want commercial" note.

RECOMMENDATION for chalk (self-hosted, FOSS, privacy-first):
- Default: WebRTC built-in NS3 (free, no bundle cost).
- Optional toggle: **RNNoise via AudioWorklet+WASM** as the "better suppression"
  setting -- license-clean, self-contained, no third party, no per-minute fees,
  runs entirely client-side (no audio leaves the device -- consistent with
  chalk's E2E identity). Bundle the .wasm; lazy-load it only when enabled.
- Leave a seam to swap in dtln-rs later as a "high quality" tier (same
  AudioWorklet slot), gated on a perf/capability check.
- IMPORTANT pitfall (from research): do NOT stack suppressors. If RNNoise is on,
  set getUserMedia `noiseSuppression:false` (disable NS3) so they don't fight and
  over-suppress/erase sibilants. KEEP `echoCancellation:true` (AEC3) -- RNNoise
  is a noise suppressor, NOT an echo canceller; you still need AEC.

## A3. The audio pipeline (Web Audio graph) -- "adjust every bit"

To make audio fully tunable (the Mumble/gaming goal), route the mic through a
Web Audio graph BEFORE it hits the RTCPeerConnection, instead of sending the raw
getUserMedia track. Graph:

  getUserMedia(mic)
    -> MediaStreamSource
    -> [input gain]          (mic volume / amplification, ~0.0-3.0x)
    -> [noise suppressor]    (AudioWorklet: RNNoise/DTLN, or bypass for NS3)
    -> [VAD gate]            (voice-activity gate; see A4)
    -> [optional: high-pass / compressor / limiter]  (clean up rumble, even out level)
    -> MediaStreamDestination
    -> pc.addTrack(dest track)

On the RECEIVE side, per remote peer:
  remote track -> MediaStreamSource -> [per-user gain] -> [master output gain]
    -> AudioContext destination
This gives per-user volume (A1 permanent-mute is just gain=0) + master output.

All of this is standard Web Audio + AudioWorklet; nothing leaves the device, so
it stays consistent with E2E (the server never sees raw or processed audio --
only the encrypted SRTP after WebRTC).

## A4. Mumble-style mic calibration + transmit modes (the gaming core)

Model the proven Mumble controls (researched). Per-user LOCAL settings,
persisted:

- **Transmit mode:**
  - Voice Activity (VAD) -- default; mic transmits when input crosses a threshold.
  - Push-to-Talk (PTT) -- transmit only while a keybind is held; double-tap-latch
    + configurable release/hold timer (so word-ends aren't clipped). Best for
    noisy rooms / gaming.
  - Continuous -- always transmit (discouraged; transmits background noise).
- **VAD calibration (Mumble's two-threshold scheme):** a live input VU meter +
  two thresholds:
  - "speech below" (silence floor) and "speech above" (definite-voice) with a gap
    between them (hysteresis) so a brief dip mid-word doesn't cut you off.
  - Determine activity by amplitude OR signal-to-noise ratio.
  - A setup wizard: speak normally -> it watches the meter -> auto-suggests the
    thresholds; user can drag to fine-tune. (This is the "mic sensitivity
    calibration, Mumble-like" ask.)
- **Input gain / amplification** (boost a quiet mic; VU meter shows clipping in
  red so you don't over-drive).
- **Voice hold timer** (keep transmitting N ms after voice stops -- avoids
  choppy word-tails).
- **Per-user output volume** + **master output volume** (receive-side gains, A3).
- **Self mute / self deafen** keybinds. (Self-mute IS broadcast via voice_state
  so the roster shows it; per-viewer mutes in A1 are NOT.)
- **Optional audio cues** (a sound when your mic goes live/idle); off by default.
- Keybinds for PTT / mute / deafen, user-configurable.

Persistence: all of A1/A4 are client-local settings in localStorage/IndexedDB
(per-user, and per-channel where it makes sense like the A1 mute set). None of it
touches the server schema except the EXISTING voice_state frame (muted/video_on)
which already broadcasts self-mute/self-video for roster display.

## A5. Build placement (these are mostly a new client slice)

- vv-1..vv-4 unchanged (server + WebRTC transport + signaling + anti-MITM).
- **vv-3 (UI)** gains: per-user "disable video" + "mute (local, persistent)"
  controls in the participant list; the local-mute persistence store.
- **NEW vv-5 (audio engine)** -- the Web Audio graph (A3), the noise-suppression
  AudioWorklet (RNNoise WASM, lazy-loaded, NS3 fallback), VAD gate + PTT, the
  mic-calibration wizard + VU meters, per-user/master output gains, keybinds.
  This is its own focused slice -- it's the "gaming-grade audio" surface and is
  independent of the transport. Build AFTER a basic call works (vv-4) so there's
  real audio to tune.

## A6. Config / dependency notes

- RNNoise WASM: vendor the .wasm + a small AudioWorklet wrapper; lazy-load only
  when the user enables "enhanced noise suppression." Confirm the specific
  RNNoise build's license (Xiph RNNoise is BSD-style/permissive -- compatible
  with chalk's BSD-3) before bundling; pin the source.
- Everything in Addendum A is CLIENT-SIDE and leaves no audio with the server,
  so it adds nothing to the E2E threat surface (raw/processed audio never leaves
  the device; only encrypted SRTP does, post-processing).
- No new server config beyond the existing CHALK_VOICE_*/CHALK_TURN_* set; the
  audio engine is pure client.

---

# ADDENDUM B — Screen & game sharing (crisp screen / high-FPS game)

Requirement: share a SCREEN "crisp" (sharp text/detail) AND share a GAME at
"high FPS." These are the two OPPOSITE ends of a single STANDARDIZED WebRTC
lever -- so chalk gets both from one transport (the same mesh + coturn already
built), with a per-share mode toggle. No new infra; the screen share is just
another WebRTC track on the existing peer connections.

## B0. The core insight: one lever, two modes (W3C contentHint)

Under bitrate pressure an encoder MUST sacrifice EITHER framerate OR resolution
-- you cannot hold both. WebRTC exposes exactly this choice via
MediaStreamTrack.contentHint, which the spec maps deterministically onto the
sender's degradationPreference:

  contentHint = "motion" -> degradationPreference "maintain-framerate"
                            (drop RESOLUTION to keep FPS)   => GAME mode
  contentHint = "detail" -> degradationPreference "maintain-resolution"
                            (drop FPS to keep pixels sharp) => SCREEN mode
  contentHint = "text"   -> "maintain-resolution"; AND if codec is AV1,
                            activates AV1 screen-content-coding tools
                            => SCREEN mode, text-optimized (sharpest edges)

So "high-FPS game" == motion; "crisp screen" == detail/text. The requirement
IS the contentHint API -- not a hand-wave. (Source: W3C mst-content-hint;
libWebRTC already auto-enables AV1's screen-content tools for detail/screen
tracks.) Valid video hints are exactly: "", "motion", "detail", "text".

Implementation:

    const stream = await navigator.mediaDevices.getDisplayMedia(caps); // B3
    const track  = stream.getVideoTracks()[0];
    track.contentHint = mode === 'game' ? 'motion'
                      : mode === 'text' ? 'text'
                      :                   'detail';   // user-chosen, see UI
    const sender = pc.addTrack(track, stream);        // SEPARATE transceiver

Pin it explicitly too (don't rely only on the hint's implied default):

    const p = sender.getParameters();
    p.degradationPreference = mode === 'game' ? 'maintain-framerate'
                                              : 'maintain-resolution';
    p.encodings[0].maxBitrate = bitrateFor(mode);     // B3
    await sender.setParameters(p);

UI: a 3-way "Prioritize" toggle on the share (Discord-style):
  [ Smooth motion (game) ] [ Sharp detail (screen) ] [ Sharp text (docs/code) ]
Default to "detail" for a screen/window pick; the user flips to "motion" for a
game (do NOT try to auto-detect a game -- just default detail + let them flip).

## B1. Separate track -- share screen AND camera at once

The screen share is its OWN video track on its OWN transceiver; it does NOT
replace the camera. Camera + screen can be up simultaneously (Discord parity).
addTrack() mid-call => RENEGOTIATION (a new m-line), per peer in the mesh.

  - Receiver must tell screen-track from camera-track. Tag it: send the new
    transceiver's mid (or a stable track label) inside the encrypted
    voice_signal payload as {kind:'screen_add', mid}. Receiver maps that
    incoming track to a big "screen" tile vs a small "camera" tile.
  - On stop: removeTrack + renegotiate + {kind:'screen_remove'}; broadcast
    screen_on=false via voice_state so the roster badge clears.

## B2. Mid-call renegotiation glare -> perfect negotiation

The Section 4 glare rule ("joiner offers, existing only answers") covers JOIN
only. Adding/removing a screen track is a renegotiation started by an EXISTING
peer, so two peers can offer at once (glare). Adopt the standard PERFECT
NEGOTIATION pattern per peer pair:
  - polite/impolite role = deterministic compare of (user_id,device_id).
  - impolite peer ignores an incoming offer that collides with its own;
    polite peer rolls back and accepts. Eliminates glare on every mid-call
    track add/remove. Also future-proofs camera on/off toggles mid-call.

## B3. Codec & bitrate (where "crisp" and "high-FPS" actually come from)

Codec preference (setCodecPreferences / SDP) -> AV1 > VP9 > H.264 > VP8:
  - AV1 and VP9 carry SCREEN-CONTENT-CODING tools (large savings on sharp
    edges + flat color); AV1 is ~30% more efficient than VP9. libWebRTC
    auto-enables AV1's screen tools for detail/text/screen tracks -> the best
    "crisp" at low bitrate.
  - BUT AV1 software encode is ~3-5x the CPU of VP9, and HW AV1 encode is still
    limited across 2026 clients. GATE AV1 behind a capability/CPU check; fall
    back VP9 (still has screen tools) -> H.264 (strong HW path for high-motion
    game, sustains 60fps without pinning a core) -> VP8.
  - Net: SCREEN/crisp -> prefer AV1 (fallback VP9) for edge sharpness;
    GAME/motion -> VP9 or H.264-HW for sustainable 60fps.

Bitrate (sender.getParameters().encodings[0].maxBitrate):
  - GAME 1080p60 motion: cap ~2.5-8 Mbps (PER receiver in mesh -- see B4).
  - SCREEN detail/text: screen content compresses very well; ~0.3-2.5 Mbps is
    plenty at 1080p, with headroom for full-frame scene-change bursts.
  - scalabilityMode 'L1T2'/'L1T3' (temporal) for graceful frame dropping;
    scaleResolutionDownBy for explicit resolution control.

Capture constraints (getDisplayMedia):
  GAME:   { video:{ frameRate:{ ideal:60, max:60 } } }  + contentHint 'motion'
  SCREEN: { video:{ frameRate:{ ideal:15, max:30 } } }  + contentHint
          'detail'|'text'  (low fps, full resolution)

Share app/game AUDIO too (Discord parity): getDisplayMedia({ audio:true })
captures tab/system audio in Chromium (system audio mainly Chrome/Windows; tab
audio broadly; Firefox/Safari limited -- feature-detect, degrade to video-only).
Carry shared audio as a SEPARATE audio track; do NOT route it through the mic
A3 graph / VAD gate -- it is program audio, not a microphone.

## B4. The honest mesh ceiling (and why big tiers need the SFU seam)

In a mesh the sharer encodes once but UPLOADS N-1 copies. A 1->4 game share at
8 Mbps = ~32 Mbps upstream from ONE machine -- that is the real limit, not the
codec. So:
  - Realistic chalk target (mesh, cap 5): a crisp 1080p SCREEN share to a few
    viewers is comfortable (screen content is cheap); a 1080p60 GAME share is
    fine 1->1 / 1->2, strained 1->4 on typical home uplinks.
  - All viewers receive the SAME stream (mesh = one encode, copied N-1x).
    Per-viewer quality / 4K-to-many is an SFU feature (server forwards one
    upstream and selects simulcast/SVC layers per viewer). That is Slice I
    (SFU seam, unbuilt) -- the documented path to true Discord-tier
    "1080p60 to a big room." chalk v1 deliberately targets small rooms done
    well, consistent with the mesh cap.

## B5. Per-viewer controls (reuse Addendum A1) + UX

  - Screen tiles inherit A1: a viewer can locally HIDE a remote screen share
    (detach track / set the RECEIVER's track.enabled=false) -- same
    per-viewer, never-signaled pattern as remote video. Saves the viewer's
    decode/render; sender + other viewers untouched.
  - In mesh the SHARER owns the single quality; a viewer cannot request a
    custom quality (that needs SFU/simulcast). So the viewer control is
    show/hide + local fit (contain/cover) + pop-out/fullscreen -- NOT a
    quality slider.
  - Layout: the shared screen is the large primary tile; cameras shrink to a
    filmstrip; click a camera to swap focus (Discord layout).

## B6. Platform / test caveats (researched)

  - getDisplayMedia needs a transient user gesture; it shows the browser's
    native picker (screen / window / tab). Worth setting: displaySurface,
    systemAudio, surfaceSwitching, selfBrowserSurface:'exclude' (avoid the
    hall-of-mirrors), monitorTypeSurfaces.
  - Linux/Wayland: capture flows through xdg-desktop-portal + PipeWire; if the
    portal/PipeWire aren't present the picker is empty.
  - macOS: first capture triggers the OS Screen-Recording permission prompt;
    the browser must be granted it in System Settings.
  - Safari/iOS: WebKit-only, H.264-only, screen capture restricted -- expect
    video-only and lower ceilings; feature-detect and degrade gracefully.
  - DEV NOTE (your env): capturing INSIDE the Parallels VM may cap framerate or
    only expose the VM surface. Validate 60fps GAME mode on a host browser or a
    real client, not just the trixie VM, before trusting the FPS numbers.
  - Verify in chrome://webrtc-internals on the OUTBOUND screen track:
    motion mode -> framesPerSecond holds, frameWidth/Height dip under load;
    detail mode -> resolution holds, fps dips under load. That divergence is
    the proof the contentHint/degradationPreference wiring works.

## B7. Anti-MITM & E2E (no extra work)

The screen track rides the SAME DTLS-SRTP transport as audio/video, so Slice F
(identity-bound fingerprints) and the coturn-relays-ciphertext property cover
it automatically. No new crypto, no new fingerprint signing. The screen_add/
screen_remove control rides inside the already-encrypted voice_signal payload;
coturn and chalkd never see screen pixels.

---

# ADDENDUM C — Discord-parity scorecard (what "replacement" means here)

HAVE (this design):
  - persistent click-to-join voice rooms + live roster            (core)
  - audio + video calls; mute / deafen / self-video               (core)
  - gaming-grade mic: PTT, two-threshold VAD calibration, gain    (Add. A)
  - on-device noise suppression (NS3 default, RNNoise opt-in)     (Add. A)
  - per-user + master output volume; per-viewer local mute/hide   (Add. A)
  - screen share (crisp) + game share (high-FPS) + shared audio   (Add. B)
  - share screen AND camera together; big-tile + filmstrip layout (Add. B)
  - E2E (coturn relays ciphertext) + identity-bound anti-MITM     (Slice F)

DEFERRED (honest):
  - big rooms / 1080p60-to-many / per-viewer quality  -> needs SFU (Slice I)
  - server-side recording, soundboard, "Go Live" to 50 -> out of scope v1
  - Krisp-tier commercial noise suppression            -> not FOSS, skipped

Net: chalk targets "Discord for a small, private, self-hosted, E2E group" --
small rooms done crisply, not a 50-person stage. The crisp-vs-smooth share is
first-class (Addendum B); the SFU seam (Slice I) is the one documented upgrade
path to the large-room / high-tier experience.

---

# ADDENDUM D — Bandwidth probe + adaptive downscaler (fit the uplink)

Requirement: (1) a downscaler that shrinks the share when the uplink is small
(e.g. only ~10 Mbps), (2) a simple speed test BEFORE streaming to pick a sane
starting quality, (3) re-check 3x during the call (t = +1, +6, +11 min). This
makes Addendum B's static bitrate caps DYNAMIC and ties them to a measured
uplink budget. Extends B4 (the mesh upload-multiplication problem).

## D0. What WebRTC already does (so we build only the missing piece)

Don't rebuild congestion control. The browser already:
  - runs Google Congestion Control (GCC), continuously estimating the path and
    exposing it via getStats: candidate-pair.availableOutgoingBitrate (bits/s,
    1 s window) and outbound-rtp.targetBitrate (what it's asking the encoder to
    hit -- the single closest number to "the estimate").
  - AUTO-DOWNSCALES the encoder to fit that estimate, and the
    degradationPreference set in Addendum B decides HOW: motion sheds
    RESOLUTION (holds FPS), detail/text sheds FPS (holds resolution).
  - ramps cautiously: a fresh stream starts at ~15% of requested quality and
    climbs to 100% over ~30 s if the link allows.

So per-stream real-time adaptation is FREE and already on. The TWO things the
app must add:
  1. A MESH BUDGET DIVIDER. Each PeerConnection's GCC estimates ITS OWN path
     independently and they all compete; none knows you're also uploading N-1
     other copies (B4). The app measures total uplink, reserves audio, and
     divides the rest across ALL active outbound video senders as explicit
     maxBitrate caps -- so one share can't starve audio or the other copies.
  2. A STARTING-TIER pick from a pre-stream probe, to skip the slow 15%->100%
     ramp and avoid overshooting a thin uplink on join.

## D1. The pre-stream speed test (simple, once, before media flows)

Before the first share, run a short ACTIVE probe (safe -- no media flowing yet):
  - Simple default: a timed HTTP upload to a tiny new chalkd endpoint
    (POST /api/netprobe, body discarded, returns server-measured bytes/s) --
    a ~3-5 s or ~2-4 MB-capped upload. Because ~99% of chalk media is
    coturn-RELAYED (Section 0) and coturn sits with chalkd, uplink-to-server is
    a good proxy for the relay uplink the media actually uses.
  - More representative option: a brief WebRTC probe (open the PC, read
    availableOutgoingBitrate after ~3-5 s). Heavier to wire; the HTTP probe is
    the "simple speed test" asked for.
  - Caveat: a server probe measures uplink to the SERVER. If a pair connects
    true-P2P rather than relayed, that path can differ -- but relay is the
    common case here, so it's a sound STARTING estimate, refined live by D0/D2.
The probe result -> initial uplink budget -> D3 picks the starting tier.

## D2. The in-call re-checks (PASSIVE, on your schedule)

Your ask: re-check 3x, starting +1 min, every +5 min -> t = +1:00, +6:00,
+11:00. IMPORTANT correction vs "speed test": the in-call checks are PASSIVE
reads of getStats (availableOutgoingBitrate + targetBitrate), NOT active
saturating tests. An active speed test DURING a call competes with the live
media and degrades the very call it's measuring -- so we never do that mid-call.
Passive reads cost nothing and reflect the real, current path.

  - Schedule (configurable): CHALK_VOICE_RECHECK_SECS="60,360,660".
  - At each tick: sum availableOutgoingBitrate across active candidate-pairs,
    re-run the D3 divider + tier pick, step the tier (with hysteresis, D3).
  - PLUS an always-on fast guard, independent of the schedule: the encoder+GCC
    already protect in real time, and the app may also step DOWN early if
    targetBitrate stays pinned below the cap or loss spikes -- we never wait
    5 min to react to a collapsing link. The schedule governs deliberate
    RE-PLANNING / step-UP; safety is continuous.

## D3. The downscaler (mesh budget -> tier ladder, with hysteresis)

Budget math (per re-check), bits/s:
  uplink       = max(probe, sum(availableOutgoingBitrate))
  usable       = uplink * CHALK_VOICE_UPLINK_HEADROOM        // default 0.85
  audioReserve = activePeers * CHALK_VOICE_AUDIO_KBPS        // default 64/peer
  videoBudget  = usable - audioReserve
  perCopy      = videoBudget / activeOutboundVideoSenders    // see note
Note: count ALL outbound video streams. Screen + camera to 4 peers = 8 streams.
Give the SCREEN share priority; camera copies take a thumbnail cap first.

Apply via sender.setParameters() (no renegotiation -> cheap, fine to do often):
  enc.maxBitrate            = tier cap
  enc.scaleResolutionDownBy = to hit the tier resolution
  enc.maxFramerate          = tier fps ceiling
  (+ track.applyConstraints({frameRate}) on the capture side)
The encoder still does sub-tier shedding under the cap per degradationPreference
(motion=res, detail=fps). The ladder sets the CEILING; GCC fills underneath.

Tier ladder (per-copy budget; the share mode picks the column):
  perCopy >=6M : GAME 1080p60 @6M   | SCREEN 1080p @30 @2.5M
  3-6M         : GAME 1080p60 @4M   | SCREEN 1080p @30 @1.5M
  1.5-3M       : GAME 720p60  @2.5M | SCREEN 1080p @15 @1.0M
  0.8-1.5M     : GAME 540p60  @1.2M | SCREEN  900p @10 @0.6M
  0.4-0.8M     : GAME 360p    @0.6M | SCREEN  720p @8  @0.4M (prefer AV1)
  <0.4M        : GAME pause+warn / audio-only | SCREEN 720p @5 @0.3M (AV1)
(Screen content compresses cheaply -- it holds resolution and sheds fps, so even
thin budgets stay readable. Game holds fps and sheds resolution. This is just
B0's contentHint doing its job, now under an app-set ceiling.)

Hysteresis (avoid oscillation):
  - Step DOWN quickly: perCopy under the current tier floor for >~3 s.
  - Step UP slowly: only after the next tier's budget holds >~30-60 s (GCC
    ramps slowly anyway). The +5 min cadence is a natural step-up review point;
    step-down is allowed off-schedule by the fast guard.
  - One tier per step; never jump multiple tiers at once.

## D4. The 10 Mbps worked example (your number)

uplink 10 Mbps, headroom 0.85 -> usable ~8.5 Mbps. Room cap 5 (N-1 = 4 peers),
audioReserve ~4 x 64k = 256k -> videoBudget ~8.25 Mbps. ONE share (screen OR
game), perCopy = videoBudget / fanout:
  1->1 : ~8.2M -> GAME 1080p60   / SCREEN crisp 1080p, easy headroom
  1->2 : ~4.1M -> GAME 1080p60   / SCREEN crisp 1080p   (res may dip in game)
  1->3 : ~2.7M -> GAME 720p60    / SCREEN crisp 1080p@15 (screen is cheap)
  1->4 : ~2.0M -> GAME 720p60    / SCREEN crisp 1080p@15 (motion holds fps)
If ALSO sending camera, camera copies take a small thumbnail cap (~150-300k
each) off the top and the screen keeps the rest. So at 10 Mbps a crisp screen
share to the whole room is comfortable; a high-FPS game share is great 1->1/1->2
and gracefully downscales to 720p60 by 1->4 -- exactly the downscale asked for.

## D5. Config + build placement

Config (CHALK_*, client defaults server-provided per the existing pattern):
  CHALK_VOICE_PROBE_ENABLED    default true
  CHALK_VOICE_PROBE_BYTES      default 3000000     (cap the probe upload)
  CHALK_VOICE_RECHECK_SECS     default "60,360,660" (+1, +6, +11 min)
  CHALK_VOICE_UPLINK_HEADROOM  default 0.85
  CHALK_VOICE_AUDIO_KBPS       default 64          (per-peer audio reserve)
  CHALK_VOICE_MIN_VIDEO_KBPS   default 300         (floor before pausing video)

Build:
  - Server: ONE tiny endpoint POST /api/netprobe (discard body, time it).
    Optional -- skip it and use the WebRTC-probe / getStats path instead.
  - Minimal maxBitrate caps + the budget divider land in 30-4 (so the basic
    call already shares the uplink sanely).
  - NEW client slice 30-8 (adaptive quality): the pre-stream probe, the
    re-check scheduler (D2), the tier ladder + hysteresis (D3), the all-senders
    divider with screen>camera priority. Depends on 30-7 (a working share to
    adapt). TypeScript.
