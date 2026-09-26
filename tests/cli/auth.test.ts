import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginDeviceLogin,
  loginGitHubConnection,
  retrieveGitHubToken,
  runDeviceLogin,
} from "../../src/cli/auth.js";
import type { GhAuth } from "../../src/cli/gh-auth.js";
import { readGhToken } from "../../src/shared/creds.js";
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

describe("runDeviceLogin", () => {
  it("walks device flow and persists token", async () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    const f = vi.fn()
      .mockResolvedValueOnce(json({ device_code: "dc", user_code: "AB-12", verification_uri: "https://github.com/login/device", interval: 0, expires_in: 900 }))
      .mockResolvedValueOnce(json({ access_token: "gho_z" }));
    const log = vi.fn();
    await runDeviceLogin(d, f as unknown as typeof fetch, log);
    expect(readGhToken(d)).toBe("gho_z");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("AB-12"));
  });
});

describe("beginDeviceLogin (two-phase)", () => {
  it("returns the device code immediately, before any token poll runs", async () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    let polled = false;
    const f = vi.fn()
      .mockResolvedValueOnce(json({ device_code: "dc", user_code: "AB-12", verification_uri: "https://github.com/login/device", interval: 0, expires_in: 900 }))
      .mockImplementationOnce(() => { polled = true; return Promise.resolve(json({ access_token: "gho_z" })); });

    const { code, complete } = await beginDeviceLogin(d, f as unknown as typeof fetch);
    // The verification code is available without waiting for authorization.
    expect(code.user_code).toBe("AB-12");
    expect(code.verification_uri).toContain("github.com/login/device");
    expect(polled).toBe(false);

    // Completing the flow then polls and persists the token.
    await complete();
    expect(polled).toBe(true);
    expect(readGhToken(d)).toBe("gho_z");
  });
});

describe("connection auth", () => {
  it("does not inspect gh for a GitHub.com login", async () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    const gh: GhAuth = {
      isAvailable: vi.fn(async () => { throw new Error("must not run"); }),
      login: vi.fn(async () => { throw new Error("must not run"); }),
      token: vi.fn(async () => { throw new Error("must not run"); }),
    };
    const f = vi.fn()
      .mockResolvedValueOnce(json({ device_code: "dc", user_code: "AB-12", verification_uri: "https://github.com/login/device", interval: 0, expires_in: 900 }))
      .mockResolvedValueOnce(json({ access_token: "gho_z" }));

    await loginGitHubConnection({ type: "github" }, d, { fetchFn: f as unknown as typeof fetch, ghAuth: gh, log: vi.fn() });

    expect(gh.isAvailable).not.toHaveBeenCalled();
    expect(gh.login).not.toHaveBeenCalled();
    expect(gh.token).not.toHaveBeenCalled();
  });

  it("reuses an existing GHE.com gh login", async () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    const gh: GhAuth = {
      isAvailable: vi.fn(async () => true),
      login: vi.fn(async () => undefined),
      token: vi.fn(async () => "enterprise-token"),
    };

    await loginGitHubConnection({ type: "ghecom", host: "ACME.GHE.COM" }, d, { ghAuth: gh });

    expect(gh.login).not.toHaveBeenCalled();
    expect(gh.token).toHaveBeenCalledWith("acme.ghe.com");
  });

  it("starts gh login only when the GHE.com credential is missing", async () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    const token = vi.fn().mockRejectedValueOnce(new Error("missing")).mockResolvedValueOnce("enterprise-token");
    const gh: GhAuth = { isAvailable: vi.fn(async () => true), login: vi.fn(async () => undefined), token };

    await loginGitHubConnection({ type: "ghecom", host: "acme.ghe.com" }, d, { ghAuth: gh });

    expect(gh.login).toHaveBeenCalledWith("acme.ghe.com");
    expect(token).toHaveBeenCalledTimes(2);
  });

  it("redacts gh token command failures behind reauthentication", async () => {
    const gh: GhAuth = {
      isAvailable: vi.fn(async () => true),
      login: vi.fn(async () => undefined),
      token: vi.fn(async () => { throw new Error("sensitive stderr"); }),
    };

    const promise = retrieveGitHubToken({ type: "ghecom", host: "acme.ghe.com" }, gh);
    await expect(promise).rejects.toMatchObject({ code: "GITHUB_REAUTHENTICATION_REQUIRED" });
    await expect(promise).rejects.not.toThrow(/sensitive stderr/);
  });
});
