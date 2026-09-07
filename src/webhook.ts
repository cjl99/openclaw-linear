import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Config } from "./config.js";
import type { Event } from "./store.js";
export function verify(
  raw: Buffer,
  signature: string | undefined,
  secret: string,
) {
  if (!signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  return timingSafeEqual(
    createHmac("sha256", secret).update(raw).digest(),
    Buffer.from(signature, "hex"),
  );
}
export function normalize(
  p: any,
  c: Config,
  delivery: string | undefined,
  now = Date.now(),
): Event | null {
  if (
    !Number.isFinite(p?.webhookTimestamp) ||
    Math.abs(now - p.webhookTimestamp) > 60000
  )
    throw Error("Stale webhook");
  if (!c.organizationId || p.organizationId !== c.organizationId)
    throw Error("Organization not allowed");
  if (
    p.type !== "AgentSessionEvent" ||
    !["created", "prompted"].includes(p.action)
  )
    return null;
  const s = p.agentSession;
  const id = delivery || p.webhookId;
  if (
    typeof id !== "string" ||
    !id ||
    typeof s?.id !== "string" ||
    typeof s?.issue?.id !== "string"
  )
    throw Error("Invalid session event");
  if (p.action === "prompted" && p.agentActivity?.content?.type !== "prompt")
    return null;
  const prompt =
    p.action === "created" ? p.promptContext : p.agentActivity.content.body;
  const stop = p.action === "prompted" && p.agentActivity.signal === "stop";
  if (!stop && (typeof prompt !== "string" || !prompt.trim()))
    throw Error("Invalid prompt");
  return {
    id:
      p.action === "created"
        ? `created:${p.organizationId}:${s.id}`
        : typeof p.agentActivity?.id === "string" && p.agentActivity.id
          ? `activity:${p.organizationId}:${p.agentActivity.id}`
          : id,
    organizationId: p.organizationId,
    sessionId: s.id,
    issueId: s.issue.id,
    prompt: stop ? "" : prompt,
    action: stop ? "stop" : p.action,
    ...(Array.isArray(p.guidance) ? { guidance: p.guidance } : {}),
    ...(typeof p.agentActivity?.signal === "string"
      ? { signal: p.agentActivity.signal }
      : {}),
    ...(typeof p.agentActivity?.id === "string"
      ? { activityId: p.agentActivity.id }
      : {}),
    ...(typeof (s.commentId ?? s.comment?.id) === "string"
      ? { triggerCommentId: s.commentId ?? s.comment.id }
      : {}),
  };
}
export async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  const timer = setTimeout(() => req.destroy(Error("Body timeout")), 4000);
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) throw Error("Body too large");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}
