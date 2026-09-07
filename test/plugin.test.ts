import { test, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { createHmac } from "node:crypto";
import { register } from "../src/index.js";
import { Linear } from "../src/linear.js";
test("Gateway route rejects unsigned requests and dispatches signed session through configured harness", async () => {
  const dir = mkdtempSync(join(tmpdir(), "linear-plugin-"));
  const file = join(dir, "secret.json");
  writeFileSync(
    file,
    JSON.stringify({
      clientId: "test",
      clientSecret: "secret",
      webhookSecret: "hook",
    }),
    { mode: 0o600 },
  );
  const auth = vi
    .spyOn(Linear.prototype, "authorizeEvent")
    .mockResolvedValue(true);
  const activity = vi.spyOn(Linear.prototype, "activity").mockResolvedValue();
  const content = vi.spyOn(Linear.prototype, "content").mockResolvedValue();
  const link = vi.spyOn(Linear.prototype, "link").mockResolvedValue();
  let service: any;
  const routes: any[] = [];
  const run = vi.fn(async (_params: any) => ({
    runId: "host-run",
    runtime: { harness: "codex", provider: "openai", model: "gpt-5.6-sol" },
  }));
  const cfg = {
    agents: {
      defaults: { runtime: "codex", model: { primary: "openai/gpt-5.6-sol" } },
    },
  };
  const api: any = {
    pluginConfig: {
      agentId: "agent",
      organizationId: "org",
      teamIds: ["team"],
      stateDir: join(dir, "state"),
      credentialsFile: file,
      publicOrigin: "https://gateway.example.com",
    },
    logger: { warn: vi.fn() },
    registerAgentEventSubscription: vi.fn(),
    registerService: (s: any) => {
      service = s;
    },
    registerHttpRoute: (r: any) => routes.push(r),
    runtime: {
      config: { current: () => cfg },
      subagent: {
        run,
        getSessionMessages: vi.fn(async () => ({
          messages: [{ role: "assistant", content: "hello from codex" }],
        })),
        waitForRun: vi.fn(async () => ({
          status: "ok",
          terminalReply: { disposition: "visible", text: "hello from codex" },
        })),
      },
      agent: {
        resolveAgentWorkspaceDir: () => dir,
        resolveAgentTimeoutMs: () => 30000,
      },
    },
  };
  try {
    register(api);
    await service.start();
    const route = routes.find((r) => r.path === "/linear/webhook");
    expect(route.auth).toBe("plugin");
    const p = JSON.stringify({
      type: "AgentSessionEvent",
      action: "created",
      organizationId: "org",
      webhookTimestamp: Date.now(),
      agentSession: { id: "session", issue: { id: "issue" } },
      promptContext: "test",
    });
    async function send(signed: boolean, followup = false) {
      const payload = followup
        ? JSON.stringify({
            ...JSON.parse(p),
            action: "prompted",
            agentActivity: {
              id: "followup",
              content: { type: "prompt", body: "你读到什么了" },
            },
          })
        : p;
      const req = Readable.from([Buffer.from(payload)]) as any;
      req.method = "POST";
      req.headers = {
        "linear-delivery": followup ? "followup-delivery" : "delivery",
        ...(signed
          ? {
              "linear-signature": createHmac("sha256", "hook")
                .update(payload)
                .digest("hex"),
            }
          : {}),
      };
      let code = 0;
      const res: any = {
        writeHead(n: number) {
          code = n;
          return this;
        },
        end() {
          return this;
        },
      };
      await route.handler(req, res);
      return code;
    }
    expect(await send(false)).toBe(401);
    expect(run).not.toHaveBeenCalled();
    expect(await send(true)).toBe(200);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const params = run.mock.calls[0][0] as any;
    expect(params.message).toBe("test");
    expect(params.provider).toBeUndefined();
    expect(params.model).toBeUndefined();
    expect(params.deliver).toBe(false);
    expect(params.sessionKey).toMatch(/^agent:agent:linear:/);
    expect(params.agentHarnessRuntimeOverride).toBeUndefined();
    expect(await send(true)).toBe(200);
    expect(run).toHaveBeenCalledOnce();
    expect(await send(true, true)).toBe(200);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[1][0].message).toBe("你读到什么了");
    expect(run.mock.calls[1][0].sessionKey).toBe(params.sessionKey);
    expect(JSON.stringify(content.mock.calls)).not.toContain("本轮上下文");
  } finally {
    await service?.stop();
    auth.mockRestore();
    activity.mockRestore();
    content.mockRestore();
    link.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
