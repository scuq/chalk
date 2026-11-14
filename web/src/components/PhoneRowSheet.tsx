// 135-8: the sheet of one row in the phone list. A long press or a
// right-click on the row opens it. It has the channel actions that the
// sidebar menu has on desktop and that a phone needs: notifications, hide,
// group, and the owner's rename. The handlers are the ones the sidebar
// uses (App.tsx).

import { useState } from "preact/hooks";
import type { ChannelSummary } from "../state/types";
import type { HiddenChannel, HideMode } from "../chat/channel-hide";
import { DEFAULT_GROUP, canonicalizeGroup, effectiveGroup, groupDraftChange } from "../chat/channel-groups";
import { MAX_SHORT_NAME_LEN, shortNameLength } from "../chat/channel-names";
import { withChannelRule } from "../notify/rules";
import { useRulesConfig } from "../notify/rules-store";
import { PrioritySelect } from "./PrioritySelect";

interface Props {
  channel: ChannelSummary;
  /** The name the row shows: the other member for a direct message. */
  title: string;
  ownUserID: string | null;
  hidden: HiddenChannel | undefined;
  overrides: Record<string, string>;
  groupNames: string[];
  onSetHidden: (mode: HideMode | null) => void;
  onSetGroup: (group: string | null) => void;
  onUpdate: (patch: { name?: string; shortName?: string }) => void;
  onClose: () => void;
}

export function PhoneRowSheet(p: Props) {
  const ch = p.channel;
  const [rules, updateRules] = useRulesConfig();
  const [groupDraft, setGroupDraft] = useState(effectiveGroup(ch, p.overrides));
  const [nameDraft, setNameDraft] = useState(ch.name);
  const [shortDraft, setShortDraft] = useState(ch.shortName ?? "");

  // Groups apply to text channels only. Voice rooms have their own section.
  const canGroup = !ch.isDM && ch.channelType !== "voice";
  // The server lets only the owner rename, and not in democratic mode.
  const canRename = !ch.isDM && !!p.ownUserID && ch.createdBy === p.ownUserID && ch.governanceMode !== "democratic";
  const overridden = p.overrides[ch.id] !== undefined;
  const suggested = ch.groupName.trim() || DEFAULT_GROUP;

  const commitGroup = () => {
    const change = groupDraftChange(ch, groupDraft, p.groupNames, p.overrides);
    if (change?.kind === "clear") p.onSetGroup(null);
    else if (change?.kind === "set") p.onSetGroup(change.group);
    setGroupDraft(canonicalizeGroup(groupDraft, p.groupNames));
  };
  // A blank name is not a rename. The draft goes back to the current name.
  const commitName = () => {
    const next = nameDraft.trim();
    if (!next) return setNameDraft(ch.name);
    if (next !== ch.name) p.onUpdate({ name: next });
  };
  const commitShort = () => {
    const next = shortDraft.trim();
    if (shortNameLength(next) > MAX_SHORT_NAME_LEN) return;
    if (next !== (ch.shortName ?? "")) p.onUpdate({ shortName: next });
  };
  const onEnter = (commit: () => void) => (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
      (e.target as HTMLInputElement).blur();
    }
  };

  return (
    <div class="chalk-prow-backdrop" onClick={p.onClose} data-testid="phone-row-sheet">
      <div
        class="chalk-pcall-sheet chalk-prow-sheet"
        role="dialog"
        aria-label={`menu for ${p.title}`}
        onClick={(e) => e.stopPropagation()}
      >
        <span class="chalk-pcall-grip" aria-hidden="true" />
        <div class="chalk-pcall-sheet-head">{p.title}</div>

        <label class="chalk-pcall-sheet-item">
          <span class="chalk-prow-label">notifications</span>
          <PrioritySelect
            value={rules.rules.channels[ch.id] ?? null}
            withDefault
            testid="phone-row-priority"
            onChange={(prio) => updateRules(withChannelRule(rules, ch.id, prio))}
          />
        </label>

        {p.hidden ? (
          <button
            type="button"
            class="chalk-pcall-sheet-item"
            onClick={() => {
              p.onSetHidden(null);
              p.onClose();
            }}
            data-testid="phone-row-show"
          >
            show in the list again
          </button>
        ) : (
          <>
            <button
              type="button"
              class="chalk-pcall-sheet-item"
              onClick={() => {
                p.onSetHidden("untilNew");
                p.onClose();
              }}
              data-testid="phone-row-hide-until"
            >
              hide until a new message
            </button>
            <button
              type="button"
              class="chalk-pcall-sheet-item"
              onClick={() => {
                p.onSetHidden("always");
                p.onClose();
              }}
              data-testid="phone-row-hide"
            >
              hide
            </button>
          </>
        )}

        {canGroup && (
          <label class="chalk-pcall-sheet-item">
            <span class="chalk-prow-label">group</span>
            <input
              type="text"
              class="chalk-prow-input"
              value={groupDraft}
              maxLength={80}
              list="phone-row-groups"
              onInput={(e) => setGroupDraft((e.target as HTMLInputElement).value)}
              onChange={commitGroup}
              onKeyDown={onEnter(commitGroup)}
              data-testid="phone-row-group"
            />
            {overridden && (
              <button
                type="button"
                class="chalk-prow-reset"
                onClick={(e) => {
                  e.preventDefault();
                  p.onSetGroup(null);
                  setGroupDraft(suggested);
                }}
                data-testid="phone-row-group-reset"
              >
                reset
              </button>
            )}
            <datalist id="phone-row-groups">
              {p.groupNames.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </label>
        )}

        {canRename && (
          <>
            <label class="chalk-pcall-sheet-item">
              <span class="chalk-prow-label">name</span>
              <input
                type="text"
                class="chalk-prow-input"
                value={nameDraft}
                maxLength={80}
                onInput={(e) => setNameDraft((e.target as HTMLInputElement).value)}
                onChange={commitName}
                onKeyDown={onEnter(commitName)}
                data-testid="phone-row-name"
              />
            </label>
            <label class="chalk-pcall-sheet-item">
              <span class="chalk-prow-label">short name</span>
              <input
                type="text"
                class="chalk-prow-input"
                value={shortDraft}
                placeholder="optional"
                onInput={(e) => setShortDraft((e.target as HTMLInputElement).value)}
                onChange={commitShort}
                onKeyDown={onEnter(commitShort)}
                data-testid="phone-row-short"
              />
              <span class="chalk-pcall-sheet-value">
                {shortNameLength(shortDraft)}/{MAX_SHORT_NAME_LEN}
              </span>
            </label>
          </>
        )}
      </div>
    </div>
  );
}
