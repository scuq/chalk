// 62-4: the unified conversation list as pure data -- ordering, fallbacks,
// preview rendering, unread mapping.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildConversationList,
  buildFriendList,
  buildVoiceOccupants,
  previewText,
  splitVoice,
  DELETED_PREVIEW,
  type ZuckerChannel,
} from "./zucker.ts";
import {
  PLACEHOLDER_NO_KEY,
  PLACEHOLDER_PLAINTEXT_BLOCKED,
} from "../crypto/channel-crypto.ts";
import { encodeGiphyBody } from "../giphy/giphy.ts";
import { encodeLinkPreviewBody } from "../linkpreview/linkpreview.ts";
import {
  selectRosterPrefs,
  type ChannelActivity,
  type ChannelUnread,
} from "../state/types.ts";

const ME = "user-me";
const THEM = "user-them";

// ---- previewText -----------------------------------------------------

test("plain text passes through, collapsed to one line and capped", () => {
  assert.equal(previewText("hello there"), "hello there");
  assert.equal(previewText("line one\nline two\t end "), "line one line two end");
  assert.equal(previewText("x".repeat(500)).length, 200);
});

test("giphy bodies preview as [gif]", () => {
  assert.equal(previewText(encodeGiphyBody("https://media.giphy.com/media/a/c.gif")), "[gif]");
});

test("link-preview bodies preview as the user's text, falling back to the title", () => {
  const preview = {
    url: "https://example.com/post",
    title: "Release notes",
    description: "d",
    site_name: "Example",
  };
  assert.equal(previewText(encodeLinkPreviewBody(preview, "have a look")), "have a look");
  assert.equal(previewText(encodeLinkPreviewBody(preview, "")), "Release notes");
});

test("placeholders and tombstones pass through honestly", () => {
  assert.equal(previewText(PLACEHOLDER_NO_KEY), PLACEHOLDER_NO_KEY);
  assert.equal(previewText(PLACEHOLDER_PLAINTEXT_BLOCKED), PLACEHOLDER_PLAINTEXT_BLOCKED);
  assert.equal(previewText(DELETED_PREVIEW), DELETED_PREVIEW);
});

test("an empty body is an attachment-only send", () => {
  assert.equal(previewText(""), "[attachment]");
  assert.equal(previewText("   \n "), "[attachment]");
});

// ---- buildConversationList -------------------------------------------

function ch(id: string, over: Partial<ZuckerChannel> = {}): ZuckerChannel {
  return {
    id,
    isDM: false,
    channelType: "text",
    createdAt: new Date(1000),
    memberIDs: [ME, THEM],
    ...over,
  };
}

function act(over: Partial<ChannelActivity> = {}): ChannelActivity {
  return {
    msgID: "m1",
    ts: 5000,
    seq: 5,
    senderUserID: THEM,
    preview: "hi",
    deleted: false,
    ...over,
  };
}

const un = (lastSeq: number, lastReadSeq: number, mention = false): ChannelUnread => ({
  lastSeq,
  lastReadSeq,
  mention,
});

const names = (c: ZuckerChannel) => (c.isDM ? "@them" : "#" + c.id);
const handles = (id: string) => (id === THEM ? "them" : id.slice(-4));

function build(
  order: string[],
  channels: Record<string, ZuckerChannel>,
  activity: Record<string, ChannelActivity> = {},
  unread: Record<string, ChannelUnread> = {},
  voiceRoomID: string | null = null,
) {
  return buildConversationList(order, channels, activity, unread, ME, voiceRoomID, names, handles);
}

test("rows sort by activity desc, falling back to createdAt", () => {
  const channels = {
    a: ch("a", { createdAt: new Date(100) }),
    b: ch("b", { createdAt: new Date(9000) }), // silent but newly created
    c: ch("c", { createdAt: new Date(200) }),
  };
  const activity = {
    a: act({ ts: 5000 }),
    c: act({ ts: 20000 }),
  };
  const rows = build(["a", "b", "c"], channels, activity);
  assert.deepEqual(rows.map((r) => r.id), ["c", "b", "a"]);
});

test("timestamp ties break by id for a stable order", () => {
  const channels = { b: ch("b"), a: ch("a") };
  const activity = { a: act({ ts: 5000 }), b: act({ ts: 5000 }) };
  const rows = build(["b", "a"], channels, activity);
  assert.deepEqual(rows.map((r) => r.id), ["a", "b"]);
});

test("DMs and channels mix in one list, DM rows carry the counterpart", () => {
  const channels = {
    dm: ch("dm", { isDM: true, createdAt: new Date(100) }),
    general: ch("general", { createdAt: new Date(50) }),
  };
  const rows = build(["dm", "general"], channels, { dm: act({ ts: 9000 }) });
  assert.equal(rows[0].id, "dm");
  assert.equal(rows[0].name, "@them");
  assert.equal(rows[0].otherUserID, THEM);
  assert.equal(rows[1].otherUserID, null);
});

test("own sends label as you, others by handle, purged senders as none", () => {
  const channels = { a: ch("a"), b: ch("b"), c: ch("c") };
  const activity = {
    a: act({ senderUserID: ME }),
    b: act({ senderUserID: THEM }),
    c: act({ senderUserID: null }),
  };
  const rows = build(["a", "b", "c"], channels, activity);
  const byID = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byID.a.previewSender, "you");
  assert.equal(byID.b.previewSender, "them");
  assert.equal(byID.c.previewSender, null);
});

test("a deleted newest message previews as deleted", () => {
  const rows = build(["a"], { a: ch("a") }, { a: act({ deleted: true, preview: null }) });
  assert.equal(rows[0].preview, DELETED_PREVIEW);
});

test("unread and mention map from cursors; voice dots only in the room", () => {
  const channels = {
    t: ch("t"),
    v: ch("v", { channelType: "voice" }),
  };
  const unread = { t: un(5, 3, true), v: un(5, 3) };
  let rows = build(["t", "v"], channels, {}, unread);
  const byID = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byID.t.unread, true);
  assert.equal(byID.t.mention, true);
  assert.equal(byID.v.unread, false); // not in the room
  rows = build(["t", "v"], channels, {}, unread, "v");
  assert.equal(Object.fromEntries(rows.map((r) => [r.id, r])).v.unread, true);
});

test("unknown order entries are skipped", () => {
  const rows = build(["a", "ghost"], { a: ch("a") });
  assert.deepEqual(rows.map((r) => r.id), ["a"]);
});

// ---- pref resolution (62-5) ------------------------------------------

test("viewMode resolves junk-safely: only the exact string zucker turns it on", () => {
  assert.equal(selectRosterPrefs(undefined).viewMode, "classic");
  assert.equal(selectRosterPrefs({}).viewMode, "classic");
  assert.equal(selectRosterPrefs({ roster: {} }).viewMode, "classic");
  assert.equal(selectRosterPrefs({ roster: { viewMode: "zucker" } }).viewMode, "zucker");
  assert.equal(
    selectRosterPrefs({ roster: { viewMode: "whatsapp" as never } }).viewMode,
    "classic",
  );
});

// ---- buildFriendList (64-1) ------------------------------------------

test("friends sort online first, then away, then offline, names within", () => {
  const rows = buildFriendList(
    [
      { userID: "u1", handle: "zed" },
      { userID: "u2", handle: "amy" },
      { userID: "u3", handle: "bob" },
      { userID: "u4", handle: "cat" },
    ],
    { u1: "online", u2: "offline", u3: "away", u4: "online" },
  );
  assert.deepEqual(
    rows.map((r) => `${r.name}:${r.presence}`),
    ["cat:online", "zed:online", "bob:away", "amy:offline"],
  );
});

test("missing or unknown presence resolves to offline", () => {
  const rows = buildFriendList(
    [
      { userID: "u1", handle: "a" },
      { userID: "u2", handle: "b" },
    ],
    { u2: "sleeping" },
  );
  assert.deepEqual(rows.map((r) => r.presence), ["offline", "offline"]);
});

test("handle-less friends fall back to a userID slice", () => {
  const rows = buildFriendList([{ userID: "user-123456789", handle: "" }], {});
  assert.equal(rows[0].name, "23456789");
});

// ---- splitVoice (95-2) -----------------------------------------------

test("splitVoice separates rooms from conversations, order preserved", () => {
  const rows = [
    { id: "a", isVoice: false },
    { id: "b", isVoice: true },
    { id: "c", isVoice: false },
    { id: "d", isVoice: true },
  ];
  const { rest, rooms } = splitVoice(rows);
  assert.deepEqual(rest.map((r) => r.id), ["a", "c"]);
  assert.deepEqual(rooms.map((r) => r.id), ["b", "d"]);
});

test("splitVoice handles all-voice and no-voice rosters", () => {
  assert.deepEqual(splitVoice([{ id: "a", isVoice: true }]).rest, []);
  assert.deepEqual(splitVoice([{ id: "a", isVoice: false }]).rooms, []);
  assert.deepEqual(splitVoice([]), { rest: [], rooms: [] });
});

test("a voice channel lands in the rooms half of a built list", () => {
  const channels: Record<string, ZuckerChannel> = {
    c1: { id: "c1", isDM: false, channelType: "text", createdAt: new Date(2_000) },
    c2: { id: "c2", isDM: false, channelType: "voice", createdAt: new Date(1_000) },
  };
  const rows = buildConversationList(
    ["c1", "c2"],
    channels,
    {},
    {},
    ME,
    null,
    (ch) => ch.id,
    (u) => u,
  );
  const { rest, rooms } = splitVoice(rows);
  assert.deepEqual(rest.map((r) => r.id), ["c1"]);
  assert.deepEqual(rooms.map((r) => r.id), ["c2"]);
});

// ---- buildVoiceOccupants (95-4) ---------------------------------------

const dev = (userID: string, deviceID: string, over = {}) => ({
  userID,
  deviceID,
  muted: false,
  videoOn: false,
  screenOn: false,
  ...over,
});

test("buildVoiceOccupants names each occupant, own entry as you", () => {
  const out = buildVoiceOccupants(
    { r1: [dev(ME, "d1"), dev("u2", "d2")] },
    ME,
    (_cid, u) => (u === "u2" ? "carol" : "?"),
  );
  assert.deepEqual(out.r1.map((o) => o.name), ["you", "carol"]);
});

test("buildVoiceOccupants resolves names per channel", () => {
  const out = buildVoiceOccupants(
    { r1: [dev("u2", "d1")], r2: [dev("u2", "d2")] },
    ME,
    (cid, u) => `${u}@${cid}`,
  );
  assert.equal(out.r1[0].name, "u2@r1");
  assert.equal(out.r2[0].name, "u2@r2");
});

test("buildVoiceOccupants merges one person's devices into one row", () => {
  const out = buildVoiceOccupants(
    {
      r1: [
        dev("u2", "phone", { muted: true, videoOn: true }),
        dev("u2", "laptop", { muted: true, screenOn: true }),
      ],
    },
    ME,
    (_cid, u) => u,
  );
  assert.equal(out.r1.length, 1);
  // Muted on every device, so muted; sending video from one and screen from
  // the other, so both badges show.
  assert.deepEqual(
    { muted: out.r1[0].muted, videoOn: out.r1[0].videoOn, screenOn: out.r1[0].screenOn },
    { muted: true, videoOn: true, screenOn: true },
  );
});

test("buildVoiceOccupants: one open mic means not muted", () => {
  const out = buildVoiceOccupants(
    { r1: [dev("u2", "phone", { muted: true }), dev("u2", "laptop")] },
    ME,
    (_cid, u) => u,
  );
  assert.equal(out.r1[0].muted, false);
});

test("buildVoiceOccupants keeps empty rooms as empty lists", () => {
  const out = buildVoiceOccupants({ r1: [] }, ME, (_cid, u) => u);
  assert.deepEqual(out, { r1: [] });
  assert.deepEqual(buildVoiceOccupants({}, ME, (_cid, u) => u), {});
});

test("buildVoiceOccupants with no viewer names every entry", () => {
  const out = buildVoiceOccupants({ r1: [dev(ME, "d1")] }, null, () => "dave");
  assert.equal(out.r1[0].name, "dave");
});
