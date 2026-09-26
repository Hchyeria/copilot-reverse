import { describe, expect, it } from "vitest";
import { githubRestOrigin, normalizeGhecomHost } from "../../src/shared/github-connection.js";

describe("normalizeGhecomHost", () => {
  it("normalizes ASCII DNS hostnames beneath ghe.com", () => {
    expect(normalizeGhecomHost("TEAM.EU.GHE.COM")).toBe("team.eu.ghe.com");
  });

  it.each([
    "ghe.com",
    "https://team.ghe.com",
    "team.ghe.com:443",
    "team.ghe.com.evil.test",
    " team.ghe.com",
    "tëam.ghe.com",
    `${"x".repeat(64)}.ghe.com`,
  ])("rejects %s", (host) => {
    expect(() => normalizeGhecomHost(host)).toThrow(/GHE\.com hostname/i);
  });
});


describe("githubRestOrigin", () => {
  it("maps GitHub.com to the public REST origin", () => {
    expect(githubRestOrigin({ type: "github", token: "secret" })).toBe("https://api.github.com");
  });

  it("maps a normalized GHE.com web host to its REST origin", () => {
    expect(githubRestOrigin({ type: "ghecom", host: "ACME.GHE.COM" })).toBe("https://api.acme.ghe.com");
  });
});
