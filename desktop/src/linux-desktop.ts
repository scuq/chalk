// chalk-desktop -- `chalk --install-desktop-entry` on Linux (104-4).
//
// The release is a tar.gz, not a .deb, so nothing registers the app with the
// desktop. This writes the two files a launcher needs -- the .desktop entry
// pointing at wherever the user unpacked the app, and the icon in the hicolor
// theme -- under XDG_DATA_HOME, no root. Same idea as f9's --install-icons.
// Run it again after moving the directory; it just rewrites both.

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** desktopEntry is the file's text for a given executable path. Exported
 * for the test; the quoting is the part worth pinning. */
export function desktopEntry(exe: string): string {
  // Exec quoting per the Desktop Entry spec: double quotes, with backslash,
  // double quote, dollar and backtick escaped inside.
  const quoted = `"${exe.replace(/[\\"$`]/g, (c) => `\\${c}`)}"`;
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=chalk",
    "Comment=Self-hosted, end-to-end-encrypted group chat",
    `Exec=${quoted} %U`,
    "Icon=chalk",
    "Terminal=false",
    "Categories=Network;Chat;InstantMessaging;",
    "StartupWMClass=chalk",
    "",
  ].join("\n");
}

export function installDesktopEntry(exe: string, iconSource: string): string {
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const apps = join(data, "applications");
  const icons = join(data, "icons", "hicolor", "512x512", "apps");
  mkdirSync(apps, { recursive: true });
  mkdirSync(icons, { recursive: true });
  copyFileSync(iconSource, join(icons, "chalk.png"));
  const path = join(apps, "chalk.desktop");
  writeFileSync(path, desktopEntry(exe));
  return path;
}
