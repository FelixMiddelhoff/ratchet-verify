import { diffLockfiles } from "./diff.js";
import { parseLockfile } from "./parse.js";
import type { DependencyChange, RootManifest, WorkspaceManifest } from "./types.js";

export { diffLockfiles, parseLockfile };
export type * from "./types.js";

export function diffLockfileTexts(
  oldText: string,
  newText: string,
  manifest?: RootManifest,
  workspaces?: WorkspaceManifest[],
): DependencyChange[] {
  return diffLockfiles(parseLockfile(oldText), parseLockfile(newText), manifest, workspaces);
}
