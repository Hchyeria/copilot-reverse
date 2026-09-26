import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { GitHubLoginScreen } from "../../src/tui/screens/github-login.js";

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

describe("GitHubLoginScreen", () => {
  it("offers GitHub.com and GHE.com, not GHES", () => {
    const { lastFrame } = render(<GitHubLoginScreen onSubmit={vi.fn()} onCancel={vi.fn()} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("GitHub.com");
    expect(frame).toContain("GHE.com");
    expect(frame).not.toContain("GHES");
  });

  it("submits GitHub.com without asking for a hostname", async () => {
    const submit = vi.fn();
    const { stdin, lastFrame } = render(<GitHubLoginScreen onSubmit={submit} onCancel={vi.fn()} />);
    await tick();
    stdin.write("\r");
    await tick();
    expect(submit).toHaveBeenCalledWith({ type: "github" });
    expect(lastFrame()).not.toContain("hostname ›");
  });

  it("asks for and normalizes a hostname only after GHE.com is selected", async () => {
    const submit = vi.fn();
    const { stdin, lastFrame } = render(<GitHubLoginScreen onSubmit={submit} onCancel={vi.fn()} />);
    await tick();
    stdin.write("\x1b[B");
    await tick();
    stdin.write("\r");
    await tick();
    expect(lastFrame()).toContain("hostname ›");
    stdin.write("ACME.GHE.COM");
    await tick();
    stdin.write("\r");
    await tick();
    expect(submit).toHaveBeenCalledWith({ type: "ghecom", host: "acme.ghe.com" });
  });

  it("shows invalid host feedback without submitting", async () => {
    const submit = vi.fn();
    const { stdin, lastFrame } = render(<GitHubLoginScreen onSubmit={submit} onCancel={vi.fn()} />);
    await tick();
    stdin.write("\x1b[B");
    await tick();
    stdin.write("\r");
    await tick();
    stdin.write("https://acme.ghe.com");
    stdin.write("\r");
    await tick();
    expect(submit).not.toHaveBeenCalled();
    expect(lastFrame()).toMatch(/invalid GHE\.com hostname/i);
  });
});
