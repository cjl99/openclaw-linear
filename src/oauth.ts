import { randomBytes, createHash } from "node:crypto";
import type { Config, Secrets } from "./config.js";
import { Store } from "./store.js";
import { Linear } from "./linear.js";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export function authorizationUrl(c: Config, s: Secrets, store: Store) {
  const state = randomBytes(32).toString("hex");
  store.set(`oauth:${digest(state)}`, { expires: Date.now() + 600000 });
  const url = new URL("https://linear.app/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: s.clientId,
    redirect_uri: `${c.publicOrigin}/linear/oauth/callback`,
    response_type: "code",
    scope: "read,write,app:assignable,app:mentionable",
    actor: "app",
    state,
  }).toString();
  return url.toString();
}
export async function callback(
  url: URL,
  c: Config,
  store: Store,
  linear: Linear,
) {
  const state = url.searchParams.get("state") || "";
  if (!/^[a-f0-9]{64}$/.test(state)) throw Error("Invalid state");
  const nonce = store.take<{ expires: number }>(`oauth:${digest(state)}`);
  if (!nonce || nonce.expires < Date.now())
    throw Error("Expired or consumed state");
  const code = url.searchParams.get("code");
  if (!code || url.searchParams.has("error"))
    throw Error("Authorization not completed");
  const token = await linear.exchange({
    grant_type: "authorization_code",
    code,
    redirect_uri: `${c.publicOrigin}/linear/oauth/callback`,
  });
  await linear.install(token);
}
