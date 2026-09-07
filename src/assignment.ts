import type { Config } from "./config.js";
import { Store } from "./store.js";
import { Linear } from "./linear.js";

export interface Assignment {
  id: string;
  issueId: string;
  assigneeId: string;
  updatedAt: string;
}
export function assignment(
  p: any,
  c: Config,
  delivery?: string,
): Assignment | null {
  if (p.type !== "Issue" || !c.autoAssignUserIds?.length) return null;
  const d = p.data;
  if (
    !["create", "update"].includes(p.action) ||
    !c.teamIds.includes(d?.teamId) ||
    !c.autoAssignUserIds.includes(d?.assigneeId) ||
    d?.delegateId ||
    d?.archivedAt ||
    (p.action === "update" &&
      (!Object.hasOwn(p.updatedFrom ?? {}, "assigneeId") ||
        p.updatedFrom.assigneeId === d.assigneeId))
  )
    return null;
  const id = delivery || p.webhookId;
  if (
    typeof id !== "string" ||
    !id ||
    typeof d.id !== "string" ||
    typeof d.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(d.updatedAt))
  )
    throw Error("Invalid assignment event");
  return {
    id,
    issueId: d.id,
    assigneeId: d.assigneeId,
    updatedAt: d.updatedAt,
  };
}

export class Assignments {
  private active?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private c: Config,
    private store: Store,
    private linear: Linear,
    private log: (s: string) => void,
  ) {
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS assignments(id TEXT PRIMARY KEY,event TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,nextAt INTEGER NOT NULL DEFAULT 0)",
    );
  }
  enqueue(e: Assignment) {
    this.store.db
      .prepare("INSERT OR IGNORE INTO assignments(id,event) VALUES (?,?)")
      .run(e.id, JSON.stringify(e));
  }
  start() {
    this.timer = setInterval(() => this.kick(), 1000);
    this.kick();
  }
  kick() {
    if (!this.active)
      this.active = this.tick()
        .catch(() => this.log("Assignment processing deferred"))
        .finally(() => {
          this.active = undefined;
        });
  }
  async stop() {
    clearInterval(this.timer);
    await this.active;
  }
  async tick() {
    const j = this.store.db
      .prepare(
        "SELECT * FROM assignments WHERE status='pending' AND nextAt<=? ORDER BY rowid LIMIT 1",
      )
      .get(Date.now());
    if (!j) return;
    try {
      const e = JSON.parse(j.event as string) as Assignment;
      if (this.c.autoAssignUserIds?.includes(e.assigneeId)) {
        const d = await this.linear.query<any>(
          "query($id:String!){organization{id} issue(id:$id){id updatedAt archivedAt assignee{id} delegate{id} team{id} state{type}}}",
          { id: e.issueId },
        );
        const issue = d.issue;
        // Re-read authority immediately before mutation. Ignore stale, completed,
        // reassigned, moved, archived or already delegated work.
        if (
          d.organization.id === this.linear.organizationId() &&
          issue &&
          this.c.teamIds.includes(issue.team.id) &&
          !this.store.get<{denied:boolean}>(`team-permission:${issue.team.id}`)?.denied &&
          issue.assignee?.id === e.assigneeId &&
          !issue.delegate &&
          !issue.archivedAt &&
          !["completed", "canceled"].includes(issue.state.type) &&
          Date.parse(issue.updatedAt) === Date.parse(e.updatedAt)
        ) {
          const app = (await this.linear.token()).appUserId;
          const result = await this.linear.query<any>(
            "mutation($id:String!,$input:IssueUpdateInput!){issueUpdate(id:$id,input:$input){success}}",
            { id: e.issueId, input: { delegateId: app } },
          );
          if (!result.issueUpdate.success)
            throw Error("Delegation not accepted");
        }
      }
      this.store.db
        .prepare("UPDATE assignments SET status='done' WHERE id=?")
        .run(j.id);
    } catch {
      this.store.db
        .prepare(
          "UPDATE assignments SET attempts=attempts+1,nextAt=? WHERE id=?",
        )
        .run(
          Date.now() +
            Math.min(300000, 1000 * 2 ** Math.min(Number(j.attempts), 9)),
          j.id,
        );
      this.log("Assignment API retry queued; payload omitted");
    }
  }
}
