// 139-1: the label of a review instance. A review instance is a separate
// chalk server for app review, with demo accounts and no TOTP step at
// password login. The label shows on the sign-in screens and in the app, so
// that nobody takes the demo server for a real one.

interface Props {
  /** The review_mode flag of /api/auth/config. */
  reviewMode: boolean;
}

/** Shows a small fixed label at the top of the window if reviewMode is true. */
export function DemoStrip({ reviewMode }: Props) {
  if (!reviewMode) return null;
  return (
    <div class="chalk-demo-strip" role="note" data-testid="demo-strip">
      Demo server
    </div>
  );
}
