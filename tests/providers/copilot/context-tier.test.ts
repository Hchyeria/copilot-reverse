import { describe, it, expect, vi } from "vitest";
import { contextBudget } from "../../../src/core/context-tier.js";
import { fetchModelDiscovery, fetchCopilotModelCatalog, fetchModelLimits, fetchModelOneMSupport } from "../../../src/providers/copilot/models.js";
import { buildPiConfig, PI_OPENAI_PROVIDER } from "../../../src/tui/setup/pi-config.js";
import { Router } from "../../../src/worker/router.js";
import { claudeCopilotReverseEnv } from "../../../src/tui/setup/clients.js";
import { applyCodexToml } from "../../../src/tui/setup/codex-toml.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const model = {
  id: "gpt-6-astra", supported_endpoints: ["/responses"],
  capabilities: { type: "chat", limits: { max_context_window_tokens: 1_050_000, max_prompt_tokens: 1_050_000, max_output_tokens: 128_000 } },
  billing: { token_prices: { default: { max_prompt_tokens: 272_000 }, long_context: { max_prompt_tokens: 1_000_000 } } },
};
const fetchModels = () => vi.fn(async () => new Response(JSON.stringify({ data: [model] }))) as unknown as typeof fetch;

describe("context tier selection", () => {
  it.each([["default", 272_000], ["long_context", 1_000_000]] as const)("propagates %s through discovery, setup and routing", async (tier, budget) => {
    const d = await fetchModelDiscovery("test", fetchModels(), undefined, tier);
    const catalog = await fetchCopilotModelCatalog("test", fetchModels(), undefined, tier);
    expect(d.limits[model.id]).toBe(budget);
    expect(d.oneM.has(model.id)).toBe(tier === "long_context");
    expect(await fetchModelLimits("test", fetchModels(), undefined, tier)).toEqual(d.limits);
    expect(await fetchModelOneMSupport("test", fetchModels(), undefined, tier)).toEqual(d.oneM);
    const pi = buildPiConfig(catalog, { host: "127.0.0.1", port: 7891, apiKey: "dummy" });
    expect(pi[PI_OPENAI_PROVIDER].models[0]).toMatchObject({ id: model.id, contextWindow: budget, maxTokens: 128_000 });
    const router = new Router([], {});
    router.setAvailableModels(d.ids);
    router.setOneMModels(d.oneM);
    router.setModelLimits(d.limits);
    expect(router.resolveModel(model.id)).toBe(model.id);
    expect(router.modelLimit(model.id)).toBe(budget);
    const env = claudeCopilotReverseEnv("http://localhost/anthropic", "fixture", model.id, budget);
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(String(budget));
    expect(env.ANTHROPIC_MODEL.endsWith("[1m]")).toBe(tier === "long_context");
    const home = mkdtempSync(join(tmpdir(), "context-codex-"));
    try {
      const config = applyCodexToml({ home, baseUrl: "http://localhost/openai", model: model.id, contextWindow: budget });
      expect(readFileSync(config.path, "utf8")).toContain(`model_context_window = ${budget}`);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it("defaults to the smaller tier without an explicit selection", async () => {
    expect((await fetchModelDiscovery("test", fetchModels())).limits[model.id]).toBe(272_000);
    expect((await fetchCopilotModelCatalog("test", fetchModels()))[0].contextWindow).toBe(272_000);
  });
  it("honors a discovered empty 1M set rather than the hardcoded badge fallback", () => {
    const r = new Router([], {});
    r.setOneMModels([]);
    expect(r.is1M("claude-opus-4-8")).toBe(false);
  });
  it("accepts legacy tier spelling and prefers the new spelling", () => {
    const m = { ...model, billing: { token_prices: { default: { context_max: 200_000, max_prompt_tokens: 272_000 }, long_context: { context_max: 872_000 } } } };
    expect(contextBudget(m)).toBe(272_000);
    expect(contextBudget(m, "long_context")).toBe(872_000);
  });
  it("does not impose a blanket limit on untiered models", () => {
    expect(contextBudget({ capabilities: model.capabilities })).toBe(1_050_000);
    expect(contextBudget({ capabilities: { limits: { max_prompt_tokens: 128_000 } } })).toBe(128_000);
    expect(contextBudget({})).toBeUndefined();
  });
  it("bounds tier budgets by the advertised window and ignores invalid values", () => {
    expect(contextBudget({ ...model, capabilities: { limits: { max_context_window_tokens: 128_000 } } })).toBe(128_000);
    for (const invalid of [0, -1, NaN, Infinity]) {
      expect(contextBudget({ ...model, billing: { token_prices: { default: { max_prompt_tokens: invalid, context_max: 272_000 }, long_context: {} } } })).toBe(272_000);
    }
    expect(contextBudget({ capabilities: { limits: { max_context_window_tokens: 1_050_000, max_prompt_tokens: 272_000 } }, billing: { token_prices: { long_context: {} } } })).toBe(272_000);
  });
});
