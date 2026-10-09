# OpenClaw Linear Agents

[English](README.md) | 简体中文

将 Linear Agent Session 接入 OpenClaw Gateway。插件接收已授权的 Linear 事件，运行配置的 OpenClaw Agent，将用户可见的执行进度回传 Linear，并在稳定会话中保留追问上下文。

本仓库面向 **OpenClaw 2026.9.1**、**Node.js 24** 和 Linear Agent Session API。它是 OpenClaw Gateway 插件，不是 Codex Desktop 插件，也不替代 Linear 内置的 Agent UI。

## 功能

- 处理 Agent Session 的 `created`、`prompted` 和 `stop` 事件。
- 追问复用稳定的 OpenClaw 会话。
- 将 commentary 和工具活动同步到 Linear，并限制输出长度、尽力脱敏。
- 校验 Linear webhook 签名，通过 OAuth 授权并验证工作区和团队。
- 可选按负责人白名单自动委派给应用，且不替换人类负责人。
- 处理撤权、权限变化、重试、持久 outbox、取消竞态和崩溃恢复。
- 将 Linear Session 链接到对应的 OpenClaw 会话。
- 插件生成的状态文案和 OAuth 页面默认使用英文，可切换为简体中文。

## 安全模型

- OAuth 客户端凭据和 webhook secret 必须放在仓库外、权限为 `600` 的 JSON 文件中。
- 插件状态必须放在权限为 `700` 的私有目录中。SQLite 数据库包含 OAuth token、任务文本和结果，应用层未加密。
- 保持 Gateway 身份认证开启。反向代理只暴露必要的 webhook 和 OAuth callback 路径。
- Webhook 使用原始请求体和有界时间戳进行 HMAC-SHA256 校验。
- OAuth 安装绑定配置的工作区和团队；运行时事件在执行前重新校验。
- 进度输出会脱敏常见 token、密码、Authorization header、Cookie、API key 和私钥。这不是完整 DLP，只应运行适合向 Linear Issue 受众展示输出的任务。
- 插件不需要 GitHub token。Agent 如果访问 GitHub，权限继承自配置的 OpenClaw 运行环境。

## 安装

```sh
git clone https://github.com/cjl99/openclaw-linear.git
cd openclaw-linear
npm ci --ignore-scripts
npm run build
npm test
```

包保持 `private: true`，防止误发布到 npm。OpenClaw 从本地 checkout 加载插件。

## 创建 Linear OAuth 应用

在 **Linear Settings → Administration → API → OAuth applications** 中创建应用并配置：

- Webhook URL：`https://gateway.example.com/linear/webhook`
- Redirect URI：`https://gateway.example.com/linear/oauth/callback`
- Webhooks：Agent Session events、Inbox Notifications、Permission changes
- 如需按负责人自动委派，再启用 Issues
- OAuth actor：`app`
- OAuth scopes：`read`、`write`、`app:assignable`、`app:mentionable`

只允许需要调用 Agent 的团队使用该应用。插件的 `teamIds` 校验是额外边界，不能代替 Linear 侧授权。

## 凭据

在 Gateway 主机创建私有 JSON 文件：

```json
{
  "clientId": "LINEAR_CLIENT_ID",
  "clientSecret": "LINEAR_CLIENT_SECRET",
  "webhookSecret": "LINEAR_WEBHOOK_SIGNING_SECRET"
}
```

启动插件前设置权限：

```sh
chmod 600 /absolute/private/path/linear-agent.json
chmod 700 /absolute/private/path/linear-state
```

不要把真实凭据写入 shell 参数、日志、Issue 评论或仓库文件。

## 插件配置

示例：

```json
{
  "agentId": "linear-agent",
  "organizationUrlKey": "example-workspace",
  "teamIds": ["00000000-0000-4000-8000-000000000001"],
  "autoAssignUserIds": [],
  "maxConcurrency": 10,
  "locale": "zh-CN",
  "publicOrigin": "https://gateway.example.com",
  "stateDir": "/absolute/private/path/linear-state",
  "credentialsFile": "/absolute/private/path/linear-agent.json"
}
```

可用 `organizationId` 代替 `organizationUrlKey`；若同时提供，两者必须匹配。`autoAssignUserIds` 默认为空数组，即关闭按负责人自动委派。`maxConcurrency` 控制不同 Agent Session 之间的并发数（1–100，默认 1）；单个 Session 内仍严格串行。`locale` 控制插件生成的 Linear 活动和 OAuth 页面，默认为 `en`，也可设为 `zh-CN`。

将 checkout 合并到现有 OpenClaw 插件配置中，不要覆盖无关条目：

```json
{
  "plugins": {
    "allow": ["linear-agents"],
    "load": {"paths": ["/absolute/path/to/openclaw-linear"]},
    "entries": {
      "linear-agents": {
        "enabled": true,
        "config": {
          "agentId": "linear-agent",
          "organizationUrlKey": "example-workspace",
          "teamIds": ["00000000-0000-4000-8000-000000000001"],
          "autoAssignUserIds": [],
          "maxConcurrency": 10,
          "locale": "zh-CN",
          "publicOrigin": "https://gateway.example.com",
          "stateDir": "/absolute/private/path/linear-state",
          "credentialsFile": "/absolute/private/path/linear-agent.json"
        }
      }
    }
  }
}
```

manifest 中的 `activation.onStartup=true` 用于让 Gateway 注册 webhook 和 callback 路由。

## 授权与验收

构建并启动 Gateway 后，在本机生成 OAuth URL：

```sh
node dist/authorize.js /absolute/private/path/linear-agents.json
```

在已登录目标 Linear 工作区的浏览器中打开该 URL。不要把含临时 `code` 或 `state` 参数的 callback URL 复制到聊天或日志中。

在专用测试团队中验证：

1. 将测试 Issue 委派给应用，确认 Session 启动。
2. 在同一 Agent Session 中追问，确认上下文复用。
3. 停止长任务，确认取消完成前不会启动新任务。
4. 核对活动进度、最终回复和会话链接。
5. 若开启按负责人委派，分别测试允许和不允许的负责人。
6. 在测试环境撤销团队权限，确认新任务被阻止。

未签名请求应被拒绝：

```sh
curl -i -X POST https://gateway.example.com/linear/webhook -d '{}'
```

预期：未签名 POST 返回 `401`，GET 返回 `405`。通用 SPA 页面不能证明插件路由已生效。

## Session 与上下文

Session key 由工作区 ID 和 Linear Agent Session ID 派生。同一 Linear Agent Session 内的追问复用 OpenClaw 历史；同一 Issue 的不同 Agent Session 相互独立。

首轮使用 Linear `promptContext`。追问只发送新消息，依赖已有 OpenClaw Session；Guidance 仅在新增或变化时注入。若宿主历史不可用，插件可从不可变 Agent Activities 中恢复有界上下文。

如需读取最新 Issue 详情、评论、项目和文档，应另行连接 Linear 官方 MCP server。插件刻意不复制通用 Linear CRUD 工具。MCP 授权独立于插件 OAuth 应用，也不受 `teamIds` 限制。

## 运维

更新与验证：

```sh
git pull --ff-only
npm ci --ignore-scripts
npm run build
npm run typecheck
npm test
```

重新构建后冷重启 Gateway；进程内配置重载可能继续使用旧模块。停用时将插件 entry 设为 `enabled: false`、重启 Gateway；如需移除访问权限，再撤销 Linear 应用授权。除非明确要清除 token 和 Session 状态，否则保留私有状态目录。

## 已知边界

- 取消无法撤销 Agent 已完成的文件修改、Git 操作、外部 API 调用或其他副作用。
- 工具进度为尽力投递；最终回复使用持久 outbox。
- 长历史恢复上限为 100 页和 100,000 字符。
- 主动创建 Session 的 mutation 没有调用方提供的跨系统幂等键；结果未知时必须先检查再重试。
- Activity 布局和原生 `Worked for` 时长由 Linear 控制，插件无法复现所有 OpenClaw UI 细节。

实现细节见[能力与边界](docs/agent-capabilities.zh-CN.md)和[上下文行为](docs/context.zh-CN.md)。

公开文档同时维护英文和简体中文。新增或修改文档时，应在同一变更中同步更新两个语言版本。

## License

MIT
