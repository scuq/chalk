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

#auth           31        internal/auth/ web/src/auth/
#browser        48        web/src/webauthn.ts web/src/crypto/ docs/browser-support.md
#friends        59        internal/friends/ web/src/components/
#voice          30 41 44 63 66 70 71  internal/turncred/ web/src/voice/ web/src/components/VoiceCallPanel.tsx
#camera-bg      52        web/src/voice/ web/src/components/
#threads        42 45 47 49  web/src/chat/threadinbox.ts web/src/chat/ web/src/components/
#unread         33 62 76 79  web/src/chat/ web/src/state/ web/src/components/MessageList.tsx web/src/components/ZuckerList.tsx web/src/theme.css
#notify         40 50 71  web/src/notify/
#parking        53        web/src/parking.ts web/src/components/
#roster         54 78     web/src/chat/ web/src/components/Sidebar.tsx web/src/components/ZuckerList.tsx
#history        55        internal/store/ web/src/chat/ web/src/components/MessageList.tsx
#mentions       56        web/src/chat/ web/src/components/Composer.tsx
#linkpreview    57 67     internal/linkpreview/ web/src/linkpreview/
#code           74        web/src/code/ web/src/chat/bodytext.ts web/src/components/CodeModal.tsx web/src/components/CodeBlockView.tsx
#nanomd         77        web/src/chat/nanomd.ts web/src/components/MessageList.tsx web/src/theme.css
#search         61        web/src/chat/ web/src/components/
#reactions      37 75     web/src/chat/reactions.ts web/src/chat/press.ts web/src/state/ web/src/components/ReactionBar.tsx
#typing         43        internal/server/ web/src/state/
#presence       34        internal/presence/ internal/server/
#spacekeys      25 38     web/src/crypto/ internal/store/
#deletion       35        web/src/chat/ web/src/components/
#mobile         64 76     web/src/mobile.ts web/src/chat/swipe-back.ts web/src/chat/use-swipe-back.ts web/src/chat/press.ts web/src/components/ web/src/theme.css
#settings       68 70 76  web/src/settings-nav.ts web/src/components/ProfilePanel.tsx
#version        39        internal/version/ web/src/version.ts
#servernotice   46        web/src/state/ web/src/components/
#governance     -         internal/store/governance.go internal/server/governance_ws.go
#attachments    -         web/src/attachments/ internal/store/
#chalkctl       72 73     internal/chalkctl/ cmd/chalkctl/ test/integration/backup_restore_test.go
#ephemeral      80        internal/chalkctl/ migrations/ internal/store/ internal/server/ internal/auth/ internal/proto/ internal/config/ web/src/crypto/ web/src/components/ web/src/chat/
#hardening      81        internal/auth/ internal/ratelimit/ internal/store/ internal/chalkctl/ docs/threat-model.md docs/PHASE-81-SECAUDIT.md
#signedwrap     82        web/src/crypto/ web/src/components/ web/src/chat/keyprovenance.ts web/src/state/ internal/proto/ internal/server/ internal/store/ internal/config/ internal/chalkctl/ internal/auth/join_http.go docs/PHASE-82-SIGNEDWRAP.md docs/design/crypto-agility.md docs/threat-model.md

## Phases with no topic yet

Phase numbers that appear in the source but are not claimed above. Left here
rather than guessed at, so the legend stays trustworthy; move one into a tag
line when its topic is clear.

    (none — 25 through 77 are all claimed)
