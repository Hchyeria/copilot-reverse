import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyClaude, applyCodex } from "../../src/tui/setup/apply.js";
import { applyPi } from "../../src/tui/setup/pi-config.js";
import { readClientStatus } from "../../src/tui/setup/status.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

describe("readClientStatus", () => {
  it("reports per-scope (user/project) config presence + pinned model from the real files", () => {
    const home = tmp("home-"), cwd = tmp("proj-");
    expect(readClientStatus({ home, cwd }).claude).toMatchObject({ user: false, project: false });

    applyClaude("project", { ANTHROPIC_BASE_URL: "http://127.0.0.1:7891", ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL: "claude-opus-4.8[1m]" }, { home, cwd });
    expect(readClientStatus({ home, cwd }).claude).toMatchObject({ user: false, project: true, projectModel: "claude-opus-4.8[1m]" });

    applyCodex("global", { OPENAI_BASE_URL: "http://127.0.0.1:7891/v1", OPENAI_API_KEY: "k", OPENAI_MODEL: "gpt-5.4" }, { home, cwd });
    const s = readClientStatus({ home, cwd });
    expect(s.codex).toMatchObject({ user: true, project: false, userModel: "gpt-5.4" });
  });

  it("ignores a non-copilot-reverse base url (a user's own Anthropic endpoint)", () => {
    const home = tmp("home-"), cwd = tmp("proj-");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } }));
    expect(readClientStatus({ home, cwd }).claude.project).toBe(false);
  });

  // pi's models.json is always ~/.pi/agent/models.json — it has no project-scoped form — and it pins no
  // single model, so the "model" slot reports how many we advertised instead.
  it("reports pi as user-scope only, with the model count in place of a pinned model", () => {
    const home = tmp("home-"), cwd = tmp("proj-");
    expect(readClientStatus({ home, cwd }).pi).toEqual({ user: false, project: false, userModel: undefined });

    applyPi(
      [{ id: "gpt-4o", name: "GPT-4o", contextWindow: 128_000, maxOutputTokens: 16_384, vision: false, reasoningEfforts: [] }],
      { host: "127.0.0.1", port: 7891, apiKey: "k" },
      { home },
    );
    expect(readClientStatus({ home, cwd }).pi).toEqual({ user: true, project: false, userModel: "1 model" });
  });
});
