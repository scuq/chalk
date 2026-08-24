// chalk-desktop -- the picker page's script. Two modes, chosen by the
// ?mode= query the main process loads it with:
//
//   server  the list of remembered servers and a field for a new one
//   share   the screen/window chooser for getDisplayMedia (screenshare.ts)
//
// Talks to the main process only through window.chalkPicker (preload.ts).
// No framework: this page shows for seconds and must not carry a bundle.

import type { PickerBridge } from "../preload";
import type { ShareSource } from "../screenshare";

declare global {
  interface Window {
    chalkPicker: PickerBridge;
  }
}

const bridge = window.chalkPicker;
const params = new URLSearchParams(location.search);
const mode = params.get("mode") === "share" ? "share" : "server";

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`picker: #${id} missing`);
  return e as T;
}

// --- server mode ----------------------------------------------------------

async function serverMode(): Promise<void> {
  const root = el<HTMLElement>("server");
  const list = el<HTMLUListElement>("servers");
  const form = el<HTMLFormElement>("form");
  const input = el<HTMLInputElement>("url");
  const error = el<HTMLParagraphElement>("error");
  root.hidden = false;

  const showError = (text: string | null) => {
    error.hidden = text === null;
    error.textContent = text ?? "";
  };
  showError(params.get("error"));

  const render = async () => {
    const { servers } = await bridge.servers();
    list.replaceChildren();
    for (const s of servers) {
      const li = document.createElement("li");
      const open = document.createElement("button");
      open.type = "button";
      open.className = "open";
      open.textContent = s.url;
      open.addEventListener("click", () => void go(s.url));
      const forget = document.createElement("button");
      forget.type = "button";
      forget.className = "forget";
      forget.title = "Forget this server";
      forget.textContent = "✕";
      forget.addEventListener("click", async () => {
        await bridge.forget(s.url);
        await render();
      });
      li.append(open, forget);
      list.append(li);
    }
  };

  const go = async (url: string) => {
    showError(null);
    const err = await bridge.connect(url);
    if (err !== null) showError(err);
  };

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void go(input.value);
  });

  await render();
  input.focus();

  // 105-5: the shell's own preferences and the update state.
  const prefs = el<HTMLElement>("prefs");
  const tray = el<HTMLInputElement>("pref-tray");
  const updates = el<HTMLInputElement>("pref-updates");
  const status = el<HTMLSpanElement>("update-status");
  const version = el<HTMLParagraphElement>("version");
  const show = (p: Awaited<ReturnType<PickerBridge["prefs"]>>) => {
    tray.checked = p.closeToTray;
    updates.checked = p.checkUpdates;
    version.textContent =
      `chalk desktop ${p.version}` +
      (p.update ? ` — ${p.update.version} ${p.update.ready ? "is ready; restart from the tray or the chalk menu" : "is available"}` : "");
    prefs.hidden = false;
  };
  show(await bridge.prefs());
  tray.addEventListener("change", async () => show(await bridge.setPrefs({ closeToTray: tray.checked })));
  updates.addEventListener("change", async () => show(await bridge.setPrefs({ checkUpdates: updates.checked })));
  el<HTMLButtonElement>("check-updates").addEventListener("click", async () => {
    status.textContent = "checking…";
    status.textContent = await bridge.checkUpdates();
    show(await bridge.prefs());
  });
}

// --- share mode -----------------------------------------------------------

function sourceButton(s: ShareSource): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "source";
  const thumb = document.createElement("img");
  thumb.className = "thumb";
  thumb.alt = "";
  if (s.thumbnail) thumb.src = s.thumbnail;
  const name = document.createElement("div");
  name.className = "name";
  if (s.icon) {
    const icon = document.createElement("img");
    icon.alt = "";
    icon.src = s.icon;
    name.append(icon);
  }
  const label = document.createElement("span");
  label.textContent = s.name;
  label.title = s.name;
  name.append(label);
  b.append(thumb, name);
  b.addEventListener("click", () => bridge.choose(s.id));
  return b;
}

async function shareMode(): Promise<void> {
  const root = el<HTMLElement>("share");
  const grid = el<HTMLDivElement>("sources");
  root.hidden = false;
  el<HTMLButtonElement>("cancel").addEventListener("click", () => bridge.choose(null));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") bridge.choose(null);
  });

  const sources = await bridge.sources();
  const section = (title: string) => {
    const h = document.createElement("div");
    h.className = "section";
    h.textContent = title;
    return h;
  };
  const screens = sources.filter((s) => s.kind === "screen");
  const windows = sources.filter((s) => s.kind === "window");
  if (screens.length > 0) {
    grid.append(section(screens.length === 1 ? "Screen" : "Screens"));
    for (const s of screens) grid.append(sourceButton(s));
  }
  if (windows.length > 0) {
    grid.append(section("Windows"));
    for (const s of windows) grid.append(sourceButton(s));
  }
  if (sources.length === 0) {
    grid.append(section("Nothing to share was found."));
  }
  const first = grid.querySelector<HTMLButtonElement>("button.source");
  first?.focus();
}

void (mode === "share" ? shareMode() : serverMode());
