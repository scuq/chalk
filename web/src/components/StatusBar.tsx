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
  // phase 09d-2b: admin moderation panel entry. Only shown when
  // me.role === "admin".
  onOpenAdmin?: () => void;
}

const labels: Record<ConnectionState, string> = {
  connecting: "connecting...",
  open: "online",
  closed: "offline",
  error: "error",
};

export function StatusBar({ state, detail, user, me, onLogout, onOpenInvites, onOpenProfile, onOpenAdmin }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

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

  // Display name preference: me.username > user.handle > "you"
  const displayName = me?.username ?? user?.handle ?? null;
  const titleAttr = me?.userID ?? user?.id ?? undefined;
  // Only enable the menu when we have a session AND are connected.
  const menuEnabled = !!me && state === "open";

  return (
    <div class="chalk-status" data-state={state} data-testid="status-bar">
      <span class={`chalk-status-dot chalk-status-dot--${state}`} aria-hidden="true" />
      <span class="chalk-status-label">{labels[state]}</span>
      {detail && state !== "open" && (
        <span class="chalk-status-detail" data-testid="status-detail">
          ({detail})
        </span>
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
