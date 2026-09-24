export type GateResult = "ok" | "queue-full" | "timeout" | "aborted";

interface Waiter {
  resolve(result: GateResult): void;
  timer: NodeJS.Timeout;
  signal: AbortSignal | undefined;
  onAbort: () => void;
}

/**
 * Bounded concurrency gate with a bounded FIFO wait queue. `acquire` resolves
 * "ok" when a slot is held (the caller must `release`), "queue-full" when the
 * queue is already at its limit, "timeout" after `waitMs` in the queue and
 * "aborted" when the caller's signal fires while waiting.
 */
export class Gate {
  #active = 0;
  readonly #waiters: Waiter[] = [];

  constructor(
    private readonly max: number,
    private readonly maxQueued: number,
    private readonly waitMs: number,
  ) {}

  get active(): number {
    return this.#active;
  }
  get queued(): number {
    return this.#waiters.length;
  }

  acquire(signal?: AbortSignal): Promise<GateResult> {
    if (signal?.aborted) return Promise.resolve("aborted");
    if (this.#active < this.max) {
      this.#active++;
      return Promise.resolve("ok");
    }
    if (this.#waiters.length >= this.maxQueued) return Promise.resolve("queue-full");
    return new Promise<GateResult>((resolve) => {
      const waiter: Waiter = {
        resolve,
        signal,
        timer: setTimeout(() => this.#drop(waiter, "timeout"), this.waitMs),
        onAbort: () => this.#drop(waiter, "aborted"),
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  release(): void {
    const next = this.#waiters.shift();
    if (next) {
      // The slot is handed over directly; #active stays the same.
      this.#settle(next, "ok");
      return;
    }
    this.#active = Math.max(0, this.#active - 1);
  }

  /** Fails every waiter (shutdown). */
  dispose(): void {
    for (const w of this.#waiters.splice(0)) this.#settle(w, "aborted");
  }

  #drop(waiter: Waiter, result: GateResult): void {
    const i = this.#waiters.indexOf(waiter);
    if (i === -1) return;
    this.#waiters.splice(i, 1);
    this.#settle(waiter, result);
  }

  #settle(waiter: Waiter, result: GateResult): void {
    clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
    waiter.resolve(result);
  }
}

/** Plain counter with a cap (CONNECT tunnels). */
export class Counter {
  #n = 0;
  constructor(private readonly max: number) {}
  tryAcquire(): boolean {
    if (this.#n >= this.max) return false;
    this.#n++;
    return true;
  }
  release(): void {
    this.#n = Math.max(0, this.#n - 1);
  }
}
