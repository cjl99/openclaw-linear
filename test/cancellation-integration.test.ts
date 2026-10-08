import { test, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { createHmac } from "node:crypto";
import { register } from "../src/index.js";
import { Linear } from "../src/linear.js";
import { Store } from "../src/store.js";

test.each(["running", "acceptance"])(
  "signed stop during %s reaches host cancellation or prevents submission, without registering tools",
  async (phase) => {
    const delayAcceptance = phase === "acceptance";
    const dir = mkdtempSync(join(tmpdir(), "linear-cancel-integration-"));
    const credentialsFile = join(dir, "fake-credentials.json");
    writeFileSync(
      credentialsFile,
      JSON.stringify({
        clientId: "client",
        clientSecret: "fake",
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
    let accept!: () => void;
    const acceptance = new Promise<void>((resolve) => {
      accept = resolve;
    });
    let ended = false;
    let resolveWait: ((value: any) => void) | undefined;
    const terminal = () => ({ status: "error", endedAt: Date.now() });
    const run = vi.fn(async () => {
      if (delayAcceptance) await acceptance;
      return { runId: "host-run" };
    });
    const wait = vi.fn(async () =>
      ended
        ? terminal()
        : new Promise<any>((resolve) => {
            resolveWait = resolve;
          }),
    );
    const request = vi.fn(async (method: string) => {
      if (method === "health") return {};
      ended = true;
      resolveWait?.(terminal());
      return { aborted: true, runIds: ["host-run"] };
    });
    const registerTool = vi.fn();
    const api: any = {
      pluginConfig: {
        agentId: "agent",
        organizationId: "org",
        teamIds: ["team"],
        stateDir: join(dir, "state"),
        credentialsFile,
        publicOrigin: "https://gateway.example.com",
      },
      logger: { warn: vi.fn() },
      registerTool,
      registerAgentEventSubscription: vi.fn(),
      registerService: (s: any) => {
        service = s;
      },
      registerHttpRoute: (r: any) => routes.push(r),
      runtime: {
        config: { current: () => ({}) },
        agent: { resolveAgentTimeoutMs: () => 30000 },
        gateway: { request },
        subagent: { run, waitForRun: wait },
      },
    };
    let inspection: Store | undefined;
    try {
      register(api);
      await service.start();
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith("health", {}, { timeoutMs: 1000 }),
      );
      request.mockClear();
      inspection = new Store(join(dir, "state"));
      const route = routes.find((r) => r.path === "/linear/webhook");
      async function send(stop: boolean) {
        const raw = JSON.stringify({
          type: "AgentSessionEvent",
          action: stop ? "prompted" : "created",
          organizationId: "org",
          webhookTimestamp: Date.now(),
          agentSession: { id: "session", issue: { id: "issue" } },
          promptContext: "test",
          ...(stop
            ? {
                agentActivity: {
                  id: "stop-activity",
                  signal: "stop",
                  content: { type: "prompt", body: "" },
                },
              }
            : {}),
        });
        const req: any = Readable.from([Buffer.from(raw)]);
        req.method = "POST";
        req.headers = {
          "linear-delivery": stop ? "stop" : "created",
          "linear-signature": createHmac("sha256", "hook")
            .update(raw)
            .digest("hex"),
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
      expect(await send(false)).toBe(200);
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
      expect(registerTool).not.toHaveBeenCalled();
      expect((run.mock.calls[0] as any)[0].toolsAlsoAllow).toBeUndefined();
      expect(await send(true)).toBe(200);
      if (delayAcceptance) {
        expect(request).not.toHaveBeenCalled();
        accept();
      }
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      expect(request.mock.calls[0]).toEqual([
        "chat.abort",
        {
          sessionKey: expect.stringMatching(/^agent:agent:linear:/),
          runId: "host-run",
        },
        { timeoutMs: 10000 },
      ]);
      await vi.waitFor(() =>
        expect(inspection!.get("blocked:session")).toBe(false),
      );
      expect(inspection.get("active:session")).toBeUndefined();
      expect(run).toHaveBeenCalledOnce();
      expect(await send(true)).toBe(200);
      expect(request).toHaveBeenCalledOnce();
    } finally {
      accept();
      ended = true;
      resolveWait?.(terminal());
      await service?.stop();
      inspection?.close();
      auth.mockRestore();
      activity.mockRestore();
      content.mockRestore();
      link.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
