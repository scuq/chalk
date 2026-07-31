// 63-3: saved-device resolution against the live device list.

import test from "node:test";
import assert from "node:assert/strict";

import { resolveDeviceId } from "./device-resolve";

const DEVICES = [
  { deviceId: "id-internal", label: "MacBook Pro Microphone" },
  { deviceId: "id-airpods", label: "scuq's AirPods Pro" },
];

test("a still-present id wins, label not consulted", () => {
  assert.equal(resolveDeviceId("id-airpods", "something else entirely", DEVICES), "id-airpods");
});

test("a stale id re-resolves by label to the device's current id", () => {
  assert.equal(resolveDeviceId("id-from-last-session", "scuq's AirPods Pro", DEVICES), "id-airpods");
});

test("nothing saved means system default", () => {
  assert.equal(resolveDeviceId("", "", DEVICES), "");
});

test("saved device absent (stale id, label not present) falls back to default", () => {
  assert.equal(resolveDeviceId("id-gone", "USB Interface", DEVICES), "");
});

test("stale id with no saved label falls back to default", () => {
  assert.equal(resolveDeviceId("id-gone", "", DEVICES), "");
});

test("duplicate labels resolve to the first match", () => {
  const dupes = [
    { deviceId: "id-a", label: "USB Microphone" },
    { deviceId: "id-b", label: "USB Microphone" },
  ];
  assert.equal(resolveDeviceId("id-stale", "USB Microphone", dupes), "id-a");
});

test("empty device list (enumeration denied) falls back to default", () => {
  assert.equal(resolveDeviceId("id-airpods", "scuq's AirPods Pro", []), "");
});
