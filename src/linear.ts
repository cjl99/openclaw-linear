import type { Config, Secrets } from "./config.js";
import { Store, type Event } from "./store.js";
import { presentation } from "./presentation.js";
export interface Token {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  appUserId: string;
}
export class Linear {
  private refreshing?: Promise<Token>;
  constructor(
    private c: Config,
    private s: Secrets,
    private store: Store,
    private http: typeof fetch = fetch,
  ) {}
  async exchange(fields: Record<string, string>) {
    const r = await this.http("https://api.linear.app/oauth/token", {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.s.clientId,
        client_secret: this.s.clientSecret,
        ...fields,
      }),
    });
    if (!r.ok) throw Error(`OAuth HTTP ${r.status}`);
    const t = (await r.json()) as any;
    if (!t.access_token || !t.refresh_token || !Number.isFinite(t.expires_in))
      throw Error("Invalid OAuth token response");
    return {
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      expiresAt: Date.now() + t.expires_in * 1000,
      appUserId: "",
    } as Token;
  }
  async token(): Promise<Token> {
    if (this.store.get("revoked")) throw Error("Linear authorization revoked");
    const t = this.store.get<Token>("token");
    if (!t) throw Error("Linear authorization required");
    if (t.expiresAt > Date.now() + 60000) return t;
    return (this.refreshing ??= this.exchange({
      grant_type: "refresh_token",
      refresh_token: t.refreshToken,
    })
      .then((n) => {
        if (this.store.get("revoked"))
          throw Error("Linear authorization revoked during refresh");
        n.appUserId = t.appUserId;
        this.store.set("token", n);
        return n;
      })
      .finally(() => {
        this.refreshing = undefined;
      }));
  }
  async query<T>(
    query: string,
    variables: Record<string, unknown> = {},
    token?: string,
    timeoutMs = 15000,
  ): Promise<T> {
    const r = await this.http("https://api.linear.app/graphql", {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token ?? (await this.token()).accessToken}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!r.ok) throw Error(`Linear HTTP ${r.status}`);
    const d = (await r.json()) as any;
    if (d.errors?.length || !d.data)
      throw Error("Linear GraphQL request failed");
    return d.data;
  }
  async install(t: Token) {
    const d = await this.query<any>(
      "query { organization { id urlKey } viewer { id } teams { nodes { id } } }",
      {},
      t.accessToken,
    );
    if (
      (this.c.organizationId && d.organization.id !== this.c.organizationId) ||
      (this.c.organizationUrlKey &&
        d.organization.urlKey !== this.c.organizationUrlKey) ||
      (this.store.get<string>("organizationId") &&
        d.organization.id !== this.store.get<string>("organizationId")) ||
      this.c.teamIds.some((id) => !d.teams.nodes.some((x: any) => x.id === id))
    )
      throw Error("Installation outside configured workspace/team");
    t.appUserId = d.viewer.id;
    this.store.set("organizationId", d.organization.id);
    this.store.set("token", t);
    this.store.take("revoked");
  }
  organizationId() {
    return this.c.organizationId ?? this.store.get<string>("organizationId");
  }
  async authorizeEvent(e: Event) {
    if (this.store.get("revoked") || e.organizationId !== this.organizationId())
      return false;
    const t = await this.token();
    const d = await this.query<any>(
      "query($id:String!){ organization { id } agentSession(id:$id){ appUser { id } issue { id identifier title team { id } } } }",
      { id: e.sessionId },
    );
    const s = d.agentSession;
    const authorized =
      !this.store.get("revoked") &&
      !this.store.get<{ denied: boolean }>(
        `team-permission:${s?.issue?.team?.id}`,
      )?.denied &&
      d.organization.id === this.organizationId() &&
      s?.appUser?.id === t.appUserId &&
      s.issue?.id === e.issueId &&
      this.c.teamIds.includes(s.issue.team.id);
    if (authorized) {
      this.store.set(`team:${e.sessionId}`, s.issue.team.id);
      e.issueIdentifier = s.issue.identifier;
      e.issueTitle = s.issue.title;
    }
    return authorized;
  }
  async activity(sessionId: string, id: string, type: string, body: string) {
    return this.content(sessionId, id, { type, body });
  }
  async link(sessionId: string, url: string) {
    const d = await this.query<any>(
      "mutation($id:String!,$input:AgentSessionUpdateInput!){agentSessionUpdate(id:$id,input:$input){success}}",
      {
        id: sessionId,
        input: {
          addedExternalUrls: [
            { label: presentation(this.c.locale).linkLabel, url },
          ],
        },
      },
      undefined,
      2000,
    );
    if (!d.agentSessionUpdate.success) throw Error("Session link not accepted");
  }
  async content(
    sessionId: string,
    id: string,
    content: Record<string, unknown>,
    ephemeral = false,
    timeoutMs = 15000,
    signal?: { signal?: string; signalMetadata?: Record<string, unknown> },
  ) {
    // Stable UUID survives retry. Check before creating when a previous response was lost.
    const attemptKey = `activity:${sessionId}:${id}`;
    const attempt = this.store.get<string>(attemptKey);
    if (attempt === "done") return;
    let before: string | undefined;
    const cursors = new Set<string>();
    for (let page = 0; ; page++) {
      if (page === 200) throw Error("Activity deduplication pagination limit");
      const exists = await this.query<any>(
        "query($id:String!,$before:String){ agentSession(id:$id){ activities(last:100,before:$before){ nodes { id } pageInfo{hasPreviousPage startCursor} } } }",
        { id: sessionId, before },
        undefined,
        timeoutMs,
      );
      const activities = exists.agentSession.activities;
      if (activities.nodes.some((a: any) => a.id === id)) {
        this.store.set(attemptKey, "done");
        return;
      }
      if (!attempt || !activities.pageInfo?.hasPreviousPage) break;
      before = activities.pageInfo.startCursor;
      if (!before || cursors.has(before))
        throw Error("Invalid activity deduplication cursor");
      cursors.add(before);
    }
    this.store.set(attemptKey, "pending");
    const d = await this.query<any>(
      "mutation($input:AgentActivityCreateInput!){ agentActivityCreate(input:$input){ success } }",
      {
        input: {
          id,
          agentSessionId: sessionId,
          content,
          ephemeral,
          ...(signal?.signal
            ? { signal: signal.signal, signalMetadata: signal.signalMetadata }
            : {}),
        },
      },
      undefined,
      timeoutMs,
    );
    if (!d.agentActivityCreate.success) throw Error("Activity not accepted");
    this.store.set(attemptKey, "done");
  }
  async updateSession(sessionId: string, input: Record<string, unknown>) {
    const d = await this.query<any>(
      "mutation($id:String!,$input:AgentSessionUpdateInput!){agentSessionUpdate(id:$id,input:$input){success}}",
      { id: sessionId, input },
    );
    if (!d.agentSessionUpdate.success) throw Error("Session update rejected");
  }
  async history(e: Event, after?: string) {
    if (!(await this.authorizeEvent(e))) throw Error("Session not authorized");
    return this.query<any>(
      `query($id:String!,$after:String){agentSession(id:$id){activities(first:100,after:$after){nodes{id createdAt signal signalMetadata ephemeral content {
      ... on AgentActivityPromptContent {type body}
      ... on AgentActivityThoughtContent {type body}
      ... on AgentActivityResponseContent {type body}
      ... on AgentActivityErrorContent {type body}
      ... on AgentActivityElicitationContent {type body}
      ... on AgentActivityActionContent {type action parameter result}
    }} pageInfo{hasNextPage endCursor}}}}`,
      { id: e.sessionId, after },
    );
  }
  async repositories(
    e: Event,
    candidates: { hostname: string; repositoryFullName: string }[],
  ) {
    if (!(await this.authorizeEvent(e))) throw Error("Session not authorized");
    const d = await this.query<any>(
      "query($issue:String!,$session:String!,$candidates:[CandidateRepository!]!){issueRepositorySuggestions(issueId:$issue,agentSessionId:$session,candidateRepositories:$candidates){suggestions{hostname repositoryFullName confidence}}}",
      { issue: e.issueId, session: e.sessionId, candidates },
    );
    return d.issueRepositorySuggestions;
  }
  async createSession(
    kind: "issue" | "comment",
    target: string,
    requestKey: string,
  ) {
    // API has no client-supplied idempotency key. Persist uncertainty BEFORE mutation;
    // a lost response must never automatically create another session.
    const key = `proactive:${requestKey}`;
    const existing = this.store.get<any>(key);
    if (existing) {
      if (existing.kind !== kind || existing.target !== target)
        throw Error("Request key already used for a different target");
      if (!existing.session)
        throw Error(
          "Previous creation outcome unknown; inspect Linear before a new request",
        );
      return existing.session;
    }
    const lookup =
      kind === "issue"
        ? "query($id:String!){organization{id} issue(id:$id){id archivedAt team{id}}}"
        : "query($id:String!){organization{id} comment(id:$id){issue{id archivedAt team{id}}}}";
    const d = await this.query<any>(lookup, { id: target });
    const issue = kind === "issue" ? d.issue : d.comment?.issue;
    if (
      d.organization.id !== this.organizationId() ||
      !issue ||
      issue.archivedAt ||
      !this.c.teamIds.includes(issue.team.id) ||
      this.store.get<{ denied: boolean }>(`team-permission:${issue.team.id}`)
        ?.denied
    )
      throw Error("Target outside allowed workspace/team");
    // Recheck after asynchronous authorization to close concurrent duplicate calls.
    if (this.store.get(key))
      throw Error("Creation already in progress; retry with same request key");
    this.store.set(key, { kind, target });
    const name =
      kind === "issue"
        ? "agentSessionCreateOnIssue"
        : "agentSessionCreateOnComment";
    const type =
      kind === "issue"
        ? "AgentSessionCreateOnIssue"
        : "AgentSessionCreateOnComment";
    const result = await this.query<any>(
      `mutation($input:${type}!){${name}(input:$input){success agentSession{id}}}`,
      {
        input: kind === "issue" ? { issueId: issue.id } : { commentId: target },
      },
    );
    if (!result[name]?.success || !result[name]?.agentSession?.id)
      throw Error("Session creation unconfirmed");
    const session = {
      sessionId: result[name].agentSession.id,
      issueId: issue.id,
    };
    this.store.set(key, { kind, target, session });
    return session;
  }
}
