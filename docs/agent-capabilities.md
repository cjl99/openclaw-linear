# Linear Agent capabilities and boundaries

English | [简体中文](agent-capabilities.zh-CN.md)

Design principle: **do not add model tools, start a separate Codex CLI, or create a second tool or session orchestration system.** The plugin only bridges the Linear protocol to OpenClaw's public runtime interfaces. Native plan and elicitation mappings are outside the current scope.

“Implemented” below means that a source path and automated coverage exist. It does not mean that every deployment has passed production acceptance testing.

| Priority | Capability | Status |
| --- | --- | --- |
| P0 | created / prompted | Implemented with the host-configured native harness, stable sessions, and a sequential queue |
| P0 | stop | `prompted` plus `agentActivity.signal=stop` follows a control path rather than the model; it cancels the exact Gateway run and clears earlier queued requests |
| P0 | cancellation race | If stop arrives before run acceptance, cancellation runs after the real run ID is returned; progress is muted and late receipts and stale results are suppressed |
| P0 | unconfirmed cancellation | Does not claim success; blocks new work in that session, preserves the binding, and allows another stop request to retry cancellation |
| P0 | crash recovery | Does not rerun uncertain work; restores an error outbox and attempts to cancel an accepted run; keeps new runs blocked when cancellation fails |
| P0 | OAuthApp.revoked | Validates workspace and client, persistently blocks token use and refresh, cancels bound runs, and allows recovery after authorization is restored |
| P0 | PermissionChange | Validates the app user, persists team revocation in timestamp order, cancels affected runs, and prevents late grants from overriding newer revocations or expanding the configured allowlist |
| P0 | deduplication and delivery | Prefers Session-created and Activity IDs for deduplication, uses stable outbox UUIDs, and searches backward through pages before retrying an uncertain Activity delivery |
| P1 | thought / action / response / error | Forwards implemented execution progress, temporary updates, redacted tool details, and final results |
| P1 | Guidance | Adds and deduplicates the separate Guidance field; injects it again only when new or changed, retains the latest value when absent, and does not elevate it into host security instructions |
| P1 | minimal context | Uses promptContext on the first turn and the raw follow-up message thereafter, reusing native history without scanning comments, replaying answers, or emitting context reports. See [context behavior](context.md) |
| P1 | Agent Activities history | When host messages are missing, pages through immutable Activities to rebuild context; removes the current prompt and ephemeral activities and fails explicitly on budget or pagination errors |
| P1 | AppUserNotification | Records minimal metadata; canceled delegation stops sessions bound to the issue; reactions, ordinary comments, and status notifications do not start model work |
| P1 | externalUrls | Adds a link to the OpenClaw session through the supported external URL API |
| P2 | proactive Issue / Comment Session | Adapters and tests exist for both official mutations, including target-team authorization and request-key reuse; no model tool, CLI, or scheduler entry point is provided |
| P2 | plan | The Session update adapter can send a complete plan; native plan events are not mapped |
| P2 | elicitation / select / auth | The Activity adapter can carry signals and metadata; native elicitation, approval, and resume flows are not connected; ordinary questions are not converted to elicitation and third-party OAuth is not implemented |
| P2 | issueRepositorySuggestions | Supports authorized sessions with explicit repository candidates; there is no automatic repository selection or native invocation entry point |
| Existing boundary | Issue/comment/project/document CRUD | Continues to use the official Linear MCP server. The plugin keeps optional allowlisted delegation and does not duplicate general CRUD tools. MCP write access depends on its own OAuth scopes |
| Out of scope | worktree orchestration | Remains the responsibility of host capabilities and task instructions |

## Required configuration and acceptance testing

The Linear OAuth app must subscribe to **Agent Session events, Inbox Notifications, and Permission changes**. Assignee-based delegation additionally requires Issues. The plugin does not modify developer-console subscriptions.

Tests use temporary databases, fake OAuth data, and simulated GraphQL and Gateway interfaces. They do not access real issues, consume model calls, or revoke real authorization.

Before each production deployment, verify in an authorized test workspace:

1. Stop during a long run, the run-ID acceptance race, and a later prompt; confirm that host execution and managed child tasks actually stop.
2. When permissions are insufficient or cancellation RPC fails, confirm that Linear reports unconfirmed cancellation rather than success.
3. Confirm the real webhook shapes and delivery for team revocation, reauthorization, and canceled delegation.
4. Recover Activities when host messages are missing and exercise the explicit large-history failure path.
5. Verify proactive Session API permissions and the created-webhook behavior. After API timeouts, inspect state before retrying and do not blindly change the request key.

## Remaining boundaries

- Cancellation cannot undo file changes, Git operations, external API calls, or other completed side effects. Background processes unmanaged by the host are also outside the guarantee.
- The Gateway must allow the plugin to cancel the matching run through the public `chat.abort` method. The plugin does not add administrative privileges or bypass authorization. Unknown RPC outcomes keep the session safely blocked.
- A single worker remains sequential. Long work in other sessions can delay cancellation-confirmation outbox delivery, though the control cancellation itself does not wait for that outbox.
- History recovery is limited to 100,000 characters and 100 pages; automatic long-context compaction is not implemented.
- Proactive creation APIs accept no caller-provided idempotency key. The local marker is written before the mutation. Lost responses and process interruption remain “outcome unknown,” so cross-system exactly-once delivery is not guaranteed.
- Native tool mappings, automatic proactive scheduling, and a complete authorization-recovery loop are not implemented.

## Official references

- [Agent interaction: sessions, activities, plans, and repository suggestions](https://linear.app/developers/agent-interaction)
- [Signals: stop, select, and auth](https://linear.app/developers/agent-signals)
- [Best practices: immutable Activities, notifications, and permission changes](https://linear.app/developers/agent-best-practices)
