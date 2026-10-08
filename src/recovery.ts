import { setTimeout as delay } from "node:timers/promises";
import type { Store, Event } from "./store.js";

export interface ActiveBinding {
  event: Event;
  sessionKey: string;
  runId: string;
}
interface Attempt {
  runId: string;
  attempts: number;
  nextAttemptAt: number;
  status: "confirmed" | "unconfirmed";
}

/** Bound a host operation even when the host API cannot cancel its waiter. */
export async function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    // The operation was already created by the caller; observe its rejection.
    void operation.catch(() => {});
    throw signal.reason;
  }
  let abort!: () => void;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Only bindings captured at boot are eligible; never cancel a new live run. */
export class StartupRecovery {
  private readonly controller = new AbortController();
  private readonly pending = new Map<string, ActiveBinding>();
  private readonly inFlight = new Map<string, Promise<boolean>>();
  private operation?: Promise<void>;
  constructor(
    private readonly store: Store,
    private readonly ready: (signal: AbortSignal) => Promise<void>,
    private readonly cancel: (
      binding: ActiveBinding,
      signal: AbortSignal,
    ) => Promise<boolean>,
    private readonly onReady: () => void,
    private readonly log: (message: string) => void,
  ) {
    for (const row of store.db
      .prepare("SELECT value FROM kv WHERE key LIKE 'active:%'")
      .all()) {
      const binding = JSON.parse(row.value as string) as ActiveBinding;
      this.pending.set(binding.event.sessionId, binding);
      // Protect old sessions before the worker can dispatch any queued event.
      store.set(`blocked:${binding.event.sessionId}`, true);
    }
  }

  start() {
    if (this.operation) return;
    this.operation = this.run().catch(() => {
      if (!this.controller.signal.aborted)
        this.log("Linear startup recovery failed; affected sessions remain blocked");
    });
  }

  async stop() {
    this.controller.abort(new Error("Linear recovery stopped"));
    await this.operation;
    await Promise.allSettled(this.inFlight.values());
  }

  private current(binding: ActiveBinding) {
    const active = this.store.get<ActiveBinding>(
      `active:${binding.event.sessionId}`,
    );
    return active?.runId === binding.runId &&
      active.sessionKey === binding.sessionKey;
  }

  private reconcile(binding: ActiveBinding, signal: AbortSignal) {
    const key = binding.event.sessionId;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const task = (async () => {
      if (!this.current(binding)) {
        this.pending.delete(key);
        return false;
      }
      const before = this.store.get<Attempt>(`recovery:${key}`);
      const attempts = before?.runId === binding.runId ? before.attempts + 1 : 1;
      let confirmed = false;
      try {
        confirmed = await abortable(this.cancel(binding, signal), signal);
      } catch {
        signal.throwIfAborted();
      }
      signal.throwIfAborted();
      // A live worker may have replaced/cleared the binding while we waited.
      if (!this.current(binding)) {
        this.pending.delete(key);
        return false;
      }
      const nextAttemptAt = confirmed ? 0 : Date.now() +
        Math.min(3_600_000, 300_000 * 2 ** Math.min(attempts - 1, 4));
      this.store.set(`recovery:${key}`, {
        runId: binding.runId,
        attempts,
        nextAttemptAt,
        status: confirmed ? "confirmed" : "unconfirmed",
      } satisfies Attempt);
      if (confirmed) {
        this.store.take(`active:${key}`);
        this.store.set(`blocked:${key}`, false);
        this.pending.delete(key);
      }
      return confirmed;
    })().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, task);
    return task;
  }

  private async run() {
    const signal = this.controller.signal;
    // service.start must settle before any Gateway-dependent recovery begins.
    await delay(0, undefined, { signal });
    while (!signal.aborted) {
      try {
        await abortable(this.ready(signal), signal);
        break;
      } catch {
        signal.throwIfAborted();
        await delay(1_000, undefined, { signal });
      }
    }
    signal.throwIfAborted();
    this.onReady();
    while (this.pending.size) {
      const eligible = [...this.pending.values()].filter((binding) => {
        if (!this.current(binding)) {
          this.pending.delete(binding.event.sessionId);
          return false;
        }
        const attempt = this.store.get<Attempt>(
          `recovery:${binding.event.sessionId}`,
        );
        return attempt?.runId !== binding.runId || attempt.nextAttemptAt <= Date.now();
      });
      if (eligible.length) {
        const started = Date.now();
        const deadline = AbortSignal.timeout(30_000);
        const passSignal = AbortSignal.any([signal, deadline]);
        let next = 0;
        let confirmed = 0;
        await Promise.allSettled(Array.from(
          { length: Math.min(4, eligible.length) },
          async () => {
            while (next < eligible.length && !passSignal.aborted) {
              const binding = eligible[next++];
              if (await this.reconcile(binding, passSignal)) confirmed++;
            }
          },
        ));
        signal.throwIfAborted();
        this.log(`Linear background recovery: checked=${next} confirmed=${confirmed} unresolved=${this.pending.size} elapsedMs=${Date.now() - started}`);
        // Budget expiry must not cause an immediate retry loop.
        if (deadline.aborted) await delay(300_000, undefined, { signal });
      }
      if (this.pending.size) await delay(60_000, undefined, { signal });
    }
  }
}
