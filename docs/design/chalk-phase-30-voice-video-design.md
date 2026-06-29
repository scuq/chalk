# chalk — PHASE 30: Voice/Video (Discord-style rooms, coturn-relayed, E2E)

Status: IMPLEMENTATION-READY design. Architecture: Discord-style persistent voice
channels (click to join, members see who's present), **mesh P2P with coturn as
the mandatory relay** (works WHEN P2P fails -- the common case), identity-bound
DTLS for anti-MITM, fully E2E (coturn relays encrypted SRTP it cannot decrypt).
Mesh hard-capped to small rooms (<=5). Written against the post-attachments tree;
matches chalk's real docker/Makefile/config conventions.

This supersedes the earlier voice-video sketch. Build the slices in order.

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
                 kind in {offer, answer, ice}; payload = E2E-encrypted SDP/ICE
                 (encrypted under the channel space key). Server routes by
                 (to_user, to_device); NEVER inspects payload.
  voice_state   {channel_id, muted, video_on}

Server -> client (pushes / acks):
  voice_join_ack {channel_id, roster:[{user_id,device_id,muted,video_on}],
                  ice_servers:[{urls, username, credential}]}   -- TURN creds here
  voice_participant_joined {channel_id, user_id, device_id}
  voice_participant_left   {channel_id, user_id, device_id}
  voice_participant_state  {channel_id, user_id, device_id, muted, video_on}
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
