# Tags

Topic → where it lives.

chalk's source is already densely tagged, by phase number: 646 comments like
`// 54-2:` across 123 files. But phase numbers are chronological and features
are not — the threads dot was built across 42, 45, 47 and 49, and the roster
across 54 alone. This file is the legend that turns those numbers back into
topics, so a topic can be looked up without knowing when it was built.

    tools/where.sh -g roster        # the topic's phase tags and its name, layer-grouped
    tools/where.sh -g               # list every tag

**Format.** A tag line is `#tag`, the phase numbers it covers (`-` if it
predates the convention or was never phase-tagged), then the paths it lives in.
Everything else in this file is prose and ignored by the tooling. Paths are
where to start reading, not an exhaustive list — the search is what finds the
edges.

**Keeping it honest.** Add a tag line when a topic gets its own phase, and
extend an existing one when a later phase touches the same topic. A tag whose
phases have drifted is worse than a missing tag, so correct it in place rather
than adding a second entry. `-g` warns when a listed path no longer exists.

#auth           31        internal/auth/ web/src/auth/ web/src/crypto/authkdf.ts docs/phases/PHASE-31-AUTHV2.md
#browser        48        web/src/webauthn.ts web/src/crypto/ docs/browser-support.md docs/phases/PHASE-48-BROWSER.md
#friends        59 89     internal/friends/ web/src/components/ web/src/settings-nav.ts web/src/components/StatusBar.tsx docs/phases/PHASE-59-FRIENDS.md docs/phases/PHASE-89-REQUESTHINT.md
#voice          30 41 44 45 63 66 70 71 95 96 97 103  internal/turncred/ web/src/voice/ web/src/components/VoiceCallPanel.tsx web/src/components/VoiceControls.tsx web/src/components/VoiceDock.tsx docs/phases/PHASE-30-VOICE.md docs/phases/PHASE-41-MICROPHONE.md docs/phases/PHASE-44-VOICEPANEL.md docs/phases/PHASE-63-CALLTILES.md docs/phases/PHASE-66-CALLPREFS.md docs/phases/PHASE-95-PHONEVOICE.md docs/phases/PHASE-96-CALLSTAGE.md docs/phases/PHASE-97-VOICEDIAG.md docs/phases/PHASE-103-CAMERAOFF.md docs/design/chalk-phase-30-voice-video-design.md
#camera-bg      52        web/src/voice/ web/src/components/ docs/phases/PHASE-52-CAMERABG.md
#threads        42 45 47 49  web/src/chat/threadinbox.ts web/src/chat/ web/src/components/ docs/phases/PHASE-42-THREADS.md docs/phases/PHASE-47-THREADINBOX.md docs/phases/PHASE-49-THREADTITLES.md
#ties           -         docs/phases/PHASE-86-TIES.md
#reminders      -         docs/phases/PHASE-87-REMINDERS.md
#federation     -         docs/phases/PHASE-88-FEDERATION.md docs/threat-model.md
#unread         33 62 76 79  web/src/chat/ web/src/state/ web/src/components/MessageList.tsx web/src/components/ZuckerList.tsx web/src/theme.css docs/phases/PHASE-33-UNREAD.md docs/phases/PHASE-79-LANDING.md
#notify         40 50 71 102  web/src/notify/ web/assets/sounds/ web/src/components/ProfilePanel.tsx docs/notification-sounds.md docs/phases/PHASE-40-SOUNDS.md docs/phases/PHASE-50-NOTIFYRULES.md docs/phases/PHASE-71-CALLSOUNDS.md docs/phases/PHASE-102-SOUNDTHEMES.md
#push           -         docs/phases/PHASE-65-PUSH.md
#parking        53        web/src/parking.ts web/src/parking-hotkey.ts web/src/state/ web/src/components/ docs/phases/PHASE-53-PARKING.md
#roster         54 78 92 100  web/src/chat/ web/src/components/Sidebar.tsx web/src/components/HoverCard.tsx web/src/components/ZuckerList.tsx web/src/components/CreateChannelModal.tsx web/src/theme.css docs/phases/PHASE-54-ROSTER.md docs/phases/PHASE-78-HIDECHANNELS.md docs/phases/PHASE-92-HOVERCARD.md docs/phases/PHASE-100-VOICESECTION.md
#zucker         62 64 78 95  web/src/chat/zucker.ts web/src/components/ZuckerList.tsx web/src/theme.css docs/phases/PHASE-62-ZUCKER.md docs/phases/PHASE-78-HIDECHANNELS.md docs/phases/PHASE-95-PHONEVOICE.md
#history        55 69 79  internal/store/ web/src/chat/ web/src/components/MessageList.tsx docs/phases/PHASE-55-HISTORY.md docs/phases/PHASE-69-PINNEDHEADER.md docs/phases/PHASE-79-LANDING.md
#mentions       56        web/src/chat/ web/src/components/Composer.tsx docs/phases/PHASE-56-MENTIONS.md
#composer       91 94     web/src/chat/composer-height.ts web/src/chat/composer-keys.ts web/src/components/ComposerResizer.tsx web/src/components/Composer.tsx web/src/theme.css docs/phases/PHASE-91-COMPOSERSIZE.md docs/phases/PHASE-94-PHONECOMPOSER.md
#linkpreview    57 67     internal/linkpreview/ web/src/linkpreview/ web/src/chat/links.ts docs/phases/PHASE-57-LINKPREVIEW.md docs/phases/PHASE-67-LINKLABELS.md
#code           74        web/src/code/ web/src/chat/bodytext.ts web/src/components/CodeModal.tsx web/src/components/CodeBlockView.tsx docs/phases/PHASE-74-CODEBLOCKS.md
#nanomd         77        web/src/chat/nanomd.ts web/src/components/MessageList.tsx web/src/theme.css docs/phases/PHASE-77-NANOMD.md
#search         61        web/src/chat/ web/src/components/ docs/phases/PHASE-61-SEARCH.md
#reactions      37 58 75  web/src/chat/reactions.ts web/src/chat/press.ts web/src/chat/editpolicy.ts web/src/state/ web/src/components/ReactionBar.tsx docs/phases/PHASE-37-EDITREACT.md docs/phases/PHASE-58-EDITWINDOW.md docs/phases/PHASE-75-REACTORS.md
#typing         43        internal/server/ web/src/state/ docs/phases/PHASE-43-TYPING.md
#presence       34 45 60 92  internal/presence/ internal/server/ web/src/chat/hovercard.ts web/src/chat/presence.ts web/src/components/HoverCard.tsx web/src/components/MessageList.tsx web/src/auth/display-names.ts web/src/state/ docs/phases/PHASE-34-PRESENCE.md docs/phases/PHASE-45-SCRATCHPAD.md docs/phases/PHASE-92-HOVERCARD.md
#spacekeys      25 38     web/src/crypto/ internal/store/ docs/phases/PHASE-38-KEYDELIVERY.md docs/phases/PHASE-00-29-FOUNDATION.md
#deletion       35        web/src/chat/ web/src/components/ docs/phases/PHASE-35-DELETION.md
#mobile         32 60 64 76 94  web/src/mobile.ts web/src/chat/swipe-back.ts web/src/chat/use-swipe-back.ts web/src/chat/press.ts web/src/components/ web/src/theme.css docs/phases/PHASE-32-MOBILE.md docs/phases/PHASE-60-MOBILEFIT.md docs/phases/PHASE-64-SWIPEBACK.md docs/phases/PHASE-94-PHONECOMPOSER.md
#settings       68 70 76  web/src/settings-nav.ts web/src/components/ProfilePanel.tsx docs/phases/PHASE-68-SETTINGSTABS.md docs/phases/PHASE-70-APPEARANCE.md docs/phases/PHASE-76-SHORTCUTS.md
#fullwidth      93        web/src/display-prefs.ts web/src/theme.css web/src/components/ProfilePanel.tsx docs/phases/PHASE-93-WIDTH.md
#themes         -         web/src/theme.css web/src/theme-palette.test.ts web/src/components/ProfilePanel.tsx web/src/chat/nickcolor.ts docs/theming.md
#version        39        internal/version/ web/src/version.ts docs/phases/PHASE-39-VERSION.md
#servernotice   46        web/src/state/ web/src/components/ docs/phases/PHASE-46-UPDATENOTICE.md
#pwa            36        web/manifest.json web/icons/ web/build.mjs web/src/theme.css docs/phases/PHASE-36-PWA.md
#csp            51        internal/server/server.go internal/server/spa_test.go docs/phases/PHASE-51-CSP.md
#governance     -         internal/store/governance.go internal/server/governance_ws.go docs/phases/PHASE-00-29-FOUNDATION.md
#attachments    69        web/src/attachments/ internal/store/ docs/design/chalk-attachments-design-spec.md docs/phases/PHASE-69-PINNEDHEADER.md docs/phases/PHASE-00-29-FOUNDATION.md
#chalkctl       72 73 82  internal/chalkctl/ cmd/chalkctl/ test/integration/backup_restore_test.go docs/deployment.md docs/phases/PHASE-72-BACKUP.md docs/phases/PHASE-73-METRICS.md
#ephemeral      80        internal/chalkctl/ migrations/ internal/store/ internal/server/ internal/auth/ internal/proto/ internal/config/ web/src/crypto/ web/src/components/ web/src/chat/
#hardening      81        internal/auth/ internal/ratelimit/ internal/store/ internal/chalkctl/ docs/threat-model.md docs/phases/PHASE-81-SECAUDIT.md
#msgsig         83        web/src/crypto/ web/src/chat/verify.ts web/src/chat/roster-observe.ts web/src/components/ web/src/state/ web/src/attachments/pipeline.ts web/src/ws-client.ts web/src/auth/ internal/innerchan/ internal/store/ internal/server/ internal/proto/ internal/chalkctl/ internal/config/ migrations/ docs/phases/PHASE-83-MSGSIG.md docs/audits/ docs/threat-model.md docs/deployment.md
#bigrooms       -         docs/phases/PHASE-98-BIGROOMS.md
#dbcreds        -         docs/phases/PHASE-99-DBCREDS.md internal/chalkctl/ docs/threat-model.md
#signedwrap     82        web/src/crypto/ web/src/components/ web/src/chat/keyprovenance.ts web/src/state/ internal/proto/ internal/server/ internal/store/ internal/config/ internal/chalkctl/ internal/auth/join_http.go docs/phases/PHASE-82-SIGNEDWRAP.md docs/design/crypto-agility.md docs/threat-model.md
#oplog          85        internal/config/oplog.go internal/server/oplog.go internal/auth/security_log.go internal/chalkctl/secret.go internal/chalkctl/templates/Caddyfile.tmpl cmd/chalkd/main.go docs/deployment.md docs/phases/PHASE-85-OPLOG.md
#pinbackup      84        web/src/crypto/pin-backup.ts web/src/crypto/pin-sync.ts web/src/crypto/idb.ts web/src/components/ProfilePanel.tsx web/src/components/App.tsx web/src/settings-nav.ts web/src/state/types.ts docs/phases/PHASE-84-PINBACKUP.md docs/threat-model.md
#tilegrid       101       web/src/attachments/tiles.ts web/src/components/AttachmentGroup.tsx web/src/components/AttachmentView.tsx web/src/components/MessageList.tsx web/src/components/LinkPreviewView.tsx web/src/theme.css docs/phases/PHASE-101-TILEGRID.md

## Phase docs

Every phase number also has a record under `docs/phases/PHASE-<N>-<TOPIC>.md` — why the
phase exists, what each slice landed, and what it left open. `docs/phase-log.md`
indexes them all in one table. The tag lines above list a topic's phase docs
among its paths, so `-g` reaches them too.

## Phases with no topic yet

Phase numbers that appear in the source but are not claimed above. Left here
rather than guessed at, so the legend stays trustworthy; move one into a tag
line when its topic is clear.

    (none — 25 through 102 are all claimed)

Phases below 25 predate the tagging convention and carry no `// NN-n:` comments
to find. They are recorded in `docs/phases/PHASE-00-29-FOUNDATION.md` instead —
the bootstrap, the 09 auth arc, the MLS detour that shipped and was removed, and
the 22–25 encryption rebuild everything since sits on.
