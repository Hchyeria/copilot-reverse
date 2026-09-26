import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { MultiSelect } from "../../src/tui/components/multi-select.js";

const items = [
  { label: "a", value: "a" },
  { label: "b", value: "b" },
  { label: "c", value: "c" },
];

const ESC = String.fromCharCode(27);
const DOWN = ESC + "[B";
const settle = () => new Promise((r) => setTimeout(r, 25));

describe("MultiSelect", () => {
  it("space toggles the highlighted item; enter submits every checked one", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<MultiSelect items={items} onSubmit={onSubmit} />);
    await settle();
    stdin.write(" ");    // check a
    await settle();
    stdin.write(DOWN);
    await settle();
    stdin.write(DOWN);   // -> c
    await settle();
    stdin.write(" ");    // check c
    await settle();
    stdin.write("\r");
    await settle();
    expect(onSubmit).toHaveBeenCalledWith(["a", "c"]);
  });

  it("pre-checks the initial values, so the common case is a single keypress", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<MultiSelect items={items} initial={["b"]} onSubmit={onSubmit} />);
    await settle();
    expect(lastFrame()).toMatch(/\[x\] b/);
    expect(lastFrame()).toMatch(/1 selected/);
    stdin.write("\r");
    await settle();
    expect(onSubmit).toHaveBeenCalledWith(["b"]);
  });

  it("`a` checks everything, and again clears everything", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<MultiSelect items={items} onSubmit={onSubmit} />);
    await settle();
    stdin.write("a");
    await settle();
    expect(lastFrame()).toMatch(/3 selected/);
    stdin.write("a");
    await settle();
    expect(lastFrame()).toMatch(/0 selected/);
    stdin.write("a");
    await settle();
    stdin.write("\r");
    await settle();
    expect(onSubmit).toHaveBeenCalledWith(["a", "b", "c"]);
  });

  it("ignores enter while nothing is checked — an empty pick would write a provider with no models", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<MultiSelect items={items} onSubmit={onSubmit} />);
    await settle();
    stdin.write("\r");
    await settle();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("esc cancels", async () => {
    const onCancel = vi.fn();
    const { stdin } = render(<MultiSelect items={items} onSubmit={vi.fn()} onCancel={onCancel} />);
    await settle();
    stdin.write(ESC);
    await settle();
    expect(onCancel).toHaveBeenCalled();
  });

  it("windows a long list so the full Copilot model list can't overflow the terminal", async () => {
    const long = Array.from({ length: 30 }, (_, i) => ({ label: `m${i}`, value: `m${i}` }));
    const { lastFrame } = render(<MultiSelect items={long} onSubmit={vi.fn()} />);
    await settle();
    expect(lastFrame()).toMatch(/more/);
  });
});
