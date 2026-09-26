import { describe, expect, it, vi } from "vitest";
import { createWorkerCopilotTokenStore } from "../../src/worker/copilot-session.js";
import { GitHubReauthenticationRequiredError } from "../../src/cli/auth.js";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("createWorkerCopilotTokenStore", () => {
  it("never calls ghAuth for a GitHub.com connection", async () => {
    const ghAuth = {
      token: vi.fn(async () => { throw new Error("must not be called"); }),
    };
    const fetchFn = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.github.com/copilot_internal/v2/token");
      return json({ token: "cop", expires_at: 9_999_999_999 });
    });
    const store = createWorkerCopilotTokenStore(
      { type: "github", token: "github-token" },
      ghAuth,
      fetchFn as unknown as typeof fetch,
    );

    await expect(store.getSession()).resolves.toMatchObject({ inferenceOrigin: "https://api.githubcopilot.com" });
    expect(ghAuth.token).not.toHaveBeenCalled();
  });

  it("retrieves a runtime gh token only for the selected GHE.com host", async () => {
    const ghAuth = { token: vi.fn(async () => "enterprise-runtime-token") };
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://acme.ghe.com/api/v3/copilot_internal/user");
      expect((init?.headers as Record<string, string>).authorization).toBe("token enterprise-runtime-token");
      return json({ access_type_sku: "copilot_enterprise_seat_quota", chat_enabled: true, endpoints: { api: "https://copilot.acme.ghe.com" } });
    });
    const store = createWorkerCopilotTokenStore(
      { type: "ghecom", host: "acme.ghe.com" },
      ghAuth,
      fetchFn as unknown as typeof fetch,
    );

    await store.getSession();
    expect(ghAuth.token).toHaveBeenCalledOnce();
    expect(ghAuth.token).toHaveBeenCalledWith("acme.ghe.com");
  });

  it.each(["empty", "failure"])("converts a GHE.com gh.token %s into a redacted reauthentication error", async (mode) => {
    const secret = "ghp-secret-from-stderr";
    const ghAuth = {
      token: vi.fn(async () => {
        if (mode === "failure") throw new Error(`gh failed: ${secret}`);
        return "";
      }),
    };
    const fetchFn = vi.fn();
    const store = createWorkerCopilotTokenStore(
      { type: "ghecom", host: "acme.ghe.com" },
      ghAuth,
      fetchFn as unknown as typeof fetch,
    );

    const error = await store.getSession().catch((caught) => caught);
    expect(error).toBeInstanceOf(GitHubReauthenticationRequiredError);
    expect(String(error)).toContain("acme.ghe.com");
    expect(String(error)).not.toContain(secret);
    expect((error as Error).cause).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
