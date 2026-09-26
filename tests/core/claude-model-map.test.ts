import { describe, expect, it } from "vitest";
import {
  CLAUDE_MODEL_DEFAULTS,
  availableClaudeMappings,
  backendForClaudeAlias,
  claudeMapLines,
  mappedModelIds,
  modelMapDisplay,
  resolveClaudeModelMap,
  sanitizeClaudeModelOverrides,
} from "../../src/core/claude-model-map.js";

describe("Claude model compatibility map", () => {
  it("defines the approved current defaults in stable display order", () => {
    expect(CLAUDE_MODEL_DEFAULTS).toEqual({
      "claude-fable-5-1": "gpt-6-astra",
      "claude-opus-5": "gpt-5.6-sol",
      "claude-sonnet-5": "gpt-5.6-sol-fast",
      "claude-haiku-4-5": "gpt-5.6-luna",
    });
    expect(claudeMapLines()).toEqual([
      "claude-fable-5-1 → gpt-6-astra",
      "claude-opus-5 → gpt-5.6-sol",
      "claude-sonnet-5 → gpt-5.6-sol-fast",
      "claude-haiku-4-5 → gpt-5.6-luna",
    ]);
  });

  it("sanitizes overrides independently and overlays only supported GPT targets", () => {
    const raw = {
      "claude-fable-5-1": "gpt-6-astra-preview",
      "claude-opus-5": "",
      "claude-sonnet-5": "gemini-3.7-flash",
      "claude-haiku-4-5": "gpt-5.4-mini",
      "claude-opus-4-8": "gpt-5.6-luna",
    };
    expect(sanitizeClaudeModelOverrides(raw)).toEqual({
      "claude-fable-5-1": "gpt-6-astra-preview",
      "claude-haiku-4-5": "gpt-5.4-mini",
    });
    expect(resolveClaudeModelMap(raw)).toEqual({
      "claude-fable-5-1": "gpt-6-astra-preview",
      "claude-opus-5": "gpt-5.6-sol",
      "claude-sonnet-5": "gpt-5.6-sol-fast",
      "claude-haiku-4-5": "gpt-5.4-mini",
    });
    expect(sanitizeClaudeModelOverrides(null)).toEqual({});
    expect(sanitizeClaudeModelOverrides({ "claude-opus-5": "gpt-5.6-sol\ninvalid" })).toEqual({});
    expect(sanitizeClaudeModelOverrides({ "claude-opus-5": "gpt-5.6-sol " })).toEqual({});
  });

  it("publishes only aliases whose exact effective GPT backend is live and no real Claude identity exists", () => {
    const map = resolveClaudeModelMap({ "claude-sonnet-5": "gpt-5.5" });
    expect(availableClaudeMappings(["gpt-6-astra", "gpt-5.5", "gpt-4o"], map)).toEqual([
      { alias: "claude-fable-5-1", backend: "gpt-6-astra" },
      { alias: "claude-sonnet-5", backend: "gpt-5.5" },
    ]);
    expect(availableClaudeMappings(["claude-sonnet-5", "gpt-5.5"], map)).toEqual([]);
  });

  it("resolves canonical and [1m] aliases only when their effective backend is live", () => {
    const map = resolveClaudeModelMap({ "claude-opus-5": "gpt-6-astra" });
    expect(backendForClaudeAlias("claude-opus-5", ["gpt-6-astra"], map)).toBe("gpt-6-astra");
    expect(backendForClaudeAlias("claude-opus-5[1m]", ["gpt-6-astra"], map)).toBe("gpt-6-astra");
    expect(backendForClaudeAlias("claude-sonnet-5[1m]", ["gpt-6-astra"], map)).toBeUndefined();
    expect(backendForClaudeAlias("claude-opus-4-8[1m]", ["gpt-5.6-luna"], map)).toBeUndefined();
    expect(backendForClaudeAlias("claude-sonnet-4-6[1m]", ["gpt-5.5"], map)).toBeUndefined();
    expect(backendForClaudeAlias("claude-opus-5[1m]", ["claude-opus-5", "gpt-6-astra"], map)).toBeUndefined();
  });

  it("retains original GPT ids and appends available aliases without duplicates", () => {
    expect(mappedModelIds(["gpt-5.6-sol", "gpt-4o", "claude-opus-5"])).toEqual([
      "gpt-5.6-sol", "gpt-4o", "claude-opus-5",
    ]);
    expect(mappedModelIds(["gpt-5.6-sol", "gpt-4o"])).toEqual([
      "gpt-5.6-sol", "gpt-4o", "claude-opus-5",
    ]);
  });

  it("provides a custom arrow label without changing the model id", () => {
    const map = resolveClaudeModelMap({ "claude-sonnet-5": "gpt-5.5" });
    expect(modelMapDisplay("claude-sonnet-5", ["gpt-5.5"], map)).toBe("claude-sonnet-5 → gpt-5.5");
    expect(modelMapDisplay("gpt-5.5", ["gpt-5.5"], map)).toBe("gpt-5.5");
  });
});
