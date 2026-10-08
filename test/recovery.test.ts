import { test, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Event } from "../src/store.js";
import { StartupRecovery, type ActiveBinding } from "../src/recovery.js";

const event: Event = {
  id: "event", organizationId: "org", sessionId: "session",
  issueId: "issue", prompt: "test", action: "created",
};
function binding(i = 0): ActiveBinding {
  return {
    event: { ...event, sessionId: `session-${i}` },
    sessionKey: `agent:test:linear:session-${i}`,
    runId: `old-run-${i}`,
  };
}
async function fixture(test: (store: Store, add: (i: number) => ActiveBinding) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "linear-recovery-"));
  const store = new Store(dir);
  try {
    await test(store, (i) => {
      const b = binding(i);
      store.set(`active:${b.event.sessionId}`, b);
      return b;
    });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("17 old runs do not block start; recovery waits for Gateway readiness and bounds concurrency", () =>
  fixture(async (store, add) => {
    for (let i = 0; i < 17; i++) add(i);
    let ready!: () => void;
    const readiness = new Promise<void>((resolve) => { ready = resolve; });
    let active = 0;
    let maximum = 0;
    const cancel = vi.fn(async () => {
      maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return true;
    });
    const onReady = vi.fn();
    const recovery = new StartupRecovery(store, () => readiness, cancel, onReady, () => {});
    try {
      recovery.start();
      expect(store.get("blocked:session-0")).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(cancel).not.toHaveBeenCalled();
      expect(onReady).not.toHaveBeenCalled();
      ready();
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(17));
      await vi.waitFor(() => expect(store.get("active:session-16")).toBeUndefined());
      expect(maximum).toBe(4);
      expect(onReady).toHaveBeenCalledOnce();
      expect(store.get("blocked:session-0")).toBe(false);
      expect(store.get<any>("recovery:session-0").status).toBe("confirmed");
    } finally { await recovery.stop(); }
  }));

test("unconfirmed runs stay blocked and persisted backoff survives service restart", () =>
  fixture(async (store, add) => {
    add(0);
    const cancel = vi.fn(async () => false);
    const first = new StartupRecovery(store, async () => {}, cancel, () => {}, () => {});
    first.start();
    try {
      await vi.waitFor(() => expect(store.get<any>("recovery:session-0")?.status).toBe("unconfirmed"));
      expect(store.get("active:session-0")).toBeDefined();
      expect(store.get("blocked:session-0")).toBe(true);
      expect(store.get<any>("recovery:session-0").nextAttemptAt).toBeGreaterThan(Date.now());
    } finally { await first.stop(); }
    const second = new StartupRecovery(store, async () => {}, cancel, () => {}, () => {});
    try {
      second.start();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(cancel).toHaveBeenCalledOnce();
    } finally { await second.stop(); }
  }));

test("a late recovery result cannot clear a replacement live binding", () =>
  fixture(async (store, add) => {
    const old = add(0);
    let finish!: (confirmed: boolean) => void;
    const cancel = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const recovery = new StartupRecovery(store, async () => {}, cancel, () => {}, () => {});
    try {
      recovery.start();
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      const current = { ...old, runId: "new-live-run" };
      store.set("active:session-0", current);
      finish(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(store.get("active:session-0")).toEqual(current);
      expect(store.get("blocked:session-0")).toBe(true);
    } finally { await recovery.stop(); }
  }));

test.each(["readiness", "cancellation"])("stop interrupts unresolved %s without late state changes", (phase) =>
  fixture(async (store, add) => {
    const old = add(0);
    let finish!: (value: any) => void;
    const stalled = new Promise<any>((resolve) => { finish = resolve; });
    const ready = vi.fn(() => phase === "readiness" ? stalled : Promise.resolve());
    const cancel = vi.fn(() => stalled);
    const recovery = new StartupRecovery(store, ready, cancel, () => {}, () => {});
    recovery.start();
    await vi.waitFor(() => expect(phase === "readiness" ? ready : cancel).toHaveBeenCalledOnce());
    await Promise.race([
      recovery.stop(),
      new Promise((_, reject) => setTimeout(() => reject(Error("stop blocked")), 100)),
    ]);
    finish(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.get("active:session-0")).toEqual(old);
    expect(store.get("recovery:session-0")).toBeUndefined();
  }));

test("pass budget leaves unconfirmed sessions blocked and does not launch the remaining queue", () =>
  fixture(async (store, add) => {
    for (let i = 0; i < 17; i++) add(i);
    const budget = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(budget.signal);
    const cancel = vi.fn(() => new Promise<boolean>(() => {}));
    const log = vi.fn();
    const recovery = new StartupRecovery(store, async () => {}, cancel, () => {}, log);
    try {
      recovery.start();
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(4));
      expect(timeout).toHaveBeenCalledWith(30_000);
      budget.abort(Error("pass budget exhausted"));
      await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
      expect(cancel).toHaveBeenCalledTimes(4);
      expect(store.get("active:session-0")).toBeDefined();
      expect(store.get("blocked:session-0")).toBe(true);
    } finally {
      await recovery.stop();
      timeout.mockRestore();
    }
  }));
