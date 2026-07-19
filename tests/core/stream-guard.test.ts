import { describe, it, expect } from "vitest";
import { RunawayGuard, runawayErrorText } from "../../src/core/stream-guard.js";

describe("RunawayGuard", () => {
  it("trips on a short delta repeated past the limit", () => {
    const g = new RunawayGuard({ maxRepeats: 50 });
    let tripped = false;
    for (let i = 0; i < 200; i++) tripped = g.push("code\n") || tripped;
    expect(tripped).toBe(true);
    expect(g.reason).toBe("repetition");
  });

  it("does not trip on varied text", () => {
    const g = new RunawayGuard({ maxRepeats: 50 });
    let tripped = false;
    for (let i = 0; i < 200; i++) tripped = g.push(`line ${i} `) || tripped;
    expect(tripped).toBe(false);
  });

  it("trips when total output exceeds the cap", () => {
    const g = new RunawayGuard({ maxOutputChars: 100 });
    let tripped = false;
    for (let i = 0; i < 50; i++) tripped = g.push(`chunk-${i} `) || tripped;
    expect(tripped).toBe(true);
    expect(g.reason).toBe("max_output");
  });

  it("tolerates a few repeats then variety (counter resets)", () => {
    const g = new RunawayGuard({ maxRepeats: 50 });
    for (let i = 0; i < 10; i++) expect(g.push("a")).toBe(false);
    expect(g.push("b")).toBe(false);
    for (let i = 0; i < 10; i++) expect(g.push("a")).toBe(false);
  });
});

describe("runawayErrorText", () => {
  it("blames the model for a genuine degeneration (repetition / max_output)", () => {
    for (const reason of ["repetition", "max_output"]) {
      const text = runawayErrorText(reason);
      expect(text).toContain(`(${reason})`);
      expect(text).toContain("model degenerated");
    }
  });

  it("does NOT blame the model on a wall-clock deadline cut", () => {
    const text = runawayErrorText("deadline");
    expect(text).toContain("(deadline)");
    expect(text).toContain("wall-clock");
    // The whole point of the fix: a slow-but-healthy stream must not be mislabeled as degenerated.
    expect(text).not.toContain("degenerated");
  });
});
