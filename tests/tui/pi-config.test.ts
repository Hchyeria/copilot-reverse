import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyPi, resetPi, buildPiConfig, piPath, readPiStatus,
  PI_ANTHROPIC_PROVIDER, PI_OPENAI_PROVIDER,
} from "../../src/tui/setup/pi-config.js";
import type { CopilotModelInfo } from "../../src/providers/copilot/models.js";

const endpoint = { host: "127.0.0.1", port: 7891, apiKey: "copilot-reverse-local" };
const home = () => mkdtempSync(join(tmpdir(), "pi-"));
const read = (h: string) => JSON.parse(readFileSync(piPath({ home: h }), "utf8"));

const OPUS: CopilotModelInfo = {
  id: "claude-opus-4.8", name: "Claude Opus 4.8",
  contextWindow: 200_000, maxOutputTokens: 64_000,
  vision: true, reasoningEfforts: ["low", "medium", "high"],
};
const GPT4O: CopilotModelInfo = {
  id: "gpt-4o", name: "GPT-4o",
  contextWindow: 128_000, maxOutputTokens: 16_384,
  vision: false, reasoningEfforts: [],
};

describe("buildPiConfig", () => {
  it("emits both surfaces, each on the base URL pi's SDK will append the right path to", () => {
    const p = buildPiConfig([OPUS], endpoint);
    // pi's built-in anthropic provider is https://api.anthropic.com (its SDK appends /v1/messages) and
    // openai is https://api.openai.com/v1 (appends /chat/completions) — so these land exactly on the
    // worker's /anthropic/v1/messages and /openai/chat/completions mounts.
    expect(p[PI_ANTHROPIC_PROVIDER].api).toBe("anthropic-messages");
    expect(p[PI_ANTHROPIC_PROVIDER].baseUrl).toBe("http://127.0.0.1:7891/anthropic");
    expect(p[PI_OPENAI_PROVIDER].api).toBe("openai-completions");
    expect(p[PI_OPENAI_PROVIDER].baseUrl).toBe("http://127.0.0.1:7891/openai");
  });

  it("carries every picked model on both providers, keeping Copilot's raw dotted id", () => {
    const p = buildPiConfig([OPUS, GPT4O], endpoint);
    // router.resolveModel runs on both worker routes, so a dotted id resolves as-is on either one.
    expect(p[PI_ANTHROPIC_PROVIDER].models.map((m) => m.id)).toEqual(["claude-opus-4.8", "gpt-4o"]);
    expect(p[PI_OPENAI_PROVIDER].models.map((m) => m.id)).toEqual(["claude-opus-4.8", "gpt-4o"]);
    // Each model states the api/baseUrl of the provider it sits under.
    expect(p[PI_OPENAI_PROVIDER].models[0].api).toBe("openai-completions");
    expect(p[PI_OPENAI_PROVIDER].models[0].baseUrl).toBe("http://127.0.0.1:7891/openai");
  });

  it("maps vision to image input and cost to the /metrics list price", () => {
    const [opus, gpt] = buildPiConfig([OPUS, GPT4O], endpoint)[PI_OPENAI_PROVIDER].models;
    expect(opus.input).toEqual(["text", "image"]);
    expect(gpt.input).toEqual(["text"]);
    expect(opus.contextWindow).toBe(200_000);
    expect(opus.maxTokens).toBe(64_000);
    // Shared with estimateCost's table (opus = 15/75), so pi's session cost agrees with our /metrics.
    expect(opus.cost.input).toBe(15);
    expect(opus.cost.output).toBe(75);
    expect(opus.cost.cacheRead).toBeCloseTo(1.5);
    expect(opus.cost.cacheWrite).toBeCloseTo(18.75);
  });

  it("clamps every pi thinking level onto an effort the model actually accepts", () => {
    const [opus] = buildPiConfig([OPUS], endpoint)[PI_OPENAI_PROVIDER].models;
    expect(opus.reasoning).toBe(true);
    // The model accepts only low/medium/high. A missing key would make pi forward its own level
    // verbatim — "xhigh"/"max" would be a hard upstream 400 — so every level is stated and clamped.
    expect(opus.thinkingLevelMap).toEqual({
      off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high",
    });
  });

  it("omits the thinking map entirely for a non-reasoning model", () => {
    const [gpt] = buildPiConfig([GPT4O], endpoint)[PI_OPENAI_PROVIDER].models;
    expect(gpt.reasoning).toBe(false);
    expect(gpt.thinkingLevelMap).toBeUndefined();
  });

  it("marks every level unsupported when the model's effort enum has no name pi knows", () => {
    const odd: CopilotModelInfo = { ...GPT4O, id: "odd", reasoningEfforts: ["none"] };
    const [m] = buildPiConfig([odd], endpoint)[PI_OPENAI_PROVIDER].models;
    expect(m.thinkingLevelMap).toEqual({ off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null });
  });
});

describe("applyPi / resetPi (non-destructive merge into ~/.pi/agent/models.json)", () => {
  it("creates the file (and the agent dir) when pi has never been configured", () => {
    const h = home();
    const r = applyPi([OPUS], endpoint, { home: h });
    expect(r.path).toBe(join(h, ".pi", "agent", "models.json"));
    expect(r.changed).toEqual([PI_ANTHROPIC_PROVIDER, PI_OPENAI_PROVIDER]);
    expect(Object.keys(read(h).providers)).toEqual([PI_ANTHROPIC_PROVIDER, PI_OPENAI_PROVIDER]);
  });

  it("preserves a foreign provider and every other top-level key", () => {
    const h = home();
    mkdirSync(join(h, ".pi", "agent"), { recursive: true });
    writeFileSync(piPath({ home: h }), JSON.stringify({
      // pi's OWN built-in Copilot provider, plus a user's hand-rolled one — neither is ours to touch.
      providers: { "github-copilot": { models: [{ id: "gpt-5.6-luna" }] }, ollama: { baseUrl: "http://localhost:11434/v1" } },
      somethingElse: { keep: true },
    }));
    applyPi([OPUS], endpoint, { home: h });
    const cfg = read(h);
    expect(cfg.providers["github-copilot"].models).toEqual([{ id: "gpt-5.6-luna" }]);
    expect(cfg.providers.ollama.baseUrl).toBe("http://localhost:11434/v1");
    expect(cfg.somethingElse).toEqual({ keep: true });
    expect(cfg.providers[PI_OPENAI_PROVIDER].models).toHaveLength(1);
  });

  it("replaces our providers wholesale on re-run, so a de-selected model doesn't linger", () => {
    const h = home();
    applyPi([OPUS, GPT4O], endpoint, { home: h });
    applyPi([GPT4O], endpoint, { home: h });
    expect(read(h).providers[PI_OPENAI_PROVIDER].models.map((m: { id: string }) => m.id)).toEqual(["gpt-4o"]);
  });

  it("treats a corrupt models.json as absent instead of throwing", () => {
    const h = home();
    mkdirSync(join(h, ".pi", "agent"), { recursive: true });
    writeFileSync(piPath({ home: h }), "{ not json");
    expect(() => applyPi([OPUS], endpoint, { home: h })).not.toThrow();
    expect(Object.keys(read(h).providers)).toEqual([PI_ANTHROPIC_PROVIDER, PI_OPENAI_PROVIDER]);
  });

  it("resetPi removes only our providers, keeping the rest of the file", () => {
    const h = home();
    mkdirSync(join(h, ".pi", "agent"), { recursive: true });
    writeFileSync(piPath({ home: h }), JSON.stringify({ providers: { ollama: { baseUrl: "x" } }, theme: "nord" }));
    applyPi([OPUS], endpoint, { home: h });
    const r = resetPi({ home: h });
    expect(r.changed).toEqual([PI_ANTHROPIC_PROVIDER, PI_OPENAI_PROVIDER]);
    const cfg = read(h);
    expect(Object.keys(cfg.providers)).toEqual(["ollama"]);
    expect(cfg.theme).toBe("nord");
  });

  it("resetPi drops an emptied providers map rather than leaving scaffolding", () => {
    const h = home();
    applyPi([OPUS], endpoint, { home: h });
    resetPi({ home: h });
    expect(read(h).providers).toBeUndefined();
  });

  it("resetPi is a no-op when pi was never configured", () => {
    const h = home();
    const r = resetPi({ home: h });
    expect(r.changed).toEqual([]);
    expect(existsSync(piPath({ home: h }))).toBe(false); // and it doesn't create the file
  });
});

describe("readPiStatus (what the HUD / dashboard report)", () => {
  it("reports on + the model count once configured", () => {
    const h = home();
    applyPi([OPUS, GPT4O], endpoint, { home: h });
    expect(readPiStatus({ home: h })).toEqual({ on: true, models: 2 });
  });

  it("is off when pi has no config at all", () => {
    expect(readPiStatus({ home: home() })).toEqual({ on: false, models: 0 });
  });

  it("does not claim a same-named provider that points somewhere else as ours", () => {
    const h = home();
    mkdirSync(join(h, ".pi", "agent"), { recursive: true });
    // Same key, but a remote base URL — that's not a copilot-reverse local setup.
    writeFileSync(piPath({ home: h }), JSON.stringify({
      providers: { [PI_OPENAI_PROVIDER]: { baseUrl: "https://api.openai.com/v1", models: [{ id: "gpt-4o" }] } },
    }));
    expect(readPiStatus({ home: h })).toEqual({ on: false, models: 0 });
  });
});
