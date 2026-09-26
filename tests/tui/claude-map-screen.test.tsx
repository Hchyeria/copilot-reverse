import { describe, expect, it, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { ClaudeMapScreen, type ClaudeMapSaveResult } from "../../src/tui/screens/claude-map.js";
import type { ClaudeMapSettings } from "../../src/shared/prefs.js";

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const down = "\x1b[B";
const enter = "\r";
const esc = "\x1b";
const defaults: ClaudeMapSettings = { enabled: true, overrides: {} };

async function move(stdin: { write: (value: string) => void }, count: number) {
  for (let i = 0; i < count; i++) { stdin.write(down); await tick(); }
}

describe("ClaudeMapScreen", () => {
  it("shows a loading state before live Copilot discovery resolves", async () => {
    const loadModels = () => new Promise<string[]>(() => {});
    const { lastFrame } = render(<ClaudeMapScreen settings={defaults} loadModels={loadModels} onSave={async () => ({})} onDone={() => {}} onCancel={() => {}} />);
    await tick();
    expect(lastFrame() ?? "").toMatch(/loading.*Copilot/i);
  });

  it("shows discovery errors and lets the user leave the editor", async () => {
    const onCancel = vi.fn();
    const { stdin, lastFrame } = render(<ClaudeMapScreen settings={defaults} loadModels={async () => { throw new Error("offline"); }} onSave={async () => ({})} onDone={() => {}} onCancel={onCancel} />);
    await tick(80);
    expect(lastFrame() ?? "").toMatch(/failed.*offline/i);
    stdin.write(esc); await tick(40);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows current identities, custom/default markers, and preserved unavailable targets", async () => {
    const settings: ClaudeMapSettings = { enabled: true, overrides: { "claude-fable-5-1": "gpt-6-astra-preview", "claude-sonnet-5": "gpt-5.5" } };
    const { lastFrame } = render(<ClaudeMapScreen settings={settings} loadModels={async () => ["gpt-5.5", "gemini-3.7-flash"]} onSave={async () => ({})} onDone={() => {}} onCancel={() => {}} />);
    await tick(80);
    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/Claude model map.*on/i);
    expect(frame).toContain("claude-fable-5-1 → gpt-6-astra-preview");
    expect(frame).toMatch(/gpt-6-astra-preview.*custom.*unavailable/i);
    expect(frame).toMatch(/claude-sonnet-5.*gpt-5\.5.*custom/i);
    expect(frame).toMatch(/claude-opus-5.*gpt-5\.6-sol.*default/i);
  });

  it("edits a row using only live gpt-* targets, then saves one complete custom snapshot", async () => {
    const saved: ClaudeMapSettings[] = [];
    const onSave = vi.fn(async (settings: ClaudeMapSettings): Promise<ClaudeMapSaveResult> => { saved.push(settings); return { models: ["claude-sonnet-5"] }; });
    const onDone = vi.fn();
    const { stdin, lastFrame } = render(<ClaudeMapScreen settings={defaults} loadModels={async () => ["gemini-3.7-flash", "gpt-5.5", "gpt-5.6-sol-fast", "gpt-5.5"]} onSave={onSave} onDone={onDone} onCancel={() => {}} />);
    await tick(80);

    await move(stdin, 3);
    stdin.write(enter); await tick(60);
    const picker = lastFrame() ?? "";
    expect(picker).toMatch(/choose.*Sonnet 5.*backend/i);
    expect(picker).toContain("gpt-5.5");
    expect(picker).toContain("gpt-5.6-sol-fast");
    expect(picker).not.toContain("gemini-3.7-flash");
    expect(picker.match(/gpt-5\.5/g)?.length).toBe(1);

    stdin.write(enter); await tick(60);
    expect(lastFrame() ?? "").toMatch(/claude-sonnet-5.*gpt-5\.5.*custom/i);
    await move(stdin, 6);
    stdin.write(enter); await tick(80);

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(saved).toEqual([{ enabled: true, overrides: { "claude-sonnet-5": "gpt-5.5" } }]);
    expect(onDone).toHaveBeenCalledWith({ enabled: true, overrides: { "claude-sonnet-5": "gpt-5.5" } }, { models: ["claude-sonnet-5"] });
  });

  it("restores defaults in the draft and persists no redundant overrides", async () => {
    const settings: ClaudeMapSettings = { enabled: true, overrides: { "claude-sonnet-5": "gpt-5.5" } };
    const onSave = vi.fn(async (): Promise<ClaudeMapSaveResult> => ({}));
    const { stdin, lastFrame } = render(<ClaudeMapScreen settings={settings} loadModels={async () => ["gpt-5.5", "gpt-5.6-sol-fast"]} onSave={onSave} onDone={() => {}} onCancel={() => {}} />);
    await tick(80);
    await move(stdin, 5); stdin.write(enter); await tick(60);
    expect(lastFrame() ?? "").toMatch(/claude-sonnet-5.*gpt-5\.6-sol-fast.*default/i);
    stdin.write(down); await tick(); stdin.write(enter); await tick(80);
    expect(onSave).toHaveBeenCalledWith({ enabled: true, overrides: {} });
  });

  it("keeps overrides while disabling and writes only when Save is selected", async () => {
    const settings: ClaudeMapSettings = { enabled: true, overrides: { "claude-sonnet-5": "gpt-5.5" } };
    const onSave = vi.fn(async (): Promise<ClaudeMapSaveResult> => ({}));
    const { stdin } = render(<ClaudeMapScreen settings={settings} loadModels={async () => ["gpt-5.5"]} onSave={onSave} onDone={() => {}} onCancel={() => {}} />);
    await tick(80);
    stdin.write(enter); await tick(60);
    expect(onSave).not.toHaveBeenCalled();
    await move(stdin, 6); stdin.write(enter); await tick(80);
    expect(onSave).toHaveBeenCalledWith({ enabled: false, overrides: { "claude-sonnet-5": "gpt-5.5" } });
  });

  it("cancels from overview without saving and returns from a backend picker without mutating", async () => {
    const onSave = vi.fn(async (): Promise<ClaudeMapSaveResult> => ({}));
    const onCancel = vi.fn();
    const first = render(<ClaudeMapScreen settings={defaults} loadModels={async () => ["gpt-5.5"]} onSave={onSave} onDone={() => {}} onCancel={onCancel} />);
    await tick(80); first.stdin.write(esc); await tick(40);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();

    const second = render(<ClaudeMapScreen settings={defaults} loadModels={async () => ["gpt-5.5"]} onSave={onSave} onDone={() => {}} onCancel={() => {}} />);
    await tick(80); await move(second.stdin, 1); second.stdin.write(enter); await tick(60);
    second.stdin.write(esc); await tick(60);
    expect(second.lastFrame() ?? "").toMatch(/claude-fable-5-1.*gpt-6-astra.*default/i);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("keeps non-edit actions usable when discovery has no GPT models", async () => {
    const onSave = vi.fn(async (): Promise<ClaudeMapSaveResult> => ({}));
    const { stdin, lastFrame } = render(<ClaudeMapScreen settings={defaults} loadModels={async () => ["gemini-3.7-flash", "o3-mini"]} onSave={onSave} onDone={() => {}} onCancel={() => {}} />);
    await tick(80);
    expect(lastFrame() ?? "").toMatch(/no live GPT backends/i);
    stdin.write(enter); await tick(40);
    await move(stdin, 2); stdin.write(enter); await tick(80);
    expect(onSave).toHaveBeenCalledWith({ enabled: false, overrides: {} });
  });

  it("surfaces a persistence failure without claiming the settings were saved", async () => {
    const onSave = vi.fn(async () => { throw new Error("disk full"); });
    const onDone = vi.fn();
    const { stdin, lastFrame } = render(<ClaudeMapScreen settings={defaults} loadModels={async () => []} onSave={onSave} onDone={onDone} onCancel={() => {}} />);
    await tick(80); await move(stdin, 2); stdin.write(enter); await tick(80);
    expect(lastFrame() ?? "").toMatch(/save failed.*disk full/i);
    expect(lastFrame() ?? "").not.toMatch(/preference.*saved/i);
    expect(onDone).not.toHaveBeenCalled();
  });
});
