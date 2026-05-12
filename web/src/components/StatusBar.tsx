import type { ConnectionState } from "../ws-client";

interface Props {
  state: ConnectionState;
  detail: string;
  // phase 08c: handle optional for backward compat
  user: { id: string; device: string; handle?: string } | null;
}

const labels: Record<ConnectionState, string> = {
  connecting: "connecting...",
  open: "online",
  closed: "offline",
  error: "error",
};

export function StatusBar({ state, detail, user }: Props) {
  return (
    <div class="chalk-status" data-state={state} data-testid="status-bar">
      <span class={`chalk-status-dot chalk-status-dot--${state}`} aria-hidden="true" />
      <span class="chalk-status-label">{labels[state]}</span>
      {detail && state !== "open" && (
        <span class="chalk-status-detail" data-testid="status-detail">
          ({detail})
        </span>
      )}
      {user && state === "open" && (
        <span class="chalk-status-user" data-testid="status-user">
          {/* phase 08b polish: self-label-you */}
          {/* phase 08c: include handle when known */}
          <span title={user.id}>
            {user.handle ? `you (${user.handle})` : "you"}
          </span>
        </span>
      )}
    </div>
  );
}
