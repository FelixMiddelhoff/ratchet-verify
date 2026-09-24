import type { Redactor } from "./secret.js";

export type AuditClass = "packument" | "tarball" | "connect" | "denied" | "invalid";
export type AuditDecision = "allow" | "deny" | "error";

/** Deliberately narrow: no headers, no paths, no query strings, no bodies. */
export interface AuditEntry {
  time: number;
  method: string;
  class: AuditClass;
  registry: string | null;
  host: string | null;
  status: number;
  decision: AuditDecision;
  reason: string;
}

export type AuditInput = Omit<AuditEntry, "time">;

const MAX_ENTRIES = 10_000;

const clean = (redact: Redactor, v: string | null): string | null =>
  v === null ? null : redact(v).replace(/[^ -~]/g, "?").slice(0, 200);

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
    const entry: AuditEntry = {
      time: this.#now(),
      method: clean(this.#redact, input.method) ?? "",
      class: input.class,
      registry: clean(this.#redact, input.registry),
      host: clean(this.#redact, input.host),
      status: Number.isInteger(input.status) ? input.status : 0,
      decision: input.decision,
      reason: clean(this.#redact, input.reason) ?? "",
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
