import { render } from "preact";
import { App } from "./components/App";
import { applyDisplayPrefs, loadDisplayPrefs } from "./display-prefs";

// The HTML scaffolds the page with a #root element and links to
// theme.css + app.js. esbuild emits both as plain ESM artifacts;
// app.js mounts into #root on load.

// Font family/size are device-local, so they're readable synchronously
// here. Applying before the first render means the UI never paints at
// the default size and then jumps.
applyDisplayPrefs(loadDisplayPrefs());

const root = document.getElementById("root");
if (!root) {
  // Should be impossible -- index.html ships with #root -- but if
  // someone breaks the template, fail loudly rather than silently.
  throw new Error("chalk: #root element missing from page");
}
render(<App />, root);
