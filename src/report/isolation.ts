import type { IsolationInfo } from "../sandbox/index.js";

/** One line saying how strongly the installs were isolated, so a report never implies more than was done. */
export function describeIsolation(info: IsolationInfo): string {
  if (info.level === "container") return `container (${[info.runtime, info.image].filter(Boolean).join(", ")}): installs and tests could only see the sandbox directory`;
  return "temp-dir: credentials are withheld, but install scripts can still read host files (use --isolation container)";
}
