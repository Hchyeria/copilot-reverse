import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, render } from "ink-testing-library";
import { App, RecordingHud, sameRecordingStatus } from "../../src/tui/app.js";
import { buildRegistry } from "../../src/tui/slash/commands.js";
import { Registry } from "../../src/tui/slash/registry.js";
import type { StatusResponse } from "../../src/shared/control-types.js";
import type { RecordingStatus } from "../../src/shared/recording.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 50));
const off: RecordingStatus = { active: false, requests: 0, inFlight: 0 };
const active: RecordingStatus = { active: true, directory: "/private/session", requests: 3, inFlight: 2 };
const registry = () => new Registry({ client: {} as any, quit: () => {} });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// Capture the App's existing 2s poll so tests can drive real refreshes without sleeping seconds.
function statusPoll() {
  const original = globalThis.setInterval;
  let poll: () => Promise<unknown> = async () => {};
  vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => Promise<unknown>, ms: number, ...args: unknown[]) => {
    if (ms === 2000) poll = fn;
    return original(fn, ms, ...args);
  }) as typeof setInterval);
  return () => poll();
}

describe("recording HUD", () => {
  it("shows active/path/counts, stopped/draining, and incomplete warnings", () => {
    const view = render(<RecordingHud status={active} />);
    expect(view.lastFrame()).toContain("REC active");
    expect(view.lastFrame()).toContain("/private/session");
    expect(view.lastFrame()).toContain("3 requests, 2 in flight");
    view.rerender(<RecordingHud status={{ ...active, active: false, warning: "incomplete: disk full" }} />);
    expect(view.lastFrame()).toContain("REC stopped enrollment; draining");
    expect(view.lastFrame()).toContain("REC WARNING: incomplete: disk full");
    view.rerender(<RecordingHud status={{ ...active, active: false, inFlight: 0 }} />);
    expect(view.lastFrame()).toContain("REC stopped");
    expect(view.lastFrame()).not.toContain("draining");
    view.rerender(<RecordingHud status={off} />);
    expect(view.lastFrame()).toContain("REC off");
    expect(view.lastFrame()).not.toContain("/private/session");
  });

  it("compares every status field by value to avoid idle-poll redraws", () => {
    expect(sameRecordingStatus(active, { ...active })).toBe(true);
    expect(sameRecordingStatus(undefined, undefined)).toBe(true);
    expect(sameRecordingStatus(active, undefined)).toBe(false);
    for (const change of [{ active: false }, { directory: "/new" }, { requests: 4 }, { inFlight: 1 }, { warning: "incomplete" }]) {
      expect(sameRecordingStatus(active, { ...active, ...change })).toBe(false);
    }
  });

  it("reflects another client's changes and a worker restart through polling, with stable idle frames", async () => {
    const poll = statusPoll();
    let status: StatusResponse = { workerState: "ready", restarts: [], recording: active };
    const statusSource = async () => ({ ...status, recording: status.recording && { ...status.recording } });
    const view = render(<App registry={registry()} title="m" statusSource={statusSource} />);
    await tick();
    expect(view.lastFrame()).toContain("REC active");
    const frames = view.frames.length;
    await poll(); await tick();
    await poll(); await tick();
    expect(view.frames.length).toBe(frames);
    status = { ...status, recording: { ...active, active: false, warning: "incomplete: disk full" } };
    await poll(); await tick();
    expect(view.lastFrame()).toContain("REC stopped enrollment; draining");
    expect(view.lastFrame()).toContain("incomplete: disk full");
    status = { ...status, workerState: "starting", recording: off };
    await poll(); await tick();
    expect(view.lastFrame()).toContain("REC off");
    expect(view.lastFrame()).not.toContain("REC active");
    expect(view.lastFrame()).not.toContain("/private/session");
  });

  it("never displays active recording for a non-ready worker, even with a stale snapshot", async () => {
    const statusSource = async (): Promise<StatusResponse> => ({ workerState: "starting", restarts: [], recording: active });
    const view = render(<App registry={registry()} title="m" statusSource={statusSource} />);
    await tick();
    expect(view.lastFrame()).not.toContain("REC active");
    expect(view.lastFrame()).not.toContain("draining");
  });

  it("does not retain an active claim when the supervisor becomes unreachable", async () => {
    const poll = statusPoll();
    let fail = false;
    const statusSource = async (): Promise<StatusResponse> => {
      if (fail) throw new Error("connection refused");
      return { workerState: "ready", restarts: [], recording: active };
    };
    const view = render(<App registry={registry()} title="m" statusSource={statusSource} />);
    await tick();
    fail = true;
    await poll(); await tick();
    expect(view.lastFrame()).not.toContain("REC active");
    expect(view.lastFrame()).toContain("recording state unknown");
  });

  it("refreshes immediately after slash commands and ignores a stale in-flight poll", async () => {
    const poll = statusPoll();
    let snapshot = off;
    let pending = false;
    let resolveOld!: (s: StatusResponse) => void;
    const statusSource = vi.fn(async (): Promise<StatusResponse> => {
      if (pending) { pending = false; return new Promise((resolve) => { resolveOld = resolve; }); }
      return { workerState: "ready", restarts: [], recording: snapshot };
    });
    const client = {
      recordStart: async () => { snapshot = active; return snapshot; },
      recordEnd: async () => { snapshot = { ...active, active: false }; return snapshot; },
    };
    const reg = buildRegistry({ client: client as any, quit: () => {} }, { host: "127.0.0.1", port: 7891, apiKey: "k" });
    const view = render(<App registry={reg} title="m" statusSource={statusSource} />);
    await tick();
    pending = true;
    const old = poll();
    view.stdin.write("/record-start"); await tick(); view.stdin.write("\r"); await tick();
    expect(statusSource).toHaveBeenCalledTimes(3); // startup, held poll, immediate command refresh
    expect(view.lastFrame()).toContain("REC active");
    resolveOld({ workerState: "ready", restarts: [], recording: off });
    await old; await tick();
    // Two occurrences: command result card and persistent HUD (stale poll must not turn the HUD off).
    expect(view.lastFrame()?.match(/REC active/g)).toHaveLength(2);
    view.stdin.write("/record-end"); await tick(); view.stdin.write("\r"); await tick();
    expect(statusSource).toHaveBeenCalledTimes(4);
    expect(view.lastFrame()?.match(/REC stopped enrollment; draining/g)).toHaveLength(2);
  });
});
