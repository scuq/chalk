# Phase 127 — password managers recognise the sign-in fields

**Status:** 127-1 built (2026-10-31). Unit-tested by
`web/src/auth/form.test.ts`. Verified on a live stack (28 checks) with a
Playwright probe. The probe covered the signup wizard, the sign-in screen
from a clean context, the passkey step, and the recovery-reset card. Not yet
checked against a real password manager — see the manual checklist.

**Tags:** `#auth` → `tools/where.sh -g auth`

## The problem

Password managers such as 1Password did not recognise the username and
password fields. They offered neither to fill a saved login nor to save a
new one.

The sign-in screen, and every other password screen, rendered its inputs in
plain `<div>` elements. There was no `<form>` element and no `name` or `id`
attribute. The username input had no `type`. The screens submitted through a
button `onClick` and a hand-written Enter `onKeyDown`.

Password managers use four signals to pair a username with a password: a
form element, `name` and `id`, `type`, and `autocomplete`. Only
`autocomplete` was present.

## The design (127-1)

Client only, under `web/`.

- `web/src/auth/form.ts` (new): `submitWhen(ok, run)` returns a form
  `onSubmit` handler. The handler always calls `preventDefault()`, so the
  browser never navigates. It runs `run` only if `ok` is true. The guard
  copies the `disabled` expression of the submit button, so Enter and the
  button agree. `web/src/auth/form.test.ts` has three tests.
- `web/src/auth/HiddenUsername.tsx` (new): a visually hidden, read-only
  `<input type="text" name="username" autocomplete="username">` that holds
  the current username. It sits in forms that show a password but no
  username field: the signup password step, the password-change and re-link
  forms in account security, and the step-up prompt. It lets a password
  manager save or update the right login. `.chalk-auth-hidden` in
  `web/src/theme.css` hides it with the clip-path pattern. `tabIndex={-1}`
  and `aria-hidden` keep it out of the tab order and the accessibility tree.
- Each credentials step is now a `<form onSubmit={submitWhen(...)}>`. The
  primary button has `type="submit"`. The `onClick` and `onKeyDown` Enter
  handlers are removed. Secondary link buttons were already
  `type="button"`.
- Inputs gained `type="text"` (username and codes), `name`, and `id`.
  Existing `autocomplete` values are kept. The signup display name has
  `autocomplete="nickname"`. The invite token has `autocomplete="off"`.
- Files: `PasswordLoginScreen.tsx` (credentials, totp, and passkey steps),
  `SignupWizardScreen.tsx` (account, password, and totp steps),
  `RecoveryResetScreen.tsx` (the card is the form, and the TOTP re-enrol
  fragment is a form), `MigrationScreen.tsx`, `SecurityPanel.tsx` (password
  change, TOTP confirm, and re-link), and `StepUpPrompt.tsx` (the
  `.chalk-stepup` element is a form).
- All `data-testid` values are unchanged, so the e2e specs and the run-chalk
  probes still work.

Rejected:

- `preact-render-to-string` to unit-test the markup. It is a new
  dependency, and chalk writes small things by hand.
- Keeping the `onKeyDown` Enter handlers beside the form. Two submit paths
  can disagree.
- `display:none` for the hidden username. Some password managers ignore
  fields with `display:none`.
- A hidden username on the login TOTP step. The run-chalk launch probe
  fills `[data-testid='login-step-totp'] input`, and a second input would
  break it. The TOTP step is also not a credential pair.

## Open

`web/src/auth/LoginScreen.tsx` is dead code. No file imports it. This slice
leaves it untouched. It is a candidate for deletion in a later slice.

## Manual checklist

- [ ] 1Password on the sign-in form offers the saved login and fills both
      fields.
- [ ] Chrome's built-in password manager does the same.
- [ ] Signup offers to save the new password with the username.
- [ ] Enter in the password field still signs in.
- [ ] Enter on a step whose button is disabled does nothing.
- [ ] Account security, change password: the password manager offers to
      update the saved entry.
