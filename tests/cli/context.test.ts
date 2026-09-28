import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readChatModel, writeChatModel } from "../../src/shared/prefs.js";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "context-tier-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("context preference", () => {
  it("persists a budget-specific model without changing unrelated or legacy preferences", () => {
    const dir = temp();
    writeFileSync(join(dir, "prefs.json"), '{"contextTier":"long_context","unrelated":true}');
    for (const model of ["gpt-6-astra", "gpt-6-astra:long_context", "gpt-6-astra"]) {
      writeChatModel(dir, model);
      expect(readChatModel(dir)).toBe(model);
      expect(JSON.parse(readFileSync(join(dir, "prefs.json"), "utf8")).unrelated).toBe(true);
    }
  });
  it("runs the real CLI without credentials and rejects invalid input without overwriting", () => {
    const home = temp();
    const cli = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "src/cli/index.ts", "context", ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8",
    });
    expect(cli().stdout).toContain("No restart required");
    for (const tier of ["default", "long_context", "1m"]) {
      const bad = cli(tier);
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain("Global context tiers were replaced");
    }
    expect(cli().stdout).toContain(":long_context");
  }, 20_000);
});
