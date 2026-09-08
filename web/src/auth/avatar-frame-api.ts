// chalk-web -- 115-6: the avatar frame, set by its wearer.
//
//   PUT /api/auth/avatar-frame   {"avatar_frame": "ember"}   -- "" clears
//
// Session-gated. The server holds the allowlist; a name it does not know
// comes back 400 bad_frame, which parseAuthResponse turns into an error the
// picker can show.

import { parseAuthResponse } from "./signup-v2-api";

export async function setAvatarFrame(frame: string): Promise<string> {
  const resp = await fetch("/api/auth/avatar-frame", {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ avatar_frame: frame }),
  });
  const body = await parseAuthResponse<{ avatar_frame: string }>(resp);
  return body.avatar_frame ?? "";
}
