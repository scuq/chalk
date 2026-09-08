// 115-6: the avatar frames -- the decorative rings a member can choose for
// their own profile picture.
//
// The list mirrors the server's allowlist (internal/auth/avatar_frame_http.go,
// AvatarFrames) in the same order: "" first, then the styles. The server
// stores what it recognises and refuses the rest; this side draws what it
// recognises and treats the rest as none, so a server a version ahead can
// name a frame this bundle has no CSS for without anything breaking.
//
// The frame is the wearer's choice and everyone sees it -- but only readers
// who turned flair on (and its frames switch) draw it, gated in CSS by
// data-flair-frames on <html>. The picture stays a plain square for
// everyone else.

export type AvatarFrame = "" | "ember" | "aurora" | "pulse" | "matrix" | "frost" | "gold";

// 115-7: a frame moves only while its wearer is online (Avatar's data-live);
// the rest of the time it rests as a plain ring. The descriptions describe
// the motion, which is what the picker's swatch shows.
export const AVATAR_FRAMES: { value: AvatarFrame; label: string; desc: string }[] = [
  { value: "", label: "none", desc: "the picture as it is" },
  { value: "ember", label: "ember", desc: "a warm glow that breathes" },
  { value: "aurora", label: "aurora", desc: "a ring drifting through the spectrum" },
  { value: "pulse", label: "pulse", desc: "a ring in the accent colour, beating" },
  { value: "matrix", label: "matrix", desc: "terminal green, flickering like phosphor" },
  { value: "frost", label: "frost", desc: "ice white, with a slow cold breath" },
  { value: "gold", label: "gold", desc: "a warm metal ring catching the light" },
];

/** normalizeFrame maps anything to a frame this bundle can draw, or "". */
export function normalizeFrame(v: unknown): AvatarFrame {
  if (typeof v !== "string") return "";
  return AVATAR_FRAMES.some((f) => f.value === v) ? (v as AvatarFrame) : "";
}
