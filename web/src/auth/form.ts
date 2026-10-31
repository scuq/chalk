// 127-1: Password managers pair a username with a password only inside a
// real form element. These helpers let each credentials step submit as a form.

/**
 * submitWhen returns a form `onSubmit` handler.
 * The handler always calls `preventDefault`, so the browser never navigates.
 * It calls `run` only if `ok` is true.
 * Pass the same expression as the `disabled` state of the submit button,
 * so that Enter and the button agree.
 */
export function submitWhen(ok: boolean, run: () => unknown): (e: Event) => void {
  return (e) => {
    e.preventDefault();
    if (ok) void run();
  };
}
