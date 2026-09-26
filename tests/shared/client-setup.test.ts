import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClientSetup, writeClientSetup } from "../../src/shared/client-setup.js";

const tmp = () => mkdtempSync(join(tmpdir(), "clset-"));

describe("client-setup", () => {
  it("defaults to all-false when no file exists", () => {
    expect(readClientSetup(tmp())).toEqual({ claude: false, codex: false, pi: false });
  });
  it("round-trips written state", () => {
    const dir = tmp();
    writeClientSetup(dir, { claude: true, codex: false, pi: true });
    expect(readClientSetup(dir)).toEqual({ claude: true, codex: false, pi: true });
  });
  it("creates the dir if missing", () => {
    const dir = join(tmp(), "nested", "deeper");
    writeClientSetup(dir, { claude: false, codex: true, pi: false });
    expect(readClientSetup(dir).codex).toBe(true);
  });
  it("falls back to all-false on a corrupt file", () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "clients.json"), "{ not json");
    expect(readClientSetup(dir)).toEqual({ claude: false, codex: false, pi: false });
  });
  it("coerces missing keys to false", () => {
    const dir = tmp();
    writeFileSync(join(dir, "clients.json"), JSON.stringify({ claude: true }));
    expect(readClientSetup(dir)).toEqual({ claude: true, codex: false, pi: false });
  });
  // A clients.json written by a version that predates pi must still read cleanly — pi simply reports
  // false rather than the whole read falling back to all-false.
  it("reads a pre-pi clients.json without losing the other flags", () => {
    const dir = tmp();
    writeFileSync(join(dir, "clients.json"), JSON.stringify({ claude: true, codex: true }));
    expect(readClientSetup(dir)).toEqual({ claude: true, codex: true, pi: false });
  });
});
