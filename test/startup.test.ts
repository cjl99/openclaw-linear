import { test, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "../src/index.js";
import { Store } from "../src/store.js";

test("service.start returns with 17 stale runs while Gateway readiness is unresolved", async () => {
  const dir = mkdtempSync(join(tmpdir(), "linear-startup-"));
  const stateDir = join(dir, "state");
  const credentialsFile = join(dir, "fake.json");
  writeFileSync(credentialsFile, JSON.stringify({
    clientId: "fake", clientSecret: "fake", webhookSecret: "fake",
  }), { mode: 0o600 });
  const store = new Store(stateDir);
  for (let i = 0; i < 17; i++) store.set(`active:session-${i}`, {
    event: { sessionId: `session-${i}` },
    sessionKey: `agent:test:linear:${i}`,
    runId: `stale-${i}`,
  });
  let service: any;
  const request = vi.fn(() => new Promise(() => {}));
  const wait = vi.fn();
  const run = vi.fn();
  register({
    pluginConfig: { agentId: "test", organizationId: "org", teamIds: ["team"],
      stateDir, credentialsFile, publicOrigin: "https://gateway.example.com" },
    logger: { warn: vi.fn() },
    registerService: (s: any) => { service = s; },
    registerAgentEventSubscription: vi.fn(), registerHttpRoute: vi.fn(),
    runtime: { gateway: { request }, subagent: { run, waitForRun: wait } },
  } as any);
  try {
    await Promise.race([
      service.start(),
      new Promise((_, reject) => setTimeout(() => reject(Error("startup blocked")), 100)),
    ]);
    expect(wait).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    for (let i = 0; i < 17; i++) expect(store.get(`blocked:session-${i}`)).toBe(true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith("health", {}, { timeoutMs: 1000 });
    await Promise.race([
      service.stop(),
      new Promise((_, reject) => setTimeout(() => reject(Error("stop blocked")), 100)),
    ]);
    expect(store.db.prepare("SELECT count(*) AS n FROM kv WHERE key LIKE 'active:%'").get()?.n).toBe(17);
  } finally {
    await service?.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
