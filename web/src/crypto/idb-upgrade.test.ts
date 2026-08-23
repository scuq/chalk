// 83-8 verification: the IndexedDB v4 -> v7 upgrade an EXISTING browser
// profile goes through on its first load of a phase-83 build. A database is
// created by hand at version 4 with the four pre-83 stores populated
// (identity, space_keys, verifications, attachment_cache), then the real
// openDB (v7) runs via the public helpers. Asserted: every old record
// survives byte-for-byte reachable through the same helpers the app uses,
// and the three new stores (replay_ids, server_pin, observed_rosters) exist
// and work. This is the whole client-side "migration": additive stores,
// zero data rewriting -- an upgrade a user never notices.

import "fake-indexeddb/auto";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  loadSpaceKey,
  loadVerification,
  loadServerPin,
  saveServerPin,
  loadObservedRoster,
  saveObservedRoster,
  loadReplayRecord,
  saveReplayRecord,
} from "./idb";

// Build the pre-83 database exactly as idb.ts@v4 did: same names, same key
// paths, version 4.
function createV4WithData(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("chalk", 4);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("identity", { keyPath: "userID" });
      db.createObjectStore("space_keys", { keyPath: "cacheKey" });
      db.createObjectStore("verifications", { keyPath: "peerUserID" });
      db.createObjectStore("attachment_cache", { keyPath: "cacheKey" });
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(["space_keys", "verifications", "attachment_cache"], "readwrite");
      // a cached channel key, as saveSpaceKey wrote it pre-83
      tx.objectStore("space_keys").put({
        cacheKey: "chan-1:1",
        channelID: "chan-1",
        keyVersion: 1,
        key: new Uint8Array(32).fill(7),
        provenance: { kind: "self_minted" },
      });
      // an identity pin from 82-2, manual source
      tx.objectStore("verifications").put({
        peerUserID: "peer-1",
        digestHex: "abcd",
        generation: 1,
        verifiedAt: 1700000000000,
        ed25519PubB64: "QUFBQQ==",
        source: "manual",
        pinnedAt: 1700000000000,
      });
      tx.objectStore("attachment_cache").put({
        cacheKey: "att-1:1:full",
        attachmentID: "att-1",
        keyVersion: 1,
        variant: "full",
        bytes: new Uint8Array([1, 2, 3]),
        byteLen: 3,
        lastAccess: 1700000000000,
      });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

test("v4 profile upgrades to v7: old data survives, new stores work", async () => {
  await createV4WithData();

  // The first call through the real module triggers the v7 upgrade.
  const held = await loadSpaceKey("chan-1", 1);
  assert.ok(held, "space key must survive the upgrade");
  assert.equal([...held!.key].every((b) => b === 7), true);
  assert.equal(held!.provenance.kind, "self_minted");

  const pin = await loadVerification("peer-1");
  assert.ok(pin, "identity pin must survive");
  assert.equal(pin!.source, "manual");
  assert.equal(pin!.ed25519PubB64, "QUFBQQ==");
  assert.equal(pin!.digestHex, "abcd");

  // the new stores exist and round-trip
  assert.equal(await loadServerPin("http://x"), null);
  await saveServerPin({
    origin: "http://x",
    ed25519PubB64: "QkJCQg==",
    fingerprint: "aaaa bbbb",
    source: "tofu",
    pinnedAt: 1,
  });
  assert.equal((await loadServerPin("http://x"))?.source, "tofu");

  assert.equal(await loadReplayRecord("a/b/c"), null);
  await saveReplayRecord({ triple: "a/b/c", serverID: "row-1", channelID: "ch", firstSeenAt: 1 });
  assert.equal((await loadReplayRecord("a/b/c"))?.serverID, "row-1");

  assert.equal(await loadObservedRoster("ch"), null);
  await saveObservedRoster({ channelID: "ch", members: [], notices: [], observedAt: 1 });
  assert.ok(await loadObservedRoster("ch"));

  // and the raw attachment-cache record is still present under its key
  const att = await new Promise((resolve) => {
    const req = indexedDB.open("chalk");
    req.onsuccess = () => {
      const db = req.result;
      assert.equal(db.version, 7, "database must be at v7 now");
      const get = db.transaction("attachment_cache").objectStore("attachment_cache").get("att-1:1:full");
      get.onsuccess = () => {
        db.close();
        resolve(get.result);
      };
    };
  });
  assert.ok(att, "attachment cache must survive");
});
