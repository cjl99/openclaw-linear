# Linear Agent 能力与边界

设计原则：**不新增模型 tool，不另起 Codex CLI，不创建第二套工具或会话调度系统。** 插件只承接 Linear 协议与 OpenClaw 公开运行接口。计划/询问等原生工具映射不在当前范围内。

下面的“已接通”指源码路径与自动测试，不等同于任意具体部署已完成生产验收。

| 优先级 | 能力 | 当前状态 |
| --- | --- | --- |
| P0 | created / prompted | 已接通；仍使用宿主配置的原生 harness、稳定 Session 和顺序队列 |
| P0 | stop | 已接通；`prompted` + `agentActivity.signal=stop` 走控制路径，不交给模型；取消精确 Gateway run，清理此前排队请求 |
| P0 | 停止竞态 | 停止先于 run 接受时，收到真实 runId 后取消；停止期间静默进度，抑制迟到回执与旧结果 |
| P0 | 无法确认停止 | 不声称成功；阻止该 Session 新执行，保留绑定，可重发停止重试取消 |
| P0 | 崩溃恢复 | 不重跑不确定任务；恢复错误 outbox，并尝试取消遗留 run；取消失败则继续阻止新运行 |
| P0 | OAuthApp.revoked | 校验 workspace/client；持久阻止 token 使用和刷新，取消已绑定运行；重新授权后可恢复 |
| P0 | PermissionChange | 校验 app user；按团队持久化撤权与时间顺序，取消受影响运行；迟到的授权增加不会覆盖新撤权，也不扩展配置白名单 |
| P0 | 去重与投递 | Session created / Activity ID 优先去重；稳定 UUID outbox；不确定 Activity 投递会向前翻页查重，而非只查最后 100 条 |
| P1 | thought / action / response / error | 保留已接通的执行过程、临时进度、脱敏和结果投递 |
| P1 | Guidance | 独立字段补充去重，成功传递后仅新增/变化时注入；未携带字段时沿用最近版本，不提升为宿主安全指令 |
| P1 | 简洁上下文 | 首轮 promptContext、追问原消息，复用原生历史；不扫描评论、不回填回答、不发送覆盖报告。背景用已有 Linear 工具按需读取，详见 [上下文设计](context.md) |
| P1 | Agent Activities 历史 | prompted 时若宿主消息为空，分页读取不可变 Activities 重建上下文；去掉当前 prompt、临时活动；超预算/分页异常明确报错，不静默丢弃 |
| P1 | AppUserNotification | 记录最小元数据；取消委派通知停止该 Issue 的绑定会话；reaction/普通评论/状态通知不启动新模型任务 |
| P1 | externalUrls | session🔗 会话链接已接通；通用新增链接 API 适配已有，未新增模型入口 |
| P2 | 主动 Issue / Comment Session | 两个官方 mutation 的 API 适配与测试已有；校验目标 Issue 团队、请求键去重；没有新增 tool、CLI 或定时调度入口，不能算自动工作流已完成 |
| P2 | plan | Session 更新 API 可发送全量计划；没有接入原生计划事件，映射小项暂停 |
| P2 | elicitation / select / auth | Activity API 可携带 signal/metadata；未接原生询问/审批与恢复流程；不自动把普通结尾问句改成 elicitation，也不实现第三方 OAuth |
| P2 | issueRepositorySuggestions | 授权 Session + 显式候选仓库的 API 适配已有；未接自动仓库选择/原生调用入口 |
| 既有边界 | Issue/评论/项目/文档 CRUD | 继续使用官方 Linear MCP；插件保留既有白名单自动委派，不复制通用 CRUD 工具。MCP 实际可写性由自己的 OAuth scope 决定 |
| 不做 | worktree 调度系统 | 仍由现有宿主能力与任务 Prompt 管理 |

## 必要配置与验收

Linear OAuth app 必须订阅 **Agent Session events、Inbox Notifications、Permission changes**；自动委派另需 Issues。代码不会偷偷替用户修改开发者后台订阅。

测试使用临时数据库、假 OAuth 数据、模拟 GraphQL 和 Gateway；不访问真实工单，不消费模型调用，不撤销真实授权。

每次生产部署前应在授权的测试 workspace 验收：

1. 长运行中停止、runId 接受竞态、继续新的 prompt；核实宿主执行及受控子任务确实停止。
2. 真实权限不足/取消 RPC 失败时，Linear 显示未确认停止，而非成功。
3. 团队撤权、重新授予和取消 delegate 的真实 webhook 形状及订阅是否到达。
4. 宿主消息缺失时恢复 Activities；大历史的明确报错路径。
5. 主动 Session API 的真实权限与 created webhook 行为；API 请求超时后人工核对，不换请求键盲目重建。

## 仍然存在的边界

- 取消不撤销已经发生的文件、Git、外部 API 等副作用；宿主未管理的后台进程也不在插件承诺范围内。
- Gateway 必须允许插件通过公开 `chat.abort` 取消对应运行；插件不会加管理权限或绕过授权。RPC 结果未知时保留安全阻塞。
- 单 worker 仍按既有方式串行处理；其他 Session 的耗时任务可能延迟停止确认的 outbox 投递，但控制取消不等待该 outbox。
- 历史恢复预算为 100,000 字符 / 100 页；尚未做自动长上下文压缩。
- 主动创建 API 无可传入的幂等键：本地标记写在 mutation 之前。丢失响应或进程中断后，保留“结果未知”，不能保证跨系统 exactly-once。
- 原生工具映射、自动主动调度和完整授权恢复闭环尚未实现。

## 官方依据

- [Agent interaction：Session、活动、计划与仓库建议](https://linear.app/developers/agent-interaction)
- [Signals：stop、select、auth](https://linear.app/developers/agent-signals)
- [Best practices：不可变 Activities、通知与权限变化](https://linear.app/developers/agent-best-practices)
