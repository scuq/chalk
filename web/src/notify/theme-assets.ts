// chalk-web -- the sound themes' files.
//
// 102-1: every cue file goes through esbuild's file loader, so each lands in
// dist/ under a content-hashed name and spa.go serves it immutable for a
// year -- the same contract every other asset keeps (build.mjs). A changed
// cue is a changed URL, never a stale cache.
//
// Kept apart from themes.ts so the theme *table* can be imported under
// node without a file loader in the way. Nothing here is tested; it is a
// lookup.
//
// 102-4: extensions differ per theme and that is deliberate. The four
// authored themes and the rendered classic one are WAV; arcade is MP3
// because that is what romainsimon/uisfx publishes, and shipping its files
// unmodified is what keeps the MIT attribution honest.

import type { SoundThemeId, ThemeCue } from "./themes";

import arcade01 from "../../assets/sounds/arcade/01_friend_online.mp3";
import arcade02 from "../../assets/sounds/arcade/02_you_join_call.mp3";
import arcade03 from "../../assets/sounds/arcade/03_you_leave_call.mp3";
import arcade04 from "../../assets/sounds/arcade/04_someone_joins.mp3";
import arcade05 from "../../assets/sounds/arcade/05_someone_leaves.mp3";
import arcade06 from "../../assets/sounds/arcade/06_connected.mp3";
import arcade07 from "../../assets/sounds/arcade/07_disconnected.mp3";
import arcade08 from "../../assets/sounds/arcade/08_send_confirmed.mp3";
import arcade09 from "../../assets/sounds/arcade/09_error.mp3";
import arcade10 from "../../assets/sounds/arcade/10_new_message.mp3";

import classic01 from "../../assets/sounds/chalk-classic/01_friend_online.wav";
import classic02 from "../../assets/sounds/chalk-classic/02_you_join_call.wav";
import classic03 from "../../assets/sounds/chalk-classic/03_you_leave_call.wav";
import classic04 from "../../assets/sounds/chalk-classic/04_someone_joins.wav";
import classic05 from "../../assets/sounds/chalk-classic/05_someone_leaves.wav";
import classic06 from "../../assets/sounds/chalk-classic/06_connected.wav";
import classic07 from "../../assets/sounds/chalk-classic/07_disconnected.wav";
import classic08 from "../../assets/sounds/chalk-classic/08_send_confirmed.wav";
import classic09 from "../../assets/sounds/chalk-classic/09_error.wav";
import classic10 from "../../assets/sounds/chalk-classic/10_new_message.wav";

import gamegirl01 from "../../assets/sounds/gamegirl/01_friend_online.wav";
import gamegirl02 from "../../assets/sounds/gamegirl/02_you_join_call.wav";
import gamegirl03 from "../../assets/sounds/gamegirl/03_you_leave_call.wav";
import gamegirl04 from "../../assets/sounds/gamegirl/04_someone_joins.wav";
import gamegirl05 from "../../assets/sounds/gamegirl/05_someone_leaves.wav";
import gamegirl06 from "../../assets/sounds/gamegirl/06_connected.wav";
import gamegirl07 from "../../assets/sounds/gamegirl/07_disconnected.wav";
import gamegirl08 from "../../assets/sounds/gamegirl/08_send_confirmed.wav";
import gamegirl09 from "../../assets/sounds/gamegirl/09_error.wav";
import gamegirl10 from "../../assets/sounds/gamegirl/10_new_message.wav";

import runestone01 from "../../assets/sounds/runestone/01_friend_online.wav";
import runestone02 from "../../assets/sounds/runestone/02_you_join_call.wav";
import runestone03 from "../../assets/sounds/runestone/03_you_leave_call.wav";
import runestone04 from "../../assets/sounds/runestone/04_someone_joins.wav";
import runestone05 from "../../assets/sounds/runestone/05_someone_leaves.wav";
import runestone06 from "../../assets/sounds/runestone/06_connected.wav";
import runestone07 from "../../assets/sounds/runestone/07_disconnected.wav";
import runestone08 from "../../assets/sounds/runestone/08_send_confirmed.wav";
import runestone09 from "../../assets/sounds/runestone/09_error.wav";
import runestone10 from "../../assets/sounds/runestone/10_new_message.wav";

import empir01 from "../../assets/sounds/empir/01_friend_online.wav";
import empir02 from "../../assets/sounds/empir/02_you_join_call.wav";
import empir03 from "../../assets/sounds/empir/03_you_leave_call.wav";
import empir04 from "../../assets/sounds/empir/04_someone_joins.wav";
import empir05 from "../../assets/sounds/empir/05_someone_leaves.wav";
import empir06 from "../../assets/sounds/empir/06_connected.wav";
import empir07 from "../../assets/sounds/empir/07_disconnected.wav";
import empir08 from "../../assets/sounds/empir/08_send_confirmed.wav";
import empir09 from "../../assets/sounds/empir/09_error.wav";
import empir10 from "../../assets/sounds/empir/10_new_message.wav";

export const THEME_URLS: Record<SoundThemeId, Record<ThemeCue, string>> = {
  arcade: {
    "01_friend_online": arcade01,
    "02_you_join_call": arcade02,
    "03_you_leave_call": arcade03,
    "04_someone_joins": arcade04,
    "05_someone_leaves": arcade05,
    "06_connected": arcade06,
    "07_disconnected": arcade07,
    "08_send_confirmed": arcade08,
    "09_error": arcade09,
    "10_new_message": arcade10,
  },
  "chalk-classic": {
    "01_friend_online": classic01,
    "02_you_join_call": classic02,
    "03_you_leave_call": classic03,
    "04_someone_joins": classic04,
    "05_someone_leaves": classic05,
    "06_connected": classic06,
    "07_disconnected": classic07,
    "08_send_confirmed": classic08,
    "09_error": classic09,
    "10_new_message": classic10,
  },
  gamegirl: {
    "01_friend_online": gamegirl01,
    "02_you_join_call": gamegirl02,
    "03_you_leave_call": gamegirl03,
    "04_someone_joins": gamegirl04,
    "05_someone_leaves": gamegirl05,
    "06_connected": gamegirl06,
    "07_disconnected": gamegirl07,
    "08_send_confirmed": gamegirl08,
    "09_error": gamegirl09,
    "10_new_message": gamegirl10,
  },
  runestone: {
    "01_friend_online": runestone01,
    "02_you_join_call": runestone02,
    "03_you_leave_call": runestone03,
    "04_someone_joins": runestone04,
    "05_someone_leaves": runestone05,
    "06_connected": runestone06,
    "07_disconnected": runestone07,
    "08_send_confirmed": runestone08,
    "09_error": runestone09,
    "10_new_message": runestone10,
  },
  empir: {
    "01_friend_online": empir01,
    "02_you_join_call": empir02,
    "03_you_leave_call": empir03,
    "04_someone_joins": empir04,
    "05_someone_leaves": empir05,
    "06_connected": empir06,
    "07_disconnected": empir07,
    "08_send_confirmed": empir08,
    "09_error": empir09,
    "10_new_message": empir10,
  },
};
