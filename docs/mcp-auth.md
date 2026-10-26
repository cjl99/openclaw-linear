# Reusing the App identity for MCP

The running plugin provides a private Unix socket at `<stateDir>/mcp-auth.sock` (directory 0700, socket 0600). A same-user local client sends `headers\n` and receives one JSON object with `appUserId`, `organizationId`, and `headers.Authorization`. This is a credential interface: only a trusted MCP headers helper should consume it; never print or log the response.

The plugin uses the same `Linear.token()` instance for Agent Sessions and MCP. Expired credentials are refreshed through its existing single-flight refresh operation. The broker verifies the viewer and workspace before releasing a newly observed access token. Revoked or mismatched authorization fails closed. No new OAuth grant or scopes are requested by the broker.

Configure a native Streamable HTTP MCP server with an `http_headers_helper` that validates the socket owner and permissions, bounds the response size and timeout, checks the expected App user/workspace IDs, and emits only the headers object to Codex. Do not configure a competing bearer environment variable, static Authorization header, or stored personal OAuth credential. Codex caches headers per connection and can invoke the helper again after an authentication failure; the helper itself must not rotate the refresh token independently.

This deliberately uses a local Unix socket, not a public Gateway HTTP route. The filesystem permissions isolate other Unix users; processes running as the same user already have access to the underlying OAuth state. It is not a sandbox against the account owner or root. Stop the plugin to close the socket. Do not copy access tokens into configuration or treat them as permanent API keys.
