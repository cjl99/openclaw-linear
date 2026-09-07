import { isAbsolute } from "node:path";
import { readFileSync, statSync } from "node:fs";
export interface Config {
  agentId: string;
  organizationId?: string;
  organizationUrlKey?: string;
  teamIds: string[];
  publicOrigin: string;
  stateDir: string;
  credentialsFile: string;
  autoAssignUserIds?: string[];
}
export interface Secrets {
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
}
export function config(value: unknown): Config {
  const c = value as Config;
  if (
    !c ||
    !c.agentId ||
    (!c.organizationId && !c.organizationUrlKey) ||
    !Array.isArray(c.teamIds) ||
    !c.teamIds.length ||
    c.teamIds.some((x) => typeof x !== "string" || !x)
  )
    throw Error("agentId, organizationId and explicit teamIds required");
  if (!isAbsolute(c.stateDir) || !isAbsolute(c.credentialsFile))
    throw Error("Use absolute private state and credential paths");
  if (
    c.autoAssignUserIds !== undefined &&
    (!Array.isArray(c.autoAssignUserIds) ||
      c.autoAssignUserIds.some(
        (id) => typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id),
      ))
  )
    throw Error("autoAssignUserIds must contain Linear user UUIDs");
  const u = new URL(c.publicOrigin);
  if (u.protocol !== "https:" || u.origin !== c.publicOrigin)
    throw Error("publicOrigin must be an HTTPS origin");
  return c;
}
export function secrets(c: Config): Secrets {
  if (statSync(c.credentialsFile).mode & 0o077)
    throw Error("Credential file requires mode 600");
  const s = JSON.parse(readFileSync(c.credentialsFile, "utf8")) as Secrets;
  if (!s.clientId || !s.clientSecret || !s.webhookSecret)
    throw Error("Incomplete Linear app credentials");
  return s;
}
