// chalk 112-6 -- the one-time ask.
//
// chalk ships no default picture: a member who has not set one shows nothing
// at all, which is the honest state and the one the feed was designed around.
// But nobody discovers a setting they have never been told about, so the first
// time someone is in a channel without a picture, they get asked -- once.
//
// "Once" is the whole specification, and it is why the flag lives in account
// prefs rather than localStorage: per-device it would ask again on every new
// browser, which is exactly the nagging this is not. It is set when the prompt
// is answered either way, and never cleared -- someone who declined is not
// asked again, and someone who set a picture and later removed it is not
// re-prompted either.

interface Props {
  onChoose: () => void;
  onDismiss: () => void;
}

export function AvatarNudge({ onChoose, onDismiss }: Props) {
  return (
    <div
      class="chalk-modal-backdrop"
      data-testid="avatar-nudge-backdrop"
      onClick={(e) => {
        // Clicking away is an answer too -- and it is "no", which is the
        // safe reading of someone dismissing a question they did not ask
        // for. It still counts, so this never comes back.
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      <div
        class="chalk-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="avatar-nudge-title"
        data-testid="avatar-nudge"
      >
        <header class="chalk-modal-header">
          <h2 id="avatar-nudge-title">add a picture?</h2>
          <button
            type="button"
            class="chalk-modal-close"
            aria-label="close"
            data-testid="avatar-nudge-close"
            onClick={onDismiss}
          >
            ×
          </button>
        </header>
        <div class="chalk-modal-body">
          <p>
            A profile picture sits beside your name in a conversation, so people
            can find you at a glance. It is drawn small — it costs the
            conversation no room.
          </p>
          <p class="chalk-profile-hint">
            It is encrypted for each channel separately, like everything else
            you send: only people in a channel with you can see it, and the
            server storing it cannot. You can set or remove one any time in
            settings → account → picture.
          </p>
          <p class="chalk-profile-hint">This is the only time chalk will ask.</p>
        </div>
        <footer class="chalk-modal-footer">
          <button
            type="button"
            class="chalk-button"
            data-testid="avatar-nudge-later"
            onClick={onDismiss}
          >
            no thanks
          </button>
          <button
            type="button"
            class="chalk-button chalk-button--primary"
            data-testid="avatar-nudge-choose"
            onClick={onChoose}
          >
            choose a picture
          </button>
        </footer>
      </div>
    </div>
  );
}
