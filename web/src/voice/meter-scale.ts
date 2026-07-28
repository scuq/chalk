// chalk-web -- the level meter's scale.
//
// RMS is linear and speech is quiet: a normal speaking voice lands somewhere
// around 0.05-0.2 RMS. A linear meter therefore spends four fifths of its width
// on levels nobody ever reaches, and crams the entire useful range -- room
// tone, voice, and both VAD thresholds -- into a strip a few pixels wide at the
// left edge. That is why the thresholds were impossible to place by eye: at
// that scale one pixel of drag is a large change in the gate.
//
// So the meter draws decibels. The gate keeps comparing linear RMS (vad.ts is
// untouched) and stored thresholds keep their meaning -- this is a display
// mapping only, applied to the bar, the handles and the numbers together.
//
// -60 dB is the floor. Below that is a silent room on a hot preamp, and giving
// it travel only squeezes the part that matters back down again.

export const METER_FLOOR_DB = -60;

/** rmsToDb converts an RMS amplitude to dBFS, clamped to the meter's range. */
export function rmsToDb(rms: number): number {
  if (!(rms > 0)) return METER_FLOOR_DB;
  return Math.max(METER_FLOOR_DB, Math.min(0, 20 * Math.log10(rms)));
}

/** meterPos maps an RMS amplitude to its 0..1 position along the meter. */
export function meterPos(rms: number): number {
  return (rmsToDb(rms) - METER_FLOOR_DB) / -METER_FLOOR_DB;
}

/** meterRms inverts meterPos: where a handle was dropped, back to RMS. */
export function meterRms(pos: number): number {
  const clamped = Math.min(1, Math.max(0, pos));
  // Exactly zero rather than 10^-3: a threshold at the floor should mean "any
  // signal at all", and the gate compares with >=.
  if (clamped <= 0) return 0;
  return Math.pow(10, (METER_FLOOR_DB * (1 - clamped)) / 20);
}

/** dbLabel is how a threshold or a level is printed in the panel. */
export function dbLabel(rms: number): string {
  const db = rmsToDb(rms);
  return db <= METER_FLOOR_DB ? "silence" : `${Math.round(db)} dB`;
}
