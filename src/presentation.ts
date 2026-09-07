export type Locale = "en" | "zh-CN";

const copy = {
  en: {
    longContent: "\n… Content truncated. Open the full session for the remainder.",
    attachment: (type: string) =>
      `[${type}: open the full session to view this content]`,
    tool: "Tool",
    toolFailed: "Failed",
    toolCompleted: "Completed",
    seconds: "seconds",
    input: "Input",
    output: "Output",
    noToolOutput: "The tool returned no visible text.",
    processing: (seconds: number, calls: number) =>
      `Processing · ${seconds} seconds${calls ? ` · ${calls} tool calls` : ""}`,
    outputUnavailable:
      "\n\nThe complete output has not synced yet. Open the full session.",
    finished: (ok: boolean, seconds: number, calls: number, omitted: boolean) =>
      `${ok ? "Run completed" : "Run ended"} · ${seconds} seconds · ${calls} tool calls${omitted ? "\nSome progress could not be synced. Open the full session." : ""}`,
    received: "Request received. Preparing to start.",
    stopUnconfirmed:
      "The run could not be confirmed as stopped. New work in this session is blocked; retry the stop request later.",
    stopped: "The session run was stopped and queued requests were canceled.",
    blocked:
      "The run could not be confirmed as stopped. New work in this session is blocked; retry later.",
    noResult: "This run returned no visible result.",
    failed:
      "This run failed or was interrupted. Open the full session before deciding whether to retry.",
    linkLabel: "OpenClaw session",
    oauthSuccessTitle: "Linear Agent · Authorization complete",
    oauthSuccessHeading: "Linear authorization complete",
    oauthSuccessBody: "You can close this page and return to Linear.",
    oauthFailureTitle: "Linear Agent · Authorization incomplete",
    oauthFailureHeading: "Authorization incomplete",
    oauthFailureBody:
      "Check the workspace and team configuration, then start authorization again.",
  },
  "zh-CN": {
    longContent: "\n… 内容较长，余下内容请打开完整会话查看。",
    attachment: (type: string) => `[${type}：请在完整会话中查看]`,
    tool: "工具",
    toolFailed: "执行失败",
    toolCompleted: "执行完成",
    seconds: "秒",
    input: "参数",
    output: "输出",
    noToolOutput: "工具未返回可见文本。",
    processing: (seconds: number, calls: number) =>
      `正在处理 · 已运行 ${seconds} 秒${calls ? ` · 已调用 ${calls} 个工具` : ""}`,
    outputUnavailable: "\n\n完整输出尚未同步，请打开完整会话。",
    finished: (ok: boolean, seconds: number, calls: number, omitted: boolean) =>
      `${ok ? "本轮执行完成" : "本轮执行结束"} · 用时 ${seconds} 秒 · 调用了 ${calls} 个工具${omitted ? "\n部分过程未能同步，请打开完整会话。" : ""}`,
    received: "已收到请求，准备开始。",
    stopUnconfirmed:
      "尚未确认执行已停止；已阻止此会话启动新任务，请稍后重试停止。",
    stopped: "已停止此会话的执行，并取消已排队的请求。",
    blocked: "尚未确认执行已停止；已阻止此会话启动新任务，请稍后重试。",
    noResult: "本次运行未返回可见结果。",
    failed: "本次执行失败或被中断，请打开完整会话后决定是否重试。",
    linkLabel: "OpenClaw 会话",
    oauthSuccessTitle: "Linear Agent · 授权完成",
    oauthSuccessHeading: "Linear 授权完成",
    oauthSuccessBody: "可以关闭此页面，返回 Linear 继续使用。",
    oauthFailureTitle: "Linear Agent · 授权未完成",
    oauthFailureHeading: "授权未完成",
    oauthFailureBody: "请检查工作区与团队配置，再重新发起授权。",
  },
} as const;

export function presentation(locale: Locale = "en") {
  return copy[locale];
}
