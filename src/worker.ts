import { randomUUID } from "node:crypto";
import { Store, type Event, type Job } from "./store.js";
import { redact } from "./progress.js";
import { presentation, type Locale } from "./presentation.js";
export interface AgentRunner {
  (
    e: Event,
    sessionId: string,
    runId: string,
    signal: AbortSignal,
  ): Promise<string>;
}
export interface Delivery {
  authorizeEvent(e: Event): Promise<boolean>;
  activity(
    sessionId: string,
    id: string,
    type: string,
    body: string,
  ): Promise<void>;
}
export class Worker {
  private active = new Map<
    string,
    {
      event: Event;
      controller: AbortController;
      promise: Promise<void>;
    }
  >();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = true;
  private shutdownRequested = false;
  constructor(
    private store: Store,
    private linear: Delivery,
    private run: AgentRunner,
    private log: (message: string) => void,
    private cancelStored?: (e: Event) => Promise<void>,
    private locale: Locale = "en",
    private maxConcurrency = 1,
  ) {}
  start() {
    this.store.recover();
    this.stopped = false;
    this.shutdownRequested = false;
    this.timer = setInterval(() => this.kick(), 1000);
    this.kick();
  }
  kick() {
    if (this.stopped) return;
    while (this.active.size < this.maxConcurrency && this.startNext()) {
      // Fill every available slot. Each session remains exclusive.
    }
  }
  private startNext() {
    const j = this.store.next(
      [...this.active.values()].map(({ event }) => event.sessionId),
    );
    if (!j) return undefined;
    const event = JSON.parse(j.event) as Event;
    const controller = new AbortController();
    const entry = {
      event,
      controller,
      promise: Promise.resolve(),
    };
    this.active.set(j.id, entry);
    entry.promise = this.process(j, event, controller)
      .catch(() => this.log("Linear worker error; pending work retained"))
      .finally(() => {
        this.active.delete(j.id);
        this.kick();
      });
    return entry.promise;
  }
  async stop() {
    this.stopped = true;
    this.shutdownRequested = true;
    clearInterval(this.timer);
    for (const { controller } of this.active.values()) controller.abort();
    await Promise.allSettled(
      [...this.active.values()].map(({ promise }) => promise),
    );
  }
  async acknowledge(e: Event) {
    if (e.action === "stop") return;
    if (!(await this.linear.authorizeEvent(e))) return;
    if (this.store.suppressed(e.id) || this.shutdownRequested) return;
    let id = this.store.get<string>(`receipt:${e.id}`);
    if (!id) {
      id = randomUUID();
      this.store.set(`receipt:${e.id}`, id);
    }
    await this.linear.activity(
      e.sessionId,
      id,
      "thought",
      presentation(this.locale).received,
    );
  }
  /** Caller has authenticated the webhook and verified session ownership. */
  requestStop(e: Event) {
    if (this.store.get(`stop:${e.id}`)) return;
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const cutoff = this.store.db
        .prepare("SELECT MAX(seq) AS seq FROM jobs WHERE sessionId=?")
        .get(e.sessionId)?.seq;
      this.store.set(`stop-cutoff:${e.sessionId}`, Number(cutoff ?? 0));
      this.store.cancelQueued(e.sessionId);
      this.store.enqueue(e);
      this.store.set(`stop:${e.id}`, true);
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
    for (const active of this.active.values())
      if (active.event.sessionId === e.sessionId) active.controller.abort();
    this.kick();
  }
  async tick() {
    await this.startNext();
  }
  private async process(j: Job, e: Event, controller: AbortController) {
    try {
      if (!(await this.linear.authorizeEvent(e))) {
        this.store.done(j.id);
        this.log("Rejected event outside configured session/team");
        return;
      }
      if (this.store.suppressed(e.id)) {
        this.store.done(j.id);
        return;
      }
      if (j.status === "outbox") {
        await this.linear.activity(
          e.sessionId,
          j.activityId,
          j.outputType,
          String(redact(j.output!)),
        );
        this.store.done(j.id);
        return;
      }
      if (e.action === "stop") {
        await this.cancelStored?.(e);
        const blocked = this.store.get(`blocked:${e.sessionId}`);
        const p = presentation(this.locale);
        this.store.output(
          j.id,
          blocked
            ? p.stopUnconfirmed
            : p.stopped,
          blocked ? "error" : "response",
        );
        return;
      }
      if (this.store.get(`blocked:${e.sessionId}`)) {
        await this.cancelStored?.(e);
        if (this.store.get(`blocked:${e.sessionId}`)) {
          this.store.output(
            j.id,
            presentation(this.locale).blocked,
            "error",
          );
          return;
        }
      }
      let sessionId = this.store.get<string>(
        `session:${e.organizationId}:${e.sessionId}`,
      );
      if (!sessionId) {
        sessionId = randomUUID();
        this.store.set(`session:${e.organizationId}:${e.sessionId}`, sessionId);
      }
      if (
        this.store.db.prepare("SELECT status FROM jobs WHERE id=?").get(j.id)
          ?.status !== "pending"
      )
        return;
      if (this.shutdownRequested) return;
      this.store.running(j.id);
      try {
        const output = await this.run(
          e,
          sessionId,
          j.runId,
          controller.signal,
        );
        this.store.output(j.id, output || presentation(this.locale).noResult);
      } catch {
        this.store.output(
          j.id,
          presentation(this.locale).failed,
          "error",
        );
      }
    } catch {
      this.store.defer(j);
      this.log(
        `Linear delivery deferred (${j.id}); credentials and payload omitted`,
      );
    }
  }
}
