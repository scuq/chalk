// The rules engine: event -> priority -> actions.
//
// The precedence order is the whole feature -- "boost this friend" only
// works if a user rule reliably beats the channel it happened in -- so
// most of this file is the resolve matrix. The normalize tests hold the
// same totality contract prefs already promise: garbage in, usable
// config out.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TYPE_PRIORITIES,
  NOTIFY_EVENT_TYPES,
  actionsFor,
  defaultRulesConfig,
  normalizeRulesConfig,
  resolvePriority,
  withChannelRule,
  withProfileAction,
  withTypeDefault,
  withUserRule,
  type NotifyRules,
  type RuleFacts,
} from "./rules.ts";
import { publishNotifyEvent, subscribeNotifyEvents, type NotifyEvent } from "./bus.ts";
import { seedRulesFromSoundCategories } from "./rules-store.ts";

function rules(over: Partial<NotifyRules> = {}): NotifyRules {
  return { defaults: { ...DEFAULT_TYPE_PRIORITIES }, users: {}, channels: {}, ...over };
}

const ev = (over: Partial<RuleFacts> = {}): RuleFacts => ({
  type: "message",
  senderUserID: "u1",
  channelID: "c1",
  ...over,
});

test("no overrides: the event type default decides", () => {
  for (const t of NOTIFY_EVENT_TYPES) {
    assert.equal(resolvePriority(ev({ type: t }), rules()), DEFAULT_TYPE_PRIORITIES[t]);
  }
});

test("a channel rule beats the type default", () => {
  const r = rules({ channels: { c1: 4 } });
  assert.equal(resolvePriority(ev(), r), 4);
  assert.equal(resolvePriority(ev({ channelID: "c2" }), r), DEFAULT_TYPE_PRIORITIES.message);
});

test("a user rule beats the channel rule", () => {
  const r = rules({ users: { u1: 4 }, channels: { c1: 0 } });
  assert.equal(resolvePriority(ev(), r), 4, "boosted friend heard even in a muted channel");
  assert.equal(resolvePriority(ev({ senderUserID: "u2" }), r), 0, "everyone else stays muted");
});

test("mute is a priority, so it wins by the same precedence", () => {
  assert.equal(resolvePriority(ev(), rules({ users: { u1: 0 } })), 0);
  assert.equal(resolvePriority(ev(), rules({ channels: { c1: 0 } })), 0);
});

test("a user rule applies across event types", () => {
  const r = rules({ users: { u1: 4 } });
  for (const t of NOTIFY_EVENT_TYPES) {
    assert.equal(resolvePriority(ev({ type: t }), r), 4);
  }
});

test("events without a sender or channel skip those tiers", () => {
  const r = rules({ users: { u1: 4 }, channels: { c1: 4 } });
  assert.equal(
    resolvePriority({ type: "message" }, r),
    DEFAULT_TYPE_PRIORITIES.message,
    "no facts to match on means the default",
  );
});

test("mute produces no actions regardless of profiles", () => {
  const { profiles } = defaultRulesConfig();
  assert.deepEqual(actionsFor(0, profiles), { sound: false, banner: false, blink: false });
});

test("priorities map through the profile table", () => {
  const { profiles } = defaultRulesConfig();
  assert.equal(actionsFor(1, profiles).sound, true);
  assert.equal(actionsFor(1, profiles).banner, false);
  assert.equal(actionsFor(4, profiles).banner, true);
  assert.equal(actionsFor(4, profiles).blink, true);
});

test("normalize: garbage in, defaults out", () => {
  for (const junk of [null, undefined, 42, "x", [], { rules: "no", profiles: 7 }]) {
    assert.deepEqual(normalizeRulesConfig(junk), defaultRulesConfig());
  }
});

test("normalize: valid pieces survive, invalid pieces fall back", () => {
  const config = normalizeRulesConfig({
    rules: {
      defaults: { message: 3, dm: "loud", bogus_type: 4 },
      users: { u1: 4, u2: 9, "": 3 },
      channels: { c1: 0 },
    },
    profiles: { 1: { sound: false, banner: "yes" }, 4: { blink: false } },
  });
  assert.equal(config.rules.defaults.message, 3);
  assert.equal(config.rules.defaults.dm, DEFAULT_TYPE_PRIORITIES.dm);
  assert.ok(!("bogus_type" in config.rules.defaults));
  assert.deepEqual(config.rules.users, { u1: 4 });
  assert.deepEqual(config.rules.channels, { c1: 0 });
  assert.equal(config.profiles[1].sound, false);
  assert.equal(config.profiles[1].banner, false, "non-boolean falls back to default");
  assert.equal(config.profiles[4].blink, false);
  assert.equal(config.profiles[4].banner, true, "untouched fields keep defaults");
});

test("normalize: overrides for unknown ids are kept", () => {
  // A rule made on another device for a channel this one hasn't loaded
  // must not be silently deleted by a round-trip through normalize.
  const config = normalizeRulesConfig({
    rules: { defaults: {}, users: { "u-elsewhere": 2 }, channels: { "c-elsewhere": 0 } },
    profiles: {},
  });
  assert.equal(config.rules.users["u-elsewhere"], 2);
  assert.equal(config.rules.channels["c-elsewhere"], 0);
});

test("v1 seed: a switched-off chat category becomes a muted type", () => {
  const config = seedRulesFromSoundCategories({
    mention: true,
    dm: false,
    thread_reply: false,
    message: true,
    // Machine categories must not leak into rules.
    presence: false,
    error: false,
  });
  assert.equal(config.rules.defaults.dm, 0);
  assert.equal(config.rules.defaults.thread_reply, 0);
  assert.equal(config.rules.defaults.mention, DEFAULT_TYPE_PRIORITIES.mention);
  assert.equal(config.rules.defaults.message, DEFAULT_TYPE_PRIORITIES.message);
  assert.deepEqual(config.profiles, defaultRulesConfig().profiles);
});

test("the edit helpers set, change, and clear without touching the rest", () => {
  // Both the panel and the context menus edit through these; the same
  // shape from either place is the whole point.
  let c = defaultRulesConfig();
  c = withUserRule(c, "u1", 4);
  c = withChannelRule(c, "c1", 0);
  c = withTypeDefault(c, "message", 2);
  c = withProfileAction(c, 2, "blink", true);
  assert.equal(c.rules.users.u1, 4);
  assert.equal(c.rules.channels.c1, 0);
  assert.equal(c.rules.defaults.message, 2);
  assert.equal(c.profiles[2].blink, true);
  assert.equal(c.profiles[2].sound, true, "untouched actions keep their value");

  // null clears: back to "no override", not to a fifth priority.
  c = withUserRule(c, "u1", null);
  c = withChannelRule(c, "c1", null);
  assert.ok(!("u1" in c.rules.users));
  assert.ok(!("c1" in c.rules.channels));

  // Pure: the starting config was never mutated.
  const fresh = defaultRulesConfig();
  assert.deepEqual(withUserRule(fresh, "u9", 3) !== fresh, true);
  assert.deepEqual(fresh, defaultRulesConfig());
});

test("bus: publish reaches subscribers until they unsubscribe", () => {
  const seen: NotifyEvent[] = [];
  const unsub = subscribeNotifyEvents((e) => seen.push(e));
  publishNotifyEvent({ type: "dm", senderUserID: "u1" });
  unsub();
  publishNotifyEvent({ type: "dm", senderUserID: "u2" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].senderUserID, "u1");
});
