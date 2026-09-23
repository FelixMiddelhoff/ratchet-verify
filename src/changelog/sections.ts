import { isSemver } from "./semver.js";

export interface ChangelogSection {
  version: string;
  body: string;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const VERSION_IN_HEADING = /\[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?/;

/**
 * Splits a CHANGELOG.md into one section per version heading. Sub-headings without a version
 * ("### Bug Fixes") stay inside the section they belong to.
 */
export function parseChangelogSections(markdown: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  let current: { version: string; lines: string[] } | undefined;

  for (const line of markdown.split(/\r?\n/)) {
    const version = versionOfHeading(line);
    if (version) {
      if (current) sections.push({ version: current.version, body: current.lines.join("\n").trim() });
      current = { version, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push({ version: current.version, body: current.lines.join("\n").trim() });
  return sections;
}

function versionOfHeading(line: string): string | undefined {
  const heading = HEADING.exec(line);
  const version = heading && VERSION_IN_HEADING.exec(heading[2]!)?.[1];
  return version && isSemver(version) ? version : undefined;
}
