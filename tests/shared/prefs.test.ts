import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readChatModel,
  writeChatModel,
  shouldShowChange,
  markChangeShown,
  readClaudeMapEnabled,
  readClaudeMapSettings,
  writeClaudeMapEnabled,
  writeClaudeMapSettings,
} from "../../src/shared/prefs.js";

describe("prefs", () => {
  it("round-trips the chat model", () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    expect(readChatModel(d)).toBeNull();
    writeChatModel(d, "gpt-4o");
    expect(readChatModel(d)).toBe("gpt-4o");
  });
  it("preserves other prefs keys on write", () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    writeFileSync(join(d, "prefs.json"), JSON.stringify({ other: 1 }));
    writeChatModel(d, "claude-sonnet-5");
    const raw = JSON.parse(readFileSync(join(d, "prefs.json"), "utf8"));
    expect(raw.other).toBe(1);
    expect(raw.chatModel).toBe("claude-sonnet-5");
  });
  it("change banner shows maxShows times then stops, per id", () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    expect(shouldShowChange(d, "v1", 3)).toBe(true);
    for (let i = 0; i < 3; i++) markChangeShown(d, "v1");
    expect(shouldShowChange(d, "v1", 3)).toBe(false);
    expect(shouldShowChange(d, "v2", 3)).toBe(true);
  });

  it("defaults the Claude map off with no custom overrides", () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    expect(readClaudeMapSettings(d)).toEqual({ enabled: false, overrides: {} });
    expect(readClaudeMapEnabled(d)).toBe(false);
  });

  it("round-trips one complete map snapshot and preserves unrelated preferences", () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    writeFileSync(join(d, "prefs.json"), JSON.stringify({ chatModel: "gpt-5.6-sol", other: 1 }));
    writeClaudeMapSettings(d, {
      enabled: true,
      overrides: {
        "claude-fable-5-1": "gpt-6-astra-preview",
        "claude-sonnet-5": "gpt-5.5",
      },
    });
    expect(readClaudeMapSettings(d)).toEqual({
      enabled: true,
      overrides: {
        "claude-fable-5-1": "gpt-6-astra-preview",
        "claude-sonnet-5": "gpt-5.5",
      },
    });
    expect(readClaudeMapEnabled(d)).toBe(true);
    const raw = JSON.parse(readFileSync(join(d, "prefs.json"), "utf8"));
    expect(raw).toMatchObject({ chatModel: "gpt-5.6-sol", other: 1, claudeMapEnabled: true });
  });

  it("sanitizes bad entries independently and fails closed for a non-boolean toggle", () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    writeFileSync(join(d, "prefs.json"), JSON.stringify({
      claudeMapEnabled: "yes",
      claudeModelMap: {
        "claude-fable-5-1": "gpt-6-astra",
        "claude-opus-5": "",
        "claude-sonnet-5": "gemini-3.7-flash",
        "claude-haiku-4-5": "gpt-5.4-mini",
        "claude-opus-4-8": "gpt-5.6-luna",
      },
    }));
    expect(readClaudeMapSettings(d)).toEqual({
      enabled: false,
      overrides: {
        "claude-fable-5-1": "gpt-6-astra",
        "claude-haiku-4-5": "gpt-5.4-mini",
      },
    });
  });

  it("replaces the override snapshot, including resetting to defaults", () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    writeClaudeMapSettings(d, { enabled: true, overrides: { "claude-sonnet-5": "gpt-5.5" } });
    writeClaudeMapSettings(d, { enabled: false, overrides: {} });
    expect(readClaudeMapSettings(d)).toEqual({ enabled: false, overrides: {} });
    const raw = JSON.parse(readFileSync(join(d, "prefs.json"), "utf8"));
    expect(raw.claudeModelMap).toEqual({});
  });

  it("keeps the legacy toggle writer compatible while preserving overrides", () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    writeClaudeMapSettings(d, { enabled: false, overrides: { "claude-sonnet-5": "gpt-5.5" } });
    writeClaudeMapEnabled(d, true);
    expect(readClaudeMapSettings(d)).toEqual({ enabled: true, overrides: { "claude-sonnet-5": "gpt-5.5" } });
  });

  it("fails closed for corrupt or syntactically valid non-object preferences", () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    writeFileSync(join(d, "prefs.json"), "{bad");
    expect(readClaudeMapSettings(d)).toEqual({ enabled: false, overrides: {} });
    for (const malformed of ["null", "[]", '"text"', "42"]) {
      writeFileSync(join(d, "prefs.json"), malformed);
      expect(readClaudeMapSettings(d)).toEqual({ enabled: false, overrides: {} });
      expect(readChatModel(d)).toBeNull();
    }
  });
});
