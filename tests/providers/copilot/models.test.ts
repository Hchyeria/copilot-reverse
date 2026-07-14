import { describe, it, expect, vi } from "vitest";
import { fetchModelEndpoints, fetchModelReasoningSupport, fetchModelOneMSupport, fetchCopilotModelCatalog, fetchModelDiscovery } from "../../../src/providers/copilot/models.js";

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

describe("fetchModelEndpoints", () => {
  it("maps model id -> supported_endpoints", async () => {
    const f = vi.fn(async () => json({ data: [
      { id: "gpt-5.5", supported_endpoints: ["/responses", "ws:/responses"] },
      { id: "gpt-4o", supported_endpoints: undefined },
      { id: "gpt-5-mini", supported_endpoints: ["/chat/completions", "/responses"] },
    ] }));
    const out = await fetchModelEndpoints("tok", f as unknown as typeof fetch);
    expect(out["gpt-5.5"]).toEqual(["/responses", "ws:/responses"]);
    expect(out["gpt-5-mini"]).toContain("/chat/completions");
    expect(out["gpt-4o"]).toBeUndefined(); // no field -> omitted
  });

  it("returns {} when the endpoint fails", async () => {
    const f = vi.fn(async () => new Response("", { status: 500 }));
    expect(await fetchModelEndpoints("tok", f as unknown as typeof fetch)).toEqual({});
  });
});

describe("fetchModelReasoningSupport", () => {
  it("includes only ids whose capabilities advertise a non-empty reasoning_effort", async () => {
    const f = vi.fn(async () => json({ data: [
      { id: "claude-opus-4.8", capabilities: { supports: { reasoning_effort: ["low", "medium", "high"] } } },
      { id: "gpt-5.5", capabilities: { supports: { reasoning_effort: ["none", "low", "high"] } } },
      { id: "gpt-4o", capabilities: { supports: { tool_calls: true } } }, // no reasoning_effort
      { id: "gpt-4o-mini", capabilities: { supports: { reasoning_effort: [] } } }, // empty -> excluded
      { id: "text-embedding-3-small", capabilities: { supports: {} } },
    ] }));
    const out = await fetchModelReasoningSupport("tok", f as unknown as typeof fetch);
    expect(out.has("claude-opus-4.8")).toBe(true);
    expect(out.has("gpt-5.5")).toBe(true);
    expect(out.has("gpt-4o")).toBe(false);
    expect(out.has("gpt-4o-mini")).toBe(false);
    expect(out.has("text-embedding-3-small")).toBe(false);
  });

  it("returns an empty set when the endpoint fails", async () => {
    const f = vi.fn(async () => new Response("", { status: 500 }));
    expect((await fetchModelReasoningSupport("tok", f as unknown as typeof fetch)).size).toBe(0);
  });
});

describe("fetchModelOneMSupport", () => {
  it("includes only ids whose context window exceeds the 1M threshold", async () => {
    const f = vi.fn(async () => json({ data: [
      { id: "claude-opus-4.8", capabilities: { limits: { max_context_window_tokens: 1_000_000, max_prompt_tokens: 936_000 } } },
      { id: "claude-sonnet-5", capabilities: { limits: { max_context_window_tokens: 1_000_000 } } },
      { id: "claude-sonnet-4.5", capabilities: { limits: { max_context_window_tokens: 200_000 } } }, // 200K -> excluded
      { id: "gpt-4o", capabilities: { limits: {} } }, // no window -> excluded
      { id: "no-caps" }, // no capabilities at all -> excluded
    ] }));
    const out = await fetchModelOneMSupport("tok", f as unknown as typeof fetch);
    expect(out.has("claude-opus-4.8")).toBe(true);
    expect(out.has("claude-sonnet-5")).toBe(true);
    expect(out.has("claude-sonnet-4.5")).toBe(false);
    expect(out.has("gpt-4o")).toBe(false);
    expect(out.has("no-caps")).toBe(false);
  });

  it("falls back to max_prompt_tokens when max_context_window_tokens is absent", async () => {
    const f = vi.fn(async () => json({ data: [
      { id: "claude-opus-4.7", capabilities: { limits: { max_prompt_tokens: 936_000 } } }, // 936K > 800K -> included
    ] }));
    const out = await fetchModelOneMSupport("tok", f as unknown as typeof fetch);
    expect(out.has("claude-opus-4.7")).toBe(true);
  });

  it("returns an empty set when the endpoint fails", async () => {
    const f = vi.fn(async () => new Response("", { status: 500 }));
    expect((await fetchModelOneMSupport("tok", f as unknown as typeof fetch)).size).toBe(0);
  });
});

describe("fetchCopilotModelCatalog", () => {
  const payload = {
    data: [
      {
        id: "claude-opus-4.8", name: "Claude Opus 4.8",
        capabilities: { type: "chat", limits: { max_context_window_tokens: 200_000, max_output_tokens: 64_000 }, supports: { vision: true, reasoning_effort: ["low", "medium", "high"] } },
      },
      { id: "gpt-4o", name: "GPT-4o", capabilities: { type: "chat", limits: { max_prompt_tokens: 128_000 }, supports: { vision: true } } },
      { id: "text-embedding-3-small", name: "Embedding", capabilities: { type: "embeddings" } },
      { id: "bare" }, // no capabilities at all
    ],
  };

  it("returns the full definition each model needs in a client config", async () => {
    const f = vi.fn(async () => json(payload));
    const out = await fetchCopilotModelCatalog("tok", f as unknown as typeof fetch);
    const opus = out.find((m) => m.id === "claude-opus-4.8")!;
    expect(opus).toEqual({
      id: "claude-opus-4.8", name: "Claude Opus 4.8",
      contextWindow: 200_000, maxOutputTokens: 64_000,
      vision: true, reasoningEfforts: ["low", "medium", "high"],
    });
  });

  it("drops non-chat models so an embedding can never reach a picker or a generated config", async () => {
    const f = vi.fn(async () => json(payload));
    const out = await fetchCopilotModelCatalog("tok", f as unknown as typeof fetch);
    expect(out.map((m) => m.id)).not.toContain("text-embedding-3-small");
  });

  it("fills sane defaults for a model whose payload omits the metadata", async () => {
    const f = vi.fn(async () => json(payload));
    const out = await fetchCopilotModelCatalog("tok", f as unknown as typeof fetch);
    // A capability-less entry is treated as chat (missing type != non-chat) and gets defaults, not NaN.
    expect(out.find((m) => m.id === "bare")).toEqual({
      id: "bare", name: "bare", contextWindow: 128_000, maxOutputTokens: 16_384, vision: false, reasoningEfforts: [],
    });
    // max_prompt_tokens stands in for an absent context window, same as fetchModelLimits.
    expect(out.find((m) => m.id === "gpt-4o")!.contextWindow).toBe(128_000);
    expect(out.find((m) => m.id === "gpt-4o")!.reasoningEfforts).toEqual([]);
  });

  it("returns [] when the endpoint fails, so a caller says 'unreachable' instead of writing a guess", async () => {
    const f = vi.fn(async () => new Response("", { status: 500 }));
    expect(await fetchCopilotModelCatalog("tok", f as unknown as typeof fetch)).toEqual([]);
  });
});

describe("fetchModelDiscovery", () => {
  it("derives ids, endpoints, reasoning and 1M sets from ONE fetch", async () => {
    const f = vi.fn(async () => json({ data: [
      { id: "claude-opus-4.8", supported_endpoints: ["/chat/completions"], capabilities: { limits: { max_context_window_tokens: 1_000_000 }, supports: { reasoning_effort: ["low", "high"] } } },
      { id: "gpt-4o", capabilities: { limits: { max_context_window_tokens: 128_000 } } },
    ] }));
    const d = (await fetchModelDiscovery("tok", f as unknown as typeof fetch))!;
    // The worker used to make four separate calls for this same payload; Copilot serializes them, so
    // all four raced one 8s timeout and degraded together.
    expect(f).toHaveBeenCalledTimes(1);
    expect(d.ids).toEqual(["claude-opus-4.8", "gpt-4o"]);
    expect(d.endpoints).toEqual({ "claude-opus-4.8": ["/chat/completions"] });
    expect([...d.reasoning]).toEqual(["claude-opus-4.8"]);
    expect([...d.oneM]).toEqual(["claude-opus-4.8"]);
  });

  it("returns null on failure rather than a fallback list", async () => {
    // This is the whole point: fetchCopilotModels answers a failure with FALLBACK_MODELS, whose ids are
    // DASHED. Handing those to the router as fuzzy-match targets rewrites a valid claude-opus-4.8 into a
    // claude-opus-4-8 that Copilot rejects with 400 "model_not_supported". null lets the worker keep an
    // empty list and pass the requested id through untouched.
    const f = vi.fn(async () => new Response("", { status: 500 }));
    expect(await fetchModelDiscovery("tok", f as unknown as typeof fetch)).toBeNull();
  });

  it("returns null for an empty model list", async () => {
    const f = vi.fn(async () => json({ data: [] }));
    expect(await fetchModelDiscovery("tok", f as unknown as typeof fetch)).toBeNull();
  });
});
