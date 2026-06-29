# chalk — Attachments / Compose (images, files, paste, GIFs) — Design Spec

Status: design, pre-build. chalk-specific (read against the post-thread-fix tree).

---

## 0. The pivotal question: store blobs in Postgres?

**Short answer: yes, you CAN, and for a self-hosted single-operator app it's the
right default — with caveats and a clean migration path to object storage later.**

### Why DB storage is fine here
- chalk is self-hosted, single-operator, modest scale. You don't have the
  multi-tenant, petabyte, CDN-offload pressures that make people say "never put
  blobs in the DB."
- The body is ALREADY `bytea` and messages are range-partitioned — Postgres
  handles binary fine. Attachments are encrypted blobs (opaque ciphertext), so
  the DB is just a dumb store; no indexing/scanning of contents.
- One storage system = one backup, one access-control story, one consistency
  model. For E2E especially, "the server only ever holds ciphertext" is simplest
  when there's no second storage system (S3 bucket policies, signed URLs, etc.).

### The caveats (and how to handle each)
- **TOAST / row bloat:** Postgres auto-TOASTs large `bytea` out-of-line, so big
  blobs don't bloat the main row. Fine. But put attachments in their OWN table
  (`attachments`), NOT inline in `messages.body` — keeps the hot message-feed
  query small and lets you prune/offload blobs independently.
- **Size cap:** enforce a hard per-attachment limit (e.g. 10 MiB) and a per-
  message total. Don't let the DB become a file dump.
- **The 1 MiB WS frame limit is the REAL constraint** (proto.MaxFrameBytes).
  A 10 MiB encrypted image cannot ride in one WS frame. -> CHUNKED UPLOAD over a
  separate HTTP endpoint, not the WS. (See §3.) This is the single biggest
  architectural point and it's independent of DB-vs-S3.
- **Migration path:** because attachments live in their own table keyed by id
  with a `storage` discriminator, swapping the bytes' home from a `bytea` column
  to S3/MinIO later is a localized change (the store method for read/write),
  not a schema-wide rewrite. Design the boundary now, store in DB today.

### Verdict
Store encrypted attachment bytes in a dedicated `attachments` table (`bytea`,
TOAST handles size), behind a store interface that could later point at object
storage. Upload/download via chunked HTTP (not WS) to respect the frame limit.

---

## 1. What the feature is

In the Composer:
- **Attach files/images** via a button (file picker) AND drag-drop.
- **Paste images** (Ctrl/Cmd+V of a screenshot or copied image) -> becomes an
  attachment automatically. (This is the killer feature; clipboard image paste.)
- **GIPHY picker** -> pick a GIF; it's fetched and attached (or referenced —
  see §6, the GIF privacy fork).
- A message can carry text AND/OR one+ attachments.
- In the feed: images render inline (thumbnail -> click to enlarge); non-image
  files show a name + size + download control.

All attachment bytes are **end-to-end encrypted** with the channel space key,
exactly like message text — the server only ever stores ciphertext.

---

## 2. Encryption model (reuses everything)

An attachment is just bytes. `encryptMessage(spaceKey, channelID, version, bytes)`
already encrypts arbitrary Uint8Array — so an attachment encrypts the SAME way a
text body does, under the channel's current key version. No new crypto.

- Each attachment is encrypted independently (its own nonce), under the channel's
  current key version at send time.
- Metadata that must be encrypted too (filename, mime type are sensitive — they
  leak content): encrypt a small JSON header `{name, mime, size}` alongside, OR
  fold it into the encrypted blob's prefix. The SERVER must not see filename/mime
  in cleartext (it'd leak "alice sent tax_return.pdf"). So: mime/name live in the
  ENCRYPTED metadata, not server columns. The server sees only: id, message ref,
  ciphertext, byte length, key version.
- Forward-only access / rotation / removal all apply automatically: an attachment
  is decryptable iff you hold its key version — same as messages. A removed
  member can't read new attachments. (Consistency with everything built.)

## 3. Upload/download transport — CHUNKED HTTP, not WS

The 1 MiB WS frame limit makes WS unsuitable for multi-MB blobs. Use the
existing authenticated HTTP layer (auth/http.go) for blob transfer:

UPLOAD (client -> server), per attachment:
1. Client encrypts the blob locally (channel key) -> ciphertext (could be 10 MiB).
2. Client POSTs an "init" -> server returns an `attachment_id` + an upload session.
3. Client uploads ciphertext in CHUNKS (e.g. 512 KiB) to a PUT endpoint
   (`/attachments/{id}/chunk?seq=N`), server appends to the row's bytea (or a
   staging area, then assembles). Auth via the existing session.
4. Client finalizes -> server marks the attachment complete, records byte length
   + key version (NOT mime/name — those are in the encrypted metadata).
5. Client sends the normal `send` WS frame, whose payload now references the
   attachment id(s) (+ the encrypted metadata blob, which is small, can ride the
   WS frame).

DOWNLOAD (server -> client):
- GET `/attachments/{id}` (authed; server checks the requester is a member of the
  attachment's channel) -> streams ciphertext. Client decrypts with the channel
  key + version. Image renders; file offers save.
- Range requests / streaming optional later; v1 can download whole.

Why chunked + HTTP: respects MaxFrameBytes, doesn't block the WS message channel
with megabytes, reuses HTTP auth, and supports progress UI.

## 4. Schema (migration 00xx)

    attachments (
      id            UUID PK,
      channel_id    UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      message_id    UUID,             -- set on finalize/send; null while uploading
      message_ts    TIMESTAMPTZ,      -- messages are partitioned on ts; need both
      uploader_device_id UUID NOT NULL,
      key_version   INT NOT NULL,     -- which channel key version it's encrypted under
      byte_len      BIGINT NOT NULL,  -- ciphertext length (server-visible; fine)
      ciphertext    BYTEA,            -- the encrypted blob (TOASTed). nullable while chunking
      enc_meta      BYTEA NOT NULL,   -- encrypted {name,mime,size,kind} (server-opaque)
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      status        TEXT NOT NULL DEFAULT 'uploading'  -- uploading|complete|orphaned
    )
    -- index on (channel_id), (message_ts, message_id) for feed joins
    -- a 'storage' column could discriminate db|s3 later; v1 = db only

Server-visible columns leak NOTHING sensitive: just sizes, channel, key version,
timestamps. name/mime/kind are inside enc_meta (E2E).

The message wire payload gains an `attachments: [{id, enc_meta, byte_len,
key_version}]` array (small — the heavy ciphertext is fetched separately).

## 5. Client UX (Composer + feed)

Composer (Composer.tsx):
- Attach button (paperclip) -> file picker (accept image/*, plus any file).
- **Paste handler**: on paste, inspect clipboardData.items for an image ->
  capture as a File -> add to a pending-attachments tray below the textarea.
- **Drag-drop**: dragover/drop on the composer -> same tray.
- Pending tray: thumbnails for images, name+size chips for files, an x to remove
  each, an upload-progress bar per item once sending.
- Send: encrypt each pending attachment -> chunked upload -> then the send frame
  with the attachment ids. Text + attachments in one message.

Feed (MessageList.tsx):
- Image attachments: lazy-load + decrypt -> render a bounded thumbnail; click to
  open full (a lightbox, or just larger inline). Use object URLs from the
  decrypted bytes; revoke on unmount.
- File attachments: a row with name (from enc_meta), size, a download button
  (fetch -> decrypt -> trigger browser save with the real filename).
- Respect fail-closed: if the key isn't available, show a "locked attachment"
  placeholder, never raw bytes.

## 6. GIPHY — and its privacy fork

GIPHY is different from a normal attachment: the GIF lives on Giphy's CDN.
Two models, a real fork:

A. **Re-host (encrypt) the GIF** — fetch the chosen GIF bytes client-side, then
   treat it as a normal encrypted attachment (upload ciphertext to chalk). PRO:
   fully E2E, no third-party sees who's in the channel; the GIF is as private as
   any image. CON: bigger blobs in your DB; you fetch from Giphy at pick time.
   RECOMMENDED for an E2E app — consistency with the "server only holds
   ciphertext" promise.

B. **Reference the Giphy URL** — store just the URL; clients load it from Giphy's
   CDN at render. PRO: tiny, no blob storage. CON: leaks to Giphy (every member's
   browser hits Giphy's CDN -> Giphy sees IPs + which GIF -> partial metadata
   leak), and the URL itself rides in the encrypted body so chalk's server
   doesn't see it, but Giphy does at render. BREAKS the E2E/no-third-party
   property.

For an app whose entire identity is E2E privacy, **A (re-host) is the
consistent choice**, even at a storage cost. The Giphy API key (for search) is a
server-side secret (CHALK_GIPHY_API_KEY env) — proxy search through chalkd so the
client never holds the key and Giphy doesn't even see the end-user during SEARCH
(only chalkd's server IP). Then re-host the picked GIF. That keeps Giphy at
arm's length for both search and display.

## 7. Limits / config (env, per the governance precedent)

    CHALK_ATTACH_MAX_BYTES        default 10485760  (10 MiB) per attachment
    CHALK_ATTACH_MAX_PER_MESSAGE  default 10
    CHALK_ATTACH_CHUNK_BYTES      default 524288    (512 KiB) upload chunk
    CHALK_GIPHY_API_KEY           (optional; enables the GIF picker if set)
    CHALK_ATTACH_TOTAL_QUOTA_*    (optional later: per-user/per-channel quota)

Server enforces max bytes BEFORE storing; rejects oversize at init.

## 8. The forks to decide before building

1. **GIF model: re-host (E2E) vs URL-reference (leaks to Giphy)?**
   (Recommend A, re-host — matches chalk's E2E identity.)
2. **Max attachment size?** (Recommend 10 MiB; bump via env.)
3. **Image thumbnails:** client-side downscale a thumbnail and store it as a
   SECOND small encrypted attachment (fast feed, fetch full on click), or just
   fetch+downscale the full image in the browser? (Recommend: v1 fetch full +
   CSS-bound size; add encrypted thumbnails later if the feed feels heavy.)
4. **Orphan cleanup:** uploads that never get a send frame (status='uploading'
   forever) — a janitor that prunes stale uploading rows after N hours.
   (Recommend yes, a simple periodic sweep — reuse the partition/janitor pattern.)
5. **Download authz granularity:** member-of-channel is the check. Confirm:
   a removed member can't GET old attachments? They can't decrypt (no key), but
   should the server also refuse the BYTES to non-members? (Recommend yes —
   server refuses ciphertext to non-members; defense in depth, cheap.)
6. **Build split** (below).

## 9. Build split (multi-phase — fresh session per phase)

This is a SUBSTANTIAL arc, comparable to governance. Phases:

- **att-1 (server core):** migration (attachments table); store (CreateAttachment,
  AppendChunk/PutCiphertext, FinalizeAttachment, GetAttachment, member-authz
  read); the chunked HTTP upload + download endpoints (auth/http.go); orphan
  janitor. Wire the message payload's attachments array (proto + send handler
  records the refs). MOSTLY GO + HTTP. The meaty part.
- **att-2 (client core):** encrypt/upload pipeline (chunked POST), the message
  send carrying attachment refs, download+decrypt, and feed RENDERING (inline
  images + file rows) with fail-closed placeholders. TypeScript.
- **att-3 (composer UX):** the paperclip + file picker + DRAG-DROP + PASTE
  handler + pending-attachments tray + per-item progress. TypeScript, the
  delightful part.
- **att-4 (GIPHY):** server search proxy (CHALK_GIPHY_API_KEY) + the GIF picker
  UI + re-host-on-pick (reuses att-1/att-2 pipeline). Optional / gated on the key.

Recommend building att-1 -> att-2 -> att-3 first (a working attach/paste/render
loop), then att-4 (GIPHY) as a self-contained add-on.

## 10. What this reuses (already built + validated)

- encryptMessage / decryptMessage (arbitrary bytes) — attachments encrypt like text.
- The channel key + version + rotation + removal model — attachments inherit
  forward-only access and revocation for free.
- The HTTP auth layer (sessions) — for the chunked endpoints.
- The env-config pattern (CHALK_*) — for the limits.
- The Composer + MessageList components — extended, not replaced.

## 11. Honest scope note

This is a multi-phase feature touching crypto (reuse), a new HTTP transport
(new), a new table + storage boundary (new), and significant client UX (new).
The single hardest architectural decision — DB blobs + chunked HTTP because of
the 1 MiB WS frame limit — is settled above. Build server-first
(att-1) in a fresh session; it's Go + HTTP that the sandbox can't fully compile,
so proxy-validate + your go build gate, exactly like every prior phase.


---

# GIPHY DECISION — FINALIZED: URL-reference + per-user opt-in consent

Supersedes §6. The user chose URL-reference (B) over re-host, with an explicit
informed-consent gate. Re-host was rejected: it reads against GIPHY User Terms
§5 (no copy/transmit/distribute of their content outside the Services) and rests
on shaky redistribution rights for licensed clips. URL-reference is terms-
friendly (display from Giphy's infra, as intended) BUT leaks each viewer's IP +
which GIF to Giphy's CDN at render -- which breaks chalk's E2E/no-third-party
property. Resolution: make that leak OPT-IN and informed, default OFF.

## Key finding from the code (scopes this cleanly)

The message feed currently renders ZERO remote content -- no <a>, href, fetch,
Image, markdown, or linkify; bodies are plain text. So Giphy would be the FIRST
and ONLY remote fetch chalk ever performs. The "declined" fallback (render the
Giphy link as inert text) is exactly today's behavior. The consent gate is thus
cleanly scoped to Giphy alone; there is no pre-existing link-fetching to widen.

## Consent state: TRI-STATE per user (not a boolean)

Stored in the existing user_preferences JSONB (migration 0020; lazy-merged via
||). New key e.g. prefs.giphy: "unset" | "enabled" | "disabled". Default absent
= "unset".

  - unset:    no Giphy fetching. On the FIRST trigger (user clicks the Giphy
              button in the composer, OR a Giphy-URL message is RECEIVED and
              would-be-rendered), show the consent modal explaining the leak.
  - enabled:  user accepted. Composer Giphy picker works (can send); received
              Giphy URLs render as actual GIFs (fetched from Giphy CDN).
  - disabled: user declined. Cannot send Giphy GIFs (button hidden/disabled);
              received Giphy URLs render as PLAIN INERT TEXT (no fetch, ever).
              A small "enable Giphy in settings" hint may accompany, but NEVER
              auto-fetches.

Settings panel: a Giphy toggle that sets enabled/disabled directly (and can
flip later either way). The modal is just the first-touch path to the same pref.

## Consent is PER-VIEWER, two-sided (the important privacy invariant)

Sending and rendering are independently gated by the LOCAL user's pref:
  - To SEND a Giphy GIF: the SENDER must be "enabled".
  - To RENDER a received Giphy URL as a GIF: the RECEIVER must be "enabled".
One person enabling Giphy NEVER causes anyone else's browser to fetch from Giphy.
The Giphy URL travels inside the normal E2E-encrypted body; each recipient's
client independently decides fetch-vs-text based on THEIR OWN pref. So a member
who never consented leaks nothing, even in a channel full of Giphy users.

## Wire / rendering model

- A Giphy GIF is sent as a normal text message whose body IS (or contains) the
  Giphy URL. No new message type strictly required; but RECOMMEND a small
  structured marker so the client can reliably distinguish "this is a Giphy GIF"
  from "user happened to type a giphy.com link". Options:
    (a) a message metadata flag kind="giphy" + the url, or
    (b) a sentinel body format the client parses.
  Recommend (a) -- explicit, avoids fragile URL-sniffing of arbitrary text.
- On receive, client: if body/kind indicates Giphy AND pref==enabled -> render
  an <img> from the Giphy URL (CDN fetch happens HERE -- the only leak point).
  If pref!=enabled -> render the URL as plain text (inert; selectable; no fetch).
- URL host allowlist: only fetch from known Giphy hosts (media*.giphy.com,
  i.giphy.com, etc.). Never fetch arbitrary hosts even when "enabled" -- prevents
  a malicious sender turning the feature into an IP-grabber/SSRF-on-client via a
  non-Giphy URL dressed as a GIF. This allowlist is a SECURITY control, not just
  tidiness.

## Search: still proxy through chalkd (API key server-side)

The GIF PICKER's search hits Giphy's API -- proxy it through chalkd
(CHALK_GIPHY_API_KEY env) so the key never reaches the client and Giphy sees
only chalkd's server IP during SEARCH (not the end user). The privacy leak is
confined to the RENDER fetch (unavoidable with URL-reference) and only for
consented users. Picker is only shown to "enabled" users.

## Why this is the right call

- Honors chalk's privacy-by-default identity: zero third-party contact unless
  the user explicitly, informedly opts in.
- Terms-friendly: content displays from Giphy's infrastructure as their terms
  contemplate; no re-hosting/redistribution.
- Defense-in-depth: host allowlist prevents the URL-render path from becoming a
  generic remote-fetch/SSRF vector.
- Lighter to build than re-host: NO blob storage, NO chunked upload, NO GIF-byte
  encryption. Just a tri-state pref, a consent modal, a kind="giphy" marker,
  conditional render, and a server-proxied search.

## Build placement

This becomes att-4 (GIPHY), now reframed as URL-reference+consent. Still build
att-1/2/3 (own attachments: paste, drag-drop, picker, encrypted DB blobs) FIRST
-- they're the unambiguous core and share nothing with Giphy. att-4 is a self-
contained add-on: prefs key + consent modal + giphy kind + search proxy + gated
render. Note att-4 here is SMALLER than the original re-host att-4 (no upload
pipeline reuse needed; it's URLs, not blobs).

## att-4 forks (small)

- Marker model: kind="giphy"+url (recommend) vs body-sentinel.
- Settings UX: plain toggle + first-touch modal (recommend both: modal is the
  first-touch entry to the same pref).
- Allowlist hosts: enumerate the Giphy CDN hosts to permit.
- Does declining HIDE the composer Giphy button entirely, or show it disabled
  with a "enable in settings" tooltip? (Recommend: show disabled w/ tooltip --
  discoverable, not nagging.)


---

# STORAGE & PERFORMANCE REFINEMENTS (att-1/att-2) — FINALIZED

User input, folded in. These materially refine the att-1 schema and att-2
render pipeline. Build to THIS for the storage/preview/cache concerns.

## S1. Partition the attachments table by time (aligned with messages)

messages is range-partitioned on ts (monthly). Partition `attachments` by
`created_at` on the SAME monthly cadence so:
- a bounded history fetch only touches recent partitions on BOTH tables,
- the attachments<->messages join stays partition-aligned,
- old attachments can be pruned by DROPping old partitions (cheap retention).

Reuse the existing partition-ensure machinery (the "partitions ensured for
current and next month" startup step) for the attachments table too.

    attachments ( ... created_at TIMESTAMPTZ NOT NULL DEFAULT now() ... )
      PARTITION BY RANGE (created_at)
    -- monthly child partitions, ensured at startup like messages

## S2. Bounded backward fetch window (ENV-configurable, default ~1 day)

History backfetch should not pull all attachments ever. The attachment fetch
FOLLOWS the message window already loaded by the feed (seq-windowed). Add a sane
default lookback so the FIRST load and re-fetches stay cheap:

    CHALK_ATTACH_FETCH_WINDOW_HOURS   default 24   (~1 day)

On channel open / history load, attachments are fetched only for messages within
the window; older images load their previews on demand as the user scrolls back
(the message rows already lazy-paginate; attachments piggyback on that). The
window bounds the EAGER fetch; scrolling further back fetches older partitions
lazily.

## S3. Inline images = TWO encrypted blobs: preview (always) + full (on demand)

The privacy constraint: the server only ever holds ciphertext, so the PREVIEW
must be generated CLIENT-SIDE before encryption. The server cannot downscale.

On send, for an inline-displayable type (image/*):
1. Client downscales to a small preview (e.g. max 320px longest edge, low
   quality JPEG/WebP) -> a few KB.
2. Client encrypts BOTH the preview and the full image (channel key, current
   version), independently.
3. Upload: the full via chunked HTTP (§3); the preview is tiny -> either a
   single small HTTP PUT or even inlined into the attachment's enc_meta-adjacent
   field. Preview is small enough to fetch eagerly with the feed.

Schema: one attachment row carries BOTH (they are one logical attachment; never
orphan a preview from its full):

    attachments (
      ...
      enc_preview   BYTEA,         -- encrypted low-res preview (image kinds only; null otherwise)
      preview_len   INT,
      ciphertext    BYTEA,         -- encrypted full blob (TOASTed; chunk-assembled)
      byte_len      BIGINT,        -- full ciphertext length
      enc_meta      BYTEA NOT NULL,-- encrypted {name,mime,kind,width,height,...}
      ...
    )

Render pipeline (att-2):
- Feed paints the PREVIEW immediately (decrypt the small enc_preview; cheap).
  Bounded by CSS to the display size; blurry-but-instant.
- When the image row scrolls INTO VIEW (IntersectionObserver), fetch+decrypt the
  FULL ciphertext and swap it in ("fast reload of the actual image"). Scrolling
  away keeps the preview; scrolling back hits the cache (S4).
- Non-image / non-previewable types: no preview; show a file row (name+size+
  download), fetch full only on explicit download click.

This is the standard progressive-image pattern, made E2E: preview-first, full-
on-demand, both encrypted, server sees neither in cleartext.

## S4. Client-side image cache (decrypted) — with a privacy fork

Once a full image is fetched+decrypted, cache it so scroll-away/back doesn't
re-fetch+re-decrypt. FORK on where:

  A. In-memory LRU object-URL cache (default, RECOMMENDED): decrypted bytes live
     only for the session; evaporate on reload. Safest (no plaintext at rest),
     consistent with chalk's privacy-by-default. Cap by count/bytes (LRU evict);
     revoke object URLs on eviction/unmount.
  B. Persistent IndexedDB cache (opt-in): decrypted images survive reload ->
     faster warm starts, BUT plaintext images at rest on disk. Some threat models
     reject this. Make it an explicit user opt-in, never default.

Recommend: ship A (in-memory LRU) in att-2; offer B as a later opt-in pref if
warm-start speed is wanted. Previews can use the same in-memory cache.

## S5. Size limit (ENV) — FINALIZED

    CHALK_ATTACH_MAX_BYTES   default 20971520   (20 MiB) per FULL attachment

- Enforced at upload-init: server rejects oversize BEFORE storing any bytes.
- Applies to the full blob; the preview is tiny and separate (not counted, but
  bounded by the downscale).
- 20 MiB / 512 KiB chunks ~= 40 chunks/attachment -> confirms chunked HTTP is
  mandatory (1 MiB WS frame can't carry it).
- Per-message count limit still applies (CHALK_ATTACH_MAX_PER_MESSAGE, default 10).

## S6. Updated att-1 / att-2 scope notes

att-1 (server) now also: PARTITION BY RANGE(created_at) + partition-ensure at
startup; enc_preview/preview_len columns; the fetch-window-bounded list query;
retention-friendly (drop-old-partition) shape.

att-2 (client) now also: client-side downscale->preview-encrypt on SEND; the
preview-first / full-on-scroll IntersectionObserver render; the in-memory LRU
decrypted-image cache (S4-A).

## S7. New/updated env knobs (consolidated)

    CHALK_ATTACH_MAX_BYTES            20971520   (20 MiB) per full attachment
    CHALK_ATTACH_MAX_PER_MESSAGE      10
    CHALK_ATTACH_CHUNK_BYTES          524288     (512 KiB)
    CHALK_ATTACH_FETCH_WINDOW_HOURS   24         (eager backfetch window)
    CHALK_ATTACH_PREVIEW_MAX_EDGE     320        (px, preview downscale longest edge)
    CHALK_GIPHY_API_KEY               (optional; enables Giphy search proxy)


---

# S4 DECISION — FINALIZED: persistent IndexedDB cache (operator's choice)

User chose B (persistent IndexedDB) over A (in-memory). Recorded as a deliberate,
operator-chosen tradeoff for a self-hosted/trusted-device deployment.

## The tradeoff (stated plainly)

- BUYS: fast warm starts; scroll-back through history doesn't re-fetch/re-decrypt;
  images survive reload. Better UX for an image-heavy feed.
- COSTS: decrypted image bytes persist ON DISK (plaintext at rest), outside the
  ciphertext-only model that protects everything else. Anyone with access to the
  device's browser profile can read cached images WITHOUT the channel key. This
  weakens chalk's "nothing plaintext at rest" property for cached images
  specifically. Acceptable for trusted-device/self-hosted use; would not suit a
  high-threat deployment. Operator's deliberate call.

## Important framing (why it's defensible)

A cached decrypted image is plaintext the user ALREADY viewed on screen. The
cache keeps a copy of content already decrypted for that user; it does not expose
anything they couldn't already see. This is true of any app that displays an
image. So persistent caching does not create a NEW disclosure beyond "this device
retained an image its user already opened." Key rotation / member removal do not
retroactively unsee it (same forward-secrecy reality as messages).

## Guardrails REQUIRED for the persistent path (build into att-2)

1. BOUNDED LRU: IndexedDB is not infinite. Cap the cache by total bytes
   (configurable, e.g. CHALK_ATTACH_CACHE_MAX_BYTES surfaced client-side, default
   e.g. 256 MiB) and evict least-recently-used decrypted images past the cap.
2. CLEAR-ON-LOGOUT + manual clear control: because plaintext images persist,
   the logout / "clear local data" flow MUST wipe this cache (alongside the
   space-key cache it already clears). Add a visible "clear cached images" action
   in settings too. Without an off-ramp, plaintext images outlive the session
   uncontrollably.
3. CACHE KEY = attachment-id (+ key-version): stable, content-addressed. No need
   to invalidate on rotation (the bytes are already-seen plaintext), but DO purge
   on logout/clear and on LRU eviction; revoke any derived object URLs.
4. Store DECRYPTED bytes (or an object URL's backing blob) keyed by attachment-id;
   previews may share the same store with their own keys.

## Net

Persistent IndexedDB cache, LRU-bounded, wiped on logout + via a settings
control. att-2 implements this instead of the in-memory LRU. The space-key cache
clear path already exists (spacekey cache clear) -- extend that same teardown to
also clear the image cache.


---

# S4 CORRECTION — at-rest posture stated accurately

A question surfaced that my earlier S4 framing was imprecise. Checked the code:
chalk's IndexedDB (web/src/crypto/idb.ts) has exactly THREE stores:
  - identity (user keypair), keyed by userID
  - space keys (channel keys), keyed by cacheKey
  - verification records, keyed by peerUserID
There is NO message store. Decrypted message TEXT is never persisted -- it lives
only in in-memory app state and evaporates on reload; ciphertext is re-fetched
and re-decrypted each session.

So the accurate at-rest picture:
- Text is NOT plaintext at rest. BUT the KEYS are at rest. With the space keys on
  disk, all history is already recoverable AT REST by someone who has the browser
  profile AND can reach the server (fetch ciphertext, decrypt with cached keys).
- A persistent decrypted-IMAGE cache (S4-B) does NOT "introduce plaintext at rest
  where there was none" (my earlier overstatement) -- the keys already make data
  recoverable at rest. What it DOES add: cached images become recoverable from the
  PROFILE ALONE -- offline, without server access, and independent of later key
  rotation / member removal / server-side deletion. That is a real but SMALLER
  delta than first stated.
- Equally, the "no new disclosure at all" framing was too generous: self-contained
  on-disk plaintext (no server needed) IS a new property vs today's keys-only.

Corrected tradeoff for the persistent image cache (S4-B), which remains the
chosen option:
  You are NOT breaking a pristine no-plaintext-at-rest guarantee (the keys already
  compromise that for anyone with profile+server). You ARE removing the "+ server
  access" qualifier for cached images: they become directly readable from the disk
  profile by itself. For a trusted-device / self-hosted deployment that is a
  reasonable operator call. The S4-B guardrails (LRU bound; clear-on-logout;
  settings "clear cached images"; revoke object URLs) are what keep it managed.

This corrects the S4 rationale only; the DECISION (persistent IndexedDB, with
guardrails) stands.


---

# S4 FINAL — cache CIPHERTEXT in IndexedDB (best option; supersedes S4-A/B)

User asked: can the image cache be stored ENCRYPTED in IndexedDB under our model?
Yes -- and it is the right answer. It resolves the plaintext-at-rest tension that
S4-A (in-memory) and S4-B (plaintext IndexedDB) traded off against speed. The
plaintext-vs-in-memory fork was a false dichotomy; caching CIPHERTEXT is the
third option that keeps the warm-start win without the at-rest carve-out.

## What to cache: the server's ciphertext, unchanged

An attachment arrives from the server ALREADY encrypted under the channel key/
version. So the cache stores that ciphertext blob DIRECTLY in IndexedDB -- no
decrypt-then-re-encrypt, no separate cache key. On read: pull ciphertext from
IndexedDB, decrypt IN MEMORY (same as a fresh server fetch), make a transient
object URL, render, revoke on eviction/unmount. Previews cached the same way.

Reuses the existing channel-key encryption; NO new key management.

## At-rest posture (stated honestly)

- Every byte chalk writes to disk is now ciphertext -- the image cache no longer
  is a plaintext-at-rest carve-out. chalk's "only ciphertext touches disk"
  invariant holds uniformly (identity, space keys, verification, and now image
  cache are all non-plaintext / key-protected).
- Against a FULL-PROFILE attacker (has both the image-cache store AND the
  space-key store): ciphertext caching is NOT materially stronger than plaintext
  caching -- they hold the space key, so they can decrypt either way. Be honest
  about this: it does not defeat total profile compromise.
- Against PARTIAL / SECONDARY threats it IS stronger: forensic object-store dumps,
  backup/sync copying IndexedDB to cloud, other scripts/extensions with limited
  storage reach, casual inspection. Plaintext caching hands over a viewable image;
  ciphertext caching requires ALSO grabbing the space-key store and reconstructing
  chalk's decryption. Restores consistency: no special-case plaintext on disk.

Net: same recoverability as any message (need profile + space key), zero new
plaintext-at-rest surface, defends the common partial-access cases.

## Performance: warm-start win preserved

The expensive part of a cold load is the NETWORK fetch of the multi-MB blob.
Caching ciphertext locally still skips the network entirely; you re-pay only the
in-memory AES-GCM decrypt (milliseconds even at 20 MiB). User-perceptible
difference vs plaintext caching is negligible; the speed came from avoiding the
re-fetch, which this keeps.

## Render path: unchanged from fresh-fetch

Can't hand IndexedDB ciphertext to <img> directly -- decrypt -> bytes ->
object URL -> render -> revoke. But that is ALREADY the fresh-fetch path
(server ciphertext -> decrypt -> object URL); the cache just swaps
"fetch from server" for "read from IndexedDB". No new render complexity.

## Guardrails (as before, still apply)

LRU bound by total bytes (CHALK_ATTACH_CACHE_MAX_BYTES client-side, e.g. 256 MiB);
clear-on-logout + settings "clear cached images"; cache key = attachment-id
(+ key-version); revoke object URLs on eviction. (Clear-on-logout matters less
now that the cache is ciphertext, but keep it for hygiene + to drop disk usage.)

## Comparison (final)

  plaintext IndexedDB : fast, BUT plaintext at rest (carve-out), breaks invariant
  in-memory only      : no at-rest data, BUT re-fetch every session (slow warm)
  CIPHERTEXT IndexedDB: fast (skip network), NO plaintext at rest, reuses channel
                        key, same render path, preserves invariant  <-- CHOSEN

att-2 implements ciphertext-in-IndexedDB. This is strictly better than the
earlier S4-B plaintext choice and is the final S4 decision.
