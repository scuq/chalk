// NotificationsPanel: the rules engine's face. Phase 50-4.
//
// Two ideas, two sections:
//
//   priorities  what each priority level DOES (sound / banner / blink),
//               configured once -- never per person or per channel
//   rules       what priority each thing GETS: defaults per event type,
//               overridable per person and per channel; mute is a
//               priority, so a muted channel is just a rule here like
//               any other and can be edited or deleted like one
//
// The config lives in the rules store (localStorage; the sync slice
// mirrors it through the server encrypted), so -- like the sound prefs --
// the panel talks to it directly through useRulesConfig rather than
// through app state. Friends and channels come in as props purely to
// turn ids into names.
//
// The desktop-banner permission is the one piece of browser state here:
// requested from the toggle click (a real user gesture), re-read after
// the prompt resolves, and the whole banner column hidden where the
// platform can't show page-context notifications at all (Android/iOS).

import { useEffect, useState } from "preact/hooks";
import type { ChannelSummary, Friend } from "../state/types";
import { PrioritySelect } from "./PrioritySelect";
import { notifyBanners } from "../notify/banners";
import { notifySounds } from "../notify";
import {
  EVENT_TYPE_LABELS,
  NOTIFY_EVENT_TYPES,
  PRIORITY_LABELS,
  withChannelRule,
  withProfileAction,
  withTypeDefault,
  withUserRule,
  type ActionSet,
} from "../notify/rules";
import { useRulesConfig } from "../notify/rules-store";

interface Props {
  friends: Friend[];
  channels: ChannelSummary[];
  onClose: () => void;
}

export function NotificationsPanel({ friends, channels, onClose }: Props) {
  const [config, update] = useRulesConfig();
  const banners = notifyBanners();
  const [permission, setPermission] = useState(banners.permission());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // id -> display name, from everything this device knows: friends plus
  // every channel member list. A rule for someone neither list covers
  // (made on another device, or the person left) falls back to the id --
  // still editable, still deletable.
  const handleByID = new Map<string, string>();
  for (const ch of channels) {
    for (const m of ch.members) if (m.handle) handleByID.set(m.userID, m.handle);
  }
  for (const f of friends) if (f.handle) handleByID.set(f.userID, f.handle);
  const nameForUser = (id: string) => handleByID.get(id) ?? id.slice(0, 8);

  const channelByID = new Map(channels.map((ch) => [ch.id, ch]));
  const nameForChannel = (id: string) => {
    const ch = channelByID.get(id);
    if (!ch) return id.slice(0, 8);
    if (ch.isDM) {
      const other = ch.members.find((m) => m.handle && m.handle !== "");
      return `dm: ${other?.handle ?? "?"}`;
    }
    return `#${ch.name}`;
  };

  const userRules = Object.entries(config.rules.users).sort(([a], [b]) =>
    nameForUser(a).localeCompare(nameForUser(b)),
  );
  const channelRules = Object.entries(config.rules.channels).sort(([a], [b]) =>
    nameForChannel(a).localeCompare(nameForChannel(b)),
  );

  const unruledFriends = friends.filter((f) => config.rules.users[f.userID] === undefined);
  const unruledChannels = channels.filter(
    (ch) => !ch.isDM && config.rules.channels[ch.id] === undefined,
  );

  const bannerSupported = banners.supported();
  const actionColumns: (keyof ActionSet)[] = bannerSupported
    ? ["sound", "banner", "blink"]
    : ["sound", "blink"];
  const ACTION_LABELS: Record<keyof ActionSet, string> = {
    sound: "sound",
    banner: "banner",
    blink: "blink tab",
  };

  return (
    <div class="chalk-modal-backdrop" data-testid="notify-rules-backdrop" onClick={onClose}>
      <div
        class="chalk-modal-card chalk-notify-panel"
        data-testid="notify-rules-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="notification rules"
      >
        <div class="chalk-friends-header">
          <div class="chalk-friends-title">notification rules</div>
          <button
            class="chalk-modal-close"
            type="button"
            data-testid="notify-rules-close"
            aria-label="close"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div class="chalk-notify-panel-body">
          <section>
            <h3>what each priority does</h3>
            <table class="chalk-notify-matrix" data-testid="notify-priority-matrix">
              <thead>
                <tr>
                  <th />
                  {actionColumns.map((a) => (
                    <th key={a}>{ACTION_LABELS[a]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {([1, 2, 3, 4] as const).map((p) => (
                  <tr key={p}>
                    <td>{PRIORITY_LABELS[p]}</td>
                    {actionColumns.map((a) => (
                      <td key={a}>
                        <input
                          type="checkbox"
                          checked={config.profiles[p][a]}
                          disabled={a === "banner" && permission !== "granted"}
                          data-testid={`notify-profile-${p}-${a}`}
                          onChange={(e) =>
                            update(
                              withProfileAction(
                                config,
                                p,
                                a,
                                (e.target as HTMLInputElement).checked,
                              ),
                            )
                          }
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p class="chalk-profile-hint">
              mute is always available as a rule below and does none of these.
            </p>
            {bannerSupported && permission === "default" && (
              <button
                type="button"
                class="chalk-notify-permission-btn"
                data-testid="notify-banner-permission"
                onClick={() => {
                  void banners.requestPermission().then(setPermission);
                }}
              >
                enable desktop banners…
              </button>
            )}
            {bannerSupported && permission === "denied" && (
              <p class="chalk-profile-hint" data-testid="notify-banner-denied">
                the browser has blocked notifications for chalk — allow them in the browser's
                site settings, then reopen this panel.
              </p>
            )}
          </section>

          <section>
            <h3>what gets which priority</h3>
            <div class="chalk-profile-sound-list">
              {NOTIFY_EVENT_TYPES.map((t) => (
                <div class="chalk-notify-rule-row" key={t}>
                  <span class="chalk-notify-rule-name">
                    {EVENT_TYPE_LABELS[t].label}
                    {EVENT_TYPE_LABELS[t].desc && (
                      <span class="chalk-profile-theme-desc"> — {EVENT_TYPE_LABELS[t].desc}</span>
                    )}
                  </span>
                  <span class="chalk-notify-rule-controls">
                    <button
                      type="button"
                      class="chalk-profile-sound-preview"
                      onClick={() => notifySounds().preview(t)}
                      aria-label={`play the ${EVENT_TYPE_LABELS[t].label} sound`}
                      data-testid={`notify-preview-${t}`}
                    >
                      play
                    </button>
                    <PrioritySelect
                      value={config.rules.defaults[t]}
                      testid={`notify-default-${t}`}
                      onChange={(p) => {
                        if (p !== null) update(withTypeDefault(config, t, p));
                      }}
                    />
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h3>per person</h3>
            {userRules.length === 0 && (
              <p class="chalk-profile-hint">no per-person rules — everyone gets the defaults.</p>
            )}
            <div class="chalk-profile-sound-list">
              {userRules.map(([id, p]) => (
                <div class="chalk-notify-rule-row" key={id} data-testid={`notify-user-rule-${id}`}>
                  <span class="chalk-notify-rule-name">{nameForUser(id)}</span>
                  <span class="chalk-notify-rule-controls">
                    <PrioritySelect
                      value={p}
                      withDefault
                      testid={`notify-user-priority-${id}`}
                      onChange={(next) => update(withUserRule(config, id, next))}
                    />
                    <button
                      type="button"
                      class="chalk-profile-sound-preview"
                      aria-label={`remove the rule for ${nameForUser(id)}`}
                      data-testid={`notify-user-remove-${id}`}
                      onClick={() => update(withUserRule(config, id, null))}
                    >
                      remove
                    </button>
                  </span>
                </div>
              ))}
            </div>
            {unruledFriends.length > 0 && (
              <select
                class="chalk-notify-priority-select"
                data-testid="notify-user-add"
                value=""
                onChange={(e) => {
                  const id = (e.target as HTMLSelectElement).value;
                  // A new person rule starts at the top: singling someone
                  // out to make them quieter is the rarer intent, and the
                  // select is right there to change it.
                  if (id) update(withUserRule(config, id, 4));
                  (e.target as HTMLSelectElement).value = "";
                }}
              >
                <option value="">add a rule for a person…</option>
                {unruledFriends.map((f) => (
                  <option key={f.userID} value={f.userID}>
                    {f.handle || f.userID.slice(0, 8)}
                  </option>
                ))}
              </select>
            )}
          </section>

          <section>
            <h3>per channel</h3>
            {channelRules.length === 0 && (
              <p class="chalk-profile-hint">no per-channel rules — every channel gets the defaults.</p>
            )}
            <div class="chalk-profile-sound-list">
              {channelRules.map(([id, p]) => (
                <div
                  class="chalk-notify-rule-row"
                  key={id}
                  data-testid={`notify-channel-rule-${id}`}
                >
                  <span class="chalk-notify-rule-name">{nameForChannel(id)}</span>
                  <span class="chalk-notify-rule-controls">
                    <PrioritySelect
                      value={p}
                      withDefault
                      testid={`notify-channel-priority-${id}`}
                      onChange={(next) => update(withChannelRule(config, id, next))}
                    />
                    <button
                      type="button"
                      class="chalk-profile-sound-preview"
                      aria-label={`remove the rule for ${nameForChannel(id)}`}
                      data-testid={`notify-channel-remove-${id}`}
                      onClick={() => update(withChannelRule(config, id, null))}
                    >
                      remove
                    </button>
                  </span>
                </div>
              ))}
            </div>
            {unruledChannels.length > 0 && (
              <select
                class="chalk-notify-priority-select"
                data-testid="notify-channel-add"
                value=""
                onChange={(e) => {
                  const id = (e.target as HTMLSelectElement).value;
                  // A new channel rule starts muted: quieting a busy room
                  // is what per-channel rules are for.
                  if (id) update(withChannelRule(config, id, 0));
                  (e.target as HTMLSelectElement).value = "";
                }}
              >
                <option value="">add a rule for a channel…</option>
                {unruledChannels.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    #{ch.name}
                  </option>
                ))}
              </select>
            )}
            <p class="chalk-profile-hint">
              a person's rule beats their channel's, which beats the defaults — so a muted
              channel stays quiet unless someone in it has their own rule.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
