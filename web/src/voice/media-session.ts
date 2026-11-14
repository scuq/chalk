// 135-7: the call on the lock screen and in the notification. The Media
// Session API lets the phone show the call with buttons for the microphone,
// the camera, and hang up. Chromium 93 and later has the microphone and
// camera actions, and so has iOS 18.4. The hangup action is not on iOS.
// Support differs for each action, so each call is in its own try block.

/** What the lock screen shows for a call. */
export interface MediaSessionPlan {
  active: boolean;
  mic: boolean;
  cam: boolean;
  title: string;
}

/** mediaSessionPlan returns what the lock screen shows for a session. */
export function mediaSessionPlan(s: { phase: string; muted: boolean; camOn: boolean; channelName: string | null }): MediaSessionPlan {
  const active = s.phase === "in-call";
  return { active, mic: active && !s.muted, cam: active && s.camOn, title: `chalk · ${s.channelName || "voice"}` };
}

type Handler = (() => void) | null;
interface MediaSessionLike {
  metadata: unknown;
  setActionHandler(action: string, fn: Handler): void;
  setMicrophoneActive?(on: boolean): void;
  setCameraActive?(on: boolean): void;
}
interface SessionLike {
  subscribe(fn: () => void): () => void;
  snap(): { phase: string; muted: boolean; camOn: boolean; channelName: string | null };
}
/** The actions the lock screen buttons call. */
export interface MediaSessionActions {
  toggleMic(): void;
  toggleCam(): void;
  hangUp(): void;
}

const ACTIONS = ["togglemicrophone", "togglecamera", "hangup"] as const;

function tryDo(fn: () => void): void {
  try {
    fn();
  } catch {
    // The browser does not know this action or this call.
  }
}

/** installMediaSession shows the call on the lock screen while the session
 * is in a call. Meta is the MediaMetadata constructor, if the browser has
 * one. It returns the function that removes it. */
export function installMediaSession(
  session: SessionLike,
  ms: MediaSessionLike | undefined,
  Meta: (new (init: { title: string; artist: string }) => unknown) | undefined,
  actions: MediaSessionActions,
): () => void {
  if (!ms) return () => {};
  let on = false;
  let last = "";
  const update = () => {
    const plan = mediaSessionPlan(session.snap());
    const key = JSON.stringify(plan);
    if (key === last) return;
    last = key;
    if (plan.active) {
      if (!on) {
        on = true;
        tryDo(() => ms.setActionHandler("togglemicrophone", actions.toggleMic));
        tryDo(() => ms.setActionHandler("togglecamera", actions.toggleCam));
        tryDo(() => ms.setActionHandler("hangup", actions.hangUp));
      }
      if (Meta) tryDo(() => (ms.metadata = new Meta({ title: plan.title, artist: "voice call" })));
      tryDo(() => ms.setMicrophoneActive?.(plan.mic));
      tryDo(() => ms.setCameraActive?.(plan.cam));
    } else if (on) {
      on = false;
      for (const a of ACTIONS) tryDo(() => ms.setActionHandler(a, null));
      tryDo(() => (ms.metadata = null));
    }
  };
  const unsubscribe = session.subscribe(update);
  update();
  return () => {
    unsubscribe();
    if (on) {
      for (const a of ACTIONS) tryDo(() => ms.setActionHandler(a, null));
      tryDo(() => (ms.metadata = null));
    }
  };
}
