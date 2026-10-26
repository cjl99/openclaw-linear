import { createServer, createConnection, type Socket, type Server } from "node:net";
import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Linear } from "./linear.js";

/** 本机 MCP 只向当前 Unix 用户提供 App 认证，续期始终由接单进程统一执行。 */
export class McpAuthBroker {
  private server?: Server;
  private sockets = new Set<Socket>();
  private pending = new Set<Promise<void>>();
  private verified?: { token: string; appUserId: string; organizationId: string };
  readonly path: string;
  constructor(private linear: Linear, stateDir: string) {
    this.path = join(stateDir, "mcp-auth.sock");
  }
  async start() {
    try {
      if (!lstatSync(this.path).isSocket()) throw Error("MCP auth path is not a socket");
      const live = await new Promise<boolean>((resolve) => {
        const probe = createConnection(this.path);
        probe.once("connect", () => { probe.destroy(); resolve(true); });
        probe.once("error", (e: NodeJS.ErrnoException) => resolve(e.code !== "ECONNREFUSED"));
        probe.setTimeout(1000, () => { probe.destroy(); resolve(true); });
      });
      if (live) throw Error("MCP auth socket already in use");
      unlinkSync(this.path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      socket.on("error", () => {});
      socket.setTimeout(20000, () => socket.destroy());
      // 客户端必须明确请求，连接探活本身不触发认证或续期。
      socket.once("data", (data) => {
        if (data.toString() !== "headers\n") { socket.destroy(); return; }
        const task = this.headers().then(
          (value) => { if (!socket.destroyed) socket.end(JSON.stringify(value) + "\n"); },
          () => { if (!socket.destroyed) socket.end(JSON.stringify({error: "App authentication unavailable"}) + "\n"); },
        ).finally(() => this.pending.delete(task));
        this.pending.add(task);
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.path, () => {
        // stateDir 已由 Store 限制为 0700，socket 本身再限制为 0600。
        chmodSync(this.path, 0o600);
        this.server!.removeListener("error", reject);
        resolve();
      });
    });
    this.server.on("error", () => {});
  }
  private async headers() {
    const t = await this.linear.token();
    if (!this.verified || this.verified.token !== t.accessToken) {
      const d = await this.linear.query<{ viewer: { id: string }; organization: { id: string } }>(
        "query { viewer { id } organization { id } }", {}, t.accessToken,
      );
      if (!t.appUserId || d.viewer.id !== t.appUserId || d.organization.id !== this.linear.organizationId())
        throw Error("App identity mismatch");
      this.verified = { token: t.accessToken, appUserId: d.viewer.id, organizationId: d.organization.id };
    }
    return { appUserId: this.verified.appUserId, organizationId: this.verified.organizationId,
      headers: { Authorization: `Bearer ${t.accessToken}` } };
  }
  async stop() {
    const closed = this.server ? new Promise<void>((resolve) => this.server!.close(() => resolve())) : Promise.resolve();
    for (const socket of this.sockets) socket.destroy();
    await Promise.allSettled([...this.pending]);
    await closed;
    this.verified = undefined;
    this.server = undefined;
  }
}
