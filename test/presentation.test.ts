import { test, expect, vi } from "vitest";
import { Linear } from "../src/linear.js";
import { toolActivity, redact, Progress } from "../src/progress.js";

test("session link uses the neutral label and preserves the URL", async () => {
  const linear = new Linear({} as any, {} as any, {} as any);
  const query = vi
    .spyOn(linear, "query")
    .mockResolvedValue({ agentSessionUpdate: { success: true } });
  await linear.link("session", "https://gateway.example.com/chat/agent/test");
  expect(query.mock.calls[0][1]).toEqual({
    id: "session",
    input: {
      addedExternalUrls: [
        {
          label: "session🔗",
          url: "https://gateway.example.com/chat/agent/test",
        },
      ],
    },
  });
});

test.each([
  "AGENTS.md",
  "SOUL.md",
  "agent-knowledge/linear.md",
  "/srv/openclaw/private/linear-agents/context/item.json",
])("tool details remain visible for %s", (path) => {
  const content = toolActivity({
    name: "exec",
    phase: "result",
    args: { command: `cat ${path}` },
    result: "private instructions",
  });
  expect(content?.action).toBe("exec");
  expect(content?.parameter).toBe(`cat ${path}`);
  expect(content?.result).toContain("private instructions");
  expect(content?.result).toContain(path);
});

test("business output remains visible and truncation uses session label", () => {
  const result = toolActivity({
    phase: "result",
    name: "linear.get_issue",
    args: { query: "YOU-25258" },
    result: "x".repeat(17000),
  });
  expect(result?.parameter).toBe("YOU-25258");
  expect(result?.result).toContain("session🔗");
  expect(JSON.stringify(result)).not.toContain("OpenClaw");
  expect(redact("OpenClaw /srv/openclaw/private/example.txt")).toBe(
    "OpenClaw /srv/openclaw/private/example.txt",
  );
});

test("transcript fallback preserves real tool parameters and output", async () => {
  const sent: unknown[] = [];
  const p = new Progress(
    {
      link: async () => {},
      content: async (_s: string, _id: string, c: unknown) => {
        sent.push(c);
      },
    } as any,
    () => {},
    async () => [
      {
        role: "toolResult",
        toolCallId: "tool",
        __openclaw: { runId: "run" },
        content: [{ type: "text", text: "private workspace rules" }],
      },
    ],
  );
  p.begin({ sessionId: "session" } as any, "run", "key", "https://example.com");
  p.capture({
    runId: "run",
    stream: "tool",
    seq: 1,
    data: {
      phase: "start",
      toolCallId: "tool",
      name: "read",
      args: { path: "SOUL.md" },
    },
  });
  p.capture({
    runId: "run",
    stream: "tool",
    seq: 2,
    data: { phase: "result", toolCallId: "tool", name: "read" },
  });
  await p.finish("run", true);
  expect(JSON.stringify(sent)).toContain("SOUL.md");
  expect(JSON.stringify(sent)).toContain("private workspace rules");
  expect(JSON.stringify(sent)).not.toContain("准备任务");
});
