# Minimal context

English | [简体中文](context.zh-CN.md)

- First turn: pass Linear's `promptContext` directly.
- Follow-ups: pass only the new message and reuse native session history. Do not inject the previous model answer or the current comment again.
- Guidance: add guidance from its separate field only when it is not already present in the message; after successful delivery, include it again only when it changes.
- Do not automatically scan the issue or comments, maintain a parallel work log or source ledger, or emit a context-report activity.
- When current descriptions, other comments, or project context are needed, the agent should read them on demand through its existing Linear tools. Unread content must not be claimed as known. This plugin adds no such tools.

There are two bounded fallbacks. Inputs longer than 18,000 characters show the first 12,000 characters and provide a private path to the complete original, with an explicit instruction to read that original before acting; this is not a summary. When host history is missing, the plugin recovers context from immutable Agent Activities, limited to 100 pages and 100,000 characters. HTTP request bodies remain limited to 1 MiB.

Historical messages and private caches created by older releases are not deleted, but the old context ledger is no longer read or extended. A new message does not imply a full issue refresh. Start a new Agent Session when a conversation should have no legacy wrapping.
