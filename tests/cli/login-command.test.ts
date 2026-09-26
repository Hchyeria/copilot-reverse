import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLoginRequest, runLoginCommand, type LoginPrompt } from "../../src/cli/login-command.js";
import type { GhAuth } from "../../src/cli/gh-auth.js";

const dataDir = () => mkdtempSync(join(tmpdir(), "copilot-reverse-login-"));

const ghThatMustNotRun = (): GhAuth => ({
  isAvailable: vi.fn(async () => { throw new Error("gh touched"); }),
  login: vi.fn(async () => { throw new Error("gh touched"); }),
  token: vi.fn(async () => { throw new Error("gh touched"); }),
});

const prompt = (type: "github" | "ghecom" | null, host?: string): LoginPrompt => ({
  chooseType: vi.fn(async () => type),
  readHost: vi.fn(async () => host ?? ""),
  close: vi.fn(),
});

describe("login command request resolution", () => {
  it("requires --type without a TTY", async () => {
    await expect(resolveLoginRequest({}, false, prompt(null))).rejects.toThrow(/--type/);
  });

  it("accepts explicit GitHub.com without a host", async () => {
    await expect(resolveLoginRequest({ type: "github" }, false, prompt(null))).resolves.toEqual({ type: "github" });
  });

  it("requires a GHE.com host and rejects a host for GitHub.com", async () => {
    await expect(resolveLoginRequest({ type: "ghecom" }, false, prompt(null))).rejects.toThrow(/--host/);
    await expect(resolveLoginRequest({ type: "github", host: "acme.ghe.com" }, false, prompt(null))).rejects.toThrow(/--host/);
  });

  it("validates explicit types before authentication", async () => {
    await expect(resolveLoginRequest({ type: "ghes", host: "git.acme.test" }, false, prompt(null))).rejects.toThrow(/github.*ghecom/i);
  });

  it("interactively chooses GitHub.com without asking for a host", async () => {
    const p = prompt("github");
    await expect(resolveLoginRequest({}, true, p)).resolves.toEqual({ type: "github" });
    expect(p.readHost).not.toHaveBeenCalled();
  });

  it("interactively chooses and normalizes a GHE.com host", async () => {
    await expect(resolveLoginRequest({}, true, prompt("ghecom", "ACME.GHE.COM"))).resolves.toEqual({ type: "ghecom", host: "acme.ghe.com" });
  });

  it("cancels without authenticating", async () => {
    await expect(resolveLoginRequest({}, true, prompt(null))).resolves.toBeNull();
  });
});

describe("runLoginCommand", () => {
  it("never touches gh for an explicit GitHub.com login", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ device_code: "dc", user_code: "AB-12", verification_uri: "https://github.com/login/device", interval: 0, expires_in: 900 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "gho_token" }), { status: 200 })) as unknown as typeof fetch;
    await expect(runLoginCommand(
      { type: "github" },
      { isTTY: false, dir: dataDir(), prompt: prompt(null), ghAuth: ghThatMustNotRun(), fetchFn, log: vi.fn() },
    )).resolves.toMatchObject({ completed: true, connection: { type: "github", token: "gho_token" } });
  });

  it("restores the previous connection when activation fails", async () => {
    const dir = dataDir();
    const previous = JSON.stringify({ ghToken: "old-token" });
    writeFileSync(join(dir, "creds.json"), previous);
    const gh: GhAuth = {
      isAvailable: vi.fn(async () => true),
      login: vi.fn(async () => {}),
      token: vi.fn(async () => "enterprise-token"),
    };
    await expect(runLoginCommand(
      { type: "ghecom", host: "acme.ghe.com" },
      { isTTY: false, dir, prompt: prompt(null), ghAuth: gh, activate: async () => { throw new Error("unsupported endpoint"); } },
    )).rejects.toThrow(/unsupported endpoint/);
    expect(readFileSync(join(dir, "creds.json"), "utf8")).toBe(previous);
  });
});
