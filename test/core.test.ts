import { test, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { verify, normalize } from "../src/webhook.js";
import { Store, type Event } from "../src/store.js";
import { Worker } from "../src/worker.js";
import { authorizationUrl, callback } from "../src/oauth.js";
const c = {
  agentId: "agent",
  organizationId: "test-org",
  teamIds: ["test-team"],
  publicOrigin: "https://gateway.example.com",
  stateDir: "/tmp/not-used",
  credentialsFile: "/tmp/not-used",
};
const e: Event = {
  id: "delivery-1",
  organizationId: "test-org",
  sessionId: "session-1",
  issueId: "issue-1",
  prompt: "hello",
  action: "created",
};
async function withStore(fn: (s: Store, dir: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "linear-test-"));
  const s = new Store(dir);
  try {
    await fn(s, dir);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
test("signature validates raw bytes and rejects missing, altered and malformed values", () => {
  const raw = Buffer.from('{"a":1}');
  const sig = createHmac("sha256", "secret").update(raw).digest("hex");
  expect(verify(raw, sig, "secret")).toBe(true);
  expect(verify(raw, undefined, "secret")).toBe(false);
  expect(verify(raw, "a", "secret")).toBe(false);
  expect(verify(Buffer.from('{ "a":1}'), sig, "secret")).toBe(false);
});
test("timestamp, organization and activity routing fail closed", () => {
  const p = {
    type: "AgentSessionEvent",
    action: "created",
    organizationId: "test-org",
    webhookTimestamp: 100000,
    agentSession: { id: "s", issue: { id: "i" } },
    promptContext: "hello",
  };
  expect(normalize(p, c, "d", 100000)?.prompt).toBe("hello");
  expect(() =>
    normalize({ ...p, organizationId: "work-org" }, c, "d", 100000),
  ).toThrow();
  expect(() => normalize(p, c, "d", 200000)).toThrow();
  expect(
    normalize(
      {
        ...p,
        action: "prompted",
        agentActivity: { content: { type: "response", body: "echo" } },
      },
      c,
      "d",
      100000,
    ),
  ).toBeNull();
});
test("inbox deduplicates and survives restart without repeating uncertain execution", () =>
  withStore((s, dir) => {
    expect(s.enqueue(e)).toBe(true);
    expect(s.enqueue(e)).toBe(false);
    s.running(e.id);
    const second = new Store(dir);
    second.recover();
    expect(second.next()?.status).toBe("outbox");
    expect(second.next()?.outputType).toBe("error");
    second.close();
  }));
test("failed delivery retries result without rerunning agent; followup preserves session", () =>
  withStore(async (s) => {
    s.enqueue(e);
    const run = vi.fn().mockResolvedValue("answer");
    let fail = false;
    const activity = vi.fn(async () => {
      if (fail) throw Error("offline");
    });
    const delivery = {
      authorizeEvent: vi.fn().mockResolvedValue(true),
      activity,
    };
    const w = new Worker(s, delivery, run, () => {});
    await w.tick();
    expect(run).toHaveBeenCalledTimes(1);
    fail = true;
    await w.tick();
    expect(s.next()).toBeUndefined();
    s.enqueue({ ...e, id: "followup", prompt: "next" });
    expect(s.next()).toBeUndefined();
    fail = false;
    s.db.exec("UPDATE jobs SET nextAt=0");
    await w.tick();
    await w.tick();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][1]).toBe(run.mock.calls[1][1]);
  }));
test("team/session authorization denial cannot invoke agent or emit activities", () =>
  withStore(async (s) => {
    s.enqueue(e);
    const run = vi.fn();
    const activity = vi.fn();
    await new Worker(
      s,
      { authorizeEvent: async () => false, activity },
      run,
      () => {},
    ).tick();
    expect(run).not.toHaveBeenCalled();
    expect(activity).not.toHaveBeenCalled();
    expect(s.next()).toBeUndefined();
  }));
test("OAuth state expires, is single use, and callback does not trust request host", () =>
  withStore(async (s) => {
    const auth = new URL(
      authorizationUrl(
        c,
        { clientId: "client", clientSecret: "secret", webhookSecret: "hook" },
        s,
      ),
    );
    expect(auth.searchParams.get("actor")).toBe("app");
    const exchange = vi.fn().mockResolvedValue({});
    const install = vi.fn();
    const linear = { exchange, install } as any;
    const u = new URL("https://evil.invalid/linear/oauth/callback");
    u.searchParams.set("state", auth.searchParams.get("state")!);
    u.searchParams.set("code", "code");
    await callback(u, c, s, linear);
    expect(exchange.mock.calls[0][0].redirect_uri).toBe(
      "https://gateway.example.com/linear/oauth/callback",
    );
    await expect(callback(u, c, s, linear)).rejects.toThrow();
    expect(exchange).toHaveBeenCalledTimes(1);
  }));
