import type { DependencyVerdict, Report } from "./types.js";

/** A bare "safe" headline must never hide a partial verdict underneath (quality policy rule 1). */
export function overallLabel(report: Report): string {
  const partial = report.overall === "safe" && report.verdicts.some((v) => v.confidence === "reduced");
  return partial ? "safe (partial)" : report.overall;
}

export type VerdictGroup = { members: DependencyVerdict[] };

/**
 * One failing direct bump drags every transitive change along with it, all "not tested on
 * their own" for the same reason. Renderers show that once, not once per package; the JSON
 * report still lists every dependency.
 */
export function groupVerdicts(verdicts: DependencyVerdict[]): VerdictGroup[] {
  const groups: VerdictGroup[] = [];
  const bySummary = new Map<string, VerdictGroup>();

  for (const verdict of verdicts) {
    if (!isSharedUnverified(verdict)) {
      groups.push({ members: [verdict] });
      continue;
    }
    let group = bySummary.get(verdict.summary);
    if (!group) {
      group = { members: [] };
      bySummary.set(verdict.summary, group);
      groups.push(group);
    }
    group.members.push(verdict);
  }
  return groups;
}

function isSharedUnverified(v: DependencyVerdict): boolean {
  return !v.direct && v.status === "risky" && v.evidence.length === 1 && v.evidence[0]?.kind === "no-tests";
}
