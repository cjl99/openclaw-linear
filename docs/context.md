# Minimal context

English | [简体中文](context.zh-CN.md)

The current user query always comes first. On creation, use the structured initiating comment, otherwise extract the platform user-request block or primary directive comment. Never pass the entire issue/parent/comment XML snapshot as the user query. If a wrapper contains no identifiable request, ask the agent to read the original through official Linear MCP rather than guessing.

Only a short issue title (120 characters), canonical issue URL (180 characters), and changed guidance excerpt (240 characters) may follow. No descriptions, parent issues, comment trees, relationships, or arbitrary guidance-object serialization are injected. The agent must read full issue/comments through official Linear MCP before acting. Follow-ups retain their raw query and native session history, with the same bounded reference suffix.

If the actual user query exceeds 6,000 characters, preserve its complete original in a private file, show the first 4,000 and last 1,000 characters, and require reading the original before acting. This never saves a discarded issue snapshot as a substitute query. Missing host history is recovered from immutable Agent Activities; only the last two relevant prompt/response/elicitation/error excerpts (160 characters each) follow the current request. Thoughts/actions and the current activity are excluded. Recovery scanning retains its 100-page/100,000-character safety budget and explicit failure on pagination errors. HTTP bodies remain capped at 1 MiB.

Old transcripts are retained. Start a new Agent Session to avoid already-injected legacy snapshots. The plugin adds no replacement business CRUD tools.
