import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
export interface Event {
  id: string;
  organizationId: string;
  sessionId: string;
  issueId: string;
  prompt: string;
  action: string;
  issueIdentifier?: string;
  issueTitle?: string;
  guidance?: unknown[];
  signal?: string;
  activityId?: string;
  triggerCommentId?: string;
}
export interface Job {
  seq: number;
  id: string;
  event: string;
  status: string;
  sessionId: string;
  runId: string;
  activityId: string;
  output: string | null;
  outputType: string;
  attempts: number;
  nextAt: number;
}
export class Store {
  db: DatabaseSync;
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.db = new DatabaseSync(join(dir, "linear.sqlite"));
    chmodSync(join(dir, "linear.sqlite"), 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
   CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS jobs(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,event TEXT NOT NULL,status TEXT NOT NULL,sessionId TEXT NOT NULL,runId TEXT NOT NULL,activityId TEXT NOT NULL,output TEXT,outputType TEXT NOT NULL DEFAULT 'response',attempts INTEGER NOT NULL DEFAULT 0,nextAt INTEGER NOT NULL DEFAULT 0);`);
  }
  get<T>(key: string): T | undefined {
    const r = this.db.prepare("SELECT value FROM kv WHERE key=?").get(key);
    return r ? JSON.parse(r.value as string) : undefined;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare("INSERT OR REPLACE INTO kv VALUES (?,?)")
      .run(key, JSON.stringify(value));
  }
  take<T>(key: string): T | undefined {
    const v = this.get<T>(key);
    this.db.prepare("DELETE FROM kv WHERE key=?").run(key);
    return v;
  }
  enqueue(e: Event) {
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO jobs(id,event,status,sessionId,runId,activityId) VALUES (?,?,'pending',?,?,?)",
        )
        .run(e.id, JSON.stringify(e), e.sessionId, randomUUID(), randomUUID())
        .changes > 0
    );
  }
  next(excludedSessionIds: string[] = []): Job | undefined {
    const unique = [...new Set(excludedSessionIds)];
    const exclusion = unique.length
      ? ` AND j.sessionId NOT IN (${unique.map(() => "?").join(",")})`
      : "";
    return this.db
      .prepare(
        `SELECT j.* FROM jobs j WHERE j.status IN ('pending','outbox') AND j.nextAt<=? AND NOT EXISTS (SELECT 1 FROM jobs p WHERE p.sessionId=j.sessionId AND p.seq<j.seq AND p.status!='done')${exclusion} ORDER BY j.seq LIMIT 1`,
      )
      .get(Date.now(), ...unique) as unknown as Job | undefined;
  }
  running(id: string) {
    this.db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(id);
  }
  output(id: string, text: string, type = "response") {
    this.db
      .prepare(
        "UPDATE jobs SET status='outbox',output=?,outputType=?,attempts=0,nextAt=0 WHERE id=?",
      )
      .run(text, type, id);
  }
  done(id: string) {
    this.db.prepare("UPDATE jobs SET status='done' WHERE id=?").run(id);
  }
  defer(j: Job) {
    this.db
      .prepare("UPDATE jobs SET attempts=attempts+1,nextAt=? WHERE id=?")
      .run(
        Date.now() + Math.min(300000, 1000 * 2 ** Math.min(j.attempts, 9)),
        j.id,
      );
  }
  recover() {
    for (const row of this.db
      .prepare("SELECT event FROM jobs WHERE status='running'")
      .all()) {
      const e = JSON.parse(row.event as string) as Event;
      this.set(`blocked:${e.sessionId}`, true);
    }
    this.db
      .prepare(
        "UPDATE jobs SET status='outbox',outputType='error',output='Gateway interrupted this run. Its side effects may already have occurred. Please review before asking to resume.' WHERE status='running'",
      )
      .run();
  }
  cancelQueued(sessionId: string) {
    this.db
      .prepare(
        "UPDATE jobs SET status='done' WHERE sessionId=? AND status IN ('pending','outbox')",
      )
      .run(sessionId);
  }
  suppressed(id: string) {
    const row = this.db
      .prepare("SELECT seq,sessionId FROM jobs WHERE id=?")
      .get(id);
    return (
      !!row &&
      Number(row.seq) <= (this.get<number>(`stop-cutoff:${row.sessionId}`) ?? 0)
    );
  }
  close() {
    this.db.close();
  }
}
