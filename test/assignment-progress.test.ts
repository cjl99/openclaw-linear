import { test, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { assignment, Assignments } from "../src/assignment.js";
import { Progress, toolActivity } from "../src/progress.js";
const cfg: any = { teamIds: ["team"], autoAssignUserIds: ["me"] };
const payload = {
  type: "Issue",
  action: "update",
  updatedFrom: { assigneeId: null },
  data: {
    id: "issue",
    teamId: "team",
    assigneeId: "me",
    updatedAt: "2026-09-07T00:00:00Z",
  },
};
test("assignment whitelist requires a real assignment transition and explicit team", () => {
  expect(assignment(payload, cfg, "event")).toMatchObject({ assigneeId: "me" });
  expect(
    assignment({ ...payload, action: "create" }, cfg, "event"),
  ).not.toBeNull();
  for (const change of [
    { updatedFrom: { title: "old" } },
    { updatedFrom: { assigneeId: "me" } },
    { action: "remove" },
    { data: { ...payload.data, teamId: "other" } },
    { data: { ...payload.data, assigneeId: "other" } },
    { data: { ...payload.data, delegateId: "other-agent" } },
  ]) {
    expect(assignment({ ...payload, ...change }, cfg, "event")).toBeNull();
  }
  expect(
    assignment(payload, { ...cfg, autoAssignUserIds: [] }, "event"),
  ).toBeNull();
});
test("delegation preserves human ownership and durable replay cannot delegate twice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "linear-assignment-"));
  const store = new Store(dir);
  const issue: any = {
    ...payload.data,
    assignee: { id: "me" },
    team: { id: "team" },
    delegate: null,
    state: { type: "started" },
  };
  const query = vi.fn(async (q: string, v: any) => {
    if (q.startsWith("query")) return { organization: { id: "org" }, issue };
    expect(v.input).toEqual({ delegateId: "agent" });
    issue.delegate = { id: "agent" };
    return { issueUpdate: { success: true } };
  });
  try {
    const a = new Assignments(
      cfg,
      store,
      {
        query,
        token: async () => ({ appUserId: "agent" }),
        organizationId: () => "org",
      } as any,
      () => {},
    );
    const e = assignment(payload, cfg, "one")!;
    a.enqueue(e);
    a.enqueue(e);
    await a.tick();
    a.enqueue({ ...e, id: "retry" });
    await a.tick();
    expect(
      query.mock.calls.filter(([q]) => q.startsWith("mutation")),
    ).toHaveLength(1);
    expect(issue.assignee.id).toBe("me");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("fresh API state rejects stale, moved, reassigned, completed or foreign workspace events", async () => {
  for (const change of [
    { updatedAt: "2026-09-07T01:00:00Z" },
    { team: { id: "other" } },
    { assignee: { id: "other" } },
    { state: { type: "completed" } },
    { archivedAt: "date" },
    { org: "foreign" },
  ]) {
    const dir = mkdtempSync(join(tmpdir(), "linear-assignment-"));
    const store = new Store(dir);
    const query = vi.fn(async () => ({
      organization: { id: (change as any).org ?? "org" },
      issue: {
        ...payload.data,
        assignee: { id: "me" },
        team: { id: "team" },
        state: { type: "started" },
        ...change,
      },
    }));
    try {
      const a = new Assignments(
        cfg,
        store,
        { query, organizationId: () => "org" } as any,
        () => {},
      );
      a.enqueue(assignment(payload, cfg, "event")!);
      await a.tick();
      expect(query).toHaveBeenCalledTimes(1);
      expect(
        store.db.prepare("SELECT status FROM assignments").get()?.status,
      ).toBe("done");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
test("progress forwards details with redaction, ignores unrelated runs and deduplicates events", async () => {
  const content = vi.fn(async () => {});
  const link = vi.fn(async () => {});
  const p = new Progress({ content, link } as any, () => {});
  const e: any = { sessionId: "linear-session" };
  p.begin(
    e,
    "run",
    "session-key",
    "https://gateway.example.com/chat/agent/~key/linear/hash",
  );
  const event = {
    runId: "run",
    sessionKey: "session-key",
    stream: "tool",
    seq: 1,
    data: {
      phase: "start",
      name: "exec_command",
      toolCallId: "call",
      args: { token: "secret-value" },
    },
  };
  p.capture({ ...event, runId: "unrelated" });
  p.capture({ ...event, sessionKey: "other" });
  p.capture(event);
  p.capture(event);
  p.capture({
    ...event,
    seq: 2,
    data: {
      ...event.data,
      phase: "result",
      result: "private output",
      isError: false,
    },
  } as any);
  await p.finish("run", true);
  expect(link).toHaveBeenCalledOnce();
  const actions = content.mock.calls.filter((c: any) => c[2].type === "action");
  expect(actions).toHaveLength(2);
  expect(JSON.stringify(content.mock.calls)).not.toContain("secret-value");
  expect(JSON.stringify(content.mock.calls)).toContain("private output");
  expect((actions[1] as any)[2].result).toContain("执行完成");
  expect(
    toolActivity({
      phase: "start",
      name: "exec",
      hideFromChannelProgress: true,
    }),
  ).toBeNull();
});
test("commentary is ordered once before tools, final candidates and reasoning stay private", async () => {
  const calls: any[] = [];
  const p = new Progress(
    {
      link: async () => {},
      content: async (...args: any[]) => {
        calls.push(args[2]);
      },
    } as any,
    () => {},
  );
  p.begin({ sessionId: "linear" } as any, "run", "key", "https://example.com");
  const base = { runId: "run", sessionKey: "key", stream: "item" };
  p.capture({
    ...base,
    seq: 1,
    data: {
      kind: "preamble",
      itemId: "a",
      phase: "update",
      progressText: "我先",
    },
  });
  p.capture({
    ...base,
    seq: 2,
    data: {
      kind: "preamble",
      itemId: "a",
      phase: "end",
      progressText: "我先检查当前目录。",
    },
  });
  p.capture({
    ...base,
    seq: 3,
    data: { kind: "answer_candidate", progressText: "隐藏候选答案" },
  });
  p.capture({
    ...base,
    stream: "reasoning",
    seq: 4,
    data: { text: "隐藏推理" },
  });
  p.capture({
    ...base,
    stream: "tool",
    seq: 5,
    data: {
      phase: "start",
      toolCallId: "t",
      name: "bash",
      args: { command: "pwd", cwd: "/test" },
    },
  });
  p.capture({
    ...base,
    stream: "tool",
    seq: 6,
    data: {
      phase: "result",
      toolCallId: "t",
      name: "bash",
      result: { content: [{ type: "text", text: "/test" }] },
    },
  });
  await p.finish("run", true);
  expect(calls[0]).toEqual({ type: "thought", body: "我先检查当前目录。" });
  expect(calls[2]).toMatchObject({ type: "action", parameter: "pwd" });
  expect(calls[2].result).toContain('"cwd": "/test"');
  expect(calls[2].result).toContain("输出");
  expect(JSON.stringify(calls)).not.toMatch(/隐藏|我先"/);
  expect(calls.at(-1).body).toContain("调用了 1 个工具");
});
test("progress failure does not suppress subsequent events or final summary", async () => {
  const calls: any[] = [];
  const p = new Progress(
    {
      link: async () => {
        throw Error("offline");
      },
      content: async (...args: any[]) => {
        calls.push(args[2]);
      },
    } as any,
    () => {},
  );
  p.begin({ sessionId: "linear" } as any, "run", "key", "https://example.com");
  p.capture({
    runId: "run",
    stream: "tool",
    seq: 1,
    data: {
      phase: "result",
      name: "bash",
      args: { command: "echo ok", apiKey: "private-key" },
      result: "token=do-not-expose\nOK",
    },
  });
  await p.finish("run", false);
  expect(calls[0].result).toContain("OK");
  expect(JSON.stringify(calls)).not.toMatch(/private-key|do-not-expose/);
  expect(calls.at(-1).body).toContain("部分过程未能同步");
});
test("native output comes from exact run and tool identity, never a stale result", async () => {
  const content = vi.fn(async () => {});
  const read = vi.fn(async () => [
    {
      role: "toolResult",
      toolCallId: "call",
      __openclaw: { runId: "previous" },
      content: [{ type: "toolResult", text: "stale output" }],
    },
    {
      role: "toolResult",
      toolCallId: "call",
      __openclaw: { runId: "run" },
      content: [{ type: "toolResult", text: "/expected" }],
    },
  ]);
  const p = new Progress(
    { link: async () => {}, content } as any,
    () => {},
    read,
  );
  p.begin(
    { sessionId: "linear" } as any,
    "run",
    "session",
    "https://example.com",
  );
  p.capture({
    runId: "run",
    stream: "tool",
    seq: 1,
    data: {
      phase: "result",
      name: "bash",
      toolCallId: "call",
      result: { exitCode: 0 },
    },
  });
  await p.finish("run", true);
  expect(read).toHaveBeenCalledWith("session");
  const output = JSON.stringify(content.mock.calls);
  expect(output).toContain("/expected");
  expect(output).not.toContain("stale output");
});
