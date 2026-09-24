import type { WorkspaceManifest } from "./types.js";

/** Label of the root manifest in `declaredIn` / `workspaces.used`. */
export const ROOT_LABEL = "(root)";

/** Label of a workspace: its name, except that a workspace literally named `(root)` must not pass for the root manifest. */
export function workspaceLabel(w: Pick<WorkspaceManifest, "name" | "dir">): string {
  return w.name === ROOT_LABEL ? `${w.dir} (named "${ROOT_LABEL}")` : w.name;
}
