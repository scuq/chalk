// 129-3: the settings tab of the admin panel -- the server-wide switches.
//
// One row per switch, in the settings dialog's row markup (phase 124), so an
// administrator who knows the profile panel reads this the same way. The
// values come from the server on every visit. A save is optimistic: the row
// shows the new value at once, and the server's answer replaces it. If the
// save fails, the panel reads the values again, so the row returns to the
// stored value.

import type { InstanceSettings } from "../auth/admin";
import type { AdminSettingsState } from "../state/types";

interface Props {
  state: AdminSettingsState;
  onChange: (patch: Partial<InstanceSettings>) => void;
  onRetry: () => void;
}

export function AdminSettingsTab({ state, onChange, onRetry }: Props) {
  const v = state.values;
  const busy = state.loading || state.saving;
  return (
    <div class="chalk-admin-tab chalk-admin-settings" data-testid="admin-settings-tab">
      {state.loadError && (
        <div class="chalk-admin-action-error" data-testid="admin-settings-load-error">
          <span>{state.loadError}</span>
          <button type="button" class="chalk-button" onClick={onRetry}>
            retry
          </button>
        </div>
      )}
      {state.saveError && (
        <div class="chalk-admin-action-error" data-testid="admin-settings-save-error">
          <span>{state.saveError}</span>
        </div>
      )}
      <section class="chalk-profile-seasonal">
        <h3>seasonal</h3>
        <div class="chalk-profile-field">
          <label class="chalk-profile-checkbox-label">
            <input
              type="checkbox"
              checked={v?.seasonal_decorations ?? true}
              disabled={busy || v === null}
              onChange={(e) =>
                onChange({ seasonal_decorations: (e.target as HTMLInputElement).checked })
              }
              data-testid="admin-seasonal-on"
            />
            <span>a scene for the season, for everyone on this server</span>
          </label>
          <p class="chalk-profile-hint">
            on by default. now and then a small animated scene for the season
            shows in the middle of the top bar. a phone in zuckermode shows it in a row above the conversation list. off here
            hides it for every account. each person can also turn it off for
            their own device under settings, appearance, seasonal. a change reaches other people's screens on their
            next page load.
          </p>
        </div>
      </section>
    </div>
  );
}
