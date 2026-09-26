import { describe, it, expect, vi } from "vitest";
import { CopilotTokenStore, CopilotAuthError, CopilotEndpointContractError, isCopilotTokenValid, probeGithubAuth } from "../../../src/providers/copilot/token.js";
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

describe("CopilotTokenStore", () => {
  it("caches until near expiry", async () => {
    const now = 1_000_000;
    const f = vi.fn(async () => json({ token: "cop_1", expires_at: 1_000 + now / 1000 }));
    const s = new CopilotTokenStore("gho", f as unknown as typeof fetch, () => now);
    expect(await s.get()).toBe("cop_1");
    expect(await s.get()).toBe("cop_1");
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("refreshes after expiry", async () => {
    let now = 0;
    const f = vi.fn().mockResolvedValueOnce(json({ token: "cop_1", expires_at: 100 })).mockResolvedValueOnce(json({ token: "cop_2", expires_at: 10_000 }));
    const s = new CopilotTokenStore("gho", f as unknown as typeof fetch, () => now);
    expect(await s.get()).toBe("cop_1");
    now = 200_000;
    expect(await s.get()).toBe("cop_2");
  });

  it("discovers GHE.com endpoints from copilot_internal/user and uses the gh token directly", async () => {
    const provider = vi.fn(async () => "ghe-gh-token");
    const f = vi.fn(async () => json({
      access_type_sku: "copilot_enterprise_seat_quota",
      chat_enabled: true,
      endpoints: { api: "https://copilot-api.acme.ghe.com/" },
    }));
    const s = new CopilotTokenStore(provider, f as unknown as typeof fetch, undefined, {
      connection: { type: "ghecom", host: "acme.ghe.com" },
    });

    await expect(s.getSession()).resolves.toMatchObject({
      token: "ghe-gh-token",
      inferenceOrigin: "https://copilot-api.acme.ghe.com",
      entitlement: { sku: "copilot_enterprise_seat_quota", chatEnabled: true, individual: false },
    });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0]).toBe("https://acme.ghe.com/api/v3/copilot_internal/user");
    expect((f.mock.calls[0][1] as RequestInit).headers).toMatchObject({ authorization: "token ghe-gh-token" });
  });

  it("classifies a missing GHE.com Copilot discovery endpoint as a contract error, not expired login", async () => {
    const f = vi.fn(async () => new Response("", { status: 404 }));
    const store = new CopilotTokenStore("ghe-token", f as unknown as typeof fetch, undefined, {
      connection: { type: "ghecom", host: "acme.ghe.com" },
    });
    await expect(store.getSession()).rejects.toBeInstanceOf(CopilotEndpointContractError);
  });

  it("rejects a GHE.com account whose Copilot chat entitlement is disabled", async () => {
    const f = vi.fn(async () => json({
      access_type_sku: "copilot_enterprise_seat_quota",
      chat_enabled: false,
      endpoints: { api: "https://copilot-api.acme.ghe.com" },
    }));
    const store = new CopilotTokenStore("ghe-token", f as unknown as typeof fetch, undefined, {
      connection: { type: "ghecom", host: "acme.ghe.com" },
    });
    await expect(store.getSession()).rejects.toThrow(/chat.*disabled/i);
  });

  it("keeps GitHub.com's inference fallback when endpoints.api is absent", async () => {
    const f = vi.fn(async () => json({ token: "cop", expires_at: 9_999_999_999 }));
    const s = new CopilotTokenStore("gho", f as unknown as typeof fetch);
    await expect(s.getSession()).resolves.toMatchObject({
      token: "cop",
      inferenceOrigin: "https://api.githubcopilot.com",
    });
    expect(f.mock.calls[0][0]).toBe("https://api.github.com/copilot_internal/v2/token");
  });


  it("accepts an explicit GitHub.com endpoint only beneath githubcopilot.com", async () => {
    const f = vi.fn(async () => json({
      token: "cop",
      expires_at: 9_999_999_999,
      endpoints: { api: "https://api.githubcopilot.com" },
    }));
    const s = new CopilotTokenStore("gho", f as unknown as typeof fetch);
    await expect(s.getSession()).resolves.toMatchObject({ inferenceOrigin: "https://api.githubcopilot.com" });
  });

  it.each(["https://githubcopilot.com", "https://api.githubcopilot.com"])('accepts the public Copilot domain or a true subdomain: %s', async (endpoint) => {
    const f = vi.fn(async () => json({ token: "cop", expires_at: 9_999_999_999, endpoints: { api: endpoint } }));
    const store = new CopilotTokenStore("gho", f as unknown as typeof fetch);
    await expect(store.getSession()).resolves.toMatchObject({ inferenceOrigin: endpoint });
  });

  it.each([
    ["HTTP", "http://api.githubcopilot.com"],
    ["outside domain", "https://api.github.com"],
    ["lookalike domain", "https://githubcopilot.com.evil.test"],
    ["IP literal", "https://127.0.0.1"],
    ["non-default port", "https://api.githubcopilot.com:8443"],
  ])("rejects a GitHub.com explicit %s endpoint instead of hiding it with the fallback", async (_label, endpoint) => {
    const f = vi.fn(async () => json({ token: "cop", expires_at: 9_999_999_999, endpoints: { api: endpoint } }));
    const s = new CopilotTokenStore("gho", f as unknown as typeof fetch);
    await expect(s.getSession()).rejects.toBeInstanceOf(CopilotEndpointContractError);
  });

  it.each(["https://acme.ghe.com", "https://copilot.acme.ghe.com"])('accepts the enterprise host or a true subdomain: %s', async (endpoint) => {
    const f = vi.fn(async () => json({ token: "cop", expires_at: 9_999_999_999, endpoints: { api: endpoint } }));
    const store = new CopilotTokenStore("ghe-token", f as unknown as typeof fetch, undefined, {
      connection: { type: "ghecom", host: "acme.ghe.com" },
    });
    await expect(store.getSession()).resolves.toMatchObject({ inferenceOrigin: endpoint });
  });

  it.each([
    ["missing", undefined],
    ["HTTP", "http://copilot.acme.ghe.com"],
    ["public Copilot domain", "https://api.githubcopilot.com"],
    ["outside domain", "https://copilot.other.ghe.com"],
    ["lookalike suffix", "https://acme.ghe.com.evil.test"],
    ["lookalike prefix", "https://evilacme.ghe.com"],
    ["IP literal", "https://127.0.0.1"],
    ["non-default port", "https://copilot.acme.ghe.com:8443"],
    ["userinfo", "https://user@copilot.acme.ghe.com"],
    ["password", "https://user:pass@copilot.acme.ghe.com"],
    ["query", "https://copilot.acme.ghe.com?token=x"],
    ["fragment", "https://copilot.acme.ghe.com#x"],
    ["path", "https://copilot.acme.ghe.com/injected"],
    ["non-URL", "copilot.acme.ghe.com"],
  ])("fails closed for a GHE.com %s endpoints.api contract", async (_label, endpoint) => {
    const f = vi.fn(async () => json({
      token: "opaque-cop-token",
      expires_at: 9_999_999_999,
      ...(endpoint === undefined ? {} : { endpoints: { api: endpoint } }),
    }));
    const s = new CopilotTokenStore("ghe-token", f as unknown as typeof fetch, undefined, {
      connection: { type: "ghecom", host: "acme.ghe.com" },
    });

    const error = await s.getSession().catch((caught) => caught);
    expect(error).toBeInstanceOf(CopilotEndpointContractError);
    expect(error).toMatchObject({ code: "COPILOT_ENDPOINT_CONTRACT_ERROR" });
    expect(String(error)).not.toContain("opaque-cop-token");
    expect(String(error)).not.toContain(String(endpoint));
  });

  it("does not derive an enterprise origin from a bearer token", async () => {
    const f = vi.fn(async () => json({
      token: "opaque.https://api.githubcopilot.com.payload",
      expires_at: 9_999_999_999,
    }));
    const s = new CopilotTokenStore("ghe-token", f as unknown as typeof fetch, undefined, {
      connection: { type: "ghecom", host: "acme.ghe.com" },
    });
    await expect(s.getSession()).rejects.toBeInstanceOf(CopilotEndpointContractError);
  });

  it("refreshes the GHE token, entitlement, and inference origin as one session", async () => {
    let now = 0;
    let token = "ghe-token-1";
    const f = vi.fn()
      .mockResolvedValueOnce(json({
        access_type_sku: "old-plan", chat_enabled: true,
        endpoints: { api: "https://first.acme.ghe.com" },
      }))
      .mockResolvedValueOnce(json({
        access_type_sku: "new-plan", chat_enabled: true,
        endpoints: { api: "https://second.acme.ghe.com/" },
      }));
    const s = new CopilotTokenStore(async () => token, f as unknown as typeof fetch, () => now, {
      connection: { type: "ghecom", host: "acme.ghe.com" },
    });

    expect(await s.getSession()).toMatchObject({
      token: "ghe-token-1", inferenceOrigin: "https://first.acme.ghe.com",
      entitlement: { sku: "old-plan", chatEnabled: true, individual: false },
    });
    token = "ghe-token-2";
    now = 4_000_000;
    expect(await s.getSession()).toMatchObject({
      token: "ghe-token-2", inferenceOrigin: "https://second.acme.ghe.com",
      entitlement: { sku: "new-plan", chatEnabled: true, individual: false },
    });
    expect(s.getEntitlement()).toEqual({ sku: "new-plan", chatEnabled: true, individual: false });
  });


  it("coalesces concurrent refreshes into one atomic session exchange", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = vi.fn(async () => {
      await gate;
      return json({ token: "cop", expires_at: 9_999_999_999, endpoints: { api: "https://copilot.acme.ghe.com" } });
    });
    const s = new CopilotTokenStore(async () => "ghe-token", f as unknown as typeof fetch, undefined, {
      connection: { type: "ghecom", host: "acme.ghe.com" },
    });

    const first = s.getSession();
    const second = s.getSession();
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ token: "ghe-token", inferenceOrigin: "https://copilot.acme.ghe.com" }),
      expect.objectContaining({ token: "ghe-token", inferenceOrigin: "https://copilot.acme.ghe.com" }),
    ]);
    expect(f).toHaveBeenCalledTimes(1);
  });


  it("clears a failed pending refresh so the next call can recover", async () => {
    let calls = 0;
    const f = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response("", { status: 500 });
      return json({ token: "cop-ok", expires_at: 9_999_999_999 });
    });
    const s = new CopilotTokenStore("gho", f as unknown as typeof fetch);

    await expect(s.getSession()).rejects.toMatchObject({ status: 500 });
    await expect(s.getSession()).resolves.toMatchObject({ token: "cop-ok", inferenceOrigin: "https://api.githubcopilot.com" });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("throws an actionable CopilotAuthError on 401", async () => {
    const f = vi.fn(async () => new Response("", { status: 401 }));
    const s = new CopilotTokenStore("gho", f as unknown as typeof fetch);
    await expect(s.get()).rejects.toBeInstanceOf(CopilotAuthError);
    await expect(s.get()).rejects.toThrow(/login expired/i);
  });
  it("re-reads a token provider on each exchange (a transient null does not poison the store)", async () => {
    // Provider returns null first (e.g. creds.json momentarily locked at construction), then a real
    // token. Pre-fix, a string captured null and sent `token null` forever; now get() re-reads.
    let token: string | null = null;
    const f = vi.fn(async () => json({ token: "cop_ok", expires_at: 9_999_999_999 }));
    const s = new CopilotTokenStore(() => token, f as unknown as typeof fetch);
    await expect(s.get()).rejects.toBeInstanceOf(CopilotAuthError); // null → 401, no fetch with "null"
    expect(f).not.toHaveBeenCalled();
    token = "gho_real";
    expect(await s.get()).toBe("cop_ok"); // recovered on the next read
  });
  it("a null/absent token raises 401 instead of sending `authorization: token null`", async () => {
    const f = vi.fn(async () => json({ token: "cop", expires_at: 9_999_999_999 }));
    const s = new CopilotTokenStore(() => null, f as unknown as typeof fetch);
    await expect(s.get()).rejects.toThrow(/login expired/i);
    expect(f).not.toHaveBeenCalled(); // never hits the network with a bogus credential
  });
  it("parses the plan entitlement from the exchange (no extra call)", async () => {
    const f = vi.fn(async () => json({ token: "cop", expires_at: 9_999_999_999, sku: "copilot_enterprise_seat_quota", chat_enabled: true, individual: false }));
    const s = new CopilotTokenStore("gho", f as unknown as typeof fetch);
    expect(s.getEntitlement()).toBeUndefined();       // nothing until the first exchange
    await s.get();
    expect(s.getEntitlement()).toEqual({ sku: "copilot_enterprise_seat_quota", chatEnabled: true, individual: false });
    expect(f).toHaveBeenCalledTimes(1);               // entitlement rode along on the token call
  });
  it("leaves the entitlement undefined when the exchange omits a sku", async () => {
    const f = vi.fn(async () => json({ token: "cop", expires_at: 9_999_999_999 }));
    const s = new CopilotTokenStore("gho", f as unknown as typeof fetch);
    await s.get();
    expect(s.getEntitlement()).toBeUndefined();
  });
});

describe("isCopilotTokenValid", () => {
  it("true when the token exchanges", async () => {
    const f = vi.fn(async () => json({ token: "cop", expires_at: 9_999_999_999 }));
    expect(await isCopilotTokenValid("gho", f as unknown as typeof fetch)).toBe(true);
  });
  it("false on 401", async () => {
    const f = vi.fn(async () => new Response("", { status: 401 }));
    expect(await isCopilotTokenValid("gho", f as unknown as typeof fetch)).toBe(false);
  });
});

describe("probeGithubAuth", () => {
  it("ok + non-transient when the token exchanges", async () => {
    const f = vi.fn(async () => json({ token: "cop", expires_at: 9_999_999_999 }));
    expect(await probeGithubAuth("gho", f as unknown as typeof fetch)).toEqual({ ok: true, transient: false, detail: "token valid" });
  });
  it("definitive failure (non-transient) on 401", async () => {
    const f = vi.fn(async () => new Response("", { status: 401 }));
    const p = await probeGithubAuth("gho", f as unknown as typeof fetch);
    expect(p.ok).toBe(false);
    expect(p.transient).toBe(false);
    expect(p.detail).toMatch(/login expired/i);
  });
  it("definitive failure (non-transient) on 403", async () => {
    const f = vi.fn(async () => new Response("", { status: 403 }));
    const p = await probeGithubAuth("gho", f as unknown as typeof fetch);
    expect(p.ok).toBe(false);
    expect(p.transient).toBe(false);
  });
  it("transient on a 5xx (upstream hiccup, not an auth failure)", async () => {
    const f = vi.fn(async () => new Response("", { status: 500 }));
    const p = await probeGithubAuth("gho", f as unknown as typeof fetch);
    expect(p.ok).toBe(false);
    expect(p.transient).toBe(true);
  });
  it("transient when the network call rejects", async () => {
    const f = vi.fn(async () => { throw new Error("ECONNRESET"); });
    const p = await probeGithubAuth("gho", f as unknown as typeof fetch);
    expect(p.ok).toBe(false);
    expect(p.transient).toBe(true);
  });
});
