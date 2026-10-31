// 129-3: the admin panel's settings tab in the reducer. What matters: a load
// in flight keeps the last values. A save applies its patch to the values at
// once, and the server's answer replaces them. A failure records why and
// keeps the applied patch until the panel reads the stored values again.

import { test } from "node:test";
import assert from "node:assert/strict";
import { reducer } from "./reducer.ts";
import { initialState, type AppState } from "./types.ts";

function s(): AppState {
  return reducer(initialState, { kind: "admin_tab_change", tab: "settings" });
}

test("the settings tab starts unloaded, and the tab change reaches it", () => {
  const st = s();
  assert.equal(st.adminPanel.activeTab, "settings");
  assert.equal(st.adminPanel.settings.values, null);
  assert.equal(st.adminPanel.settings.loading, false);
});

test("a load keeps the last values until the server answers", () => {
  let st = reducer(s(), {
    kind: "admin_settings_load_succeeded",
    values: { seasonal_decorations: false },
  });
  assert.deepEqual(st.adminPanel.settings.values, { seasonal_decorations: false });
  st = reducer(st, { kind: "admin_settings_load_start" });
  assert.equal(st.adminPanel.settings.loading, true);
  assert.deepEqual(st.adminPanel.settings.values, { seasonal_decorations: false });
  st = reducer(st, { kind: "admin_settings_load_failed", message: "lookup_failed: x" });
  assert.equal(st.adminPanel.settings.loading, false);
  assert.equal(st.adminPanel.settings.loadError, "lookup_failed: x");
  assert.deepEqual(st.adminPanel.settings.values, { seasonal_decorations: false });
});

test("a save shows the flip at once, and the server's answer replaces it", () => {
  let st = reducer(s(), {
    kind: "admin_settings_load_succeeded",
    values: { seasonal_decorations: true },
  });
  st = reducer(st, { kind: "admin_settings_save_start", patch: { seasonal_decorations: false } });
  assert.equal(st.adminPanel.settings.saving, true);
  assert.deepEqual(st.adminPanel.settings.values, { seasonal_decorations: false });
  st = reducer(st, { kind: "admin_settings_save_failed", message: "write_failed: y" });
  assert.equal(st.adminPanel.settings.saving, false);
  assert.equal(st.adminPanel.settings.saveError, "write_failed: y");
  // The panel reads the values again after a failure. Until then the reducer keeps the flip.
  st = reducer(st, { kind: "admin_settings_load_succeeded", values: { seasonal_decorations: true } });
  assert.deepEqual(st.adminPanel.settings.values, { seasonal_decorations: true });
  st = reducer(st, { kind: "admin_settings_save_start", patch: { seasonal_decorations: false } });
  assert.equal(st.adminPanel.settings.saveError, null);
  st = reducer(st, {
    kind: "admin_settings_save_succeeded",
    values: { seasonal_decorations: false },
  });
  assert.equal(st.adminPanel.settings.saving, false);
  assert.deepEqual(st.adminPanel.settings.values, { seasonal_decorations: false });
});

test("a save before the first load answers leaves the unloaded state alone", () => {
  const st = reducer(s(), { kind: "admin_settings_save_start", patch: { seasonal_decorations: false } });
  assert.equal(st.adminPanel.settings.values, null);
  assert.equal(st.adminPanel.settings.saving, true);
});

test("the settings tab leaves the other tabs' state alone", () => {
  const st = reducer(s(), {
    kind: "admin_settings_load_succeeded",
    values: { seasonal_decorations: false },
  });
  assert.deepEqual(st.adminPanel.users, initialState.adminPanel.users);
  assert.deepEqual(st.adminPanel.blacklist, initialState.adminPanel.blacklist);
});
