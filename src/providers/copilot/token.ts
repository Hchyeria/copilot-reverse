import type { CopilotEntitlement } from "./account.js";
import { githubRestOrigin, type GitHubConnection } from "../../shared/github-connection.js";
import { DEFAULT_COPILOT_INFERENCE_ORIGIN, type CopilotSession } from "./session.js";

interface CopilotTokenResponse {
  token?: string;
  expires_at?: number;
  sku?: string;
  access_type_sku?: string;
  chat_enabled?: boolean;
  individual?: boolean;
  endpoints?: { api?: unknown };
}

export type { CopilotSession } from "./session.js";

export class CopilotAuthError extends Error {
  constructor(public readonly status: number) {
    super(
      status === 401 || status === 403
        ? "GitHub login expired — restart copilot-reverse (or run `copilot-reverse login`) to re-authenticate"
        : `copilot token exchange failed: ${status}`,
    );
    this.name = "CopilotAuthError";
  }
}

export class CopilotEntitlementError extends Error {
  readonly code = "COPILOT_ENTITLEMENT_ERROR";

  constructor(connection: GitHubConnection) {
    super(`GitHub Copilot chat is disabled for ${connection.type === "github" ? "github.com" : connection.host}.`);
    this.name = "CopilotEntitlementError";
  }
}

export class CopilotEndpointContractError extends Error {
  readonly code = "COPILOT_ENDPOINT_CONTRACT_ERROR";

  constructor(connection: GitHubConnection) {
    super(
      connection.type === "ghecom"
        ? `GitHub Copilot for ${connection.host} did not provide a supported HTTPS inference endpoint. Re-login will not fix this endpoint contract.`
        : "GitHub Copilot returned an invalid inference endpoint.",
    );
    this.name = "CopilotEndpointContractError";
  }
}

type GithubTokenProvider = string | (() => string | null | Promise<string | null>);

export interface CopilotTokenStoreOptions {
  connection?: GitHubConnection;
}

function normalizeInferenceOrigin(value: unknown, connection: GitHubConnection): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const allowedHost = connection.type === "github" ? "githubcopilot.com" : connection.host;
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      (url.pathname !== "" && url.pathname !== "/") ||
      (url.hostname !== allowedHost && !url.hostname.endsWith(`.${allowedHost}`))
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function entitlementOf(data: CopilotTokenResponse): CopilotEntitlement | undefined {
  const sku = data.sku ?? data.access_type_sku;
  if (!sku) return undefined;
  return {
    sku,
    chatEnabled: data.chat_enabled ?? false,
    individual: data.individual ?? false,
  };
}

export class CopilotTokenStore {
  private cached?: CopilotSession;
  private pending?: Promise<CopilotSession>;
  private readGhToken: () => string | null | Promise<string | null>;
  private connection: GitHubConnection;

  constructor(
    ghToken: GithubTokenProvider,
    private fetchFn: typeof fetch = fetch,
    private nowMs: () => number = () => Date.now(),
    options: CopilotTokenStoreOptions = {},
  ) {
    this.readGhToken = typeof ghToken === "function" ? ghToken : () => ghToken;
    this.connection = options.connection ?? { type: "github", token: typeof ghToken === "string" ? ghToken : "" };
  }

  async get(): Promise<string> {
    return (await this.getSession()).token;
  }

  async getSession(): Promise<CopilotSession> {
    const skewMs = 60_000;
    if (this.cached && this.cached.expiresAtMs - skewMs > this.nowMs()) return this.cached;
    if (this.pending) return this.pending;

    const refresh = this.refreshSession();
    this.pending = refresh;
    try {
      return await refresh;
    } finally {
      if (this.pending === refresh) this.pending = undefined;
    }
  }

  private async refreshSession(): Promise<CopilotSession> {
    const ghToken = await this.readGhToken();
    if (!ghToken) throw new CopilotAuthError(401);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let res: Response;
    try {
      const url = this.connection.type === "github"
        ? `${githubRestOrigin(this.connection)}/copilot_internal/v2/token`
        : `https://${this.connection.host}/api/v3/copilot_internal/user`;
      res = await this.fetchFn(url, {
        headers: { authorization: `token ${ghToken}`, accept: "application/json" },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      if (this.connection.type === "ghecom" && res.status !== 401 && res.status !== 403) {
        throw new CopilotEndpointContractError(this.connection);
      }
      throw new CopilotAuthError(res.status);
    }

    const data = (await res.json()) as CopilotTokenResponse;
    if (this.connection.type === "ghecom" && data.chat_enabled === false) {
      throw new CopilotEntitlementError(this.connection);
    }
    const explicitOrigin = normalizeInferenceOrigin(data.endpoints?.api, this.connection);
    const inferenceOrigin = explicitOrigin ?? (
      this.connection.type === "github" && data.endpoints?.api === undefined
        ? DEFAULT_COPILOT_INFERENCE_ORIGIN
        : null
    );
    if (!inferenceOrigin) throw new CopilotEndpointContractError(this.connection);

    const session: CopilotSession = {
      token: this.connection.type === "ghecom" ? ghToken : data.token!,
      expiresAtMs: this.connection.type === "ghecom"
        ? this.nowMs() + 60 * 60 * 1000
        : data.expires_at! * 1000,
      entitlement: entitlementOf(data),
      inferenceOrigin,
    };
    this.cached = session;
    return session;
  }

  getEntitlement(): CopilotEntitlement | undefined {
    return this.cached?.entitlement;
  }
}

export async function isCopilotTokenValid(ghToken: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  return (await probeGithubAuth(ghToken, fetchFn)).ok;
}

export interface AuthProbe { ok: boolean; transient: boolean; detail: string }
export async function probeGithubAuth(ghToken: string, fetchFn: typeof fetch = fetch): Promise<AuthProbe> {
  try {
    await new CopilotTokenStore(ghToken, fetchFn).get();
    return { ok: true, transient: false, detail: "token valid" };
  } catch (e) {
    if (e instanceof CopilotAuthError && (e.status === 401 || e.status === 403)) {
      return { ok: false, transient: false, detail: e.message };
    }
    return { ok: false, transient: true, detail: e instanceof Error ? e.message : String(e) };
  }
}
