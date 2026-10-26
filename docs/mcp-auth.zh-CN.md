# 为 MCP 复用 App 身份

运行中的插件在 `<stateDir>/mcp-auth.sock` 提供私有 Unix socket（目录 0700、socket 0600）。同一用户的本机客户端发送 `headers\n`，收到包含 `appUserId`、`organizationId`、`headers.Authorization` 的单个 JSON 对象。该接口传递凭据，只允许可信 MCP 认证辅助程序消费，禁止打印或记录响应。

Agent Sessions 与 MCP 使用同一个 `Linear.token()` 实例，由现有 single-flight 操作统一刷新过期凭据。Broker 对新观察到的 access token 核对 viewer 和 workspace；撤权或身份不符时失败关闭。Broker 不发起新 OAuth grant，也不改变 scope。

配置原生 Streamable HTTP MCP 的 `http_headers_helper` 时，辅助程序应检查 socket 属主与权限、限制响应大小和超时、核对预期 App user/workspace ID，最后仅向 Codex 输出认证头对象。不要同时设置 Bearer 环境变量、静态 Authorization header 或个人 OAuth 凭据。Codex 按连接缓存认证头，认证失败后可重新调用 helper；helper 不得独立轮换 refresh token。

认证接口只监听本机 Unix socket，不新增公网 Gateway HTTP 路由。文件权限隔离其他 Unix 用户；同一用户的进程本来就能读取底层 OAuth 状态，因此这不是对该账户或 root 的沙箱。停止插件会关闭 socket。不要将 access token 复制进配置或当成永久 API Key。
