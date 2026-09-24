import { isValidPackageName } from "./config.js";
import type { Redactor } from "./secret.js";

export type AuditClass = "packument" | "tarball" | "connect" | "denied" | "invalid";
/** allow = served (2xx/304); deny = refused by policy; error = proxy-side failure; upstream-error = upstream answered >= 400. */
export type AuditDecision = "allow" | "deny" | "error" | "upstream-error";
export type ClientFamily = "npm" | "yarn" | "pnpm" | "other";

/**
 * Deliberately narrow: no headers, no query strings, no bodies. `name` and
 * `version` are only present when they passed the strict package-name /
 * version grammar; `client` is a fixed vocabulary derived from the User-Agent.
 * No attacker-controlled raw text is ever copied into an entry.
 */
export interface AuditEntry {
  time: number;
  method: string;
  class: AuditClass;
  registry: string | null;
  host: string | null;
  status: number;
  decision: AuditDecision;
  reason: string;
  name: string | null;
  version: string | null;
  upstreamStatus: number | null;
  bytes: number | null;
  ms: number | null;
  client: ClientFamily | null;
}

export type AuditInput = Omit<AuditEntry, "time" | "name" | "version" | "upstreamStatus" | "bytes" | "ms" | "client"> &
  Partial<Pick<AuditEntry, "name" | "version" | "upstreamStatus" | "bytes" | "ms" | "client">>;

const MAX_ENTRIES = 10_000;
const VERSION_OK = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const clean = (redact: Redactor, v: string | null): string | null =>
  v === null ? null : redact(v).replace(/[^ -~]/g, "?").slice(0, 200);

const nonNegInt = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

/** Maps a User-Agent to a fixed vocabulary. pnpm's UA also contains "npm/", so it is checked first. */
export function clientFamily(userAgent: unknown): ClientFamily {
  if (typeof userAgent !== "string") return "other";
  const ua = userAgent.slice(0, 200).toLowerCase();
  if (ua.startsWith("pnpm/")) return "pnpm";
  if (ua.startsWith("yarn") || ua.includes(" yarn/")) return "yarn";
  if (ua.startsWith("npm/")) return "npm";
  return "other";
}

/** Bounded, redacting, structured audit log. */
export class AuditLog {
  readonly #entries: AuditEntry[] = [];
  readonly #redact: Redactor;
  readonly #now: () => number;
  readonly #sink: ((line: string) => void) | undefined;

  constructor(redact: Redactor, now: () => number = Date.now, sink?: (line: string) => void) {
    this.#redact = redact;
    this.#now = now;
    this.#sink = sink;
  }

  record(input: AuditInput): void {
    const name = typeof input.name === "string" && isValidPackageName(input.name) ? input.name : null;
    const version = typeof input.version === "string" && input.version.length <= 128 && VERSION_OK.test(input.version) ? input.version : null;
    const entry: AuditEntry = {
      time: this.#now(),
      method: clean(this.#redact, input.method) ?? "",
      class: input.class,
      registry: clean(this.#redact, input.registry),
      host: clean(this.#redact, input.host),
      status: Number.isInteger(input.status) ? input.status : 0,
      decision: input.decision,
      reason: clean(this.#redact, input.reason) ?? "",
      name: name === null ? null : clean(this.#redact, name),
      version: version === null ? null : clean(this.#redact, version),
      upstreamStatus: nonNegInt(input.upstreamStatus),
      bytes: nonNegInt(input.bytes),
      ms: nonNegInt(input.ms),
      client: input.client ?? null,
    };
    if (this.#entries.length >= MAX_ENTRIES) this.#entries.shift();
    this.#entries.push(Object.freeze(entry));
    if (this.#sink) this.#sink(JSON.stringify(entry));
  }

  entries(): AuditEntry[] {
    return this.#entries.map((e) => ({ ...e }));
  }

  deniedCount(): number {
    return this.#entries.filter((e) => e.decision !== "allow").length;
  }
}
