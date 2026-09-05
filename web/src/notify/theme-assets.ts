// chalk-web -- the sound themes' files.
//
// 102-1: every WAV goes through esbuild's file loader, so each lands in
// dist/ under a content-hashed name and spa.go serves it immutable for a
// year -- the same contract every other asset keeps (build.mjs). A changed
// cue is a changed URL, never a stale cache.
//
// Kept apart from themes.ts so the theme *table* can be imported under
// node without a WAV loader in the way. Nothing here is tested; it is a
// lookup.

import type { SoundThemeId, ThemeCue } from "./themes";

import chalk01 from "../../assets/sounds/chalk/01_friend_online.wav";
import chalk02 from "../../assets/sounds/chalk/02_you_join_call.wav";
import chalk03 from "../../assets/sounds/chalk/03_you_leave_call.wav";
import chalk04 from "../../assets/sounds/chalk/04_someone_joins.wav";
import chalk05 from "../../assets/sounds/chalk/05_someone_leaves.wav";
import chalk06 from "../../assets/sounds/chalk/06_connected.wav";
import chalk07 from "../../assets/sounds/chalk/07_disconnected.wav";
import chalk08 from "../../assets/sounds/chalk/08_send_confirmed.wav";
import chalk09 from "../../assets/sounds/chalk/09_error.wav";
import chalk10 from "../../assets/sounds/chalk/10_new_message.wav";

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
  chalk: {
    "01_friend_online": chalk01,
    "02_you_join_call": chalk02,
    "03_you_leave_call": chalk03,
    "04_someone_joins": chalk04,
    "05_someone_leaves": chalk05,
    "06_connected": chalk06,
    "07_disconnected": chalk07,
    "08_send_confirmed": chalk08,
    "09_error": chalk09,
    "10_new_message": chalk10,
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
