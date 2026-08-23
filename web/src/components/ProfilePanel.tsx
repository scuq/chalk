// ProfilePanel: in-chat modal for managing the user's own profile and
// settings. Started as three sections (phase 09c-2); by phase 68 it holds
// sixteen, organized into tabs (settings-nav.ts maps section -> tab) with
// a filter input that searches every section's keywords across all tabs.
//
// Each section's JSX lives here, gated twice: show(<id>) for tab/filter
// visibility, and the section's own optional callback props (a section
// whose callbacks the parent didn't wire never renders at all).
//
// One sub-view takes over the whole modal: rotate recovery code (calls
// /api/auth/recovery/regenerate, shows the new 24-word phrase in a
// confirm-and-continue gate, RecoveryScreen intent="regenerated"). The
// takeover early-returns before the main view, so tab and filter state
// survive the round-trip.

import { hexFromHue, hueFromHex, nickTintStyle } from "../chat/nickcolor";
import {
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  clampSidebarWidth,
} from "../chat/sidebar-width";
import { useEffect, useState } from "preact/hooks";
import type { EmailChangeState, MeResponse } from "../auth/types";
import type { LinkPreviewDomainPrefs } from "../state/types";
import type { PinSyncStatus } from "../crypto/pin-sync"; // 84-3
import { normalizeDomainInput } from "../linkpreview/linkpreview";
import {
  regenerateRecovery,
  ApiError,
  listPasskeys,
  addPasskeyBegin,
  addPasskeyFinish,
  deletePasskey,
  type PasskeyInfo,
} from "../auth/api";
import {
  APP_WIDTH_CHOICES,
  FONT_CHOICES,
  SCALE_STEPS,
  useDisplayPrefs,
  type AppWidth,
} from "../display-prefs";
import {
  PARKING_LOT_DEFAULT_NAME,
  PARKING_LOT_NAME_MAX,
  parkingLotName,
} from "../parking";
import { PARKING_HOTKEY_LABEL } from "../parking-hotkey";
import { composerHelp, isMacPlatform } from "../chat/composer-keys";
import { useIsMobile } from "../mobile";
import { notifySounds } from "../notify";
import { useSoundPrefs } from "../notify/prefs";
import { CATEGORY_LABELS, MACHINE_CATEGORIES } from "../notify/types";
import { SOUND_THEMES, isSoundThemeId } from "../notify/themes";
import { useIdlePrefs } from "../presence/idle-prefs";
import {
  SECTION_TAB,
  SETTINGS_TABS,
  matchSections,
  type SectionId,
  type SettingsTab,
} from "../settings-nav";
import {
  systemIdlePermission,
  systemIdleSupported,
  type SystemIdlePermission,
} from "../presence/system-idle";
import { SecurityPanel } from "./SecurityPanel";
import { ServerIdentityCard } from "./ServerIdentityCard"; // 83-9 // 31-8
import { StepUpPrompt } from "./StepUpPrompt"; // 81-2
import type { StepUpProof } from "../auth/stepup";
import { VersionLink } from "./VersionLink"; // 39-1
import { performRegistration, WebAuthnError } from "../webauthn";
import { RecoveryScreen } from "../auth/RecoveryScreen";

interface Props {
  me: MeResponse;
  emailChange: EmailChangeState;
  /** 83-9: whether the live connection runs the sealed inner channel. */
  serverSealed?: boolean;
  onClose: () => void;
  onEmailChangeDraft: (value: string) => void;
  onEmailChangeSubmit: () => void;
  onEmailChangeDismiss: () => void;
  // Refresh re-fetches /api/auth/me so identity fields stay current
  // (e.g. if you verified an email change in another tab). Optional —
  // if the parent doesn't wire it, the refresh button doesn't render.
  onRefresh?: () => void;
  // 50-4: opens the notification rules panel (replaces this one).
  onOpenNotificationRules?: () => void;
  refreshing?: boolean;
  // 39-1: the running build, for the "about" section. From the welcome
  // frame, so empty until the socket is up.
  serverVersion?: string;
  serverCommit?: string;
  // Phase 9.7b: theme picker.
  theme?: string;
  onSetTheme?: (theme: string) => void;
  // Phase 9.7d: chat display prefs.
  chatPrefs?: {
    showTimestamps: boolean;
    timestampFormat: "hms" | "hm" | "relative";
    compactMode: boolean;
    // Phase 9.7e:
    userColors: { handle: string; color: string; scope: "all" | "dm" }[];
    // Phase 9.7f:
    userColorsEnabled: boolean;
    selfColorHue: number;
    userHues: Record<string, number>;
    // Phase 9.7h:
    composerToolStyle: "text" | "icons";
    // 42-1:
    emoticons: boolean;
    // 33-4:
    sidebarWidth: number;
    // 43-8:
    typingIndicators: boolean;
    // 67-1:
    shortenLinks: boolean;
    // 77-2:
    nanoMarkdown: boolean;
  };
  onSetChatPref?: <
    K extends
      | "showTimestamps"
      | "timestampFormat"
      | "compactMode"
      | "userColorsEnabled"
      | "selfColorHue"
      | "composerToolStyle"
      | "emoticons"
      | "sidebarWidth"
      | "typingIndicators"
      | "shortenLinks"
      | "nanoMarkdown",
  >(
    key: K,
    value: K extends "timestampFormat"
      ? "hms" | "hm" | "relative"
      : K extends "composerToolStyle"
      ? "text" | "icons"
      : K extends "selfColorHue" | "sidebarWidth"
      ? number
      : boolean,
  ) => void;
  // Phase 9.7e: replace the entire userColors list. We send the full
  // array on every change because JSONB || is a shallow merge so a
  // partial update would clobber the rest of chat prefs anyway.
  onSetUserColors?: (rules: { handle: string; color: string; scope: "all" | "dm" }[]) => void;
  // att-2: clear the cached attachment ciphertext (the "clear cached images"
  // guardrail). Optional -- only rendered when the parent wires it.
  onClearImageCache?: () => void | Promise<void>;
  // 84-3: how the identity-pin backup is doing. Absent until the sync has
  // started (it needs the unlocked identity), which the section says plainly
  // rather than pretending to a count it does not have.
  pinStatus?: PinSyncStatus | null;
  // att-4b: Giphy consent (tri-state). giphyPref is the current resolved
  // value; onSetGiphyPref sets it directly (used for the "disable" path);
  // onRequestEnableGiphy opens the app-level consent modal (the "enable"
  // path, so the leak is explained before the pref flips to "enabled").
  giphyPref?: "unset" | "enabled" | "disabled";
  onSetGiphyPref?: (v: "enabled" | "disabled") => void;
  onRequestEnableGiphy?: () => void;
  // 57-4: link-preview settings. Same tri-state shape as Giphy (enable
  // routes through the app-level consent modal). The domain lists control
  // which pasted links auto-offer a preview on the COMPOSE side: server
  // defaults can be unchecked (-> overrides.removed), own domains added
  // (-> overrides.added). linkPreviewHide is display-only: keep received
  // cards as plain text.
  linkPreviewPref?: "unset" | "enabled" | "disabled";
  onSetLinkPreviewPref?: (v: "enabled" | "disabled") => void;
  onRequestEnableLinkPreview?: () => void;
  linkPreviewServerDomains?: string[];
  linkPreviewOverrides?: LinkPreviewDomainPrefs;
  onSetLinkPreviewDomains?: (next: LinkPreviewDomainPrefs) => void;
  linkPreviewHide?: boolean;
  onSetLinkPreviewHide?: (hide: boolean) => void;
  // 44-3: the mic settings moved into their own dialog, reachable from the
  // footer's voice cluster. The profile panel keeps a way in for people who
  // go looking for it here.
  onOpenMicSettings?: () => void;
  // 53-1: the parking lot's title and whether its row shows at all. Account
  // prefs, so both travel with you; sent whole, like the chat block.
  // 53-5: `screen` also covers the rest of the app while parked.
  parkingLot?: { name: string; hidden: boolean; screen: boolean };
  onSetParkingLot?: (next: { name: string; hidden: boolean; screen: boolean }) => void;
  // 54-3: whether the sidebar groups channels under their group names.
  // Account pref, so the roster reads the same on every device.
  rosterGroupingEnabled?: boolean;
  onSetRosterGrouping?: (enabled: boolean) => void;
  // 62-5: Zuckermode -- the phone's unified conversation list. Synced
  // account-wide, consumed only on mobile.
  zuckerEnabled?: boolean;
  onSetZucker?: (enabled: boolean) => void;
}

export function ProfilePanel({
  me,
  emailChange,
  serverSealed,
  theme,
  onSetTheme,
  chatPrefs,
  onSetChatPref,
  onSetUserColors,
  onClearImageCache,
  pinStatus,
  giphyPref,
  onSetGiphyPref,
  onRequestEnableGiphy,
  linkPreviewPref,
  onSetLinkPreviewPref,
  onRequestEnableLinkPreview,
  linkPreviewServerDomains,
  linkPreviewOverrides,
  onSetLinkPreviewDomains,
  linkPreviewHide,
  onSetLinkPreviewHide,
  onOpenMicSettings,
  parkingLot,
  onSetParkingLot,
  rosterGroupingEnabled,
  onSetRosterGrouping,
  zuckerEnabled,
  onSetZucker,
  onClose,
  onEmailChangeDraft,
  onEmailChangeSubmit,
  onEmailChangeDismiss,
  onRefresh,
  onOpenNotificationRules,
  refreshing,
  serverVersion,
  serverCommit,
}: Props) {
  // 68-2/68-3: which settings tab is open, and the filter query. Ephemeral
  // view state — the panel unmounts on close, so both reset for free. A
  // non-empty filter overrides the tab and searches every section.
  const [activeTab, setActiveTab] = useState<SettingsTab>("account");
  const [filterQuery, setFilterQuery] = useState("");
  // 94-3: the shortcut sheet reads differently on a phone -- Enter is a
  // newline there.
  const isMobile = useIsMobile();

  // Local UI state: are we in the rotate-recovery sub-view?
  // Local because no other component cares.
  const [rotateView, setRotateView] = useState<"idle" | "confirm" | "loading" | "showing" | "error">("idle");
  const [rotatedWords, setRotatedWords] = useState<string[] | null>(null);
  const [rotateError, setRotateError] = useState<string>("");
  // 81-2: the passkey actions are step-up gated too. `pendingPasskey` names
  // what the confirmation, once given, should go on to do.
  const [pendingPasskey, setPendingPasskey] = useState<
    { kind: "add" } | { kind: "delete"; id: string } | null
  >(null);
  // att-2: transient "cleared" confirmation for the image cache control.
  const [imageCacheCleared, setImageCacheCleared] = useState(false);

  // 53-1: the parking lot's title, typed here and committed on blur. Kept as
  // a draft so the field doesn't fight the user mid-word, and re-seeded when
  // the pref changes under us (another device renamed it).
  const [parkingDraft, setParkingDraft] = useState(parkingLot?.name ?? "");
  useEffect(() => {
    setParkingDraft(parkingLot?.name ?? "");
  }, [parkingLot?.name]);
  const commitParkingName = () => {
    if (!parkingLot || !onSetParkingLot) return;
    // Normalize here too, so an emptied field snaps back to the default in
    // the box rather than only in the sidebar.
    const name = parkingLotName(parkingDraft);
    setParkingDraft(name);
    if (name !== parkingLot.name) onSetParkingLot({ ...parkingLot, name });
  };

  // Font family + size. Device-local, so unlike theme these aren't
  // threaded down from App -- the hook reads and persists them itself.
  const [display, setDisplay] = useDisplayPrefs();
  const [sound, setSound, setSoundCategory] = useSoundPrefs();

  // 45-4: away detection. The pref is this device's wish; the permission is
  // the browser's answer, and the panel has to be able to show them
  // disagreeing -- a ticked box next to a blocked permission is the one state
  // people would otherwise read as chalk being broken. Re-asked whenever the
  // panel opens, since the grant can be revoked from browser settings behind
  // our back.
  const [idle, setIdle] = useIdlePrefs();
  const [idlePerm, setIdlePerm] = useState<SystemIdlePermission | null>(null);
  useEffect(() => {
    let live = true;
    void systemIdlePermission().then((p) => {
      if (live) setIdlePerm(p);
    });
    return () => {
      live = false;
    };
  }, []);

  // md-4-2: passkey management. The list loads on mount; addState gates
  // the add button while the browser ceremony runs. null list = not yet
  // loaded.
  const [passkeys, setPasskeys] = useState<PasskeyInfo[] | null>(null);
  const [passkeysError, setPasskeysError] = useState<string>("");
  const [addState, setAddState] = useState<"idle" | "running">("idle");
  const [addError, setAddError] = useState<string>("");
  const [newPasskeyName, setNewPasskeyName] = useState<string>("");
  // md-7: per-passkey delete. confirmDeleteId is the id awaiting an
  // inline confirm; deletingId is the id whose delete is in flight.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await listPasskeys();
        if (!cancelled) {
          setPasskeys(list);
          setPasskeysError("");
        }
      } catch (e) {
        if (!cancelled) {
          setPasskeys([]);
          setPasskeysError(e instanceof ApiError ? e.message : "couldn't load passkeys");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onAddPasskey = async (stepUp: StepUpProof) => {
    setAddError("");
    setAddState("running");
    setPendingPasskey(null);
    try {
      const options = await addPasskeyBegin(stepUp);
      const att = await performRegistration(options);
      const created = await addPasskeyFinish(att, newPasskeyName.trim());
      setPasskeys((prev) => (prev ? [...prev, created] : [created]));
      setNewPasskeyName("");
    } catch (e) {
      if (e instanceof WebAuthnError) {
        setAddError(
          e.kind === "user_cancelled"
            ? "passkey creation was cancelled."
            : e.kind === "constraint"
              ? "this device has no authenticator that meets the requirements."
              : e.message,
        );
      } else if (e instanceof ApiError) {
        setAddError(friendlyAddPasskeyError(e.code, e.message));
      } else {
        console.error("add passkey failed:", e);
        setAddError("couldn't add a passkey; see browser console.");
      }
    } finally {
      setAddState("idle");
    }
  };

  const onDeletePasskey = async (id: string, stepUp: StepUpProof) => {
    setDeleteError("");
    setDeletingId(id);
    setPendingPasskey(null);
    try {
      await deletePasskey(id, stepUp);
      setPasskeys((prev) => (prev ? prev.filter((p) => p.id !== id) : prev));
      setConfirmDeleteId(null);
    } catch (e) {
      setDeleteError(
        e instanceof ApiError
          ? friendlyDeletePasskeyError(e.code, e.message)
          : "couldn't remove the passkey; see browser console.",
      );
      if (!(e instanceof ApiError)) console.error("delete passkey failed:", e);
    } finally {
      setDeletingId(null);
    }
  };

  // Close on Escape (only when not in rotate-showing state; we
  // don't want a stray keypress to lose the new recovery words).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (rotateView === "showing") return;
      onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, rotateView]);

  const startRotate = async (stepUp: StepUpProof) => {
    setRotateView("loading");
    setRotateError("");
    try {
      const words = await regenerateRecovery(stepUp);
      if (words.length !== 24) {
        setRotateView("error");
        setRotateError(`server returned ${words.length} words; expected 24`);
        return;
      }
      setRotatedWords(words);
      setRotateView("showing");
    } catch (e) {
      console.error("rotate recovery failed:", e);
      setRotateView("error");
      setRotateError(e instanceof ApiError
        ? `${e.code}: ${e.message}`
        : e instanceof Error ? e.message : "unknown error");
    }
  };

  const finishRotate = () => {
    setRotatedWords(null);
    setRotateView("idle");
  };

  // ---- rotate-showing view (full-modal takeover) ----------------------

  if (rotateView === "showing" && rotatedWords) {
    return (
      <div class="chalk-modal-backdrop" data-testid="profile-panel-rotate-backdrop">
        <div class="chalk-modal chalk-modal--wide" data-testid="profile-panel-rotate" role="dialog">
          <RecoveryScreen
            username={me.username}
            userID={me.userID}
            recoveryWords={rotatedWords}
            intent="regenerated"
            onConfirmed={finishRotate}
          />
        </div>
      </div>
    );
  }

  // ---- main view -------------------------------------------------------

  const submitEmailDisabled =
    emailChange.busy ||
    !emailChange.draft.trim() ||
    emailChange.draft.trim().toLowerCase() === me.email.toLowerCase();

  const emailBannerError = emailChange.errorCode && emailChange.errorMessage
    ? friendlyEmailChangeError(emailChange.errorCode, emailChange.errorMessage)
    : null;

  // 68-2/68-3: null means "not filtering" — show the active tab. Filtering
  // shows matching sections from every tab; show() composes with each
  // section's existing prop gates, it never replaces them.
  const matched = matchSections(filterQuery);
  const show = (id: SectionId) =>
    matched ? matched.has(id) : SECTION_TAB[id] === activeTab;

  return (
    <div
      class="chalk-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="profile-panel-backdrop"
    >
      {/* 70-2: --settings pins the modal to one height so switching tabs
          never resizes or re-centers it. */}
      <div class="chalk-modal chalk-modal--settings" data-testid="profile-panel" role="dialog" aria-label="profile">
        <header class="chalk-modal-header">
          <h2>profile</h2>
          <div class="chalk-modal-header-actions">
            {onRefresh && (
              <button
                type="button"
                class={`chalk-modal-refresh${refreshing ? " chalk-modal-refresh--spinning" : ""}`}
                onClick={onRefresh}
                disabled={refreshing}
                aria-label="refresh"
                title="refresh"
                data-testid="profile-panel-refresh"
              >
                ↻
              </button>
            )}
            <button
              type="button"
              class="chalk-modal-close"
              onClick={onClose}
              aria-label="close"
              data-testid="profile-panel-close"
            >
              ×
            </button>
          </div>
        </header>

        <div class="chalk-profile-filter">
          <input
            class="chalk-profile-filter-input"
            type="search"
            placeholder="filter settings…"
            aria-label="filter settings"
            value={filterQuery}
            onInput={(e) => setFilterQuery((e.target as HTMLInputElement).value)}
            data-testid="profile-filter-input"
          />
        </div>

        <nav class="chalk-profile-tabs" role="tablist" aria-label="settings sections" data-testid="profile-tabs">
          {SETTINGS_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              class={`chalk-profile-tab-btn${!matched && activeTab === t.id ? " chalk-profile-tab-btn--active" : ""}`}
              aria-selected={!matched && activeTab === t.id}
              onClick={() => {
                setFilterQuery("");
                setActiveTab(t.id);
              }}
              data-testid={`profile-tab-${t.id}`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div class="chalk-modal-body">
          {matched && matched.size === 0 && (
            <p class="chalk-profile-filter-empty" data-testid="profile-filter-empty">
              no settings match
            </p>
          )}

          {/* Identity section */}
          {show("identity") && (
            <section class="chalk-profile-identity">
              <h3>identity</h3>
              <dl class="chalk-profile-fields">
                <dt>username</dt>
                <dd data-testid="profile-username">@{me.username}</dd>

                <dt>display name</dt>
                <dd>{me.displayName || <em>(none set)</em>}</dd>

                <dt>email</dt>
                <dd data-testid="profile-email">{me.email}</dd>

                <dt>role</dt>
                <dd>{me.role}</dd>

                <dt>session</dt>
                <dd>expires {formatTimestamp(me.sessionExpiresAt)}</dd>
              </dl>
            </section>
          )}

          {show("appearance") && (
            <section class="chalk-profile-appearance">
              <h3>appearance</h3>
              {onSetTheme && (
                <div class="chalk-profile-field">
                  <label class="chalk-profile-label" for="theme-picker">theme</label>
                  <div class="chalk-profile-theme-picker" id="theme-picker" role="radiogroup" aria-label="theme">
                    {(["green", "light", "snazzy-light", "warmwhite", "vscode-light", "catppuccin-latte", "cyberpunk", "solarized-dark", "tokyo-night", "lcars", "blade-runner", "azeroth", "darkord", "exchalk", "catppuccin-mocha"] as const).map((t) => (
                      <label
                        key={t}
                        class={`chalk-profile-theme-option ${(theme ?? "green") === t ? "chalk-profile-theme-option--active" : ""}`}
                      >
                        <input
                          type="radio"
                          name="theme"
                          value={t}
                          checked={(theme ?? "green") === t}
                          onChange={() => onSetTheme(t)}
                          data-testid={`theme-option-${t}`}
                        />
                        <span class="chalk-profile-theme-swatch">
                          <span class={`chalk-profile-theme-swatch-preview chalk-profile-theme-swatch-preview--${t}`} aria-hidden="true" />
                          <span class="chalk-profile-theme-name">{t}</span>
                          <span class="chalk-profile-theme-desc">
                            {
                              t === "green" ? "default terminal" :
                              t === "light" ? "warm cream" :
                              t === "snazzy-light" ? "cool white, magenta accent" :
                              t === "warmwhite" ? "dark rail, warm white page" :
                              t === "vscode-light" ? "vs code light, editor white" :
                              t === "catppuccin-latte" ? "catppuccin light, mauve emphasis" :
                              t === "catppuccin-mocha" ? "catppuccin dark, mauve accent" :
                              t === "cyberpunk" ? "neon violet-black" :
                              t === "solarized-dark" ? "solarized dark" :
                              t === "tokyo-night" ? "tokyo night blue" :
                              t === "lcars" ? "starship okudagram" :
                              t === "blade-runner" ? "neon scarlet, smog black" :
                              t === "azeroth" ? "gold on forest green" :
                              t === "darkord" ? "blurple on deep grey" :
                              "true black, sky-blue links"
                            }
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                  <p class="chalk-profile-hint">
                    the theme follows you across devices.
                  </p>
                </div>
              )}

              <div class="chalk-profile-field">
                <label class="chalk-profile-label" for="font-picker">font</label>
                <div class="chalk-profile-theme-picker" id="font-picker" role="radiogroup" aria-label="font">
                  {FONT_CHOICES.map((f) => (
                    <label
                      key={f.value}
                      class={`chalk-profile-theme-option ${display.font === f.value ? "chalk-profile-theme-option--active" : ""}`}
                    >
                      <input
                        type="radio"
                        name="display-font"
                        value={f.value}
                        checked={display.font === f.value}
                        onChange={() => setDisplay({ font: f.value })}
                        data-testid={`font-option-${f.value}`}
                      />
                      <span class="chalk-profile-theme-swatch">
                        <span
                          class={`chalk-profile-font-sample chalk-profile-font-sample--${f.value}`}
                          aria-hidden="true"
                        >
                          Ag
                        </span>
                        <span class="chalk-profile-theme-name">{f.label}</span>
                        <span class="chalk-profile-theme-desc">{f.desc}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <div class="chalk-profile-field">
                <label class="chalk-profile-label" for="font-size">text size</label>
                <select
                  id="font-size"
                  class="chalk-profile-select"
                  value={String(display.scale)}
                  onChange={(e) => setDisplay({ scale: Number((e.target as HTMLSelectElement).value) })}
                  data-testid="display-font-scale"
                >
                  {SCALE_STEPS.map((s) => (
                    <option key={s.value} value={String(s.value)}>
                      {s.label} ({Math.round(s.value * 100)}%)
                    </option>
                  ))}
                </select>
              </div>

              <div class="chalk-profile-field">
                <label class="chalk-profile-label" for="app-width">layout width</label>
                <select
                  id="app-width"
                  class="chalk-profile-select"
                  value={display.appWidth}
                  onChange={(e) =>
                    setDisplay({
                      appWidth: (e.target as HTMLSelectElement).value as AppWidth,
                    })
                  }
                  data-testid="display-app-width"
                >
                  {APP_WIDTH_CHOICES.map((w) => (
                    <option key={w.value} value={w.value}>
                      {w.label}
                    </option>
                  ))}
                </select>
                <p class="chalk-profile-hint">
                  full window lets the conversation use the whole screen instead
                  of a centred column. on a narrow window the layout already
                  fills the screen, so this makes no difference there.
                </p>
              </div>

              <div class="chalk-profile-field">
                <label class="chalk-profile-checkbox-label">
                  <input
                    type="checkbox"
                    checked={display.hideScrollbars}
                    onChange={(e) =>
                      setDisplay({ hideScrollbars: (e.target as HTMLInputElement).checked })
                    }
                    data-testid="display-hide-scrollbars"
                  />
                  <span>hide scrollbars</span>
                </label>
                <p class="chalk-profile-hint">
                  with the bars hidden the wheel, trackpad and keyboard still
                  scroll. font, text size, layout width and this are stored on
                  this device only, so your phone and your desktop can differ.
                </p>
              </div>
            </section>
          )}

          {show("chat") && onSetChatPref && chatPrefs && (
            <section class="chalk-profile-chat">
              <h3>chat</h3>
              <div class="chalk-profile-field">
                <label class="chalk-profile-checkbox-label">
                  <input
                    type="checkbox"
                    checked={chatPrefs.showTimestamps}
                    onChange={(e) =>
                      onSetChatPref("showTimestamps", (e.target as HTMLInputElement).checked)
                    }
                    data-testid="chat-show-timestamps"
                  />
                  <span>show timestamps</span>
                </label>
              </div>
              <div class="chalk-profile-field">
                <label class="chalk-profile-label" for="timestamp-format">timestamp format</label>
                <select
                  id="timestamp-format"
                  class="chalk-profile-select"
                  value={chatPrefs.timestampFormat}
                  disabled={!chatPrefs.showTimestamps}
                  onChange={(e) =>
                    onSetChatPref(
                      "timestampFormat",
                      (e.target as HTMLSelectElement).value as "hms" | "hm" | "relative",
                    )
                  }
                  data-testid="chat-timestamp-format"
                >
                  <option value="hms">22:53:01 (hh:mm:ss)</option>
                  <option value="hm">22:53 (hh:mm)</option>
                  <option value="relative">5m ago (relative)</option>
                </select>
              </div>
              <div class="chalk-profile-field">
                <label class="chalk-profile-checkbox-label">
                  <input
                    type="checkbox"
                    checked={chatPrefs.compactMode}
                    onChange={(e) =>
                      onSetChatPref("compactMode", (e.target as HTMLInputElement).checked)
                    }
                    data-testid="chat-compact-mode"
                  />
                  <span>compact mode <span class="chalk-profile-theme-desc">(tighter row spacing)</span></span>
                </label>
              </div>
              {/* 33-4: sidebar width. Duplicates the drag handle on the
                  sidebar's edge, which is the faster gesture but invisible
                  until you hover it. Long channel names ellipsise to fit
                  whatever width is set. Desktop layout only -- on a phone
                  the roster is a drawer with its own sizing. */}
              <div class="chalk-profile-field">
                <label class="chalk-profile-label" for="sidebar-width">
                  sidebar width{" "}
                  <span class="chalk-profile-theme-desc">
                    ({chatPrefs.sidebarWidth}px, desktop only)
                  </span>
                </label>
                <input
                  id="sidebar-width"
                  type="range"
                  class="chalk-profile-range"
                  min={SIDEBAR_WIDTH_MIN}
                  max={SIDEBAR_WIDTH_MAX}
                  step={4}
                  value={chatPrefs.sidebarWidth}
                  // onChange, not onInput: a range fires input on every
                  // pixel of the drag, and each one is a prefs round-trip
                  // that fans out to the user's other devices.
                  onChange={(e) =>
                    onSetChatPref(
                      "sidebarWidth",
                      clampSidebarWidth(Number((e.target as HTMLInputElement).value)),
                    )
                  }
                  data-testid="chat-sidebar-width"
                />
              </div>
              {/* Phase 9.7f: nick colors. On by default; the self color is a
                  hue so it stays readable on every theme. Per-friend colors
                  are set by right-clicking (or long-pressing) a friend in the
                  roster, which is noted in the hint below. */}
              <div class="chalk-profile-field">
                <label class="chalk-profile-checkbox-label">
                  <input
                    type="checkbox"
                    checked={chatPrefs.userColorsEnabled}
                    onChange={(e) =>
                      onSetChatPref(
                        "userColorsEnabled",
                        (e.target as HTMLInputElement).checked,
                      )
                    }
                    data-testid="chat-user-colors-enabled"
                  />
                  <span>color user names in chat</span>
                </label>
              </div>
              {chatPrefs.userColorsEnabled && (
                <div class="chalk-profile-field">
                  <label class="chalk-profile-label" for="self-color">
                    your color
                  </label>
                  <div class="chalk-nick-menu-row">
                    <input
                      id="self-color"
                      type="color"
                      value={hexFromHue(chatPrefs.selfColorHue)}
                      onChange={(e) => {
                        const hue = hueFromHex((e.target as HTMLInputElement).value);
                        if (hue !== null) onSetChatPref("selfColorHue", hue);
                      }}
                      data-testid="chat-self-color"
                    />
                    <span
                      class="chalk-nick-preview"
                      style={nickTintStyle(chatPrefs.selfColorHue)}
                    >
                      you
                    </span>
                  </div>
                  <p class="chalk-profile-hint">
                    everyone gets an automatic color. right-click (or
                    long-press) a friend in the roster to change theirs.
                  </p>
                </div>
              )}
              {/* Phase 9.7h: composer tool row presentation. */}
              <div class="chalk-profile-field">
                <label class="chalk-profile-label" for="composer-tool-style">
                  composer buttons
                </label>
                <select
                  id="composer-tool-style"
                  class="chalk-profile-select"
                  value={chatPrefs.composerToolStyle}
                  onChange={(e) =>
                    onSetChatPref(
                      "composerToolStyle",
                      (e.target as HTMLSelectElement).value === "icons"
                        ? "icons"
                        : "text",
                    )
                  }
                  data-testid="composer-tool-style"
                >
                  <option value="text">text (FILE, GIF, EMOJI)</option>
                  <option value="icons">icons</option>
                </select>
              </div>
              {/* 42-1: typed emoticons -> emoji. */}
              <div class="chalk-profile-field">
                <label class="chalk-profile-checkbox-label">
                  <input
                    type="checkbox"
                    checked={chatPrefs.emoticons}
                    onChange={(e) =>
                      onSetChatPref(
                        "emoticons",
                        (e.target as HTMLInputElement).checked,
                      )
                    }
                    data-testid="chat-emoticons"
                  />
                  <span>turn typed emoticons into emoji</span>
                </label>
                <p class="chalk-profile-hint">
                  ":)" becomes 😀 as you type. backspace right after a swap
                  puts the characters back.
                </p>
              </div>
              {/* 43-8: typing indicators, both directions at once. */}
              <div class="chalk-profile-field">
                <label class="chalk-profile-checkbox-label">
                  <input
                    type="checkbox"
                    checked={chatPrefs.typingIndicators}
                    onChange={(e) =>
                      onSetChatPref(
                        "typingIndicators",
                        (e.target as HTMLInputElement).checked,
                      )
                    }
                    data-testid="chat-typing-indicators"
                  />
                  <span>show who is typing</span>
                </label>
                <p class="chalk-profile-hint">
                  works both ways: turn it off and you stop seeing "alice is
                  typing...", and nobody sees it about you either.
                </p>
              </div>
              {/* 67-1: long URLs collapse to a host label. */}
              <div class="chalk-profile-field">
                <label class="chalk-profile-checkbox-label">
                  <input
                    type="checkbox"
                    checked={chatPrefs.shortenLinks}
                    onChange={(e) =>
                      onSetChatPref(
                        "shortenLinks",
                        (e.target as HTMLInputElement).checked,
                      )
                    }
                    data-testid="chat-shorten-links"
                  />
                  <span>shorten long links</span>
                </label>
                <p class="chalk-profile-hint">
                  a very long url shows as [example.com/where-it-points…] —
                  trimmed to its start, tracking junk dropped. hovering shows
                  the real target, and right-click still copies the full
                  link.
                </p>
              </div>
              {/* 77-2: nano markdown, receive-side only. */}
              <div class="chalk-profile-field">
                <label class="chalk-profile-checkbox-label">
                  <input
                    type="checkbox"
                    checked={chatPrefs.nanoMarkdown}
                    onChange={(e) =>
                      onSetChatPref(
                        "nanoMarkdown",
                        (e.target as HTMLInputElement).checked,
                      )
                    }
                    data-testid="chat-nano-markdown"
                  />
                  <span>nano markdown</span>
                </label>
                <p class="chalk-profile-hint">
                  *asterisks* become italic, **two** become bold, and
                  `backticks` become fixed-width code. three markers, nothing
                  else — no headings, lists or link syntax. this only changes
                  what you read: your own typing is never altered, and the
                  people you write to see the plain characters unless they
                  turn this on too.
                </p>
              </div>
              {onSetUserColors && (
                <div class="chalk-profile-field">
                  <div class="chalk-profile-label">username colors</div>
                  <p class="chalk-profile-hint" style={{ marginTop: 0 }}>
                    custom display color for specific users in the chat
                    feed (sender label only, not the roster).
                  </p>
                  <div class="chalk-user-colors">
                    {chatPrefs.userColors.length === 0 && (
                      <div class="chalk-user-colors-empty">
                        no rules yet.
                      </div>
                    )}
                    {chatPrefs.userColors.map((rule, idx) => (
                      <div class="chalk-user-colors-row" key={idx}>
                        <input
                          type="text"
                          class="chalk-user-colors-handle"
                          placeholder="username"
                          value={rule.handle}
                          onInput={(e) => {
                            const next = chatPrefs.userColors.slice();
                            next[idx] = { ...rule, handle: (e.target as HTMLInputElement).value };
                            onSetUserColors(next);
                          }}
                          data-testid={`user-color-handle-${idx}`}
                        />
                        <input
                          type="color"
                          class="chalk-user-colors-color"
                          value={rule.color || "#888888"}
                          onChange={(e) => {
                            const next = chatPrefs.userColors.slice();
                            next[idx] = { ...rule, color: (e.target as HTMLInputElement).value };
                            onSetUserColors(next);
                          }}
                          data-testid={`user-color-color-${idx}`}
                        />
                        <select
                          class="chalk-profile-select chalk-user-colors-scope"
                          value={rule.scope}
                          onChange={(e) => {
                            const next = chatPrefs.userColors.slice();
                            next[idx] = { ...rule, scope: (e.target as HTMLSelectElement).value as "all" | "dm" };
                            onSetUserColors(next);
                          }}
                          data-testid={`user-color-scope-${idx}`}
                        >
                          <option value="all">all channels</option>
                          <option value="dm">DMs only</option>
                        </select>
                        <button
                          type="button"
                          class="chalk-user-colors-delete"
                          onClick={() => {
                            const next = chatPrefs.userColors.filter((_, i) => i !== idx);
                            onSetUserColors(next);
                          }}
                          title="delete rule"
                          data-testid={`user-color-delete-${idx}`}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    class="chalk-user-colors-add"
                    onClick={() => {
                      const next = chatPrefs.userColors.slice();
                      next.push({ handle: "", color: "#88ccff", scope: "all" });
                      onSetUserColors(next);
                    }}
                    data-testid="user-color-add"
                  >
                    + add color
                  </button>
                </div>
              )}
            </section>
          )}

          {/* 54-3: channel grouping. Off renders the sidebar's channel list
              flat, exactly as before phase 54. */}
          {show("roster") && rosterGroupingEnabled !== undefined && onSetRosterGrouping && (
            <section class="chalk-profile-roster" data-testid="roster-settings">
              <h3>channel list</h3>
              <div class="chalk-profile-field">
                <label class="chalk-profile-checkbox-label">
                  <input
                    type="checkbox"
                    checked={rosterGroupingEnabled}
                    onChange={(e) =>
                      onSetRosterGrouping((e.target as HTMLInputElement).checked)
                    }
                    data-testid="roster-grouping"
                  />
                  <span>
                    group channels{" "}
                    <span class="chalk-profile-theme-desc">
                      (collapsible headers in the sidebar, once more than one
                      group exists; each channel's group is suggested by its
                      creator)
                    </span>
                  </span>
                </label>
              </div>
              {/* 62-5: Zuckermode. Rendered inside the channel-list section
                  because it is a roster-presentation choice; the pref is
                  synced but only phones act on it. */}
              {zuckerEnabled !== undefined && onSetZucker && (
                <div class="chalk-profile-field">
                  <label class="chalk-profile-checkbox-label">
                    <input
                      type="checkbox"
                      checked={zuckerEnabled}
                      onChange={(e) =>
                        onSetZucker((e.target as HTMLInputElement).checked)
                      }
                      data-testid="roster-zuckermode"
                    />
                    <span>
                      Zuckermode{" "}
                      <span class="chalk-profile-theme-desc">
                        (phones only: replaces the sidebar with one
                        WhatsApp-style list of every conversation — people and
                        channels together, newest first, with a preview of the
                        last message)
                      </span>
                    </span>
                  </label>
                </div>
              )}
            </section>
          )}

          {/* 76-1: the cheat sheet the composer's "?" used to hold. Same
              composerHelp() rows, so the two can't drift; the keys are the
              same on every device, so there is nothing to store.
              94-3: except Enter, which sends on a desktop and types a newline
              on a phone -- hence the viewport argument. */}
          {show("shortcuts") && (
            <section class="chalk-profile-shortcuts" data-testid="shortcuts-settings">
              <h3>keyboard shortcuts</h3>
              <p class="chalk-profile-hint">
                What the composer listens for while you type. Nothing here is
                configurable yet.
              </p>
              <dl class="chalk-profile-keys" data-testid="shortcuts-list">
                {composerHelp(isMacPlatform(), isMobile).map((row) => (
                  <div class="chalk-profile-keys-row" key={row.keys}>
                    <dt>
                      <kbd>{row.keys}</kbd>
                    </dt>
                    <dd>{row.what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          {/* 53-1: the parking lot. Both settings are account-level: the title
              is a personal label and hiding the row is a decision about your
              chalk, so they follow you to your other devices. */}
          {show("parking") && parkingLot && onSetParkingLot && (
            <section class="chalk-profile-parking" data-testid="parking-settings">
              <h3>parking lot</h3>
              <p class="chalk-profile-hint">
                A row in the sidebar that holds nothing. Click it — or press{" "}
                {PARKING_HOTKEY_LABEL} — when someone walks up behind you: the
                conversation is replaced by the chalk mark, and chalk stays
                connected — calls keep running, nothing is marked read, and no
                notification pops up with the text in it. {PARKING_HOTKEY_LABEL}{" "}
                again brings back what you were reading, thread and panel
                included; picking any channel works too.
              </p>
              <div class="chalk-profile-field">
                <label class="chalk-profile-label" for="parking-name">
                  what to call it
                </label>
                <input
                  id="parking-name"
                  class="chalk-field-input"
                  type="text"
                  maxLength={PARKING_LOT_NAME_MAX}
                  placeholder={PARKING_LOT_DEFAULT_NAME}
                  value={parkingDraft}
                  data-testid="parking-name"
                  onInput={(e) => setParkingDraft((e.target as HTMLInputElement).value)}
                  // Committed on blur/Enter rather than per keystroke: every
                  // commit is a prefs round-trip that fans out to this user's
                  // other devices.
                  onChange={commitParkingName}
                  onBlur={commitParkingName}
                />
              </div>
              <div class="chalk-profile-field">
                <label class="chalk-profile-checkbox-label">
                  <input
                    type="checkbox"
                    checked={!parkingLot.hidden}
                    onChange={(e) =>
                      onSetParkingLot({
                        ...parkingLot,
                        hidden: !(e.target as HTMLInputElement).checked,
                      })
                    }
                    data-testid="parking-visible"
                  />
                  <span>
                    show it in the sidebar{" "}
                    <span class="chalk-profile-theme-desc">
                      (off hides the row; {PARKING_HOTKEY_LABEL} still parks and
                      unparks)
                    </span>
                  </span>
                </label>
              </div>

              {/* 53-5: the privacy screen. Off by default -- every session
                  starts parked, so on by default would blur the window on
                  every reload. */}
              <div class="chalk-profile-field">
                <label class="chalk-profile-checkbox-label">
                  <input
                    type="checkbox"
                    checked={parkingLot.screen}
                    onChange={(e) =>
                      onSetParkingLot({
                        ...parkingLot,
                        screen: (e.target as HTMLInputElement).checked,
                      })
                    }
                    data-testid="parking-screen"
                  />
                  <span>
                    hide the rest of chalk too{" "}
                    <span class="chalk-profile-theme-desc">
                      (blurs the channel list, your friends, your own name and
                      the call bar while parked; the tab stops showing an unread
                      count and notification sounds go quiet)
                    </span>
                  </span>
                </label>
              </div>
            </section>
          )}

          {/* 40-3: notification sounds. Per-device, so this section talks to
              localStorage through useSoundPrefs directly rather than taking
              props -- nothing here goes near the server. Every cue has a play
              button, so you can hear a setting before you commit to it. */}
          {show("notifications") && (
            <section class="chalk-profile-notifications" data-testid="notify-settings">
              <h3>notifications</h3>

              <div class="chalk-profile-field">
                <label class="chalk-profile-checkbox-label">
                  <input
                    type="checkbox"
                    checked={sound.master}
                    onChange={(e) => setSound({ master: (e.target as HTMLInputElement).checked })}
                    data-testid="notify-sounds-master"
                  />
                  <span>play sounds</span>
                </label>
              </div>

              <div class="chalk-profile-field">
                <label class="chalk-profile-label" for="notify-volume">
                  volume{" "}
                  <span class="chalk-profile-theme-desc">({Math.round(sound.volume * 100)}%)</span>
                </label>
                <input
                  id="notify-volume"
                  type="range"
                  class="chalk-profile-range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={sound.volume}
                  disabled={!sound.master}
                  // onChange, not onInput: a range fires input on every pixel
                  // of the drag, and each one is a write plus a fan-out to the
                  // other tabs on this device.
                  onChange={(e) => setSound({ volume: Number((e.target as HTMLInputElement).value) })}
                  data-testid="notify-volume"
                />
              </div>

              <div class="chalk-profile-field">
                <label class="chalk-profile-checkbox-label">
                  <input
                    type="checkbox"
                    checked={sound.dnd}
                    disabled={!sound.master}
                    onChange={(e) => setSound({ dnd: (e.target as HTMLInputElement).checked })}
                    data-testid="notify-dnd"
                  />
                  <span>
                    do not disturb{" "}
                    <span class="chalk-profile-theme-desc">(silence everything, keep the badges)</span>
                  </span>
                </label>
              </div>

              {/* 102-1: the sound theme. Per-device, like the volume. The
                  rows below preview in whichever theme is selected here, so
                  choosing one is: pick, then press play on a few. */}
              <div class="chalk-profile-field">
                <label class="chalk-profile-label" for="notify-theme">
                  sound theme{" "}
                  <span class="chalk-profile-theme-desc">
                    ({SOUND_THEMES.find((t) => t.id === sound.theme)?.desc})
                  </span>
                </label>
                <select
                  id="notify-theme"
                  class="chalk-profile-select"
                  value={sound.theme}
                  disabled={!sound.master}
                  onChange={(e) => {
                    const v = (e.target as HTMLSelectElement).value;
                    if (isSoundThemeId(v)) {
                      setSound({ theme: v });
                      // Hear it at once: the change is the gesture that unlocks
                      // audio, and the message cue is the one you'll hear most.
                      notifySounds().preview("message", v);
                    }
                  }}
                  data-testid="notify-theme"
                >
                  {SOUND_THEMES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* 50-4: everything about people -- which events matter, who is
                  loud, what a priority does -- lives in the rules panel. */}
              {onOpenNotificationRules && (
                <div class="chalk-profile-field">
                  <button
                    type="button"
                    class="chalk-notify-permission-btn"
                    data-testid="open-notify-rules"
                    onClick={onOpenNotificationRules}
                  >
                    notification rules…
                  </button>
                  <p class="chalk-profile-hint">
                    priorities, per-person and per-channel rules, desktop banners.
                  </p>
                </div>
              )}

              {/* 50-2: only the machine noises live here now. What the chat
                  and event notifications do is the rules engine's business,
                  configured in the notification rules panel. */}
              <div class="chalk-profile-field">
                <label class="chalk-profile-label">chalk's own noises</label>
                <div class="chalk-profile-sound-list">
                  {MACHINE_CATEGORIES.map((c) => (
                    <div class="chalk-profile-sound-row" key={c}>
                      <label class="chalk-profile-checkbox-label">
                        <input
                          type="checkbox"
                          checked={sound.categories[c]}
                          disabled={!sound.master}
                          onChange={(e) =>
                            setSoundCategory(c, (e.target as HTMLInputElement).checked)
                          }
                          data-testid={`notify-category-${c}`}
                        />
                        <span>
                          {CATEGORY_LABELS[c].label}
                          {CATEGORY_LABELS[c].desc && (
                            <span class="chalk-profile-theme-desc"> — {CATEGORY_LABELS[c].desc}</span>
                          )}
                        </span>
                      </label>
                      <button
                        type="button"
                        class="chalk-profile-sound-preview"
                        // Deliberately not disabled with the master switch:
                        // hearing one is how you decide whether to turn the
                        // whole thing back on.
                        onClick={() => notifySounds().preview(c)}
                        aria-label={`play the ${CATEGORY_LABELS[c].label} sound`}
                        data-testid={`notify-preview-${c}`}
                      >
                        play
                      </button>
                    </div>
                  ))}
                </div>
                <p class="chalk-profile-hint">
                  these settings stay on this device — your phone and your desktop can disagree.
                  chalk keeps quiet for whatever channel you're already reading.
                </p>
              </div>
            </section>
          )}

          {/* 45-4: away detection. Only rendered where the browser actually
              has the API -- Firefox and Safari have both declined to implement
              it, and a switch that cannot do anything is worse than no switch.
              Per-device for the same reason the sounds are: the permission
              belongs to this browser and cannot follow you to your phone. */}
          {show("away") && systemIdleSupported() && (
            <section class="chalk-profile-notifications" data-testid="idle-settings">
              <h3>away detection</h3>
              <div class="chalk-profile-field">
                <label class="chalk-profile-checkbox-label">
                  <input
                    type="checkbox"
                    checked={idle.systemIdle}
                    onChange={(e) =>
                      setIdle({ systemIdle: (e.target as HTMLInputElement).checked })
                    }
                    data-testid="idle-system"
                  />
                  <span>
                    notice when you leave the machine{" "}
                    <span class="chalk-profile-theme-desc">
                      (asks the browser once; chrome and edge only)
                    </span>
                  </span>
                </label>
              </div>
              <p class="chalk-profile-hint">
                {idlePerm === "denied" ? (
                  <>
                    your browser has blocked this for chalk, so away is guessed from
                    activity in the tab instead. the site permissions for this page are
                    where to undo that.
                  </>
                ) : (
                  <>
                    with this on, chalk can tell reading a long thread from having walked
                    away, and stops going quiet for a channel that's on screen with nobody
                    in front of it. with it off, away is guessed from what you do in the
                    tab. either way nothing about it leaves this device.
                  </>
                )}
              </p>
            </section>
          )}

          {/* 44-3: the mic settings live in their own dialog now, opened from
              the ⚙ in the footer's voice cluster. This is the signpost for
              anyone who comes here looking for them. */}
          {show("voice") && onOpenMicSettings && (
            <section class="chalk-profile-microphone-link">
              <h3>voice &amp; video</h3>
              <div class="chalk-profile-field">
                <button
                  type="button"
                  class="chalk-profile-clear-cache"
                  onClick={onOpenMicSettings}
                  data-testid="open-mic-settings"
                >
                  voice &amp; video settings…
                </button>
                <p class="chalk-profile-hint" style={{ marginTop: "0.5rem" }}>
                  microphone, camera and output device, level, when to transmit and the voice
                  keys. also on the ⚙ beside the mute button, under your channel list.
                </p>
              </div>
            </section>
          )}

          {/* att-2: storage -- clear the cached attachment ciphertext. */}
          {show("storage") && onClearImageCache && (
            <section class="chalk-profile-storage">
              <h3>storage</h3>
              <div class="chalk-profile-field">
                <button
                  type="button"
                  class="chalk-profile-clear-cache"
                  onClick={() => {
                    void Promise.resolve(onClearImageCache()).then(() => {
                      setImageCacheCleared(true);
                      setTimeout(() => setImageCacheCleared(false), 3000);
                    });
                  }}
                  data-testid="clear-image-cache"
                >
                  clear cached images
                </button>
                <p class="chalk-profile-hint" style={{ marginTop: "0.5rem" }}>
                  {imageCacheCleared
                    ? "cached images cleared."
                    : "removes locally cached attachment data from this device. images re-download from the server on next view."}
                </p>
              </div>
            </section>
          )}

          {/* att-4b: Giphy consent. Enabling routes through the app-level
              consent modal (onRequestEnableGiphy) so the privacy tradeoff is
              explained first; disabling is direct. Per-device, default off. */}
          {show("giphy") && onSetGiphyPref && (
            <section class="chalk-profile-storage" data-testid="giphy-settings">
              <h3>giphy</h3>
              <div class="chalk-profile-field">
                <label class="chalk-profile-checkbox-label">
                  <input
                    type="checkbox"
                    checked={giphyPref === "enabled"}
                    onChange={(e) => {
                      const on = (e.target as HTMLInputElement).checked;
                      if (on) {
                        if (onRequestEnableGiphy) onRequestEnableGiphy();
                        else onSetGiphyPref("enabled");
                      } else {
                        onSetGiphyPref("disabled");
                      }
                    }}
                    data-testid="giphy-toggle"
                  />
                  enable Giphy GIFs
                </label>
                <p class="chalk-profile-hint" style={{ marginTop: "0.5rem" }}>
                  {giphyPref === "enabled"
                    ? "on: Giphy messages render as GIFs, fetched from Giphy's CDN. Your IP and the GIF you view are visible to Giphy. Per-device; affects only you."
                    : giphyPref === "disabled"
                      ? "off: Giphy messages show as plain links and are never fetched. Nothing reaches Giphy."
                      : "not set: Giphy messages show as plain links until you opt in. Enabling lets your browser fetch GIFs from Giphy's CDN, revealing your IP to Giphy."}
                </p>
              </div>
            </section>
          )}

          {/* 57-4: link previews. Enabling routes through the app-level
              consent modal like Giphy; disabling is direct. The domain
              editor shapes the compose-side whitelist only -- received
              cards render regardless (they cost no fetches), unless the
              separate hide toggle is on. */}
          {show("linkpreviews") && onSetLinkPreviewPref && (
            <section class="chalk-profile-storage" data-testid="linkpreview-settings">
              <h3>link previews</h3>
              <div class="chalk-profile-field">
                <label class="chalk-profile-checkbox-label">
                  <input
                    type="checkbox"
                    checked={linkPreviewPref === "enabled"}
                    onChange={(e) => {
                      const on = (e.target as HTMLInputElement).checked;
                      if (on) {
                        if (onRequestEnableLinkPreview) onRequestEnableLinkPreview();
                        else onSetLinkPreviewPref("enabled");
                      } else {
                        onSetLinkPreviewPref("disabled");
                      }
                    }}
                    data-testid="linkpreview-toggle"
                  />
                  build previews for links I send
                </label>
                <p class="chalk-profile-hint" style={{ marginTop: "0.5rem" }}>
                  {linkPreviewPref === "enabled"
                    ? "on: pasting a whitelisted link asks YOUR server to fetch the page; the preview travels inside the encrypted message. The site sees the server's address, the server sees the link. Nobody else fetches anything."
                    : "off: links you send stay plain text. Previews others send still show (they cost you nothing -- everything is inside the encrypted message)."}
                </p>
                {onSetLinkPreviewHide && (
                  <label class="chalk-profile-checkbox-label" style={{ marginTop: "0.5rem" }}>
                    <input
                      type="checkbox"
                      checked={linkPreviewHide === true}
                      onChange={(e) =>
                        onSetLinkPreviewHide((e.target as HTMLInputElement).checked)
                      }
                      data-testid="linkpreview-hide-toggle"
                    />
                    hide preview cards others send (show plain text)
                  </label>
                )}
                {onSetLinkPreviewDomains && (
                  <LinkPreviewDomainEditor
                    serverDomains={linkPreviewServerDomains ?? []}
                    overrides={linkPreviewOverrides}
                    onSet={onSetLinkPreviewDomains}
                  />
                )}
              </div>
            </section>
          )}

          {/* Email change section */}
          {show("email") && (
            <section class="chalk-profile-email-change">
              <h3>change email</h3>
              {emailChange.pendingSummary ? (
                <div class="chalk-profile-pending" data-testid="profile-email-pending">
                  <p>
                    we sent a verification email to{" "}
                    <strong>{emailChange.pendingSummary.newEmail}</strong>.
                  </p>
                  <p class="chalk-auth-subtitle">
                    click the link in that email to complete the change.
                    it expires on {formatTimestamp(emailChange.pendingSummary.expiresAt)}.
                  </p>
                  <p class="chalk-auth-subtitle">
                    we also notified your current email address as a
                    security heads-up.
                  </p>
                  <button
                    type="button"
                    class="chalk-button chalk-button--secondary"
                    onClick={onEmailChangeDismiss}
                    data-testid="profile-email-pending-dismiss"
                  >
                    ok
                  </button>
                </div>
              ) : (
                <form
                  class="chalk-auth-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (submitEmailDisabled) return;
                    onEmailChangeSubmit();
                  }}
                  data-testid="profile-email-form"
                >
                  {emailBannerError && (
                    <div class="chalk-auth-error" data-testid="profile-email-error">
                      {emailBannerError}
                    </div>
                  )}
                  <div class="chalk-field">
                    <label class="chalk-field-label" for="profile-email-new">
                      new email
                    </label>
                    <input
                      id="profile-email-new"
                      class="chalk-field-input"
                      type="email"
                      autoComplete="email"
                      autoCapitalize="none"
                      required
                      value={emailChange.draft}
                      disabled={emailChange.busy}
                      onInput={(e) => onEmailChangeDraft((e.target as HTMLInputElement).value)}
                      data-testid="profile-email-input"
                    />
                    <span class="chalk-field-hint">
                      a verification link will be sent to this address;
                      the change isn't final until you click it
                    </span>
                  </div>
                  <button
                    type="submit"
                    class="chalk-button chalk-button--primary"
                    disabled={submitEmailDisabled}
                    data-testid="profile-email-submit"
                  >
                    {emailChange.busy ? "sending..." : "send verification email"}
                  </button>
                </form>
              )}
            </section>
          )}

          {/* Rotate recovery section */}
          {show("recovery") && (
            <section class="chalk-profile-rotate">
              <h3>recovery code</h3>
              <p class="chalk-auth-subtitle">
                if you suspect your recovery phrase has been seen by
                someone else, you can rotate it now. doing so consumes
                the existing phrase; you'll be shown a fresh one
                immediately.
              </p>
              {rotateView === "error" && (
                <div class="chalk-auth-error" data-testid="profile-rotate-error">
                  {rotateError}
                </div>
              )}
              {rotateView === "confirm" ? (
                <StepUpPrompt
                  username={me.username}
                  action="rotate your recovery phrase"
                  onConfirm={startRotate}
                  onCancel={() => setRotateView("idle")}
                  testid="profile-rotate-stepup"
                />
              ) : (
                <button
                  type="button"
                  class="chalk-button chalk-button--secondary"
                  onClick={() => { setRotateError(""); setRotateView("confirm"); }}
                  disabled={rotateView === "loading"}
                  data-testid="profile-rotate-button"
                >
                  {rotateView === "loading" ? "rotating..." : "rotate recovery code"}
                </button>
              )}
            </section>
          )}

          {/* md-4-2: passkeys. Account access is per-device; add a passkey
              on each device you use so you don't have to fall back to the
              one-time recovery code. Distinct from the 24-word decryption
              phrase, which is client-only and unlocks message history. */}
          {/* 31-8: password / two-factor / phrase-link management. */}
          {show("security") && <SecurityPanel username={me.username} />}
          {/* 83-9: the pinned server identity, readable outside the wall. */}
          {show("serveridentity") && <ServerIdentityCard sealed={!!serverSealed} />}

          {show("passkeys") && (
            <section class="chalk-profile-passkeys" data-testid="profile-passkeys">
              <h3>passkeys</h3>
              <p class="chalk-auth-subtitle">
                passkeys are how you sign in to this account. add one on each
                device you use, so you don't have to fall back to your recovery
                code. this is account sign-in only — it's separate from your
                24-word decryption phrase, which unlocks your message history.
              </p>
              {passkeysError && (
                <div class="chalk-auth-error" data-testid="passkeys-load-error">{passkeysError}</div>
              )}
              {passkeys === null ? (
                <p class="chalk-profile-hint">loading…</p>
              ) : passkeys.length === 0 ? (
                <p class="chalk-profile-hint" data-testid="passkeys-empty">
                  no passkeys on this account yet.
                </p>
              ) : (
                <ul class="chalk-profile-passkey-list" data-testid="passkey-list" style={{ listStyle: "none", padding: 0, margin: "0 0 0.75rem 0" }}>
                  {passkeys.map((pk) => (
                    <li key={pk.id} class="chalk-profile-passkey" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "0.5rem", padding: "0.35rem 0", borderBottom: "1px solid var(--chalk-border, rgba(255,255,255,0.08))" }}>
                      <div style={{ minWidth: 0 }}>
                        <div>{pk.name || "unnamed passkey"}</div>
                        <div class="chalk-profile-hint" style={{ marginTop: 0 }}>
                          added {formatMillis(pk.createdAt)}
                          {pk.lastUsedAt ? ` · last used ${formatMillis(pk.lastUsedAt)}` : " · never used"}
                        </div>
                      </div>
                      {passkeys.length > 1 && (
                        confirmDeleteId === pk.id ? (
                          // 81-2: removing a sign-in credential is step-up
                          // gated, so the confirmation IS the proof form.
                          <StepUpPrompt
                            username={me.username}
                            action="remove this passkey"
                            busy={deletingId === pk.id}
                            onConfirm={(proof) => onDeletePasskey(pk.id, proof)}
                            onCancel={() => setConfirmDeleteId(null)}
                            testid={`passkey-delete-stepup-${pk.id}`}
                          />
                        ) : (
                          <button
                            type="button"
                            class="chalk-button chalk-button--secondary"
                            style={{ flexShrink: 0 }}
                            onClick={() => {
                              setDeleteError("");
                              setConfirmDeleteId(pk.id);
                            }}
                            data-testid={`passkey-remove-${pk.id}`}
                          >
                            remove
                          </button>
                        )
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {deleteError && (
                <div class="chalk-auth-error" data-testid="delete-passkey-error">{deleteError}</div>
              )}
              {addError && (
                <div class="chalk-auth-error" data-testid="add-passkey-error">{addError}</div>
              )}
              <div class="chalk-profile-field">
                <label class="chalk-profile-label" for="new-passkey-name">name (optional)</label>
                <input
                  id="new-passkey-name"
                  class="chalk-field-input"
                  type="text"
                  maxLength={64}
                  placeholder="e.g. work laptop"
                  autoComplete="off"
                  value={newPasskeyName}
                  onInput={(e) => setNewPasskeyName((e.target as HTMLInputElement).value)}
                  disabled={addState === "running"}
                  data-testid="new-passkey-name"
                />
              </div>
              {pendingPasskey?.kind === "add" ? (
                <StepUpPrompt
                  username={me.username}
                  action="add a passkey"
                  busy={addState === "running"}
                  onConfirm={onAddPasskey}
                  onCancel={() => setPendingPasskey(null)}
                  testid="add-passkey-stepup"
                />
              ) : (
                <button
                  type="button"
                  class="chalk-button chalk-button--secondary"
                  onClick={() => { setAddError(""); setPendingPasskey({ kind: "add" }); }}
                  disabled={addState === "running"}
                  data-testid="add-passkey-button"
                >
                  {addState === "running" ? "follow your browser's prompt…" : "add a passkey to this device"}
                </button>
              )}
            </section>
          )}

          {/* 84-3: the pin backup, in the terms the user meets it in -- the
              badges in the members list. What it is FOR is the wiped-profile
              case, so the copy leads with that rather than with the sync. */}
          {show("pins") && (
            <section class="chalk-profile-pins" data-testid="pin-backup">
              <h3>verified identities</h3>
              <dl class="chalk-profile-fields">
                <dt>backed up</dt>
                <dd data-testid="pin-backup-count">
                  {pinStatus
                    ? pinStatus.backedUp === pinStatus.held
                      ? `${pinStatus.held} ${pinStatus.held === 1 ? "person" : "people"}`
                      : `${pinStatus.backedUp} of ${pinStatus.held}`
                    : "not started"}
                </dd>
                {pinStatus?.syncedAt != null && (
                  <>
                    <dt>last updated</dt>
                    <dd>{formatTimestamp(new Date(pinStatus.syncedAt).toISOString())}</dd>
                  </>
                )}
                {pinStatus != null && pinStatus.restored > 0 && (
                  <>
                    <dt>restored here</dt>
                    <dd data-testid="pin-backup-restored">
                      {pinStatus.restored} this session
                    </dd>
                  </>
                )}
              </dl>
              <p class="chalk-profile-hint">
                the key your app recognises for each person — and every safety
                number you compared in person — is kept on the server, encrypted
                with your identity, which the server has no key for. a new
                browser or a cleared profile gets them back when you unlock your
                encryption phrase, so people you already trusted don't come back
                as strangers.
              </p>
              {pinStatus != null && pinStatus.backedUp < pinStatus.held && (
                <p class="chalk-profile-hint" data-testid="pin-backup-full">
                  the backup is full, so {pinStatus.held - pinStatus.backedUp}{" "}
                  of these are on this device only. everyone you verified in
                  person is kept first.
                </p>
              )}
              {pinStatus != null && pinStatus.conflicts.length > 0 && (
                <p class="chalk-profile-warn" data-testid="pin-backup-conflicts">
                  {pinStatus.conflicts.length === 1
                    ? "one person's key"
                    : `${pinStatus.conflicts.length} people's keys`}{" "}
                  differ between your devices. this device keeps what it saw
                  first — open the members list in a shared channel and compare
                  the safety number to settle it.
                </p>
              )}
            </section>
          )}

          {/* 39-1: which build you're on, and what changed in it. */}
          {show("about") && (
            <section class="chalk-profile-about">
              <h3>about</h3>
              <dl class="chalk-profile-fields">
                <dt>version</dt>
                <dd>
                  <VersionLink
                    version={serverVersion}
                    commit={serverCommit}
                    variant="row"
                    testID="profile-version"
                  />
                  {serverCommit && serverCommit !== "unknown" && (
                    <span class="chalk-profile-theme-desc"> ({serverCommit})</span>
                  )}
                </dd>
              </dl>
              <p class="chalk-profile-hint">
                opens the changelog for this build on github.
              </p>
            </section>
          )}
        </div>

        {/* The header's version badge is hidden on mobile, so this footer is
            a phone's only glanceable version. Outside the tab/filter gating:
            visible whichever tab or filter is active. */}
        <footer class="chalk-modal-footer chalk-modal-footer--about">
          <VersionLink
            version={serverVersion}
            commit={serverCommit}
            variant="row"
            testID="profile-footer-version"
          />
        </footer>
      </div>
    </div>
  );
}

function friendlyDeletePasskeyError(code: string, message: string): string {
  switch (code) {
    case "last_passkey":
      return "this is your only passkey — add another before removing it.";
    case "passkey_not_found":
      return "that passkey is already gone.";
    case "no_session":
    case "invalid_session":
      return "your session expired. please log in again.";
    default:
      return message || "couldn't remove the passkey.";
  }
}

function friendlyAddPasskeyError(code: string, message: string): string {
  switch (code) {
    case "ceremony_validation_failed":
      return "that passkey couldn't be verified. please try again.";
    case "ceremony_expired":
      return "the request timed out. please try again.";
    case "ceremony_not_found":
      return "the request couldn't be matched. please try again.";
    case "persist_failed":
      return "couldn't save the passkey — it may already be registered on this device.";
    case "ceremony_user_mismatch":
    case "no_session":
    case "invalid_session":
      return "your session expired. please log in again.";
    default:
      return message || "couldn't add a passkey; see browser console.";
  }
}

function formatMillis(ms: number): string {
  try {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

function friendlyEmailChangeError(code: string, message: string): string {
  switch (code) {
    case "bad_email":
      return "that doesn't look like a valid email address.";
    case "same_email":
      return "the new email is the same as your current one.";
    case "email_blacklisted":
      return "that email cannot be used.";
    case "email_taken":
      return "that email is already in use by another account.";
    case "email_pending_elsewhere":
      return "that email has a pending change for another account.";
    default:
      return message || "couldn't start email change; see browser console.";
  }
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

// 57-4: the compose-side whitelist editor. Server defaults are checkboxes
// (unchecking records the domain in overrides.removed); own additions are
// listed with a remove control and grown through the input below. The whole
// overrides object is sent on every change -- JSONB shallow merge, like the
// chat block.
function LinkPreviewDomainEditor({
  serverDomains,
  overrides,
  onSet,
}: {
  serverDomains: string[];
  overrides: LinkPreviewDomainPrefs | undefined;
  onSet: (next: LinkPreviewDomainPrefs) => void;
}) {
  const [input, setInput] = useState("");
  const [inputError, setInputError] = useState(false);
  const added = (overrides?.added ?? []).filter((d) => typeof d === "string");
  const removed = new Set((overrides?.removed ?? []).filter((d) => typeof d === "string"));

  const setDefaultEnabled = (domain: string, enabled: boolean) => {
    const nextRemoved = enabled
      ? [...removed].filter((d) => d !== domain)
      : [...new Set([...removed, domain])];
    onSet({ added, removed: nextRemoved });
  };

  const addDomain = () => {
    const d = normalizeDomainInput(input);
    if (d === null || added.includes(d) || serverDomains.includes(d)) {
      setInputError(true);
      return;
    }
    setInputError(false);
    setInput("");
    onSet({ added: [...added, d], removed: [...removed] });
  };

  const removeAdded = (domain: string) => {
    onSet({ added: added.filter((d) => d !== domain), removed: [...removed] });
  };

  return (
    <div class="chalk-linkpreview-domains" data-testid="linkpreview-domains">
      <p class="chalk-profile-hint" style={{ marginTop: "0.75rem" }}>
        preview links from these sites (and their subdomains):
      </p>
      {serverDomains.map((d) => (
        <label class="chalk-profile-checkbox-label chalk-linkpreview-domain-row" key={d}>
          <input
            type="checkbox"
            checked={!removed.has(d)}
            onChange={(e) => setDefaultEnabled(d, (e.target as HTMLInputElement).checked)}
            data-testid={`linkpreview-domain-${d}`}
          />
          {d}
        </label>
      ))}
      {added.map((d) => (
        <div class="chalk-linkpreview-domain-row chalk-linkpreview-domain-row--added" key={d}>
          <span>{d}</span>
          <button
            type="button"
            class="chalk-linkpreview-domain-remove"
            onClick={() => removeAdded(d)}
            title={`stop previewing ${d}`}
            aria-label={`remove ${d}`}
            data-testid={`linkpreview-domain-remove-${d}`}
          >
            ✕
          </button>
        </div>
      ))}
      <div class="chalk-linkpreview-domain-add">
        <input
          type="text"
          value={input}
          placeholder="add a site, e.g. bandcamp.com"
          class={inputError ? "chalk-linkpreview-domain-input--error" : ""}
          onInput={(e) => {
            setInput((e.target as HTMLInputElement).value);
            setInputError(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addDomain();
            }
          }}
          data-testid="linkpreview-domain-input"
        />
        <button type="button" onClick={addDomain} data-testid="linkpreview-domain-add">
          add
        </button>
      </div>
      <p class="chalk-profile-hint">
        your server fetches whatever you ask it to preview; this list only
        decides which links offer one automatically.
      </p>
    </div>
  );
}
