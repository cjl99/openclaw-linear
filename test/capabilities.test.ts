import { test, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Event } from "../src/store.js";
import { Worker } from "../src/worker.js";
import { Linear } from "../src/linear.js";
import { normalize } from "../src/webhook.js";
import { controls } from "../src/controls.js";
import { cancelRun } from "../src/cancel.js";
import { recoverPrompt, guidancePrompt } from "../src/context.js";
import { Progress } from "../src/progress.js";

const config = {
  agentId: "agent",
  organizationId: "org",
  teamIds: ["team"],
  publicOrigin: "https://gateway.example.com",
  stateDir: "/unused",
  credentialsFile: "/unused",
};
const e: Event = {
  id: "event",
  organizationId: "org",
  sessionId: "session",
  issueId: "issue",
  prompt: "hello",
  action: "created",
};
const secret = {
  clientId: "client",
  clientSecret: "fake",
  webhookSecret: "fake",
};
async function fixture(fn: (s: Store, l: Linear) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "linear-capabilities-"));
  const s = new Store(dir);
  s.set("token", {
    appUserId: "bot",
    accessToken: "fake",
    refreshToken: "fake",
    expiresAt: Date.now() + 3600000,
  });
  const l = new Linear(config, secret, s, vi.fn() as any);
  try {
    await fn(s, l);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
const payload = {
  type: "AgentSessionEvent",
  action: "prompted",
  organizationId: "org",
  webhookTimestamp: Date.now(),
  agentSession: { id: "session", issue: { id: "issue" } },
};
test("stop is a prompted signal, accepts an empty body, and is never sent to the model", () => {
  const result = normalize(
    {
      ...payload,
      agentActivity: {
        id: "activity",
        signal: "stop",
        content: { type: "prompt" },
      },
    },
    config,
    "delivery",
  );
  expect(result).toMatchObject({
    action: "stop",
    prompt: "",
    signal: "stop",
    activityId: "activity",
  });
});
test("guidance and ordinary selections survive normalization", () => {
  const result = normalize(
    {
      ...payload,
      guidance: [{ prompt: "Use isolated checkout" }],
      agentActivity: { content: { type: "prompt", body: "backend" } },
    },
    config,
    "delivery",
  )!;
  expect(result.prompt).toBe("backend");
  expect(guidancePrompt(result)).toContain("Use isolated checkout");
});
test("business-event identity deduplicates redelivery even when delivery headers differ", () => {
  const p = {
    ...payload,
    agentActivity: {
      id: "same-activity",
      content: { type: "prompt", body: "hello" },
    },
  };
  expect(normalize(p, config, "delivery-one")?.id).toBe(
    normalize(p, config, "delivery-two")?.id,
  );
  const created = { ...payload, action: "created", promptContext: "hello" };
  expect(normalize(created, config, "delivery-one")?.id).toBe(
    normalize(created, config, "delivery-two")?.id,
  );
});
test("late acknowledgements are suppressed after a stop and replayed stops cannot cancel new prompts", () =>
  fixture(async (s) => {
    s.enqueue(e);
    let authorize!: (value: boolean) => void;
    const activity = vi.fn();
    const w = new Worker(
      s,
      {
        authorizeEvent: () =>
          new Promise((r) => {
            authorize = r;
          }),
        activity,
      },
      vi.fn(),
      () => {},
    );
    const receipt = w.acknowledge(e);
    const stop = { ...e, id: "stop", action: "stop" };
    w.requestStop(stop);
    s.enqueue({ ...e, id: "later", action: "prompted" });
    w.requestStop(stop);
    authorize(true);
    await receipt;
    expect(activity).not.toHaveBeenCalled();
    expect(s.suppressed("later")).toBe(false);
  }));
test("permission transitions sharing one subscription are not mistaken for duplicate deliveries", () =>
  fixture((s) => {
    const p = {
      type: "PermissionChange",
      action: "teamAccessChanged",
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "bot",
      webhookId: "same-subscription",
      createdAt: "2026-09-07T01:00:00Z",
      removedTeamIds: ["team"],
      addedTeamIds: [],
    };
    controls(p, config, "client", s, vi.fn());
    controls(
      {
        ...p,
        createdAt: "2026-09-07T02:00:00Z",
        removedTeamIds: [],
        addedTeamIds: ["team"],
      },
      config,
      "client",
      s,
      vi.fn(),
    );
    expect(s.get<any>("team-permission:team").denied).toBe(false);
  }));
test("cancel uses exact host run and session, and never invents success after an RPC failure", async () => {
  const request = vi.fn().mockResolvedValue({ aborted: true, runIds: ["run"] });
  const wait = vi.fn().mockResolvedValue({ status: "timeout" });
  expect(await cancelRun(request, wait, "key", "run")).toBe(true);
  expect(request).toHaveBeenCalledWith(
    "chat.abort",
    { sessionKey: "key", runId: "run" },
    { timeoutMs: 10000 },
  );
  request.mockResolvedValue({ aborted: true, runIds: ["other"] });
  expect(await cancelRun(request, wait, "key", "run")).toBe(false);
  request.mockRejectedValue(Error("denied"));
  expect(await cancelRun(request, wait, "key", "run")).toBe(false);
});
test("an authoritative missing run clears stale restart blocks", async () => {
  const request = vi.fn().mockResolvedValue({ aborted: false, runIds: [] });
  const wait = vi.fn().mockRejectedValue(Error("run is no longer tracked"));
  expect(await cancelRun(request, wait, "key", "run")).toBe(true);
  expect(wait).not.toHaveBeenCalled();
});
test("a confirmed abort is not lost when terminal history is unavailable", async () => {
  const request = vi.fn().mockResolvedValue({ aborted: true, runIds: ["run"] });
  const wait = vi.fn().mockRejectedValue(Error("history unavailable"));
  expect(await cancelRun(request, wait, "key", "run")).toBe(true);
  expect(wait).not.toHaveBeenCalled();
});
test("already-terminal run is confirmed even when abort races completion", async () => {
  expect(
    await cancelRun(
      async () => ({ aborted: false }),
      async () => ({ status: "ok" }),
      "key",
      "run",
    ),
  ).toBe(true);
});
test("stop bypasses running work and cancels old queued prompts, not subsequent requests", () =>
  fixture(async (s) => {
    s.enqueue(e);
    s.enqueue({ ...e, id: "old-followup", action: "prompted" });
    let signal: AbortSignal | undefined;
    const run = vi.fn(
      (_e, _s, _r, a: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          signal = a;
          a.addEventListener("abort", () => reject(Error("aborted")));
        }),
    );
    const delivery = { authorizeEvent: async () => true, activity: vi.fn() };
    const w = new Worker(s, delivery, run, () => {});
    const active = w.tick();
    await vi.waitFor(() => expect(signal).toBeDefined());
    w.requestStop({ ...e, id: "stop", action: "stop" });
    expect(signal!.aborted).toBe(true);
    s.enqueue({ ...e, id: "new-followup", action: "prompted" });
    await active;
    expect(
      s.db.prepare("SELECT status FROM jobs WHERE id='old-followup'").get()
        ?.status,
    ).toBe("done");
    await w.tick();
    await w.tick();
    await w.tick();
    expect(run).toHaveBeenCalledTimes(1);
    expect(delivery.activity).toHaveBeenLastCalledWith(
      "session",
      expect.any(String),
      "response",
      expect.stringContaining("was stopped"),
    );
    run.mockResolvedValue("continued");
    await w.tick();
    expect(run).toHaveBeenCalledTimes(2);
  }));
test("stop received during async authorization prevents stale selected job from starting", () =>
  fixture(async (s) => {
    s.enqueue(e);
    let authorize!: (v: boolean) => void;
    const run = vi.fn();
    const w = new Worker(
      s,
      {
        authorizeEvent: () =>
          new Promise((r) => {
            authorize = r;
          }),
        activity: vi.fn(),
      },
      run,
      () => {},
    );
    const tick = w.tick();
    w.requestStop({ ...e, id: "stop", action: "stop" });
    authorize(true);
    await tick;
    expect(run).not.toHaveBeenCalled();
  }));
test("uncertain restart blocks future execution until a confirmed stored-run cancellation", () =>
  fixture(async (s) => {
    s.enqueue(e);
    s.running(e.id);
    s.recover();
    s.enqueue({ ...e, id: "next" });
    const run = vi.fn();
    let cancellationAttempts = 0;
    const w = new Worker(
      s,
      { authorizeEvent: async () => true, activity: vi.fn() },
      run,
      () => {},
      async () => {
        cancellationAttempts += 1;
        if (cancellationAttempts > 1) s.set("blocked:session", false);
      },
    );
    await w.tick();
    await w.tick();
    expect(run).not.toHaveBeenCalled();
    w.requestStop({ ...e, id: "stop", action: "stop" });
    await w.tick();
    expect(s.get("blocked:session")).toBe(false);
  }));
test("retry rechecks a stale restart block and runs after the old run is gone", () =>
  fixture(async (s) => {
    s.set("blocked:session", true);
    s.enqueue({ ...e, id: "retry", action: "prompted" });
    const run = vi.fn().mockResolvedValue("continued");
    const cancelStored = vi.fn(async () => {
      s.set("blocked:session", false);
    });
    const w = new Worker(
      s,
      { authorizeEvent: async () => true, activity: vi.fn() },
      run,
      () => {},
      cancelStored,
    );
    await w.tick();
    expect(cancelStored).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    expect(
      s.db.prepare("SELECT output FROM jobs WHERE id='retry'").get()?.output,
    ).toBe("continued");
  }));
test("OAuth revocation is identity-bound, durable, deduplicated, and blocks token refresh", () =>
  fixture(async (s, l) => {
    s.set("binding:session", e);
    const stop = vi.fn();
    const p = {
      type: "OAuthApp",
      action: "revoked",
      organizationId: "org",
      oauthClientId: "client",
      webhookId: "revoke",
    };
    expect(() =>
      controls({ ...p, oauthClientId: "other" }, config, "client", s, stop),
    ).toThrow();
    expect(s.get("revoked")).toBeUndefined();
    controls(p, config, "client", s, stop);
    controls(p, config, "client", s, stop);
    expect(stop).toHaveBeenCalledOnce();
    await expect(l.token()).rejects.toThrow("revoked");
  }));
test("team removal cancels only matching sessions; late additions cannot restore access", () =>
  fixture((s) => {
    s.set("binding:session", e);
    s.set("team:session", "team");
    s.set("binding:other", { ...e, sessionId: "other" });
    s.set("team:other", "other-team");
    const stop = vi.fn();
    const p = {
      type: "PermissionChange",
      action: "teamAccessChanged",
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "bot",
      webhookId: "permission",
      createdAt: "2026-09-07T01:00:00Z",
      removedTeamIds: ["team"],
      addedTeamIds: [],
    };
    controls(p, config, "client", s, stop);
    expect(stop).toHaveBeenCalledOnce();
    expect(stop.mock.calls[0][0].sessionId).toBe("session");
    controls(
      {
        ...p,
        webhookId: "old",
        createdAt: "2026-09-06T01:00:00Z",
        removedTeamIds: [],
        addedTeamIds: ["team"],
      },
      config,
      "client",
      s,
      stop,
    );
    expect(s.get<any>("team-permission:team").denied).toBe(true);
  }));
test("notifications do not start work; unassignment stops only the affected issue", () =>
  fixture((s) => {
    s.set("binding:session", e);
    const stop = vi.fn();
    const p = {
      type: "AppUserNotification",
      action: "issueCommentReaction",
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "bot",
      notification: { id: "notice", issueId: "issue" },
    };
    controls(p, config, "client", s, stop);
    expect(stop).not.toHaveBeenCalled();
    controls(
      { ...p, action: "issueUnassignedFromYou" },
      config,
      "client",
      s,
      stop,
    );
    expect(stop).toHaveBeenCalledOnce();
    expect(s.next()).toBeUndefined();
  }));
test("proactive issue creation authorizes team and reuses a successful request key", () =>
  fixture(async (s, l) => {
    const query = vi
      .spyOn(l, "query")
      .mockResolvedValueOnce({
        organization: { id: "org" },
        issue: { id: "issue", team: { id: "team" } },
      })
      .mockResolvedValueOnce({
        agentSessionCreateOnIssue: {
          success: true,
          agentSession: { id: "new" },
        },
      });
    expect(await l.createSession("issue", "MAR-1", "key")).toEqual({
      sessionId: "new",
      issueId: "issue",
    });
    expect(await l.createSession("issue", "MAR-1", "key")).toEqual({
      sessionId: "new",
      issueId: "issue",
    });
    expect(query).toHaveBeenCalledTimes(2);
    await expect(l.createSession("issue", "MAR-2", "key")).rejects.toThrow(
      "different target",
    );
  }));
test("uncertain proactive mutation is never repeated automatically", () =>
  fixture(async (s, l) => {
    const query = vi
      .spyOn(l, "query")
      .mockResolvedValueOnce({
        organization: { id: "org" },
        issue: { id: "issue", team: { id: "team" } },
      })
      .mockRejectedValueOnce(Error("lost response"));
    await expect(l.createSession("issue", "issue", "key")).rejects.toThrow();
    await expect(l.createSession("issue", "issue", "key")).rejects.toThrow(
      "outcome unknown",
    );
    expect(query).toHaveBeenCalledTimes(2);
  }));
test("comment creation verifies its issue belongs to an allowed team", () =>
  fixture(async (s, l) => {
    const query = vi.spyOn(l, "query").mockResolvedValue({
      organization: { id: "org" },
      comment: { issue: { id: "issue", team: { id: "forbidden" } } },
    });
    await expect(l.createSession("comment", "comment", "key")).rejects.toThrow(
      "outside",
    );
    expect(query).toHaveBeenCalledOnce();
    expect(s.get("proactive:key")).toBeUndefined();
  }));
test("structured activity signal fields are siblings of content, not nested in it", () =>
  fixture(async (s, l) => {
    const query = vi
      .spyOn(l, "query")
      .mockResolvedValueOnce({ agentSession: { activities: { nodes: [] } } })
      .mockResolvedValueOnce({ agentActivityCreate: { success: true } });
    const final = {
      content: { type: "elicitation", body: "Pick" },
      signal: "select",
      signalMetadata: { options: [{ label: "A", value: "a" }] },
    };
    await l.content("session", "id", final.content, false, 15000, final);
    expect(query.mock.calls[1][1]).toMatchObject({
      input: {
        content: { type: "elicitation", body: "Pick" },
        signal: "select",
        signalMetadata: { options: [{ label: "A", value: "a" }] },
      },
    });
    await l.content("session", "id", final.content, false, 15000, final);
    expect(query).toHaveBeenCalledTimes(2);
  }));
test("uncertain activity retries search beyond the last 100 records before creating", () =>
  fixture(async (s, l) => {
    s.set("activity:session:id", "pending");
    const query = vi
      .spyOn(l, "query")
      .mockResolvedValueOnce({
        agentSession: {
          activities: {
            nodes: [],
            pageInfo: { hasPreviousPage: true, startCursor: "older" },
          },
        },
      })
      .mockResolvedValueOnce({
        agentSession: {
          activities: {
            nodes: [{ id: "id" }],
            pageInfo: { hasPreviousPage: false },
          },
        },
      });
    await l.content("session", "id", { type: "response", body: "answer" });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][1]).toEqual({ id: "session", before: "older" });
  }));
test("history recovery paginates immutable activities and excludes the current prompt", async () => {
  const history = vi
    .fn()
    .mockResolvedValueOnce({
      agentSession: {
        activities: {
          nodes: [{ id: "old", content: { type: "response", body: "done" } }],
          pageInfo: { hasNextPage: true, endCursor: "next" },
        },
      },
    })
    .mockResolvedValueOnce({
      agentSession: {
        activities: {
          nodes: [{ id: "current", content: { body: "hello" } }],
          pageInfo: { hasNextPage: false },
        },
      },
    });
  const prompt = await recoverPrompt(
    { ...e, activityId: "current" },
    { history },
    new AbortController().signal,
  );
  expect(history.mock.calls[1][1]).toBe("next");
  expect(prompt).toContain("done");
  expect(prompt).not.toContain('"id":"current"');
  expect(prompt).toContain("do not re-execute");
});
test("history recovery fails explicitly on cursor loops and never silently drops context", async () => {
  const history = vi.fn().mockResolvedValue({
    agentSession: {
      activities: {
        nodes: [],
        pageInfo: { hasNextPage: true, endCursor: "same" },
      },
    },
  });
  await expect(
    recoverPrompt(e, { history }, new AbortController().signal),
  ).rejects.toThrow("cursor");
});
test("muting a stopped run drops queued progress and the final progress summary", () =>
  fixture(async (s, l) => {
    const link = vi.spyOn(l, "link").mockResolvedValue();
    const content = vi.spyOn(l, "content").mockResolvedValue();
    const progress = new Progress(l, () => {});
    progress.begin(e, "run", "key", "https://gateway.example.com/chat");
    progress.capture({
      runId: "run",
      stream: "tool",
      seq: 1,
      data: {
        sessionKey: "key",
        name: "exec",
        phase: "start",
        toolCallId: "call",
        args: { cmd: "test" },
      },
    });
    progress.mute("run");
    await progress.finish("run", false);
    expect(link).not.toHaveBeenCalled();
    expect(content).not.toHaveBeenCalled();
  }));
test("comment sessions use the official comment mutation and validated issue identity", () =>
  fixture(async (s, l) => {
    const query = vi
      .spyOn(l, "query")
      .mockResolvedValueOnce({
        organization: { id: "org" },
        comment: { issue: { id: "issue", team: { id: "team" } } },
      })
      .mockResolvedValueOnce({
        agentSessionCreateOnComment: {
          success: true,
          agentSession: { id: "new" },
        },
      });
    expect(await l.createSession("comment", "comment", "key")).toEqual({
      sessionId: "new",
      issueId: "issue",
    });
    expect(query.mock.calls[1][0]).toContain("AgentSessionCreateOnComment!");
    expect(query.mock.calls[1][1]).toEqual({ input: { commentId: "comment" } });
  }));
test("concurrent proactive requests with one key issue at most one mutation", () =>
  fixture(async (s, l) => {
    let mutations = 0;
    vi.spyOn(l, "query").mockImplementation(async (query) => {
      if (query.startsWith("query"))
        return {
          organization: { id: "org" },
          issue: { id: "issue", team: { id: "team" } },
        } as any;
      mutations++;
      return {
        agentSessionCreateOnIssue: {
          success: true,
          agentSession: { id: "new" },
        },
      } as any;
    });
    const results = await Promise.allSettled([
      l.createSession("issue", "issue", "key"),
      l.createSession("issue", "issue", "key"),
    ]);
    expect(mutations).toBe(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  }));
test("session update API sends full plan and additive links and rejects unsuccessful mutations", () =>
  fixture(async (s, l) => {
    const query = vi
      .spyOn(l, "query")
      .mockResolvedValueOnce({ agentSessionUpdate: { success: true } })
      .mockResolvedValueOnce({ agentSessionUpdate: { success: false } });
    const input = {
      plan: [{ content: "Check", status: "completed" }],
      addedExternalUrls: [
        { label: "PR", url: "https://github.com/example/repo/pull/1" },
      ],
    };
    await l.updateSession("session", input);
    expect(query.mock.calls[0][1]).toEqual({ id: "session", input });
    await expect(l.updateSession("session", input)).rejects.toThrow("rejected");
  }));
test("repository suggestion API is bound to authorized session and supplied candidates", () =>
  fixture(async (s, l) => {
    const authorize = vi.spyOn(l, "authorizeEvent").mockResolvedValue(true);
    const query = vi
      .spyOn(l, "query")
      .mockResolvedValue({ issueRepositorySuggestions: { suggestions: [] } });
    const candidates = [
      { hostname: "github.com", repositoryFullName: "example/repo" },
    ];
    await l.repositories(e, candidates);
    expect(query.mock.calls[0][1]).toEqual({
      issue: "issue",
      session: "session",
      candidates,
    });
    authorize.mockResolvedValue(false);
    await expect(l.repositories(e, candidates)).rejects.toThrow("authorized");
    expect(query).toHaveBeenCalledOnce();
  }));
