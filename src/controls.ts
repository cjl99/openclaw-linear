import { Store, type Event } from "./store.js";
import type { Config } from "./config.js";
import type { Token } from "./linear.js";
import { createHash } from "node:crypto";

export class RejectedControl extends Error {}

/** Called only AFTER signature/timestamp/organization validation. No network before cancellation. */
export function controls(
  p: any,
  c: Config,
  clientId: string,
  store: Store,
  stop: (e: Event) => void,
): boolean {
  if (!["OAuthApp", "PermissionChange", "AppUserNotification"].includes(p.type))
    return false;
  if (
    p.organizationId !== (c.organizationId ?? store.get("organizationId")) ||
    p.oauthClientId !== clientId
  )
    throw new RejectedControl("Wrong application/workspace");
  if (
    p.type !== "OAuthApp" &&
    (!p.appUserId || p.appUserId !== store.get<Token>("token")?.appUserId)
  )
    throw new RejectedControl("Wrong app user");
  const identity =
    p.type === "AppUserNotification" ? p.notification?.id : p.webhookId;
  if (typeof identity !== "string" || !identity)
    throw new RejectedControl("Missing control identity");
  // webhookId identifies a subscription, not a unique permission transition.
  // Delivery timestamps change on retries, so hash semantic fields instead.
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        identity,
        p.action,
        p.createdAt,
        p.addedTeamIds,
        p.removedTeamIds,
      ]),
    )
    .digest("hex");
  const key = `control:${p.type}:${fingerprint}`;
  if (store.get(key)) return true;
  let match: (e: Event) => boolean = () => false;
  if (p.type === "OAuthApp" && p.action === "revoked") {
    store.set("revoked", true);
    match = () => true;
  } else if (
    p.type === "PermissionChange" &&
    p.action === "teamAccessChanged"
  ) {
    if (
      !Array.isArray(p.removedTeamIds) ||
      !Array.isArray(p.addedTeamIds) ||
      [...p.removedTeamIds, ...p.addedTeamIds].some(
        (id) => typeof id !== "string",
      )
    )
      throw new RejectedControl("Invalid team permissions");
    const time = Date.parse(p.createdAt);
    if (!Number.isFinite(time))
      throw new RejectedControl("Invalid permission timestamp");
    for (const [ids, denied] of [
      [p.addedTeamIds, false],
      [p.removedTeamIds, true],
    ] as const) {
      for (const team of ids) {
        const previous = store.get<{ time: number; denied: boolean }>(
          `team-permission:${team}`,
        );
        if (
          !previous ||
          time > previous.time ||
          (time === previous.time && denied)
        )
          store.set(`team-permission:${team}`, { time, denied });
      }
    }
    match = (e) => {
      const team = store.get<string>(`team:${e.sessionId}`);
      return Boolean(
        team &&
          store.get<{ denied: boolean }>(`team-permission:${team}`)?.denied,
      );
    };
  } else if (p.type === "AppUserNotification") {
    const issueId = p.notification?.issueId ?? p.notification?.issue?.id;
    // Notifications are observations, not prompts; never start duplicate work.
    store.set(`notification:${identity}`, {
      action: p.action,
      issueId,
      createdAt: p.createdAt,
    });
    if (p.action === "issueUnassignedFromYou" && typeof issueId === "string")
      match = (e) => e.issueId === issueId;
  }
  for (const row of store.db
    .prepare("SELECT value FROM kv WHERE key LIKE 'binding:%'")
    .all()) {
    const e = JSON.parse(row.value as string) as Event;
    if (match(e))
      stop({ ...e, id: `${key}:${e.sessionId}`, action: "stop", prompt: "" });
  }
  store.set(key, true);
  return true;
}
