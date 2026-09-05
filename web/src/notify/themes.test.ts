// The sound themes, as data.
//
// There is no AudioContext in node, so nothing here plays. What these
// tests protect is the contract between the table and the files: every
// sound category maps to a cue, every theme folder holds every cue as a
// well-formed audio file, and the picker's default exists. That is the set of
// things a "let's add a theme" or "let's add a category" edit can get
// wrong without the build noticing -- a missing file is a silent
// notification, not a compile error.
//
// Whether a theme sounds *good* is not a unit test; that is scuq's ear in
// a DAW, and the files are the recording of it.
//
// 102-4: temporary reporting of what mp3Seconds/wavDataSeconds measure is
// what filled in the durations in each theme's MANIFEST.md. Add a
// t.diagnostic() in the loop below rather than a throwaway script.

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

// 102-4: the same measurement for an MP3 cue, which is what the arcade
// theme ships. There is no length field to read -- MP3 is a stream of
// frames -- so this walks them and sums their samples, which is also the
// only real check that the file is whole. Restricted to MPEG-1 Layer III
// (what upstream publishes): a file in any other MPEG flavour throws here
// rather than being measured against the wrong table, since a silently
// mismeasured duration is worse than a failing test.
const MPEG1_L3_BITRATES = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];
const MPEG1_RATES = [44100, 48000, 32000, 0];
const MPEG1_L3_SAMPLES = 1152;

function mp3Seconds(bytes: Buffer): number {
  let at = 0;
  // Skip an ID3v2 tag: four syncsafe bytes (7 bits each) at offset 6 give
  // the tag body's size, and the 10-byte header is not counted in it.
  if (bytes.toString("ascii", 0, 3) === "ID3") {
    const size =
      (bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9];
    at = 10 + size + (bytes[5] & 0x10 ? 10 : 0); // + footer, if flagged
  }
  let samples = 0;
  let rate = 0;
  while (at + 4 <= bytes.length) {
    // Frame sync, then MPEG version 1 (bits 11) and layer III (bits 01).
    if (bytes[at] !== 0xff || (bytes[at + 1] & 0xe0) !== 0xe0) break;
    if (((bytes[at + 1] >> 3) & 0x03) !== 3 || ((bytes[at + 1] >> 1) & 0x03) !== 1) {
      throw new Error("not MPEG-1 Layer III");
    }
    const bitrate = MPEG1_L3_BITRATES[bytes[at + 2] >> 4] * 1000;
    rate = MPEG1_RATES[(bytes[at + 2] >> 2) & 0x03];
    if (!bitrate || !rate) throw new Error("bad frame header");
    at += Math.floor((144 * bitrate) / rate) + ((bytes[at + 2] >> 1) & 0x01);
    samples += MPEG1_L3_SAMPLES;
  }
  if (!samples) throw new Error("no frames");
  return samples / rate;
}

// 102-4: a cue file is a WAV or an MP3. Both decode through the same
// decodeAudioData, so which one a theme uses is a question about where the
// files came from, not about the player: the authored themes and the
// rendered classic one are WAV, and arcade is MP3 because that is the form
// romainsimon/uisfx publishes and its files ship unmodified.
const CUE_EXTS = [".wav", ".mp3"];

test("every theme folder holds every cue as a decodable audio file", () => {
  for (const { id } of SOUND_THEMES) {
    const dir = join(SOUNDS_DIR, id);
    const files = readdirSync(dir);
    for (const cue of THEME_CUES) {
      const name = CUE_EXTS.map((e) => `${cue}${e}`).find((n) => files.includes(n));
      assert.ok(name, `${id} is missing ${cue} (${CUE_EXTS.join(" or ")})`);
      const bytes = readFileSync(join(dir, name));
      let seconds: number;
      if (name.endsWith(".wav")) {
        // RIFF....WAVEfmt : the canonical header, format 1 = PCM.
        assert.equal(bytes.toString("ascii", 0, 4), "RIFF", `${id}/${name} is not RIFF`);
        assert.equal(bytes.toString("ascii", 8, 12), "WAVE", `${id}/${name} is not WAVE`);
        assert.equal(bytes.toString("ascii", 12, 16), "fmt ", `${id}/${name} has no fmt chunk`);
        assert.equal(bytes.readUInt16LE(20), 1, `${id}/${name} is not PCM`);
        assert.equal(bytes.readUInt32LE(24), 48000, `${id}/${name} is not 48 kHz`);
        // 16-bit is the WAV themes' stated format; 24 appears where a DAW
        // re-export (102-2's two synthesized empir cues) came out that way.
        const bits = bytes.readUInt16LE(34);
        assert.ok(bits === 16 || bits === 24, `${id}/${name} is ${bits}-bit, not 16 or 24`);
        seconds = wavDataSeconds(bytes);
      } else {
        // No sample-rate or bit-depth pin here on purpose: an MP3 cue is
        // shipped as its publisher made it (arcade's are 44.1 kHz mono),
        // and decodeAudioData resamples to the context's rate anyway.
        // What must hold is that the frames parse and the file is whole.
        seconds = mp3Seconds(bytes);
      }
      // A cue is a cue, not a jingle: short, so a notification never
      // outlasts the moment it is about. The ceiling is two seconds --
      // 102-2: empir's join fanfare sits exactly on it, and your own
      // call join is the one event that can afford it.
      assert.ok(seconds <= 2, `${id}/${name} is longer than two seconds (${seconds}s)`);
    }
    // And nothing the table doesn't know about, so a stray file can't
    // ship unreferenced (it would never be imported, but it would be
    // confusing to find).
    for (const f of files) {
      const ext = CUE_EXTS.find((e) => f.endsWith(e));
      if (ext) {
        assert.ok(
          THEME_CUES.includes(f.slice(0, -ext.length) as never),
          `${id}/${f} is not a known cue`,
        );
      }
    }
  }
});
