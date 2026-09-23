import { DEFAULT_IMAGE, detectRuntime, ensureImage, type ContainerRuntime, type ContainerSettings, type Exec } from "./container.js";
import { runCommand } from "./exec.js";
import type { IsolationInfo } from "./sandbox.js";

export type IsolationMode = "temp-dir" | "container" | "auto";

export interface IsolationChoice {
  mode: IsolationMode;
  runtime: ContainerRuntime | "auto";
  image?: string;
}

export interface ResolvedIsolation {
  info: IsolationInfo;
  container?: ContainerSettings;
  /** Worth telling the user, e.g. that "auto" fell back to the weaker level. */
  notes: string[];
}

/**
 * "container" is a promise: if no engine is available that is an error, never a silent
 * downgrade. "auto" is the convenience: container when possible, temp-dir with a note otherwise.
 */
export async function resolveIsolation(choice: IsolationChoice, exec: Exec = runCommand): Promise<ResolvedIsolation> {
  if (choice.mode === "temp-dir") return { info: { level: "temp-dir" }, notes: [] };

  const detected = await detectRuntime(choice.runtime, exec);
  if (!detected) {
    if (choice.mode === "container") {
      throw new Error(
        `isolation "container" needs docker or podman, but no working engine was found (is the daemon running?). ` +
          `Use --isolation temp-dir to accept weaker isolation.`,
      );
    }
    return {
      info: { level: "temp-dir" },
      notes: ["no container engine found: falling back to temp-dir isolation (install scripts can still read host files)"],
    };
  }

  const container: ContainerSettings = { runtime: detected.runtime, rootless: detected.rootless, image: choice.image ?? DEFAULT_IMAGE };
  await ensureImage(container, exec);
  return { info: { level: "container", runtime: container.runtime, image: container.image }, container, notes: [] };
}
