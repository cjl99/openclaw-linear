import { test, expect, vi } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpAuthBroker } from "../src/mcp-auth.js";
import { Linear } from "../src/linear.js";
import { Store } from "../src/store.js";

async function request(path: string) {
  return new Promise<any>((resolve, reject) => {
    const socket = createConnection(path, () => socket.write("headers\n"));
    let data = "";
    socket.on("data", (value) => data += value.toString());
    socket.once("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    socket.once("error", reject);
  });
}

test("MCP uses the same single-flight OAuth refresh as Agent Sessions and verifies App identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-auth-"));
  const store = new Store(dir);
  store.set("token", { accessToken: "old", refreshToken: "refresh", expiresAt: 0, appUserId: "app" });
  store.set("organizationId", "org");
  let refreshes = 0;
  const http = vi.fn(async (url: string | URL | Request) => {
    if (String(url).endsWith("/oauth/token")) {
      refreshes++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Response.json({ access_token: "new", refresh_token: "next", expires_in: 3600 });
    }
    return Response.json({ data: { viewer: { id: "app" }, organization: { id: "org" } } });
  });
  const linear = new Linear({ stateDir: dir, organizationId: "org" } as any,
    { clientId: "id", clientSecret: "secret" } as any, store, http as any);
  const broker = new McpAuthBroker(linear, dir);
  try {
    await broker.start();
    expect(statSync(broker.path).mode & 0o777).toBe(0o600);
    const values = await Promise.all([request(broker.path), request(broker.path), linear.token()]);
    expect(refreshes).toBe(1);
    expect(values[0]).toEqual({ appUserId: "app", organizationId: "org", headers: { Authorization: "Bearer new" } });
    expect(values[1]).toEqual(values[0]);
    store.set("revoked", true);
    expect(await request(broker.path)).toEqual({ error: "App authentication unavailable" });
  } finally { await broker.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("MCP fails closed on a different user or workspace and never includes credentials in errors", async () => {
  for (const [user, org] of [["human", "org"], ["app", "other"]]) {
    const dir = mkdtempSync(join(tmpdir(), "mcp-auth-"));
    const linear = { token: async () => ({ accessToken: "private", appUserId: "app" }),
      query: async () => ({ viewer: { id: user }, organization: { id: org } }), organizationId: () => "org" };
    const broker = new McpAuthBroker(linear as any, dir);
    try { await broker.start(); expect(await request(broker.path)).toEqual({ error: "App authentication unavailable" }); }
    finally { await broker.stop(); rmSync(dir, { recursive: true, force: true }); }
  }
});

test("MCP never overwrites another listener or an unrelated file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-auth-"));
  const first = new McpAuthBroker({} as any, dir);
  try {
    await first.start();
    await expect(new McpAuthBroker({} as any, dir).start()).rejects.toThrow("already in use");
    await first.stop();
    writeFileSync(first.path, "preserve");
    await expect(new McpAuthBroker({} as any, dir).start()).rejects.toThrow("not a socket");
  } finally { await first.stop(); rmSync(dir, { recursive: true, force: true }); }
});
