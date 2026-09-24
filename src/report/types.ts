import type { IsolationInfo } from "../sandbox/index.js";

export type VerdictStatus = "safe" | "risky" | "broken";

/** "reduced": at least one signal could not be evaluated, so the verdict rests on less than the full pipeline. */
export type VerdictConfidence = "full" | "reduced";

export type Evidence =
  | {
      kind: "call-site";
      symbol: string;
      file: string;
      line: number;
      snippet: string;
      changelogVersion: string;
      changelogExcerpt: string;
      matchConfidence: "high" | "medium";
      reason: string;
    }
  | {
      kind: "bisect";
      exact: boolean;
      /** Set when a boundary flipped on re-run: the suite is flaky and the versions are not a reliable culprit. */
      unstable?: boolean;
      /** Boundary re-runs were skipped or inconclusive. */
      unconfirmed?: boolean;
      lastGood: string;
      firstBad: string;
      ambiguousWith: string[];
      installs: number;
      failingOutput: string;
    }
  | { kind: "test-failure"; outcome: string; output: string; bisectSkippedReason?: string }
  | { kind: "no-tests"; reason: string };

export interface DependencyVerdict {
  name: string;
  oldVersion?: string;
  newVersion?: string;
  direct: boolean;
  /** Workspace projects only: which manifests declare it (`(root)` = root package.json) and which workspaces use it in code. */
  workspaces?: { declared: string[]; used: string[] };
  status: VerdictStatus;
  confidence: VerdictConfidence;
  /** One line a human can read without opening the evidence. */
  summary: string;
  evidence: Evidence[];
  /**
   * Only on a broken verdict whose bisection is exact and confirmed: the last version ratchet itself
   * tested passing in this run. `command` is set for direct dependencies only. Later versions are
   * not claimed broken, only untested.
   */
  suggestion?: { version: string; command?: string };
  /** Gaps that reduced confidence; a "safe" with caveats is a tests-only verdict, not an all-clear. */
  caveats: string[];
  /** Informational, does not affect confidence. */
  notes: string[];
}

export interface Report {
  schemaVersion: 1;
  overall: VerdictStatus;
  /** How the installs and tests were isolated; absent when nothing was run. */
  isolation?: IsolationInfo;
  verdicts: DependencyVerdict[];
}
