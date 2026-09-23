export interface ClassifiedLine {
  text: string;
  /** Inside a breaking-change section, or carrying an explicit BREAKING marker. */
  explicit: boolean;
  /** Describes a removal/rename/deprecation without being labelled breaking. */
  soft: boolean;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const BREAKING_HEADING = /breaking|removed|removals|incompatib/i;
const BOLD_LABEL = /^\s*\*\*(.+?)\*\*:?\s*$/;
const BREAKING_MARKER = /\bBREAKING\b|\*\*breaking/i;
const SOFT_CHANGE = /\b(removed?|renamed?|no longer|dropped?|drops?|now requires?|now throws?|replaced (?:by|with)|deprecated)\b/i;

/** Tags each non-empty changelog line as explicitly breaking, softly breaking, or neither. */
export function classifyLines(body: string): ClassifiedLine[] {
  const result: ClassifiedLine[] = [];
  let sectionLevel: number | undefined; // heading level of the active breaking section

  for (const raw of body.split(/\r?\n/)) {
    const text = raw.trim();
    if (!text) continue;

    const heading = HEADING.exec(text);
    const label = BOLD_LABEL.exec(text);
    if (heading || label) {
      const level = heading ? heading[1]!.length : 7; // bold labels end at any heading
      const title = heading ? heading[2]! : label![1]!;
      if (sectionLevel !== undefined && level > sectionLevel && heading) {
        // Sub-heading inside the breaking section: stays in the section.
      } else {
        sectionLevel = BREAKING_HEADING.test(title) ? level : undefined;
      }
    }
    result.push({
      text,
      explicit: sectionLevel !== undefined || BREAKING_MARKER.test(text),
      soft: SOFT_CHANGE.test(text),
    });
  }
  return result;
}
