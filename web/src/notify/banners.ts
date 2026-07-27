// chalk-web -- OS notification banners, the second sink on the bus.
//
// Everything shown here was decrypted on this device before it got
// anywhere near this module -- the OS renders the banner locally, so the
// preview text never leaves the machine, same argument as the mention
// scan. The rules engine has already decided a banner is wanted;
// decideBanner (gate.ts) decides whether this moment is one to
// interrupt, and this module does the showing, the collapsing, and the
// closing.
//
// Collapse is the OS tag mechanism: one banner per tag, a newer one
// replaces the older, so a busy channel is one banner deep, ever. Tags
// are also how banners are torn down when the thing they announced gets
// read -- on any device, since the read cursors sync.
//
// Platform reality: page-context `new Notification()` works on desktop
// Chrome/Firefox/Safari, THROWS on Android Chrome (which requires a
// service worker chalk doesn't have), and doesn't exist on iOS. The
// probe + try/catch make that an "unsupported" verdict rather than a
// crash, and the settings UI hides the whole feature where it can't work.

import type { NotifyEvent } from "./bus";
import { decideBanner, type BannerVerdict } from "./gate";
import { loadSoundPrefs, subscribeSoundPrefs } from "./prefs";

export interface BannerContent {
  tag: string;
  title: string;
  body: string;
}

const PREVIEW_MAX = 140;

function preview(text: string | undefined): string {
  const t = (text ?? "").trim();
  if (t.length <= PREVIEW_MAX) return t;
  return `${t.slice(0, PREVIEW_MAX - 1)}…`;
}

function channelLabel(ev: NotifyEvent): string {
  return ev.channelName ? `#${ev.channelName}` : "a channel";
}

const chTag = (id: string | undefined) => `chalk-ch-${id ?? "unknown"}`;

// The pure half: what does a banner for this event say? One tag per
// channel for channel-shaped events, one per thread for thread replies,
// a single shared tag for friend requests -- the newest request is the
// one worth seeing, and the friends panel lists the rest.
export function bannerContent(ev: NotifyEvent): BannerContent {
  const who = ev.senderHandle || "someone";
  switch (ev.type) {
    case "dm":
      return {
        tag: chTag(ev.channelID),
        title: ev.senderHandle || ev.channelName || "direct message",
        body: preview(ev.preview),
      };
    case "mention":
      return {
        tag: chTag(ev.channelID),
        title: `${who} mentioned you in ${channelLabel(ev)}`,
        body: preview(ev.preview),
      };
    case "message":
      return {
        tag: chTag(ev.channelID),
        title: `${who} in ${channelLabel(ev)}`,
        body: preview(ev.preview),
      };
    case "thread_reply":
      return {
        tag: `chalk-th-${ev.threadID ?? ev.channelID ?? "unknown"}`,
        title: `${who} in a thread in ${channelLabel(ev)}`,
        body: preview(ev.preview),
      };
    case "voice":
      return {
        tag: `chalk-voice-${ev.channelID ?? "unknown"}`,
        title: `${channelLabel(ev)} — call started`,
        body: ev.senderHandle ? `${ev.senderHandle} joined` : "",
      };
    case "channel_added":
      return { tag: chTag(ev.channelID), title: `added to ${channelLabel(ev)}`, body: "" };
    case "friend_request":
      return {
        tag: "chalk-friend",
        title: ev.senderHandle ? `friend request from ${ev.senderHandle}` : "friend request",
        body: "",
      };
    case "governance":
      return {
        tag: `chalk-gov-${ev.channelID ?? "unknown"}`,
        title: `${channelLabel(ev)} — ${ev.preview || "a proposal"}`,
        body: "",
      };
  }
}

export interface BannerNav {
  channelID?: string;
  threadID?: string;
}

// What the caller knows about the moment, same shape as PlayContext.
// dnd is deliberately absent: banners read it from the shared prefs
// themselves, like NotifySounds does.
export interface BannerMoment {
  tabVisible: boolean;
  userIdle: boolean;
  isRelevantSurfaceOpen: boolean;
}

export class NotifyBanners {
  private byTag = new Map<string, Notification>();
  // Set the first time the constructor throws; from then on the feature
  // reports unsupported rather than throwing once per event.
  private constructorBroken = false;
  private dnd: boolean;
  private onNavigate: ((nav: BannerNav) => void) | null = null;

  constructor() {
    this.dnd = loadSoundPrefs().dnd;
    subscribeSoundPrefs((p) => {
      this.dnd = p.dnd;
    });
  }

  supported(): boolean {
    return !this.constructorBroken && typeof window !== "undefined" && "Notification" in window;
  }

  permission(): "default" | "denied" | "granted" {
    return this.supported() ? Notification.permission : "denied";
  }

  // Must be called from a user gesture (the settings toggle). The panel
  // reads permission() afterwards to render the denied hint.
  async requestPermission(): Promise<"default" | "denied" | "granted"> {
    if (!this.supported()) return "denied";
    try {
      return await Notification.requestPermission();
    } catch {
      return "denied";
    }
  }

  // App installs this once; clicking any banner focuses the window and
  // navigates to what the banner was about.
  setNavigateHandler(fn: (nav: BannerNav) => void): void {
    this.onNavigate = fn;
  }

  show(ev: NotifyEvent, moment: BannerMoment): BannerVerdict {
    const verdict = decideBanner({
      supported: this.supported(),
      permission: this.permission(),
      dnd: this.dnd,
      ...moment,
    });
    if (verdict !== "show") return verdict;

    const content = bannerContent(ev);
    try {
      // silent: the sound sink already spoke, or the rules said not to.
      const n = new Notification(content.title, {
        body: content.body,
        tag: content.tag,
        silent: true,
      });
      n.onclick = () => {
        window.focus();
        this.onNavigate?.({ channelID: ev.channelID, threadID: ev.threadID });
        n.close();
        this.byTag.delete(content.tag);
      };
      this.byTag.set(content.tag, n);
      return "show";
    } catch {
      this.constructorBroken = true;
      return "unsupported";
    }
  }

  // Teardown, keyed the same way the tags are built. closeChannel covers
  // every channel-shaped tag so reading a channel also clears its call
  // and proposal banners.
  closeChannel(channelID: string): void {
    this.closeTag(chTag(channelID));
    this.closeTag(`chalk-voice-${channelID}`);
    this.closeTag(`chalk-gov-${channelID}`);
  }

  closeThread(threadID: string): void {
    this.closeTag(`chalk-th-${threadID}`);
  }

  closeFriend(): void {
    this.closeTag("chalk-friend");
  }

  private closeTag(tag: string): void {
    const n = this.byTag.get(tag);
    if (!n) return;
    n.close();
    this.byTag.delete(tag);
  }
}

let shared: NotifyBanners | null = null;

export function notifyBanners(): NotifyBanners {
  if (!shared) shared = new NotifyBanners();
  return shared;
}
