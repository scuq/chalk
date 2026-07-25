// 39-1: the running build, as a link to the changelog that describes it.
//
// Rendered twice: as a badge beside the wordmark in the header, and as a row
// in the profile panel's "about" section (the header badge is hidden on
// mobile, where the header has no room to spare).

import { changelogURL, versionLabel, versionTitle } from "../version";

interface Props {
  version: string | null | undefined;
  commit: string | null | undefined;
  /** Styling hook: "badge" in the header, "row" in the profile panel. */
  variant?: "badge" | "row";
  testID?: string;
}

export function VersionLink({ version, commit, variant = "badge", testID }: Props) {
  const label = versionLabel(version);
  return (
    <a
      class={`chalk-version chalk-version--${variant}`}
      href={changelogURL(version)}
      target="_blank"
      // noopener is what matters (the changelog opens on github.com, which
      // must not reach back into this tab); noreferrer comes along for free.
      rel="noopener noreferrer"
      title={versionTitle(version, commit)}
      data-testid={testID ?? "version-link"}
    >
      {label}
    </a>
  );
}
