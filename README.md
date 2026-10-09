# OpenClaw Linear Agents

English | [简体中文](README.zh-CN.md)

Connect Linear Agent Sessions to an OpenClaw Gateway. The plugin receives authorized Linear events, runs the configured OpenClaw agent, streams user-visible progress back to Linear, and preserves follow-up context in a stable session.

This repository targets **OpenClaw 2026.9.1**, **Node.js 24**, and Linear's Agent Session APIs. It is an OpenClaw Gateway plugin, not a Codex Desktop plugin or a replacement for Linear's built-in agent UI.

## Features

- Handles `created`, `prompted`, and `stop` Agent Session events.
- Reuses a stable OpenClaw session for follow-up messages.
- Streams commentary and tool activity to Linear with bounded output and best-effort secret redaction.
- Uses Linear webhook signature verification and OAuth with workspace/team validation.
- Supports optional assignee allowlists that delegate matching issues to the app without replacing the human assignee.
- Handles revocation, permission changes, retries, durable outbox delivery, cancellation races, and crash recovery.
- Links each Linear session to the corresponding OpenClaw conversation.

## Security model

- Store OAuth client credentials and webhook secrets outside the repository in a mode-`600` JSON file.
- Store plugin state in a private mode-`700` directory. The SQLite database contains OAuth tokens, task text, and results and is not application-layer encrypted.
- Keep Gateway authentication enabled. Expose only the required webhook and OAuth callback paths through your reverse proxy.
- Webhooks are verified with HMAC-SHA256 over the raw request body and a bounded timestamp.
- OAuth installation is bound to the configured workspace and teams. Runtime events are revalidated before execution.
- Progress output redacts common tokens, passwords, authorization headers, cookies, API keys, and private keys. This is not complete DLP; only run tasks whose output is appropriate for the Linear issue's audience.
- The plugin does not require a GitHub token. Agent-side GitHub access, if any, is inherited from the configured OpenClaw runtime.

## Install

```sh
git clone https://github.com/cjl99/openclaw-linear.git
cd openclaw-linear
npm ci --ignore-scripts
npm run build
npm test
```

The package remains marked `private: true` to prevent accidental npm publication. OpenClaw loads it from a local checkout.

## Create a Linear OAuth app

In **Linear Settings → Administration → API → OAuth applications**, create an app and configure:

- Webhook URL: `https://gateway.example.com/linear/webhook`
- Redirect URI: `https://gateway.example.com/linear/oauth/callback`
- Webhooks: Agent Session events, Inbox Notifications, and Permission changes
- Optional webhook for assignee-based delegation: Issues
- OAuth actor: `app`
- OAuth scopes: `read`, `write`, `app:assignable`, and `app:mentionable`

Restrict the app to only the teams that should be able to invoke the agent. The plugin's `teamIds` validation is an additional boundary, not a substitute for Linear-side authorization.

## Credentials

Create a private JSON file on the Gateway host:

```json
{
  "clientId": "LINEAR_CLIENT_ID",
  "clientSecret": "LINEAR_CLIENT_SECRET",
  "webhookSecret": "LINEAR_WEBHOOK_SIGNING_SECRET"
}
```

Protect it before starting the plugin:

```sh
chmod 600 /absolute/private/path/linear-agent.json
chmod 700 /absolute/private/path/linear-state
```

Do not place real credential values in shell arguments, logs, issue comments, or repository files.

## Plugin configuration

Example plugin config:

```json
{
  "agentId": "linear-agent",
  "organizationUrlKey": "example-workspace",
  "teamIds": ["00000000-0000-4000-8000-000000000001"],
  "autoAssignUserIds": [],
  "maxConcurrency": 10,
  "locale": "en",
  "publicOrigin": "https://gateway.example.com",
  "stateDir": "/absolute/private/path/linear-state",
  "credentialsFile": "/absolute/private/path/linear-agent.json"
}
```

`organizationId` may be used instead of `organizationUrlKey`; if both are set, both must match. `autoAssignUserIds` defaults to an empty array, which disables assignee-based delegation. `maxConcurrency` controls concurrent work across different Agent Sessions (1–100, default 1); each individual Session remains sequential. `locale` controls plugin-generated Linear activities and OAuth pages; it defaults to `en` and also accepts `zh-CN`.

Add the checkout to the existing OpenClaw plugin configuration without replacing unrelated entries:

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
          "locale": "en",
          "publicOrigin": "https://gateway.example.com",
          "stateDir": "/absolute/private/path/linear-state",
          "credentialsFile": "/absolute/private/path/linear-agent.json"
        }
      }
    }
  }
}
```

The manifest's `activation.onStartup=true` is required so the Gateway registers the webhook and callback routes.

## Authorize and verify

After building and starting the Gateway, generate the OAuth URL locally:

```sh
node dist/authorize.js /absolute/private/path/linear-agents.json
```

Open the URL in a browser already signed into the intended Linear workspace. Do not copy callback URLs containing temporary `code` or `state` parameters into chat or logs.

Verify the integration in a dedicated test team:

1. Delegate a test issue to the app and confirm the session starts.
2. Send a follow-up in the same Agent Session and confirm context is reused.
3. Stop a long-running task and confirm no new task starts until cancellation is confirmed.
4. Verify activity progress, final response, and the session link.
5. If assignee delegation is enabled, test both allowed and disallowed assignees.
6. Revoke team permission in a test environment and confirm new work is blocked.

An unsigned request should be rejected:

```sh
curl -i -X POST https://gateway.example.com/linear/webhook -d '{}'
```

Expected result: `401` for an unsigned POST and `405` for GET. A generic SPA response does not prove the plugin route is active.

## Session and context behavior

The session key is derived from the workspace ID and Linear Agent Session ID. Follow-ups within one Linear Agent Session reuse OpenClaw history; a different Agent Session on the same issue is independent.

The first turn uses Linear's `promptContext`. Follow-ups send the new message and rely on the existing OpenClaw session. Guidance is included only when new or changed. If host history is unavailable, the plugin can reconstruct bounded context from immutable Agent Activities.

For current issue details, comments, projects, and documents, connect the agent separately to Linear's official MCP server. This plugin intentionally does not duplicate general Linear CRUD tools. MCP authorization is independent from the plugin OAuth app and is not constrained by `teamIds`.

## Operations

Update and verify:

```sh
git pull --ff-only
npm ci --ignore-scripts
npm run build
npm run typecheck
npm test
```

Cold-restart the Gateway after rebuilding; an in-process configuration reload may retain the old module. To disable the plugin, set its entry to `enabled: false`, restart the Gateway, and revoke the Linear app authorization if access should be removed. Preserve the private state directory unless token and session state should intentionally be discarded.

## Known boundaries

- Cancellation cannot undo file changes, Git operations, external API calls, or other side effects already completed by an agent.
- Tool progress is best effort; the final response uses a durable outbox.
- Long history recovery is bounded to 100 pages and 100,000 characters.
- Proactive Session mutations have no caller-provided cross-system idempotency key. Unknown outcomes require inspection before retrying.
- Linear controls activity layout and its native `Worked for` duration; the plugin cannot reproduce every OpenClaw UI detail.

See [agent capabilities](docs/agent-capabilities.md) and [context behavior](docs/context.md) for implementation details.

Public documentation is maintained in English and Simplified Chinese. When adding or changing documentation, update both language files in the same change.

## License

MIT
