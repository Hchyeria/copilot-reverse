import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readContextTier, writeChatModel, writeContextTier } from "../../src/shared/prefs.js";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "context-tier-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("context preference", () => {
  it("defaults safely and preserves unrelated preferences", () => {
    const dir = temp();
    expect(readContextTier(dir)).toBe("default");
    writeChatModel(dir, "gpt-6-astra");
    writeContextTier(dir, "long_context");
    expect(readContextTier(dir)).toBe("long_context");
    expect(JSON.parse(readFileSync(join(dir, "prefs.json"), "utf8")).chatModel).toBe("gpt-6-astra");
    writeFileSync(join(dir, "prefs.json"), '{"contextTier":"1m"}');
    expect(readContextTier(dir)).toBe("default");
    writeFileSync(join(dir, "prefs.json"), "bad json");
    expect(readContextTier(dir)).toBe("default");
  });
  it("runs the real CLI without credentials and rejects invalid input without overwriting", () => {
    const home = temp();
    const cli = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "src/cli/index.ts", "context", ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8",
    });
    expect(cli().stdout.trim()).toBe("default");
    expect(cli("long_context").status).toBe(0);
    expect(cli().stdout.trim()).toBe("long_context");
    const bad = cli("1m");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("context tier must be default or long_context");
    expect(cli().stdout.trim()).toBe("long_context");
    expect(cli("default").status).toBe(0);
    expect(cli().stdout.trim()).toBe("default");
  }, 20_000);
});
