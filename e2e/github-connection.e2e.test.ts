import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as authModule from "../src/cli/auth.js";
import * as credsModule from "../src/shared/creds.js";
import { fetchGithubUser } from "../src/providers/copilot/account.js";
import { CopilotEndpointContractError, CopilotTokenStore } from "../src/providers/copilot/token.js";
import { fetchModelDiscovery } from "../src/providers/copilot/models.js";
import { CopilotAdapter } from "../src/providers/copilot/adapter.js";
import { borrowSearch } from "../src/providers/copilot/borrow-search.js";
import type { CanonicalRequest } from "../src/core/canonical.js";

type GitHubConnection =
  | { type: "github"; token: string }
  | { type: "ghecom"; host: string };

type GhAuth = {
  isAvailable: () => Promise<boolean>;
  login: (host: string) => Promise<void>;
  token: (host: string) => Promise<string>;
};

type AuthApi = {
  loginGitHubConnection: (
    request: { type: "github" } | { type: "ghecom"; host: string },
    dir: string,
    options?: { fetchFn?: typeof fetch; log?: (message: string) => void; ghAuth?: GhAuth },
  ) => Promise<void>;
  logoutGitHubConnection: (dir: string) => void;
  retrieveGitHubToken: (connection: GitHubConnection, ghAuth?: GhAuth) => Promise<string>;
  normalizeGhecomHost: (input: string) => string;
};

type CredsApi = {
  readGitHubConnection: (dir: string) => GitHubConnection | null;
};

const auth = authModule as unknown as AuthApi;
const creds = credsModule as unknown as CredsApi;
const dirs: string[] = [];

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "copilot-reverse-ghecom-"));
  dirs.push(dir);
  return dir;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function deviceFlow(token = "gho_github_token"): typeof fetch {
  return vi.fn()
    .mockResolvedValueOnce(json({
      device_code: "device-code",
      user_code: "AB-12",
      verification_uri: "https://github.com/login/device",
      interval: 0,
      expires_in: 900,
    }))
    .mockResolvedValueOnce(json({ access_token: token })) as unknown as typeof fetch;
}

function ghFake(options: {
  available?: boolean;
  loginError?: Error;
  token?: string;
  tokenError?: Error;
} = {}) {
  const isAvailable = vi.fn(async () => options.available ?? true);
  const login = vi.fn(async () => {
    if (options.loginError) throw options.loginError;
  });
  const token = vi.fn(async () => {
    if (options.tokenError) throw options.tokenError;
    return options.token ?? "enterprise-secret-token";
  });
  const logout = vi.fn();
  return { auth: { isAvailable, login, token } satisfies GhAuth, isAvailable, login, token, logout };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("GitHub connection lifecycle", () => {
  it("EP-50 reads legacy credentials as GitHub.com without touching gh", async () => {
    const dir = dataDir();
    writeFileSync(join(dir, "creds.json"), JSON.stringify({ ghToken: "legacy-token" }));
    const gh = ghFake({ available: false });

    const connection = creds.readGitHubConnection(dir);

    expect(connection).toEqual({ type: "github", token: "legacy-token" });
    await expect(auth.retrieveGitHubToken(connection!, gh.auth)).resolves.toBe("legacy-token");
    expect(gh.isAvailable).not.toHaveBeenCalled();
    expect(gh.login).not.toHaveBeenCalled();
    expect(gh.token).not.toHaveBeenCalled();
  });

  it("selecting GitHub.com never checks or invokes gh", async () => {
    const dir = dataDir();
    const gh = ghFake({ available: false });
    const log = vi.fn();

    await auth.loginGitHubConnection(
      { type: "github" },
      dir,
      { fetchFn: deviceFlow(), ghAuth: gh.auth, log },
    );

    expect(creds.readGitHubConnection(dir)).toEqual({ type: "github", token: "gho_github_token" });
    expect(gh.isAvailable).not.toHaveBeenCalled();
    expect(gh.login).not.toHaveBeenCalled();
    expect(gh.token).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(" ")).not.toContain("cli.github.com");
  });

  it.each([
    ["acme.ghe.com", "acme.ghe.com"],
    ["ACME.GHE.COM", "acme.ghe.com"],
    ["engineering.eu.ghe.com", "engineering.eu.ghe.com"],
    ["a-b.9.ghe.com", "a-b.9.ghe.com"],
  ])("normalizes valid GHE.com hostname %s", (input, expected) => {
    expect(auth.normalizeGhecomHost(input)).toBe(expected);
  });

  it.each([
    "",
    "ghe.com",
    "github.com",
    "https://acme.ghe.com",
    "http://acme.ghe.com",
    "acme.ghe.com/path",
    "acme.ghe.com\\path",
    "acme.ghe.com?query=1",
    "acme.ghe.com#fragment",
    "user@acme.ghe.com",
    "acme.ghe.com:443",
    "acme.ghe.com.evil.test",
    "acmeghe.com",
    ".acme.ghe.com",
    "acme..ghe.com",
    "-acme.ghe.com",
    "acme-.ghe.com",
    "ac_me.ghe.com",
    "équipe.ghe.com",
    " acme.ghe.com",
    "acme.ghe.com ",
    "ac me.ghe.com",
    `${"a".repeat(64)}.ghe.com`,
    `${Array(5).fill("a".repeat(63)).join(".")}.ghe.com`,
  ])("rejects invalid GHE.com hostname %s before touching gh", async (input) => {
    const gh = ghFake();
    const dir = dataDir();

    expect(() => auth.normalizeGhecomHost(input)).toThrow(/GHE\.com hostname/i);
    await expect(auth.loginGitHubConnection(
      { type: "ghecom", host: input },
      dir,
      { ghAuth: gh.auth },
    )).rejects.toThrow(/GHE\.com hostname/i);
    expect(gh.isAvailable).not.toHaveBeenCalled();
    expect(gh.login).not.toHaveBeenCalled();
    expect(gh.token).not.toHaveBeenCalled();
  });

  it("shows the official gh install URL only for the enterprise branch", async () => {
    const githubDir = dataDir();
    const enterpriseDir = dataDir();
    const gh = ghFake({ available: false });
    const log = vi.fn();

    await expect(auth.loginGitHubConnection(
      { type: "github" },
      githubDir,
      { fetchFn: deviceFlow(), ghAuth: gh.auth, log },
    )).resolves.toBeUndefined();
    expect(log.mock.calls.flat().join(" ")).not.toContain("https://cli.github.com/");

    await expect(auth.loginGitHubConnection(
      { type: "ghecom", host: "acme.ghe.com" },
      enterpriseDir,
      { ghAuth: gh.auth },
    )).rejects.toThrow(/https:\/\/cli\.github\.com\//);
    expect(gh.isAvailable).toHaveBeenCalledTimes(1);
    expect(gh.login).not.toHaveBeenCalled();
    expect(gh.token).not.toHaveBeenCalled();
  });

  it("successful enterprise login verifies gh and saves only normalized type and host", async () => {
    const dir = dataDir();
    const gh = ghFake({ token: "must-never-be-persisted" });

    await auth.loginGitHubConnection(
      { type: "ghecom", host: "Acme.GHE.com" },
      dir,
      { ghAuth: gh.auth },
    );

    expect(gh.isAvailable).toHaveBeenCalledTimes(1);
    expect(gh.login).not.toHaveBeenCalled();
    expect(gh.token).toHaveBeenCalledWith("acme.ghe.com");
    expect(creds.readGitHubConnection(dir)).toEqual({ type: "ghecom", host: "acme.ghe.com" });
    const persisted = readFileSync(join(dir, "creds.json"), "utf8");
    expect(JSON.parse(persisted)).toEqual({ type: "ghecom", host: "acme.ghe.com", authSource: "gh" });
    expect(persisted).not.toContain("must-never-be-persisted");
    expect(persisted).not.toContain("token");
  });

  it.each([
    ["login failure", { tokenError: new Error("missing"), loginError: new Error("cancelled") }],
    ["credential verification failure", { tokenError: new Error("verification failed") }],
  ])("preserves the old connection after %s", async (_label, failure) => {
    const dir = dataDir();
    const previous = JSON.stringify({ ghToken: "old-token" });
    writeFileSync(join(dir, "creds.json"), previous);
    const gh = ghFake(failure);

    await expect(auth.loginGitHubConnection(
      { type: "ghecom", host: "acme.ghe.com" },
      dir,
      { ghAuth: gh.auth },
    )).rejects.toThrow();

    expect(readFileSync(join(dir, "creds.json"), "utf8")).toBe(previous);
    expect(creds.readGitHubConnection(dir)).toEqual({ type: "github", token: "old-token" });
  });

  it("logout removes only project state and never calls gh logout", () => {
    const dir = dataDir();
    writeFileSync(join(dir, "creds.json"), JSON.stringify({ type: "ghecom", host: "acme.ghe.com", authSource: "gh" }));
    const gh = ghFake();

    auth.logoutGitHubConnection(dir);

    expect(creds.readGitHubConnection(dir)).toBeNull();
    expect(gh.logout).not.toHaveBeenCalled();
    expect(gh.isAvailable).not.toHaveBeenCalled();
    expect(gh.login).not.toHaveBeenCalled();
    expect(gh.token).not.toHaveBeenCalled();
  });

  it.each([
    ["empty output", { token: "" }],
    ["command failure", { tokenError: new Error("secret-value-from-stderr") }],
  ])("classifies enterprise token %s as reauthentication without leaking command output", async (_label, failure) => {
    const gh = ghFake(failure);
    const connection = { type: "ghecom", host: "acme.ghe.com" } as const;

    let caught: unknown;
    try {
      await auth.retrieveGitHubToken(connection, gh.auth);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: "GITHUB_REAUTHENTICATION_REQUIRED" });
    expect(String(caught)).toContain("acme.ghe.com");
    expect(String(caught)).not.toContain("secret-value-from-stderr");
  });
});


describe("EP-57 through EP-59 connection-aware upstream routing", () => {
  const enterpriseConnection = { type: "ghecom", host: "acme.ghe.com" } as const;
  const chatRequest: CanonicalRequest = {
    model: "claude-sonnet-5",
    stream: false,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  };
  const responseRequest: CanonicalRequest = { ...chatRequest, model: "gpt-5.6" };

  function enterpriseExchange(endpoint?: string) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://acme.ghe.com/api/v3/copilot_internal/user") {
        return json({
          access_type_sku: "copilot_enterprise_seat_quota",
          chat_enabled: true,
          ...(endpoint === undefined ? {} : { endpoints: { api: endpoint } }),
        });
      }
      if (url === "https://copilot.acme.ghe.com/models") return json({ data: [{ id: "claude-sonnet-5" }] });
      if (url === "https://copilot.acme.ghe.com/chat/completions") {
        return json({ id: "chat-1", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} });
      }
      if (url === "https://copilot.acme.ghe.com/responses") {
        const body = JSON.parse(init?.body as string);
        if (body.model === "gpt-5-mini") return json({ output: [] });
        return json({ id: "resp-1", model: body.model, status: "completed", output: [], usage: {} });
      }
      throw new Error(`unexpected request: ${url}`);
    });
  }

  it("EP-57 routes GHE.com /user and token exchange through its REST origin", async () => {
    const f = vi.fn(async (url: string) => {
      if (url === "https://api.acme.ghe.com/user") return json({ login: "enterprise-user" });
      if (url === "https://acme.ghe.com/api/v3/copilot_internal/user") {
        return json({ access_type_sku: "copilot_enterprise_seat_quota", chat_enabled: true, endpoints: { api: "https://copilot.acme.ghe.com/" } });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const tokenProvider = vi.fn(async () => "runtime-enterprise-token");

    await expect(fetchGithubUser({ connection: enterpriseConnection, token: "runtime-enterprise-token" }, f as unknown as typeof fetch))
      .resolves.toEqual({ login: "enterprise-user", name: null });
    const store = new CopilotTokenStore(tokenProvider, f as unknown as typeof fetch, undefined, { connection: enterpriseConnection });
    await expect(store.getSession()).resolves.toMatchObject({ inferenceOrigin: "https://copilot.acme.ghe.com" });

    expect(f.mock.calls.map((call) => call[0])).toEqual([
      "https://api.acme.ghe.com/user",
      "https://acme.ghe.com/api/v3/copilot_internal/user",
    ]);
    expect(tokenProvider).toHaveBeenCalledTimes(1);
  });

  it("EP-58 propagates one session origin to models, chat, Responses, and borrowed search", async () => {
    const f = enterpriseExchange("https://copilot.acme.ghe.com/");
    const store = new CopilotTokenStore(async () => "runtime-enterprise-token", f as unknown as typeof fetch, undefined, { connection: enterpriseConnection });

    await fetchModelDiscovery(store, f as unknown as typeof fetch);
    await new CopilotAdapter(store, f as unknown as typeof fetch).complete(chatRequest);
    await new CopilotAdapter(store, f as unknown as typeof fetch, () => ["/responses"]).complete(responseRequest);
    await borrowSearch(store, "current docs", f as unknown as typeof fetch);

    expect(f.mock.calls.map((call) => call[0])).toEqual([
      "https://acme.ghe.com/api/v3/copilot_internal/user",
      "https://copilot.acme.ghe.com/models",
      "https://copilot.acme.ghe.com/chat/completions",
      "https://copilot.acme.ghe.com/responses",
      "https://copilot.acme.ghe.com/responses",
    ]);
    expect(f.mock.calls.some((call) => call[0] === "https://api.githubcopilot.com/models")).toBe(false);
    expect(f.mock.calls.some((call) => call[0] === "https://api.githubcopilot.com/chat/completions")).toBe(false);
    expect(f.mock.calls.some((call) => call[0] === "https://api.githubcopilot.com/responses")).toBe(false);
  });


  it("EP-58 refresh replaces both the bearer token and inference origin", async () => {
    let now = 0;
    let exchange = 0;
    let runtimeToken = "runtime-enterprise-token-1";
    const calls: Array<{ url: string; authorization?: string }> = [];
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://acme.ghe.com/api/v3/copilot_internal/user") {
        exchange += 1;
        return json({
          access_type_sku: "copilot_enterprise_seat_quota",
          endpoints: { api: exchange === 1 ? "https://first.acme.ghe.com" : "https://second.acme.ghe.com/" },
        });
      }
      calls.push({ url, authorization: (init?.headers as Record<string, string>)?.authorization });
      return json({ id: "chat", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} });
    });
    const store = new CopilotTokenStore(async () => runtimeToken, f as unknown as typeof fetch, () => now, { connection: enterpriseConnection });
    const adapter = new CopilotAdapter(store, f as unknown as typeof fetch);

    await adapter.complete(chatRequest);
    runtimeToken = "runtime-enterprise-token-2";
    now = 4_000_000;
    await adapter.complete(chatRequest);

    expect(calls).toEqual([
      { url: "https://first.acme.ghe.com/chat/completions", authorization: "Bearer runtime-enterprise-token-1" },
      { url: "https://second.acme.ghe.com/chat/completions", authorization: "Bearer runtime-enterprise-token-2" },
    ]);
  });

  it.each([undefined, "http://copilot.acme.ghe.com", "https://copilot.acme.ghe.com/injected"])(
    "EP-59 fails closed for absent or invalid enterprise endpoint %s without global fallback or secret leakage",
    async (endpoint) => {
      const f = enterpriseExchange(endpoint);
      const store = new CopilotTokenStore(async () => "runtime-enterprise-token", f as unknown as typeof fetch, undefined, { connection: enterpriseConnection });

      const error = await fetchModelDiscovery(store, f as unknown as typeof fetch).catch((caught) => caught);

      expect(error).toBeInstanceOf(CopilotEndpointContractError);
      expect(String(error)).not.toContain("enterprise-copilot-secret");
      expect(f.mock.calls.some((call) => String(call[0]).startsWith("https://api.githubcopilot.com"))).toBe(false);
    },
  );
});
