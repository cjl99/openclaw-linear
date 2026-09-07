import { readFileSync } from "node:fs";
import { config, secrets } from "./config.js";
import { Store } from "./store.js";
import { authorizationUrl } from "./oauth.js";
const c = config(JSON.parse(readFileSync(process.argv[2], "utf8")));
const store = new Store(c.stateDir);
try {
  console.log(authorizationUrl(c, secrets(c), store));
} finally {
  store.close();
}
