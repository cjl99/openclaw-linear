import { randomUUID } from "node:crypto";
import { Store, type Event } from "./store.js";
import { redact } from "./progress.js";
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
  private active?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = true;
  private controller = new AbortController();
  private current?: Event;
  private shutdownRequested = false;
  constructor(
    private store: Store,
    private linear: Delivery,
    private run: AgentRunner,
    private log: (message: string) => void,
    private cancelStored?: (e: Event) => Promise<void>,
  ) {}
  start() {
    this.store.recover();
    this.stopped = false;
    this.shutdownRequested = false;
    this.timer = setInterval(() => this.kick(), 1000);
    this.kick();
  }
  kick() {
    if (this.stopped || this.active) return;
    this.active = this.tick()
      .catch(() => this.log("Linear worker error; pending work retained"))
      .finally(() => {
        this.active = undefined;
      });
  }
  async stop() {
    this.stopped = true;
    this.shutdownRequested = true;
    clearInterval(this.timer);
    this.controller.abort();
    await this.active;
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
      "已收到请求，准备开始。",
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
    if (this.current?.sessionId === e.sessionId) this.controller.abort();
    this.kick();
  }
  async tick() {
    const j = this.store.next();
    if (!j) return;
    const e = JSON.parse(j.event) as Event;
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
        this.store.output(
          j.id,
          blocked
            ? "尚未确认执行已停止；已阻止此 Session 启动新任务，请稍后重试停止。"
            : "已停止此 Session 的执行，并取消已排队的请求。",
          blocked ? "error" : "response",
        );
        return;
      }
      if (this.store.get(`blocked:${e.sessionId}`)) {
        await this.cancelStored?.(e);
        if (this.store.get(`blocked:${e.sessionId}`)) {
          this.store.output(
            j.id,
            "尚未确认执行已停止；已阻止此 Session 启动新任务，请稍后重试。",
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
      this.current = e;
      this.controller = new AbortController();
      try {
        const output = await this.run(
          e,
          sessionId,
          j.runId,
          this.controller.signal,
        );
        this.store.output(j.id, output || "本次运行未返回可见结果。");
      } catch {
        this.store.output(
          j.id,
          "本次执行失败或被中断，请查看 session🔗 后决定是否重试。",
          "error",
        );
      } finally {
        this.current = undefined;
      }
    } catch {
      this.store.defer(j);
      this.log(
        `Linear delivery deferred (${j.id}); credentials and payload omitted`,
      );
    }
  }
}
