// 127-1: A password manager needs a username next to a password field.
// Some forms show no username field, so this input carries the value.

interface Props {
  username: string;
  id: string;
}

/**
 * HiddenUsername renders a visually hidden, read-only username input.
 * Put it in a form that shows a password but no username field.
 * It lets a password manager save or update the login for `username`.
 */
export function HiddenUsername({ username, id }: Props) {
  return (
    <input
      class="chalk-auth-hidden"
      type="text"
      name="username"
      id={id}
      value={username}
      readOnly
      tabIndex={-1}
      aria-hidden="true"
      autocomplete="username"
    />
  );
}
