// The sound themes, as data.
//
// There is no AudioContext in node, so nothing here plays. What these
// tests protect is the contract between the table and the files: every
// sound category maps to a cue, every theme folder holds every cue as a
// well-formed WAV, and the picker's default exists. That is the set of
// things a "let's add a theme" or "let's add a category" edit can get
// wrong without the build noticing -- a missing file is a silent
// notification, not a compile error.
//
// Whether a theme sounds *good* is not a unit test; that is scuq's ear in
// a DAW, and the files are the recording of it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CUE_FOR,
  DEFAULT_SOUND_THEME,
  SOUND_THEMES,
  THEME_CUES,
  isSoundThemeId,
} from "./themes.ts";
import { SOUND_CATEGORIES } from "./types.ts";

// test.mjs runs from web/, and the themes live beside src/.
const SOUNDS_DIR = join("assets", "sounds");

test("every category plays a cue every theme has", () => {
  for (const c of SOUND_CATEGORIES) {
    assert.ok(CUE_FOR[c], `${c} has no cue`);
    assert.ok(THEME_CUES.includes(CUE_FOR[c]), `${c} maps to unknown cue ${CUE_FOR[c]}`);
  }
  assert.deepEqual(Object.keys(CUE_FOR).sort(), [...SOUND_CATEGORIES].sort());
});

test("the default theme is one of the themes, and ids are unique", () => {
  assert.ok(isSoundThemeId(DEFAULT_SOUND_THEME));
  assert.equal(new Set(SOUND_THEMES.map((t) => t.id)).size, SOUND_THEMES.length);
  assert.ok(!isSoundThemeId("synth"));
});

// duration walks the RIFF chunk list to the data chunk: measuring the
// whole file would bill the header (and any LIST/INFO chunk a DAW export
// carries) as audio, which is exactly the error that matters at a cue
// sitting right on the ceiling.
function wavDataSeconds(bytes: Buffer): number {
  const bytesPerSec = bytes.readUInt32LE(28);
  let at = 12;
  while (at + 8 <= bytes.length) {
    const chunkId = bytes.toString("ascii", at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (chunkId === "data") return size / bytesPerSec;
    at += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}

test("every theme folder holds every cue as a 48 kHz PCM WAV", () => {
  for (const { id } of SOUND_THEMES) {
    const dir = join(SOUNDS_DIR, id);
    const files = readdirSync(dir);
    for (const cue of THEME_CUES) {
      const name = `${cue}.wav`;
      assert.ok(files.includes(name), `${id} is missing ${name}`);
      const bytes = readFileSync(join(dir, name));
      // RIFF....WAVEfmt : the canonical header, format 1 = PCM.
      assert.equal(bytes.toString("ascii", 0, 4), "RIFF", `${id}/${name} is not RIFF`);
      assert.equal(bytes.toString("ascii", 8, 12), "WAVE", `${id}/${name} is not WAVE`);
      assert.equal(bytes.toString("ascii", 12, 16), "fmt ", `${id}/${name} has no fmt chunk`);
      assert.equal(bytes.readUInt16LE(20), 1, `${id}/${name} is not PCM`);
      assert.equal(bytes.readUInt32LE(24), 48000, `${id}/${name} is not 48 kHz`);
      // 16-bit is the themes' stated format; 24 appears where a DAW
      // re-export (102-2's two synthesized empir cues) came out that way.
      // Browsers decode both through the same decodeAudioData.
      const bits = bytes.readUInt16LE(34);
      assert.ok(bits === 16 || bits === 24, `${id}/${name} is ${bits}-bit, not 16 or 24`);
      // A cue is a cue, not a jingle: short, so a notification never
      // outlasts the moment it is about. The ceiling is two seconds --
      // 102-2: empir's join fanfare sits exactly on it, and your own
      // call join is the one event that can afford it.
      assert.ok(wavDataSeconds(bytes) <= 2, `${id}/${name} is longer than two seconds`);
    }
    // And nothing the table doesn't know about, so a stray file can't
    // ship unreferenced (it would never be imported, but it would be
    // confusing to find).
    for (const f of files) {
      if (f.endsWith(".wav")) {
        assert.ok(THEME_CUES.includes(f.slice(0, -4) as never), `${id}/${f} is not a known cue`);
      }
    }
  }
});
