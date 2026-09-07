import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { Event } from "./store.js";

export function sessionTitle(e: Event): string | undefined {
  if (!e.issueIdentifier || !/^[A-Za-z0-9_-]+-\d+$/.test(e.issueIdentifier)) return;
  const title = (e.issueTitle ?? "")
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ").trim();
  const full = title ? `${e.issueIdentifier} · ${title}` : e.issueIdentifier;
  return Array.from(full).slice(0, 120).join("");
}

export async function updateSessionTitle(
  api: OpenClawPluginApi, agentId: string, sessionKey: string, e: Event,
) {
  const displayName = sessionTitle(e);
  if (!displayName) return;
  // Only patch presentation metadata on the existing host-owned session.
  // Explicit user labels, identity, transcript and native thread binding survive.
  await api.runtime.agent.session.patchSessionEntry({
    agentId, sessionKey, preserveActivity: true,
    update: (entry) => entry.displayName === displayName ? null : { displayName },
  });
}
