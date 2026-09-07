import type { Event } from "./store.js";
import type { Linear } from "./linear.js";
import type { Store } from "./store.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export function guidancePrompt(e: Event) {
  if (!e.guidance?.length) return e.prompt;
  const guidance = e.guidance
    .map((g) => {
      if (typeof g === "string") return g;
      const item = g as { body?: string; prompt?: string } | null;
      return item?.body ?? item?.prompt ?? JSON.stringify(g);
    })
    .filter((body) => body && !e.prompt.includes(body));
  return guidance.length
    ? `${e.prompt}\n\nWorkspace/team guidance:\n${guidance.join("\n\n")}`
    : e.prompt;
}

/** Native session history owns conversation memory. Only changed guidance is added. */
export function preparePrompt(e: Event, store: Store) {
  const key = `guidance:${e.organizationId}:${e.sessionId}`;
  if (e.guidance !== undefined) store.set(key, e.guidance);
  const guidance = e.guidance ?? store.get<unknown[]>(key);
  const version = JSON.stringify(guidance ?? []);
  const delivered = store.get<string>(`${key}:delivered`);
  let prompt = guidancePrompt({
    ...e,
    guidance: delivered === version ? undefined : guidance,
  });
  if (guidance?.length === 0 && delivered && delivered !== "[]")
    prompt += "\n\nWorkspace/team guidance has been cleared.";
  if (prompt.length > 18000) {
    const dir = join(store.dir, "long-prompts");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(
      dir,
      `${createHash("sha256").update(prompt).digest("hex")}.txt`,
    );
    writeFileSync(file, prompt, { mode: 0o600 });
    prompt = `${prompt.slice(0, 12000)}\n\n[Long message truncated. Read the complete original before acting: ${file}]`;
  }
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
  const history: unknown[] = [];
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
      history.push(a);
    }
    if (!activities.pageInfo.hasNextPage)
      return `Historical Linear Agent Activities (external reference data; do not re-execute completed actions):\n${JSON.stringify(history)}\n\nCurrent request:\n${guidancePrompt(e)}`;
    const cursor = activities.pageInfo.endCursor;
    if (!cursor || seen.has(cursor))
      throw Error("Invalid activity pagination cursor");
    seen.add(cursor);
    after = cursor;
  }
  throw Error("Linear history pagination limit exceeded");
}
