import { describe, it, expect } from "vitest";
import { fetchModelDiscovery, fetchCopilotModelCatalog } from "../../../src/providers/copilot/models.js";
import { modelChoices } from "../../../src/core/model-choices.js";
import { Router } from "../../../src/worker/router.js";
import { buildPiConfig, PI_OPENAI_PROVIDER } from "../../../src/tui/setup/pi-config.js";

const astra = { id: "gpt-6-astra", capabilities: { limits: { max_context_window_tokens: 1_050_000 } },
  billing: { token_prices: { default: { max_prompt_tokens: 272_000 }, long_context: { max_prompt_tokens: 1_000_000 } } } };
const fixture = (data: unknown[]) => async () => new Response(JSON.stringify({ data }));

describe("per-model context choices", () => {
  it("advertises both GPT budgets, switches back and forth on the same router, preserves upstream id", async () => {
    const d = await fetchModelDiscovery("fixture", fixture([astra]));
    const r = new Router([], {}, { claudeMapEnabled: true });
    r.setAvailableModels(d.ids); r.setModelChoices(d.choices);
    expect(r.listModels()).toEqual([astra.id, `${astra.id}:long_context`]);
    for (const [id, budget] of [[astra.id, 272_000], [`${astra.id}:long_context`, 1_000_000], [astra.id, 272_000]] as const) {
      expect(r.resolveModel(id)).toBe(astra.id);
      expect(r.modelLimit(id)).toBe(budget);
    }
    expect(r.resolveModel("claude-fable-5-1:long_context[1m]")).toBe(astra.id);
    expect(r.modelLimit("claude-fable-5-1:long_context[1m]")).toBe(1_000_000);
    const catalog = await fetchCopilotModelCatalog("fixture", fixture([astra]));
    const pi = buildPiConfig(catalog, { host: "localhost", port: 7891, apiKey: "fixture" });
    expect(pi[PI_OPENAI_PROVIDER].models.map((m) => [m.id, m.contextWindow])).toEqual([[astra.id, 272_000], [`${astra.id}:long_context`, 1_000_000]]);
  });
  it("lists distinct Claude identities and routes canonical dotted/dashed choices correctly", async () => {
    const m = { ...astra, id: "claude-opus-4.8" };
    const d = await fetchModelDiscovery("fixture", fixture([m]));
    const r = new Router([], {}); r.setAvailableModels(d.ids); r.setModelChoices(d.choices);
    expect(r.listAnthropicModels().map((m) => m.id)).toEqual(["claude-opus-4-8", "claude-opus-4-8:long_context[1m]"]);
    expect(r.resolveModel("claude-opus-4-8:long_context[1m]")).toBe(m.id);
    expect(r.modelLimit("claude-opus-4-8")).toBe(272_000);
    expect(r.modelLimit("claude-opus-4-8:long_context[1m]")).toBe(1_000_000);
    expect(r.resolveModel("claude-opus-4.8:long_context[1m]")).toBe(m.id);
    expect(r.modelLimit("claude-opus-4.8:long_context[1m]")).toBe(1_000_000);
  });
  it("does not invent choices for unknown or equal budgets and does not fuzzy-route unknown variants", () => {
    expect(modelChoices({ id: "unknown" })).toHaveLength(1);
    expect(modelChoices({ ...astra, billing: { token_prices: { default: { max_prompt_tokens: 272_000 } } } })).toHaveLength(1);
    const r = new Router([], {}); r.setAvailableModels([astra.id]);
    expect(r.resolveModel("unknown:long_context")).toBe("unknown");
    expect(r.resolveModel(`${astra.id}:long_context`)).toBe(astra.id);
    // Empty startup discovery must not invalidate previously generated pi configs.
    const offline = new Router([], {});
    expect(offline.resolveModel(`${astra.id}:long_context`)).toBe(astra.id);
    expect(offline.modelLimit(`${astra.id}:long_context`)).toBeUndefined();
  });
  it("retains explicit user remaps after choice discovery", async () => {
    const d = await fetchModelDiscovery("fixture", fixture([astra]));
    const r = new Router([], { [astra.id]: "gpt-custom" });
    r.setAvailableModels(d.ids); r.setModelChoices(d.choices);
    expect(r.resolveModel(astra.id)).toBe("gpt-custom");
    expect(r.resolveModel(`${astra.id}:long_context`)).toBe("gpt-custom");
    r.setModelLimits({ "gpt-custom": 128_000 });
    expect(r.modelLimit(`${astra.id}:long_context`)).toBe(128_000);
  });
  it("preserves a real upstream identity colliding with our suffix", async () => {
    const id = `${astra.id}:long_context`;
    const d = await fetchModelDiscovery("fixture", fixture([astra, { id }]));
    const r = new Router([], {}); r.setAvailableModels(d.ids); r.setModelChoices(d.choices);
    expect(r.listModels().filter((m) => m === id)).toHaveLength(1);
    expect(r.resolveModel(id)).toBe(id);
    expect(r.listAnthropicModels().filter((m) => m.id === id)).toHaveLength(1);
    expect(r.listAnthropicModels().some((m) => m.id.endsWith(":long_context:long_context"))).toBe(false);
  });
});
