import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { PiScreen, piModelLabel } from "../../src/tui/screens/pi.js";
import type { CopilotModelInfo } from "../../src/providers/copilot/models.js";

const OPUS: CopilotModelInfo = {
  id: "claude-opus-4.8", name: "Claude Opus 4.8",
  contextWindow: 200_000, maxOutputTokens: 64_000, vision: true, reasoningEfforts: ["low", "high"],
};
const GPT4O: CopilotModelInfo = {
  id: "gpt-4o", name: "GPT-4o",
  contextWindow: 128_000, maxOutputTokens: 16_384, vision: false, reasoningEfforts: [],
};

const settle = () => new Promise((r) => setTimeout(r, 30));
const result = { path: "/home/u/.pi/agent/models.json", changed: ["copilot-anthropic", "copilot-openai"] };

describe("piModelLabel", () => {
  it("shows the name, id, window, and the badges that decide what pi can do with it", () => {
    expect(piModelLabel(OPUS)).toBe("Claude Opus 4.8 (claude-opus-4.8)  · 200K  · reasoning vision");
    expect(piModelLabel(GPT4O)).toBe("GPT-4o (gpt-4o)  · 128K");
  });
});

describe("PiScreen", () => {
  it("applies only the checked models, then reports where it wrote", async () => {
    const apply = vi.fn(async () => result);
    const onDone = vi.fn();
    const { stdin, lastFrame } = render(
      <PiScreen loadCatalog={async () => [OPUS, GPT4O]} apply={apply} onDone={onDone} onCancel={vi.fn()} />,
    );
    await settle();
    stdin.write(" ");   // check the first model (opus)
    await settle();
    stdin.write("\r");
    await settle();
    expect(apply).toHaveBeenCalledWith([OPUS]);
    expect(lastFrame()).toMatch(/added 1 model/);
    expect(lastFrame()).toContain(result.path);
    // The done card tells you how to run it, on the surface that matches its family (opus → Anthropic).
    expect(lastFrame()).toMatch(/--provider copilot-anthropic --model claude-opus-4\.8/);
    expect(lastFrame()).not.toMatch(/--provider copilot-openai --model claude-opus-4\.8/);
    stdin.write("x"); // dismiss
    await settle();
    expect(onDone).toHaveBeenCalledWith(result, [OPUS]);
  });

  it("pre-checks the current chat model", async () => {
    const apply = vi.fn(async () => result);
    const { stdin, lastFrame } = render(
      <PiScreen loadCatalog={async () => [OPUS, GPT4O]} apply={apply} onDone={vi.fn()} onCancel={vi.fn()} current="gpt-4o" />,
    );
    await settle();
    expect(lastFrame()).toMatch(/\[x\] GPT-4o/);
    stdin.write("\r");
    await settle();
    expect(apply).toHaveBeenCalledWith([GPT4O]);
  });

  it("refuses to write anything when discovery comes back empty", async () => {
    const apply = vi.fn(async () => result);
    const { lastFrame } = render(
      <PiScreen loadCatalog={async () => []} apply={apply} onDone={vi.fn()} onCancel={vi.fn()} />,
    );
    await settle();
    // An empty catalog means Copilot was unreachable — writing a models.json from it would produce a
    // provider with no models. Say so, and leave the file alone.
    expect(lastFrame()).toMatch(/could not reach Copilot's model list/);
    expect(apply).not.toHaveBeenCalled();
  });

  it("surfaces a failed write instead of claiming success", async () => {
    const { stdin, lastFrame } = render(
      <PiScreen
        loadCatalog={async () => [OPUS]}
        apply={async () => { throw new Error("EACCES: permission denied"); }}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await settle();
    stdin.write(" ");
    await settle();
    stdin.write("\r");
    await settle();
    expect(lastFrame()).toMatch(/failed: EACCES/);
  });
});
