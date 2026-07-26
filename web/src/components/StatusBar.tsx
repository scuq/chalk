// StatusBar: connection state + identity + (phase 09b-5b) logout menu.
//
// Identity priority for display:
//   1. me?.username  — the new 09b session-authenticated identity
//   2. user?.handle  — legacy welcome-frame handle field
//   3. "you"          — fallback when nothing else known
//
// The dropdown opens on click of the user area when state is "open"
// AND me is set (i.e. we have a real session). It closes on outside
// click, escape, or after the logout fires.

import { useEffect, useRef, useState } from "preact/hooks";
import type { ConnectionState } from "../ws-client";
import type { MeResponse } from "../auth/types";

interface Props {
  state: ConnectionState;
  detail: string;
  // phase 08c: handle optional for backward compat
  user: { id: string; device: string; handle?: string } | null;
  // phase 09b-5b: the session-resolved identity. When present, drives
  // display name and unlocks the logout menu.
  me: MeResponse | null;
  // phase 09b-5b: called when the user clicks the logout menu item.
  onLogout: () => void;
  // phase 09c-2: extra menu items.
  onOpenInvites?: () => void;
  onOpenProfile?: () => void;
  // Phase 9.6a: friends panel entry point. When provided,
  // a "friends" item appears in the user menu.
  onOpenFriends?: () => void;
  // phase 09d-2b: admin moderation panel entry. Only shown when
  // me.role === "admin".
  onOpenAdmin?: () => void;
  // 42-8: thread inbox entry point, with a dot when something needs you.
  // threadsUnread is a COUNT but renders as a dot -- it only decides whether
  // the dot appears, and feeds the tooltip.
  onOpenThreads?: () => void;
  threadsUnread?: number;
  // 46-2: the server is serving a newer build than this tab loaded. Offered,
  // never forced: a reload mid-sentence is worse than a slightly stale tab.
  updateAvailable?: boolean;
  onReload?: () => void;
  onDismissUpdate?: () => void;
  // 46-3: the server said it is restarting, so the disconnect about to show
  // up is expected rather than a fault.
  serverRestarting?: boolean;
  // Phase 9.6j: presence override picker on the connection pill.
  // When provided, clicking the pill opens a small picker with
  // auto / online / away options.
  presenceMode?: "auto" | "online" | "away";
  effectivePresence?: "online" | "away" | "offline";
  onPresenceModeChange?: (mode: "auto" | "online" | "away") => void;
}

const labels: Record<ConnectionState, string> = {
  connecting: "connecting...",
  open: "online",
  closed: "offline",
  error: "error",
};

export function StatusBar({ state, detail, user, me, onLogout, onOpenInvites, onOpenProfile, onOpenFriends, onOpenAdmin, onOpenThreads, threadsUnread = 0, updateAvailable = false, onReload, onDismissUpdate, serverRestarting = false, presenceMode, effectivePresence, onPresenceModeChange }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Phase 9.6j: presence picker.
  const [presenceOpen, setPresenceOpen] = useState(false);
  const presenceRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (!menuRef.current) return;
      if (e.target instanceof Node && !menuRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // Phase 9.6j: same pattern for the presence picker.
  useEffect(() => {
    if (!presenceOpen) return;
    function onDocClick(e: MouseEvent) {
      if (!presenceRef.current) return;
      if (e.target instanceof Node && !presenceRef.current.contains(e.target)) {
        setPresenceOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPresenceOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [presenceOpen]);

  // Display name preference: me.username > user.handle > "you"
  const displayName = me?.username ?? user?.handle ?? null;
  const titleAttr = me?.userID ?? user?.id ?? undefined;
  // Only enable the menu when we have a session AND are connected.
  const menuEnabled = !!me && state === "open";

  return (
    <div class="chalk-status" data-state={state} data-testid="status-bar">
      {state === "open" && onPresenceModeChange ? (
        // Phase 9.6j: clickable presence pill with picker.
        <div class="chalk-presence-picker" ref={presenceRef}>
          <button
            type="button"
            class={`chalk-presence-trigger chalk-presence-trigger--${effectivePresence ?? "online"}`}
            data-testid="presence-trigger"
            onClick={() => setPresenceOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={presenceOpen}
            title={`presence: ${effectivePresence ?? "online"} (mode: ${presenceMode ?? "auto"})`}
          >
            <span class={`chalk-status-dot chalk-status-dot--${state}`} aria-hidden="true" />
            <span class="chalk-status-label">
              {effectivePresence === "away" ? "away" : "online"}
              {presenceMode && presenceMode !== "auto" ? " ·" : ""}
            </span>
            {presenceMode && presenceMode !== "auto" && (
              <span class="chalk-presence-mode-badge">
                manual
              </span>
            )}
          </button>
          {presenceOpen && (
            <div class="chalk-presence-menu" role="menu" data-testid="presence-menu">
              {(["auto", "online", "away"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="menuitem"
                  class={`chalk-presence-menu-item ${presenceMode === m ? "chalk-presence-menu-item--active" : ""}`}
                  data-testid={`presence-menu-${m}`}
                  onClick={() => {
                    onPresenceModeChange(m);
                    setPresenceOpen(false);
                  }}
                >
                  {m}
                  {m === "auto" && (
                    <span class="chalk-presence-menu-hint">
                      (follows your activity)
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <>
          <span class={`chalk-status-dot chalk-status-dot--${state}`} aria-hidden="true" />
          <span class="chalk-status-label">{labels[state]}</span>
        </>
      )}
      {/* 46-3: when the server told us it was going down, say so instead of
          showing the raw close code -- an expected drop shouldn't read as a
          fault. */}
      {serverRestarting && state !== "open" ? (
        <span class="chalk-status-detail" data-testid="status-restarting">
          (server restarting)
        </span>
      ) : (
        detail && state !== "open" && (
          <span class="chalk-status-detail" data-testid="status-detail">
            ({detail})
          </span>
        )
      )}
      {/* 46-2: the server has moved to a newer build than this tab loaded.
          Not gated on state === "open": it stays true while reconnecting, and
          reloading is still the right offer then. */}
      {updateAvailable && onReload && (
        <span class="chalk-status-update" data-testid="status-update">
          <button
            type="button"
            class="chalk-status-update-reload"
            onClick={onReload}
            title="the server is running a newer version of chalk -- reload to pick it up"
            data-testid="status-update-reload"
          >
            new version · reload
          </button>
          {onDismissUpdate && (
            <button
              type="button"
              class="chalk-status-update-dismiss"
              onClick={onDismissUpdate}
              title="dismiss"
              aria-label="dismiss the new version notice"
              data-testid="status-update-dismiss"
            >
              ×
            </button>
          )}
        </span>
      )}
      {/* 42-8: the thread inbox. A top-level button rather than a user-menu
          item, because the whole point is the dot -- a badge hidden behind a
          click cannot tell you a thread needs you. A dot and not a number, the
          same call Sidebar makes for channels. */}
      {state === "open" && onOpenThreads && (
        <button
          type="button"
          class="chalk-status-threads"
          onClick={onOpenThreads}
          title={
            threadsUnread > 0
              ? `${threadsUnread} thread${threadsUnread === 1 ? "" : "s"} need you`
              : "active threads"
          }
          aria-label={
            threadsUnread > 0 ? "active threads, some need you" : "active threads"
          }
          data-testid="status-threads"
        >
          threads
          {threadsUnread > 0 && (
            <span class="chalk-unread-dot" data-testid="status-threads-dot" />
          )}
        </button>
      )}
      {state === "open" && (
        <div class="chalk-status-menu" ref={menuRef}>
          {menuEnabled ? (
            <button
              type="button"
              class="chalk-status-menu-trigger"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              onClick={() => setMenuOpen((v) => !v)}
              data-testid="status-user-menu-trigger"
              title={titleAttr}
            >
              you ({displayName ?? "—"}) ▾
            </button>
          ) : (
            <span class="chalk-status-user" data-testid="status-user">
              <span title={titleAttr}>
                {displayName ? `you (${displayName})` : "you"}
              </span>
            </span>
          )}
          {menuOpen && menuEnabled && (
            <div
              class="chalk-status-menu-popover"
              role="menu"
              data-testid="status-user-menu"
            >
              {onOpenProfile && (
                <button
                  type="button"
                  role="menuitem"
                  class="chalk-status-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenProfile();
                  }}
                  data-testid="status-user-menu-profile"
                >
                  profile
                </button>
              )}
              {onOpenInvites && (
                <button
                  type="button"
                  role="menuitem"
                  class="chalk-status-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenInvites();
                  }}
                  data-testid="status-user-menu-invites"
                >
                  invites
                </button>
              )}
              {onOpenFriends && (
                <button
                  type="button"
                  role="menuitem"
                  class="chalk-status-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenFriends();
                  }}
                  data-testid="status-user-menu-friends"
                >
                  friends
                </button>
              )}
              {onOpenAdmin && me?.role === "admin" && (
                <button
                  type="button"
                  role="menuitem"
                  class="chalk-status-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenAdmin();
                  }}
                  data-testid="status-user-menu-admin"
                >
                  admin
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                class="chalk-status-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  onLogout();
                }}
                data-testid="status-user-menu-logout"
              >
                log out
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
