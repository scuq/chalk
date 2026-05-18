// Sidebar: channel list + new-channel button. Phase 08b.

import type { ChannelSummary } from "../state/types";
import { displayName } from "./App";

interface Props {
  channels: ChannelSummary[];
  activeID: string | null;
  ownUserID: string | null;
  onSelect: (id: string) => void;
  onCreateClick: () => void;
}

export function Sidebar({ channels, activeID, ownUserID, onSelect, onCreateClick }: Props) {
  return (
    <div class="chalk-sidebar-inner" data-testid="sidebar">
      <div class="chalk-sidebar-header">
        <span class="chalk-sidebar-title">channels</span>
        <button
          class="chalk-sidebar-new"
          type="button"
          data-testid="sidebar-new"
          onClick={onCreateClick}
          aria-label="new channel"
        >
          +
        </button>
      </div>
      <ul class="chalk-sidebar-list" data-testid="sidebar-list">
        {channels.length === 0 && (
          <li class="chalk-sidebar-empty">no channels yet</li>
        )}
        {channels.map((ch) => (
          <li
            key={ch.id}
            class={`chalk-sidebar-item ${ch.id === activeID ? "chalk-sidebar-item--active" : ""}`}
            data-testid="sidebar-item"
            data-channel-id={ch.id}
            data-active={ch.id === activeID ? "true" : "false"}
            onClick={() => onSelect(ch.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(ch.id);
              }
            }}
          >
            <span class="chalk-sidebar-item-name">{displayName(ch, ownUserID)}</span>
            {ch.isDM && <span class="chalk-sidebar-item-tag">dm</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
