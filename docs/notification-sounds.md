# Notification Sounds

Off by default. When the master switch is on, each category respects its own toggle.

## Categories

| Category | Default when sounds enabled | Suggested use |
|---|---|---|
| `mention` | on | @-mention or thread reply where you participate |
| `dm` | on | Direct (1:1) message |
| `message` | **off** | Any new message in a channel you're in |
| `thread_reply` | on | Reply in a thread you participated in |
| `presence` | off | Friend came online |
| `connect` / `disconnect` | off | Your own connection state |
| `send_confirm` | off | Server acked your send |
| `error` | on | Send failed, decryption failed |

## Suppression rules (always applied)

1. Tab focused AND relevant channel/thread visible → no sound
2. DnD on → no sounds at all
3. Min 2s between any two sounds; min 5s between sounds of the same category
4. Audio context not yet unlocked (user has not interacted with page) → drop

## Sound generation

Default pack uses Web Audio API oscillators with short ADSR envelopes — no audio files, ~1KB of code, perfectly themeable, no decode latency. Distinctive frequencies per category so you can tell them apart by ear:

| Category | Pattern |
|---|---|
| mention | 880 Hz → 1320 Hz, 180ms, sine |
| dm | 660 Hz → 990 Hz, 200ms, sine |
| message | 440 Hz, 80ms, triangle |
| thread_reply | 740 Hz → 880 Hz, 140ms, sine |
| error | 220 Hz → 165 Hz, 250ms, saw |

A sample-based pack is planned as a later option for users who prefer recorded sounds.

## OS-level notifications

Paired with sounds. Same category model, same suppression rules. Permission requested only when the user explicitly enables visual notifications in settings — never on app load.

## Settings shape

```js
{
  notifications: {
    sounds: {
      master: false,
      volume: 0.4,
      pack: "synth",
      categories: { mention: true, dm: true, message: false, ... },
      dnd: false,
      dnd_schedule: null
    },
    desktop: {
      enabled: false,
      categories: { ... }
    }
  }
}
```

Stored as part of the encrypted settings blob; server never sees a user's sound preferences.
