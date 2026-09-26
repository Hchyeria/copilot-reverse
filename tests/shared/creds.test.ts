import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearGhToken,
  hasGhTokenFile,
  readGhToken,
  readGitHubConnection,
  writeGhToken,
  writeGitHubConnection,
} from "../../src/shared/creds.js";

describe("creds", () => {
  it("round-trips a token", () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    writeGhToken("gho_abc", d);
    expect(readGhToken(d)).toBe("gho_abc");
  });
  it("null when absent", () => {
    expect(readGhToken(mkdtempSync(join(tmpdir(), "m-")))).toBeNull();
  });
  it("reads legacy tokens as GitHub.com connections", () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    writeFileSync(join(d, "creds.json"), JSON.stringify({ ghToken: "legacy" }));
    expect(readGitHubConnection(d)).toEqual({ type: "github", token: "legacy" });
  });
  it("persists GHE.com metadata with the GitHub CLI auth source and without a token", () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    writeGitHubConnection({ type: "ghecom", host: "acme.ghe.com" }, d);
    expect(readGitHubConnection(d)).toEqual({ type: "ghecom", host: "acme.ghe.com" });
    expect(JSON.parse(readFileSync(join(d, "creds.json"), "utf8"))).toEqual({
      type: "ghecom",
      host: "acme.ghe.com",
      authSource: "gh",
    });
    expect(readGhToken(d)).toBeNull();
  });
  it.each([
    { type: "ghecom", host: "acme.ghe.com" },
    { type: "ghecom", host: "acme.ghe.com", authSource: "other" },
  ])("rejects a GHE.com record without the fixed GitHub CLI auth source", (stored) => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    writeFileSync(join(d, "creds.json"), JSON.stringify(stored));
    expect(readGitHubConnection(d)).toBeNull();
  });
  it("removes a token-bearing temp file and preserves the old credentials when writing fails", () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    const path = join(d, "creds.json");
    const previous = Buffer.from('{"ghToken":"old-token"}\n');
    writeFileSync(path, previous);

    const failingWrite = {
      writeFileSync(temporary: string, data: string, options: { mode: number }) {
        writeFileSync(temporary, data, options);
        throw Object.assign(new Error("simulated disk write failure"), { code: "ENOSPC" });
      },
      renameSync,
      rmSync,
    };

    expect(() => writeGitHubConnection(
      { type: "github", token: "new-secret-token" },
      d,
      failingWrite,
    )).toThrow(/simulated disk write failure/);
    expect(readFileSync(path)).toEqual(previous);
    expect(readdirSync(d)).toEqual(["creds.json"]);
  });
  it("returns null (does not throw) on a corrupt creds.json", () => {
    // A partial write / locked read must not throw: readGhToken runs on the heartbeat tick whose
    // rejection would kill the TUI. An unreadable file reads as "no token".
    const d = mkdtempSync(join(tmpdir(), "m-"));
    writeFileSync(join(d, "creds.json"), "{ this is not valid json");
    expect(() => readGhToken(d)).not.toThrow();
    expect(readGhToken(d)).toBeNull();
  });
  it("hasGhTokenFile reports existence, even when the contents are unparseable", () => {
    // The signed-out gate uses existence, not a parse: a corrupt-but-present file is a real (if
    // momentarily unreadable) login, so it must NOT read as signed out.
    const d = mkdtempSync(join(tmpdir(), "m-"));
    expect(hasGhTokenFile(d)).toBe(false);
    writeFileSync(join(d, "creds.json"), "{ corrupt");
    expect(hasGhTokenFile(d)).toBe(true);   // present despite readGhToken(d) === null
    expect(readGhToken(d)).toBeNull();
  });
  it("clearGhToken removes the stored token (and is a no-op when absent)", () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    writeGhToken("gho_abc", d);
    clearGhToken(d);
    expect(readGhToken(d)).toBeNull();
    expect(() => clearGhToken(d)).not.toThrow(); // safe to call again
  });
});
