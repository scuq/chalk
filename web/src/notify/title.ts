// chalk-web -- the one owner of document.title.
//
// Two things want to write the title: the unread badge count ("(3)
// chalk", 50-7) and the attention blink that alternates while something
// noteworthy waits in a background tab. Two independent writers would
// fight -- the blink's restore would stomp a count that changed
// mid-blink -- so both go through this controller and every write renders
// the whole state.
//
// The blink stops the moment the tab is actually looked at (visibility
// or focus), which is also why it never starts while the window is
// visible and focused: with no transition left to happen, nothing would
// ever clear it.

// The pure half: what should the title say right now?
export function titleFor(input: { base: string; count: number; blinkOn: boolean }): string {
  if (input.blinkOn) return `● ${input.base}`;
  return input.count > 0 ? `(${input.count}) ${input.base}` : input.base;
}

const BLINK_INTERVAL_MS = 1200;

export class TitleController {
  private base: string;
  private count = 0;
  private blinking = false;
  private phase = false;
  private timer: number | null = null;

  constructor() {
    this.base = (typeof document !== "undefined" && document.title) || "chalk";
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) this.stopBlink();
      });
      window.addEventListener("focus", () => this.stopBlink());
    }
  }

  // 50-7 drives this from the unread state.
  setCount(n: number): void {
    if (this.count === n) return;
    this.count = n;
    this.render();
  }

  blink(): void {
    if (typeof document === "undefined") return;
    if (!document.hidden && document.hasFocus()) return;
    if (this.blinking) return;
    this.blinking = true;
    this.phase = true;
    this.timer = window.setInterval(() => {
      this.phase = !this.phase;
      this.render();
    }, BLINK_INTERVAL_MS);
    this.render();
  }

  stopBlink(): void {
    if (!this.blinking) return;
    this.blinking = false;
    this.phase = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.render();
  }

  private render(): void {
    if (typeof document === "undefined") return;
    document.title = titleFor({
      base: this.base,
      count: this.count,
      blinkOn: this.blinking && this.phase,
    });
  }
}

let shared: TitleController | null = null;

export function titleController(): TitleController {
  if (!shared) shared = new TitleController();
  return shared;
}
