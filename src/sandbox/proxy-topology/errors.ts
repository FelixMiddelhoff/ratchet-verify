/** Every way the topology can refuse to run. There is no "degraded" outcome: any of these means NO candidate code ran. */
export type TopologyErrorCode =
  | "invalid-config"
  | "engine-unsupported"
  | "network-create-failed"
  | "inhibit-ipv4-unsupported"
  | "egress-unavailable"
  | "sidecar-start-failed"
  | "sidecar-timeout"
  | "sidecar-exited"
  | "selftest-failed"
  | "teardown-failed";

export class ProxyTopologyError extends Error {
  readonly code: TopologyErrorCode;
  /** One line per failed check (already redacted). */
  readonly details: readonly string[];
  /** Cleanup problems that happened while unwinding this error (already redacted). */
  teardownProblems: string[] = [];

  constructor(code: TopologyErrorCode, message: string, details: readonly string[] = []) {
    super(message);
    this.name = "ProxyTopologyError";
    this.code = code;
    this.details = details;
  }
}
