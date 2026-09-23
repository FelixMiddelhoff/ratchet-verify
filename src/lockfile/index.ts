import { diffLockfiles } from "./diff.js";
import { parseLockfile } from "./parse.js";
import type { DependencyChange, RootManifest } from "./types.js";

export { diffLockfiles, parseLockfile };
export type * from "./types.js";

export function diffLockfileTexts(
  oldText: string,
  newText: string,
  manifest?: RootManifest,
): DependencyChange[] {
  return diffLockfiles(parseLockfile(oldText), parseLockfile(newText), manifest);
}
