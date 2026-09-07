import { randomUUID } from "node:crypto";
import { Linear } from "./linear.js";
import type { Event } from "./store.js";
import { presentation, type Locale } from "./presentation.js";

// Forward user-visible execution events, never reasoning or hidden answer candidates.
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[Nested content omitted]";
  if (typeof value === "string")
    return value
      .replace(
        /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
        "[REDACTED PRIVATE KEY]",
      )
      .replace(
        /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]+|lin_(?:api|oauth|wh)_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{16,})/g,
        "[REDACTED]",
      )
      .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]")
      .replace(
        /((?:["']?(?:[\w-]*(?:token|secret|password|api[_-]?key)|authorization|cookie)["']?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;\n]+)/gi,
        "$1[REDACTED]",
      );
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /token|secret|password|authorization|cookie|api[_-]?key|private[_-]?key/i.test(
          k,
        )
          ? "[REDACTED]"
          : redact(v, depth + 1),
      ]),
    );
  return value;
}
function text(value: unknown): string {
  if (value === undefined) return "";
  const safe = redact(value);
  return typeof safe === "string"
    ? safe
    : (JSON.stringify(safe, null, 2) ?? "");
}
function bounded(value: string, limit: number, locale: Locale = "en") {
  return value.length <= limit
    ? value
    : value.slice(0, limit) + presentation(locale).longContent;
}
function resultText(value: unknown, locale: Locale): string {
  if (
    value &&
    typeof value === "object" &&
    Array.isArray((value as any).content)
  ) {
    const result = value as any;
    return (
      result.content
        .map((part: any) =>
          part.type === "text" || part.type === "toolResult"
            ? text(part.text)
            : presentation(locale).attachment(String(part.type ?? "attachment")),
        )
        .join("\n") + (result.details ? "\n" + text(result.details) : "")
    );
  }
  return text(value);
}
export function toolActivity(
  data: Record<string, unknown>,
  elapsedMs?: number,
  locale: Locale = "en",
) {
  const p = presentation(locale);
  if (
    data.hideFromChannelProgress === true ||
    !["start", "result"].includes(String(data.phase))
  )
    return null;
  const name =
    typeof data.name === "string" && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(data.name)
      ? data.name
      : p.tool;
  const args = data.args as Record<string, unknown> | undefined;
  const label =
    args && typeof args === "object"
      ? (args.cmd ??
        args.command ??
        args.path ??
        args.file_path ??
        args.query ??
        args.q ??
        data.meta)
      : (data.args ?? data.meta);
  const parameter = bounded(
    text(label || name).replace(/\s+/g, " "),
    240,
    locale,
  );
  const content: Record<string, unknown> = {
    type: "action",
    action: name,
    parameter,
  };
  if (data.phase === "result") {
    const status = `${data.isError === true ? p.toolFailed : p.toolCompleted}${elapsedMs === undefined ? "" : ` · ${Math.max(1, Math.round(elapsedMs / 1000))} ${p.seconds}`}`;
    const input = bounded(text(data.args), 6000, locale);
    const output = bounded(resultText(data.result, locale), 16000, locale);
    content.result = `${status}${input ? `\n\n${p.input}\n${input}` : ""}\n\n${p.output}\n${output ? output : p.noToolOutput}`;
  }
  return content;
}
export function transcriptResult(
  messages: unknown[],
  runId: string,
  toolId: string,
) {
  return messages.find(
    (value: any) =>
      value?.role === "toolResult" &&
      value.toolCallId === toolId &&
      value.__openclaw?.runId === runId,
  );
}
interface Run {
  event: Event;
  sessionKey: string;
  started: number;
  lastUpdate: number;
  chain: Promise<void>;
  tools: Map<string, { data: Record<string, unknown>; started: number }>;
  seen: Set<string>;
  commentary: Map<string, { text: string; sent: boolean }>;
  calls: number;
  closed: boolean;
  muted?: boolean;
  pending: number;
  omitted: number;
}
export class Progress {
  private runs = new Map<string, Run>();
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private linear: Linear,
    private log: (s: string) => void,
    private readMessages?: (sessionKey: string) => Promise<unknown[]>,
    private locale: Locale = "en",
  ) {}
  start() {
    this.timer = setInterval(() => {
      for (const r of this.runs.values())
        if (!r.closed && Date.now() - r.lastUpdate > 20000) {
          this.send(
            r,
            {
              type: "thought",
              body: presentation(this.locale).processing(
                Math.round((Date.now() - r.started) / 1000),
                r.calls,
              ),
            },
            true,
          );
        }
    }, 1000);
  }
  private enqueue(r: Run, task: () => Promise<void>, essential = false) {
    r.lastUpdate = Date.now();
    if (!essential && r.pending >= 200) {
      r.omitted++;
      return;
    }
    r.pending++;
    r.chain = r.chain
      .then(() => (r.muted ? undefined : task()))
      .catch(() => {
        r.omitted++;
        this.log(
          "Linear progress delivery unavailable; final answer delivery remains queued",
        );
      })
      .finally(() => {
        r.pending--;
      });
  }
  private send(
    r: Run,
    content: Record<string, unknown>,
    ephemeral = false,
    essential = false,
  ) {
    const id = randomUUID();
    this.enqueue(
      r,
      () =>
        this.linear.content(r.event.sessionId, id, content, ephemeral, 3000),
      essential,
    );
  }
  begin(e: Event, runId: string, sessionKey: string, url: string) {
    const r: Run = {
      event: e,
      sessionKey,
      started: Date.now(),
      lastUpdate: Date.now(),
      chain: Promise.resolve(),
      tools: new Map(),
      seen: new Set(),
      commentary: new Map(),
      calls: 0,
      closed: false,
      pending: 0,
      omitted: 0,
    };
    this.runs.set(runId, r);
    this.enqueue(r, () => this.linear.link(e.sessionId, url));
  }
  alias(from: string, to: string) {
    const r = this.runs.get(from);
    if (r && from !== to) {
      this.runs.delete(from);
      this.runs.set(to, r);
    }
  }
  mute(runId: string) {
    const r = this.runs.get(runId);
    if (r) {
      r.muted = true;
      r.closed = true;
    }
  }
  private flushCommentary(r: Run) {
    for (const item of r.commentary.values())
      if (!item.sent && item.text) {
        item.sent = true;
        this.send(r, {
          type: "thought",
          body: bounded(text(item.text), 12000, this.locale),
        });
      }
  }
  capture(e: {
    runId: string;
    sessionKey?: string;
    stream: string;
    seq: number;
    data: Record<string, unknown>;
  }) {
    const r = this.runs.get(e.runId);
    if (
      !r ||
      r.closed ||
      (e.sessionKey && e.sessionKey !== r.sessionKey) ||
      !["tool", "item"].includes(e.stream) ||
      e.data.hideFromChannelProgress === true
    )
      return;
    const key = `${e.stream}:${e.seq}:${e.data.phase}`;
    if (r.seen.has(key)) return;
    if (r.seen.size >= 10000) {
      r.omitted++;
      return;
    }
    r.seen.add(key);
    if (e.stream === "item") {
      if (e.data.kind !== "preamble" || typeof e.data.progressText !== "string")
        return;
      const id = String(e.data.itemId ?? "preamble");
      const prior = r.commentary.get(id);
      // Updates are cumulative. Publish the completed item once, not every token.
      if (prior?.sent) return;
      r.commentary.set(id, { text: e.data.progressText, sent: false });
      if (e.data.phase === "end") this.flushCommentary(r);
      return;
    }
    this.flushCommentary(r);
    const toolId = String(e.data.toolCallId ?? e.data.itemId ?? e.seq);
    const prior = r.tools.get(toolId);
    const data = { ...prior?.data, ...e.data };
    const content = toolActivity(
      data,
      prior ? Date.now() - prior.started : undefined,
      this.locale,
    );
    if (!content) return;
    if (e.data.phase === "start" && !prior) {
      r.calls++;
      r.tools.set(toolId, { data, started: Date.now() });
    }
    if (e.data.phase === "result" && this.readMessages) {
      const id = randomUUID();
      const elapsed = prior ? Date.now() - prior.started : undefined;
      this.enqueue(r, async () => {
        let matched: any;
        // Codex persists the native result just after its lifecycle event.
        for (let attempt = 0; attempt < 3; attempt++) {
          const messages = await this.readMessages!(r.sessionKey).catch(
            () => [],
          );
          matched = transcriptResult(messages, e.runId, toolId);
          if (matched) break;
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        const projected = toolActivity(
          { ...data, ...(matched ? { result: matched } : {}) },
          elapsed,
          this.locale,
        )!;
        if (!matched)
          projected.result += presentation(this.locale).outputUnavailable;
        if (r.muted) return;
        await this.linear.content(
          r.event.sessionId,
          id,
          projected,
          false,
          3000,
        );
      });
    } else this.send(r, content, e.data.phase === "start");
  }
  async finish(runId: string, ok: boolean) {
    const r = this.runs.get(runId);
    if (!r) return;
    r.closed = true;
    const elapsed = Math.max(1, Math.round((Date.now() - r.started) / 1000));
    this.flushCommentary(r);
    await r.chain;
    this.send(
      r,
      {
        type: "thought",
        body: presentation(this.locale).finished(
          ok,
          elapsed,
          r.calls,
          r.omitted > 0,
        ),
      },
      false,
      true,
    );
    await r.chain;
    this.runs.delete(runId);
  }
  async stop() {
    clearInterval(this.timer);
    for (const r of this.runs.values()) r.closed = true;
    await Promise.allSettled([...this.runs.values()].map((r) => r.chain));
    this.runs.clear();
  }
}
