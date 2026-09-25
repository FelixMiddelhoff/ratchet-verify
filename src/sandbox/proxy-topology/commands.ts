import type { ContainerRuntime } from "../container.js";
import { labelArgs, type RunLabels } from "./sweep.js";
import { SIDECAR_PORT } from "./build-config.js";

/** Where the proxy's compiled directory appears inside the sidecar (read-only). */
export const SIDECAR_DIST_TARGET = "/proxy";
export const SIDECAR_CA_TARGET = "/ca/ca.pem";
/** The engine's default bridge: the sidecar's only way out. Rootless podman cannot combine pasta with a user network (spike 3a). */
export const defaultBridge = (runtime: ContainerRuntime): string => (runtime === "podman" ? "podman" : "bridge");

/** Run-scoped names (also the DNS names inside the network). */
export const networkNameFor = (run: string): string => `ratchet-net-${run.slice(0, 8)}`;
export const sidecarNameFor = (run: string): string => `ratchet-proxy-${run.slice(0, 8)}`;

/**
 * Docker: `--internal` + `inhibit_ipv4` (no host-side gateway address exists, so the host is unreachable) + explicit subnet.
 * Podman: `--internal` only (its gateway only serves DNS; podman rejects the docker bridge option; spike-network).
 */
export function networkCreateArgs(runtime: ContainerRuntime, name: string, labels: RunLabels, subnet?: string): string[] {
  if (runtime === "docker") {
    if (subnet === undefined) throw new Error("docker needs an explicit subnet with inhibit_ipv4");
    return ["network", "create", "--internal", "--opt", "com.docker.network.bridge.inhibit_ipv4=true", "--subnet", subnet, ...labelArgs(labels), name];
  }
  return ["network", "create", "--internal", ...labelArgs(labels), name];
}

export interface SidecarCreateInput {
  runtime: ContainerRuntime;
  name: string;
  network: string;
  labels: RunLabels;
  image: string;
  /** Host directory holding the compiled proxy (`main.js` and its siblings): the ONLY host path the sidecar sees, read-only. */
  proxyDir: string;
  /** Optional non-secret CA file (self-signed test upstreams, corporate CA), mounted read-only, exposed via NODE_EXTRA_CA_CERTS. */
  extraCaFile?: string;
}

/** Podman on SELinux hosts needs a relabel; `shared` because concurrent sidecars mount the same read-only files (docker's --mount has no such option, same as the sandbox mount). */
const bind = (runtime: ContainerRuntime, source: string, target: string): string[] => {
  if (source.includes(",")) throw new Error(`mount path contains a comma, which container mounts cannot express: ${source}`);
  return ["--mount", `type=bind,source=${source},target=${target},readonly${runtime === "podman" ? ",relabel=shared" : ""}`];
};

/**
 * Sidecar container: created (not started) on the internal network; the egress bridge is joined with `network connect`
 * (docker cannot attach two networks at create). Credentials are NOT here: they arrive on stdin at `start -a -i`.
 * `-i` keeps stdin open for that. No published ports, no other mounts, no env carrying secrets.
 */
export function sidecarCreateArgs(input: SidecarCreateInput): string[] {
  return [
    "create", "-i",
    "--name", input.name,
    "--network", input.network,
    ...labelArgs(input.labels),
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--read-only",
    "--pids-limit", "256",
    "--memory", "512m",
    ...bind(input.runtime, input.proxyDir, SIDECAR_DIST_TARGET),
    ...(input.extraCaFile !== undefined ? [...bind(input.runtime, input.extraCaFile, SIDECAR_CA_TARGET), "-e", `NODE_EXTRA_CA_CERTS=${SIDECAR_CA_TARGET}`] : []),
    input.image,
    "node", `${SIDECAR_DIST_TARGET}/main.js`,
  ];
}

export const sidecarConnectArgs = (runtime: ContainerRuntime, name: string): string[] => ["network", "connect", defaultBridge(runtime), name];
/** Non-detached client: a detached run never delivers stdin (spike). */
export const sidecarStartArgs = (name: string): string[] => ["start", "-a", "-i", name];
export const proxyUrlFor = (sidecarName: string, port = SIDECAR_PORT): string => `http://${sidecarName}:${port}`;
