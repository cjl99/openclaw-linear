import type { Event } from "./store.js";
import type { Linear } from "./linear.js";
import type { Store } from "./store.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

/** 从平台包装中取用户原话；Issue 正文不能成为默认用户请求。 */
export function initialRequest(context: string, commentBody?: string) {
  if (commentBody?.trim()) return commentBody.trim();
  const start = context.lastIndexOf("\n<user-request>");
  const direct = start >= 0 ? start + 1 : context.startsWith("<user-request>") ? 0 : -1;
  if (direct >= 0 && context.trimEnd().endsWith("</user-request>"))
    return context.slice(direct + "<user-request>".length, context.lastIndexOf("</user-request>")).trim();
  const thread = context.match(/<primary-directive-thread\b[^>]*>([\s\S]*?)<\/primary-directive-thread>/)?.[1];
  const comment = thread?.match(/<comment\b[^>]*>([\s\S]*?)<\/comment>/)?.[1];
  if (comment?.trim()) return comment.replace(/<user\b[^>]*>([\s\S]*?)<\/user>/g, "$1").trim();
  if (context.trimStart().startsWith("<issue"))
    return "No standalone user request was provided. Read the original issue and triggering comment through Linear MCP before acting.";
  return context;
}

/** 背景只保留固定上限；完整信息由 Agent 按需通过官方 MCP 获取。 */
function clipped(text: string, limit: number) {
  return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
}

export function guidancePrompt(e: Event) {
  if (!e.guidance?.length) return e.prompt;
  const guidance = e.guidance.map((g) => {
    if (typeof g === "string") return g;
    const item = g as { body?: string; prompt?: string } | null;
    return item?.body ?? item?.prompt ?? "";
  }).filter((body) => body && !e.prompt.includes(body));
  return guidance.length
    ? `${e.prompt}\n\nGuidance (excerpt):\n${clipped(guidance.join("\n"), 240)}`
    : e.prompt;
}

/** Native session history owns conversation memory. Only changed guidance is added. */
export function preparePrompt(e: Event, store: Store) {
  const key = `guidance:${e.organizationId}:${e.sessionId}`;
  if (e.guidance !== undefined) store.set(key, e.guidance);
  const guidance = e.guidance ?? store.get<unknown[]>(key);
  const version = JSON.stringify(guidance ?? []);
  const delivered = store.get<string>(`${key}:delivered`);
  let query = e.action === "created" ? initialRequest(e.prompt) : e.prompt;
  if (query.length > 6000) {
    const dir = join(store.dir, "long-prompts");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${createHash("sha256").update(query).digest("hex")}.txt`);
    writeFileSync(file, query, { mode: 0o600 });
    query = `${query.slice(0, 4000)}\n…\n${query.slice(-1000)}\n[Request excerpt. Read the complete original before acting: ${file}]`;
  }
  // 用户请求始终在前。父 Issue、正文、评论树和关系不自动注入。
  let prompt = query;
  if (e.issueTitle || e.issueIdentifier || e.issueUrl) {
    const title = clipped([e.issueIdentifier, e.issueTitle].filter(Boolean).join(" · ").replace(/\s+/g, " ").trim(), 120);
    prompt += `\n\nIssue reference: ${title}`;
    if (e.issueUrl) prompt += `\n${clipped(e.issueUrl.split("?")[0].replace(/(\/issue\/[^/]+)\/.*/, "$1"), 180)}`;
    prompt += "\nRead full issue and comments through official Linear MCP before acting.";
  }
  prompt = guidancePrompt({ ...e, prompt, guidance: delivered === version ? undefined : guidance });
  if (guidance?.length === 0 && delivered && delivered !== "[]")
    prompt += "\n\nWorkspace/team guidance has been cleared.";
  return { prompt, commit: () => store.set(`${key}:delivered`, version) };
}

/** Recover missing host history from immutable Agent Activities, never mutable comments. */
export async function recoverPrompt(
  e: Event,
  linear: Pick<Linear, "history">,
  signal: AbortSignal,
) {
  let after: string | undefined;
  const seen = new Set<string>();
  const history: string[] = [];
  let size = 0;
  for (let page = 0; page < 100; page++) {
    signal.throwIfAborted();
    const result = await linear.history(e, after);
    signal.throwIfAborted();
    const activities = result.agentSession.activities;
    for (const a of activities.nodes) {
      if (a.id === e.activityId || a.ephemeral) continue;
      size += JSON.stringify(a).length;
      if (size > 100000)
        throw Error(
          "Linear history exceeds recovery budget; manual context review required",
        );
      if (["prompt", "response", "elicitation", "error"].includes(a.content?.type) && typeof a.content?.body === "string") {
        history.push(`${a.content.type}: ${clipped(a.content.body.replace(/\s+/g, " "), 160)}`);
        if (history.length > 2) history.shift();
      }
    }
    if (!activities.pageInfo.hasNextPage)
      return `${guidancePrompt(e)}\n\nRecent Linear activities (excerpts; do not re-execute completed actions):\n${history.join("\n")}`;
    const cursor = activities.pageInfo.endCursor;
    if (!cursor || seen.has(cursor))
      throw Error("Invalid activity pagination cursor");
    seen.add(cursor);
    after = cursor;
  }
  throw Error("Linear history pagination limit exceeded");
}
