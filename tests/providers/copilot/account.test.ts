import { describe, it, expect, vi } from "vitest";
import { fetchGithubUser, skuLabel, formatIdentity } from "../../../src/providers/copilot/account.js";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

describe("fetchGithubUser", () => {
  it("returns login + name on success", async () => {
    const f = vi.fn(async () => json({ login: "canwa_microsoft", name: "Can Wang", id: 1 }));
    expect(await fetchGithubUser("gho", f as unknown as typeof fetch)).toEqual({ login: "canwa_microsoft", name: "Can Wang" });
  });

  it("uses the selected GHE.com REST origin for /user", async () => {
    const f = vi.fn(async () => json({ login: "enterprise-user" }));
    const auth = { connection: { type: "ghecom", host: "acme.ghe.com" } as const, token: "ghe-secret" };

    await expect(fetchGithubUser(auth, f as unknown as typeof fetch)).resolves.toEqual({ login: "enterprise-user", name: null });

    expect(f.mock.calls[0][0]).toBe("https://api.acme.ghe.com/user");
    expect((f.mock.calls[0][1] as RequestInit).headers).toMatchObject({ authorization: "token ghe-secret" });
  });

  it("maps a missing name to null (keeps the login)", async () => {
    const f = vi.fn(async () => json({ login: "handle" }));
    expect(await fetchGithubUser("gho", f as unknown as typeof fetch)).toEqual({ login: "handle", name: null });
  });
  it("returns null (best-effort) on a non-ok response", async () => {
    const f = vi.fn(async () => json({}, 401));
    expect(await fetchGithubUser("gho", f as unknown as typeof fetch)).toBeNull();
  });
  it("returns null when the call rejects, never throws", async () => {
    const f = vi.fn(async () => { throw new Error("ECONNRESET"); });
    expect(await fetchGithubUser("gho", f as unknown as typeof fetch)).toBeNull();
  });
  it("returns null (does not hang) when the request stalls past the timeout", async () => {
    const hanging = ((_u: string, init?: { signal?: AbortSignal }) =>
      new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
    expect(await fetchGithubUser("gho", hanging, 20)).toBeNull();
  });
  it("sends the token and a user-agent (GitHub rejects UA-less requests)", async () => {
    const f = vi.fn(async () => json({ login: "h" }));
    await fetchGithubUser("gho_tok", f as unknown as typeof fetch);
    const headers = (f.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers.authorization).toBe("token gho_tok");
    expect(headers["user-agent"]).toBeTruthy();
  });
});

describe("skuLabel", () => {
  it("maps the known plan families to friendly names", () => {
    expect(skuLabel("copilot_enterprise_seat_quota")).toBe("Copilot Enterprise");
    expect(skuLabel("copilot_business_seat")).toBe("Copilot Business");
    expect(skuLabel("copilot_individual")).toBe("Copilot Pro");
    expect(skuLabel("free_educational")).toBe("Copilot Free");
  });
  it("falls back to a legible title-cased form for an unknown sku", () => {
    // Not a family we recognize — should still render something clean, never empty/unknown.
    const out = skuLabel("copilot_newplan_seat");
    expect(out).toMatch(/Copilot/);
    expect(out).not.toContain("_");
  });
  it("returns the raw sku if nothing legible remains", () => {
    expect(skuLabel("seat")).toBe("seat");
  });
});

describe("formatIdentity", () => {
  it("shows 'Name (login)' when a display name exists", () => {
    expect(formatIdentity({ login: "canwa_microsoft", name: "Can Wang" })).toBe("Can Wang (canwa_microsoft)");
  });
  it("shows just the login when there is no name", () => {
    expect(formatIdentity({ login: "handle", name: null })).toBe("handle");
  });
  it("avoids the redundant 'login (login)' when name equals login", () => {
    expect(formatIdentity({ login: "handle", name: "handle" })).toBe("handle");
  });
  it("returns an empty string for a null user (safe to append)", () => {
    expect(formatIdentity(null)).toBe("");
    expect(formatIdentity(undefined)).toBe("");
  });
});
