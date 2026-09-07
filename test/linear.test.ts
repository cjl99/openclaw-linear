import { test, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { Linear } from "../src/linear.js";
test("parallel expired-token requests share one refresh and preserve app identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "linear-api-test-"));
  const s = new Store(dir);
  try {
    s.set("token", {
      accessToken: "expired",
      refreshToken: "refresh",
      expiresAt: 0,
      appUserId: "app",
    });
    const http = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "new",
            refresh_token: "rotated",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
    );
    const l = new Linear(
      { organizationId: "org" } as any,
      { clientId: "id", clientSecret: "secret" } as any,
      s,
      http as any,
    );
    const [a, b] = await Promise.all([l.token(), l.token()]);
    expect(http).toHaveBeenCalledTimes(1);
    expect(a.appUserId).toBe("app");
    expect(b.refreshToken).toBe("rotated");
    expect(s.get<any>("token").accessToken).toBe("new");
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("OAuth installation cannot replace token with another workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "linear-api-test-"));
  const s = new Store(dir);
  try {
    const http = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              organization: { id: "other-org" },
              viewer: { id: "app" },
              teams: { nodes: [{ id: "t" }] },
            },
          }),
        ),
    );
    const l = new Linear(
      { organizationId: "test", teamIds: ["t"] } as any,
      {} as any,
      s,
      http as any,
    );
    await expect(
      l.install({
        accessToken: "x",
        refreshToken: "y",
        expiresAt: 1,
        appUserId: "",
      }),
    ).rejects.toThrow();
    expect(s.get("token")).toBeUndefined();
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bootstrap pins workspace ID only after slug and team verification", async () => {
  const dir = mkdtempSync(join(tmpdir(), "linear-bootstrap-test-"));
  const s = new Store(dir);
  let org = { id: "org-a", urlKey: "wrong" };
  let teams = [{ id: "team-a" }];
  const http = async () =>
    new Response(
      JSON.stringify({
        data: {
          organization: org,
          viewer: { id: "app" },
          teams: { nodes: teams },
        },
      }),
    );
  const cfg = {
    organizationUrlKey: "example-workspace",
    teamIds: ["team-a"],
  } as any;
  const token = {
    accessToken: "test",
    refreshToken: "test",
    expiresAt: Date.now() + 3600000,
    appUserId: "",
  };
  try {
    const l = new Linear(cfg, {} as any, s, http as any);
    expect(l.organizationId()).toBeUndefined();
    await expect(l.install(token)).rejects.toThrow();
    org.urlKey = "example-workspace";
    teams = [];
    await expect(l.install(token)).rejects.toThrow();
    expect(s.get("token")).toBeUndefined();
    teams = [{ id: "team-a" }];
    await l.install(token);
    expect(new Linear(cfg, {} as any, s).organizationId()).toBe("org-a");
    org.id = "org-b";
    await expect(l.install(token)).rejects.toThrow();
    expect(l.organizationId()).toBe("org-a");
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
