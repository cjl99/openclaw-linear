import { test, expect, vi } from "vitest";
import { sessionTitle, updateSessionTitle } from "../src/title.js";
const event = { id: "event", organizationId: "org", sessionId: "linear-session", issueId: "issue", action: "created", prompt: "ignored", issueIdentifier: "MAR-8", issueTitle: " 修复\n工具展示 " };
test("uses verified issue metadata without prompt text or control characters", () => {
  expect(sessionTitle(event)).toBe("MAR-8 · 修复 工具展示");
  expect(sessionTitle({ ...event, issueIdentifier: undefined })).toBeUndefined();
  expect(Array.from(sessionTitle({ ...event, issueTitle: "😀".repeat(150) })!).length).toBe(120);
});
test("title patch preserves session identity, explicit user label and activity", async () => {
  const entry = { sessionId: "existing", displayName: "linear:hash", label: "我的自定义名称", updatedAt: 123, cliSessionId: "native-thread" };
  const patch = vi.fn(async (p) => {
    expect(p).toMatchObject({ agentId: "agent", sessionKey: "agent:agent:linear:hash", preserveActivity: true });
    const change = await p.update(entry);
    expect(change).toEqual({ displayName: "MAR-8 · 修复 工具展示" });
    expect(await p.update({ ...entry, ...change })).toBeNull();
  });
  await updateSessionTitle({ runtime: { agent: { session: { patchSessionEntry: patch } } } } as any, "agent", "agent:agent:linear:hash", event);
  expect(patch).toHaveBeenCalledTimes(1);
});
