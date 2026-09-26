import { describe, expect, it } from "vitest";
import request from "supertest";
import { createWorkerApp } from "../src/worker/server.js";
import { Router } from "../src/worker/router.js";
import type { ClaudeModelMap } from "../src/core/claude-model-map.js";
import type { ProviderAdapter } from "../src/providers/types.js";

interface FixtureOptions {
  enabled: boolean;
  map?: ClaudeModelMap;
  models?: string[];
  limits?: Record<string, number>;
}

function fixture({
  enabled,
  map,
  models = ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-sol-fast", "gpt-5.6-luna", "gpt-4o"],
  limits = {
    "gpt-6-astra": 1_050_000,
    "gpt-5.6-sol": 1_100_000,
    "gpt-5.6-sol-fast": 1_100_000,
    "gpt-5.6-luna": 1_100_000,
    "gpt-4o": 128_000,
  },
}: FixtureOptions) {
  const seen: string[] = [];
  const metrics: string[] = [];
  const provider: ProviderAdapter = {
    name: "copilot",
    complete: async (req) => {
      seen.push(req.model);
      return { id: "c1", model: req.model, content: [{ type: "text", text: "ok" }], finishReason: "stop", usage: { promptTokens: 3, completionTokens: 1 } };
    },
    async *stream() { yield { kind: "done", done: true, finishReason: "stop" } as const; },
  };
  const router = new Router([provider], {}, { claudeMapEnabled: enabled, claudeModelMap: map });
  router.setAvailableModels(models);
  router.setModelLimits(limits);
  const worker = createWorkerApp(router, (m) => metrics.push(m.model));
  return { worker, router, seen, metrics };
}

const ids = (body: { data: Array<{ id: string }> }) => body.data.map((model) => model.id);

describe("E2E: Claude model compatibility map", () => {
  it("EP-44 leaves both discovery endpoints unchanged while disabled", async () => {
    const { worker } = fixture({ enabled: false, models: ["gpt-5.6-sol", "gpt-4o"] });
    const anthropic = await request(worker).get("/anthropic/v1/models");
    const openai = await request(worker).get("/openai/models");
    expect(ids(anthropic.body)).toEqual(["gpt-5.6-sol", "gpt-4o"]);
    expect(ids(openai.body)).toEqual(["gpt-5.6-sol", "gpt-4o"]);
  });

  it("EP-45 advertises all four current default identities only when their exact backends are live", async () => {
    const { worker } = fixture({ enabled: true });
    const anthropic = await request(worker).get("/anthropic/v1/models");
    const openai = await request(worker).get("/openai/models");

    expect(anthropic.body.data.slice(-4)).toEqual([
      { type: "model", id: "claude-fable-5-1[1m]", display_name: "Fable 5.1" },
      { type: "model", id: "claude-opus-5[1m]", display_name: "Opus 5" },
      { type: "model", id: "claude-sonnet-5[1m]", display_name: "Sonnet 5" },
      { type: "model", id: "claude-haiku-4-5[1m]", display_name: "Haiku 4.5" },
    ]);
    expect(ids(openai.body)).toEqual(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-sol-fast", "gpt-5.6-luna", "gpt-4o"]);
    expect(ids(anthropic.body)).not.toContain("claude-opus-4-8[1m]");
    expect(ids(anthropic.body)).not.toContain("claude-sonnet-4-6[1m]");
  });

  it("EP-46 routes a custom mapping through discovery, provider selection, and metrics", async () => {
    const { worker, seen, metrics } = fixture({
      enabled: true,
      map: {
        "claude-fable-5-1": "gpt-6-astra",
        "claude-opus-5": "gpt-5.6-sol",
        "claude-sonnet-5": "gpt-5.5",
        "claude-haiku-4-5": "gpt-5.6-luna",
      },
      models: ["gpt-5.5"],
      limits: { "gpt-5.5": 1_100_000 },
    });
    const discovered = await request(worker).get("/anthropic/v1/models");
    expect(ids(discovered.body)).toContain("claude-sonnet-5[1m]");

    const res = await request(worker).post("/anthropic/v1/messages")
      .send({ model: "claude-sonnet-5[1m]", max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(seen).toEqual(["gpt-5.5"]);
    expect(metrics).toEqual(["gpt-5.5"]);
  });

  it("EP-47 retains but neither advertises nor resolves a custom target that is not live", async () => {
    const { worker, router, seen } = fixture({
      enabled: true,
      map: {
        "claude-fable-5-1": "gpt-6-astra",
        "claude-opus-5": "gpt-5.6-sol",
        "claude-sonnet-5": "gpt-not-live",
        "claude-haiku-4-5": "gpt-5.6-luna",
      },
      models: ["gpt-4o"],
      limits: { "gpt-4o": 128_000 },
    });
    const discovered = await request(worker).get("/anthropic/v1/models");
    expect(ids(discovered.body)).not.toContain("claude-sonnet-5");
    expect(router.resolveModel("claude-sonnet-5[1m]")).toBe("claude-sonnet-5");

    await request(worker).post("/anthropic/v1/messages")
      .send({ model: "claude-sonnet-5[1m]", max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
    expect(seen).toEqual(["claude-sonnet-5"]);
  });

  it("EP-48 derives canonical context metadata from the custom backend and removes legacy mappings", async () => {
    const { worker, router } = fixture({
      enabled: true,
      map: {
        "claude-fable-5-1": "gpt-6-astra",
        "claude-opus-5": "gpt-5.6-sol",
        "claude-sonnet-5": "gpt-5.4-mini",
        "claude-haiku-4-5": "gpt-5.6-luna",
      },
      models: ["gpt-5.4-mini", "gpt-5.6-luna"],
      limits: { "gpt-5.4-mini": 400_000, "gpt-5.6-luna": 1_100_000 },
    });
    const discovered = await request(worker).get("/anthropic/v1/models");
    expect(discovered.body.data.find((model: { id: string }) => model.id.startsWith("claude-sonnet-5"))).toEqual({
      type: "model", id: "claude-sonnet-5", display_name: "Sonnet 5",
    });
    expect(router.modelLimit("claude-sonnet-5")).toBe(400_000);
    expect(router.resolveModel("claude-opus-4-8[1m]")).toBe("claude-opus-4-8");
    expect(router.resolveModel("claude-sonnet-4-6[1m]")).toBe("claude-sonnet-4-6");
  });

  it("EP-49 retains and routes a real Claude model instead of hijacking its colliding identity", async () => {
    const { worker, router, seen } = fixture({
      enabled: true,
      models: ["claude-opus-5", "gpt-5.6-sol"],
      limits: { "claude-opus-5": 200_000, "gpt-5.6-sol": 1_100_000 },
    });
    router.setOneMModels(["gpt-5.6-sol"]);
    const discovered = await request(worker).get("/anthropic/v1/models");
    expect(ids(discovered.body)).toEqual(["claude-opus-5", "gpt-5.6-sol"]);
    const res = await request(worker).post("/anthropic/v1/messages")
      .send({ model: "claude-opus-5[1m]", max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(seen).toEqual(["claude-opus-5"]);
    expect(router.modelLimit("claude-opus-5[1m]")).toBe(200_000);
  });
});
