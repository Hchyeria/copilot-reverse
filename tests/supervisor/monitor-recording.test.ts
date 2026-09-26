import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerMonitor } from "../../src/supervisor/monitor.js";
import { defaultConfig } from "../../src/shared/config.js";
import type { RecordingStatus } from "../../src/shared/recording.js";

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock("node:child_process", () => ({ fork }));

class Child extends EventEmitter {
  connected = true;
  killed = false;
  stderr = new EventEmitter();
  send = vi.fn((_message: unknown, callback?: (error: Error | null) => void) => { callback?.(null); return true; });
  kill = vi.fn(() => { this.killed = true; return true; });
  message(message: unknown) { this.emit("message", message); }
}
const off: RecordingStatus = { active: false, requests: 0, inFlight: 0 };
const active: RecordingStatus = { active: true, directory: "/private/session", requests: 2, inFlight: 1 };
let monitor: WorkerMonitor;
let children: Child[];
const current = () => children.at(-1)!;
const ready = () => current().message({ type: "ready", port: 7891 });
const commandId = (child = current()) => (child.send.mock.calls.at(-1)![0] as { id: string }).id;

beforeEach(() => {
  vi.useFakeTimers();
  children = [];
  fork.mockImplementation(() => { const child = new Child(); children.push(child); return child as unknown as ChildProcess; });
  monitor = new WorkerMonitor(defaultConfig(), "/worker.js", { onStateChange: () => {}, onCrash: () => {}, onWorkerMessage: () => {} });
});
afterEach(() => { monitor.stop(); vi.clearAllTimers(); vi.useRealTimers(); vi.clearAllMocks(); });

describe("recording IPC lifecycle", () => {
  it("is off initially and rejects commands until a worker is ready", async () => {
    expect(monitor.recordingStatus()).toEqual(off);
    await expect(monitor.recording("start")).rejects.toThrow(/not ready/);
    monitor.start();
    await expect(monitor.recording("start")).rejects.toThrow(/not ready/);
    ready();
    expect(monitor.recordingStatus()).toEqual(off);
  });

  it("correlates replies, updates before hooks, and returns isolated snapshots", async () => {
    const snapshots: RecordingStatus[] = [];
    monitor = new WorkerMonitor(defaultConfig(), "/worker.js", {
      onStateChange: () => {}, onCrash: () => {},
      onWorkerMessage: (m) => { if (m.type === "recording-reply") snapshots.push(monitor.recordingStatus()); },
    });
    monitor.start(); ready();
    const response = monitor.recording("start");
    const id = commandId();
    expect(current().send).toHaveBeenCalledWith({ type: "recording-command", id, action: "start" }, expect.any(Function));
    current().message({ type: "recording-reply", id: "unrelated", status: active });
    expect(monitor.recordingStatus()).toEqual(off);
    current().message({ type: "recording-reply", id, status: active });
    expect(await response).toEqual(active);
    expect(snapshots.at(-1)).toEqual(active);
    const snapshot = monitor.recordingStatus(); snapshot.active = false;
    expect(monitor.recordingStatus()).toEqual(active);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains pushed warnings and ignores stale command snapshots", async () => {
    monitor.start(); ready();
    const response = monitor.recording("end");
    const id = commandId();
    const warning = { ...active, active: false, inFlight: 0, warning: "incomplete: disk full" };
    current().message({ type: "recording-status", status: warning });
    current().message({ type: "recording-reply", id, status: active });
    await response;
    expect(monitor.recordingStatus()).toEqual(warning);
  });

  it("a late earlier reply cannot flip a newer completed command's status", async () => {
    monitor.start(); ready();
    const start = monitor.recording("start"), startId = commandId();
    const end = monitor.recording("end"), endId = commandId();
    expect(startId).not.toBe(endId);
    current().message({ type: "recording-reply", id: endId, status: off });
    current().message({ type: "recording-reply", id: startId, status: active });
    await Promise.all([start, end]);
    expect(monitor.recordingStatus()).toEqual(off);
  });

  it("times out after 5s, cleans the timer, and ignores a late reply", async () => {
    monitor.start(); ready();
    const response = expect(monitor.recording("start")).rejects.toThrow(/timed out after 5s/);
    const id = commandId();
    await vi.advanceTimersByTimeAsync(5000);
    await response;
    current().message({ type: "recording-reply", id, status: active });
    expect(monitor.recordingStatus()).toEqual(off);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["restart", "stop", "disconnect", "exit"] as const)("rejects pending commands on %s and invalidates active status", async (event) => {
    monitor.start(); ready();
    current().message({ type: "recording-status", status: active });
    const old = current();
    const response = expect(monitor.recording("end")).rejects.toThrow(/Recording unavailable/);
    const id = commandId();
    if (event === "restart") monitor.restartManually();
    if (event === "stop") monitor.stop();
    if (event === "disconnect") { old.connected = false; old.emit("disconnect"); }
    if (event === "exit") { old.connected = false; old.emit("exit", 1); }
    await response;
    expect(monitor.recordingStatus()).toMatchObject({ active: false, inFlight: 0, directory: active.directory, warning: expect.stringMatching(/incomplete/) });
    await expect(monitor.recording("start")).rejects.toThrow(/not ready/);
    old.message({ type: "recording-reply", id, status: active });
    old.message({ type: "recording-status", status: active });
    expect(monitor.recordingStatus().active).toBe(false);
    if (event !== "exit") expect(vi.getTimerCount()).toBe(0);
    if (event === "restart") {
      old.connected = false; old.emit("exit", 0); ready();
      expect(monitor.recordingStatus()).toEqual(off);
      old.message({ type: "ready", port: 7891 });
      old.message({ type: "recording-status", status: active });
      expect(monitor.recordingStatus()).toEqual(off);
    }
    if (event === "exit") {
      await vi.advanceTimersByTimeAsync(defaultConfig().restart.baseBackoffMs); ready();
      expect(monitor.recordingStatus()).toEqual(off);
    }
  });

  it("stop then start waits for the old exit and comes back off; repeated start cannot spawn twice", async () => {
    monitor.start(); ready();
    current().message({ type: "recording-status", status: active });
    const old = current();
    monitor.stop();
    monitor.start();
    monitor.start();
    expect(children).toHaveLength(1);
    old.connected = false; old.emit("exit", 0); ready();
    expect(children).toHaveLength(2);
    expect(monitor.recordingStatus()).toEqual(off);
    monitor.start();
    expect(children).toHaveLength(2);
    const response = monitor.recording("status");
    current().message({ type: "recording-reply", id: commandId(), status: off });
    expect(await response).toEqual(off);
  });

  it("start can resume a restart that was stopped while waiting for the old worker to exit", () => {
    monitor.start(); ready();
    const old = current();
    monitor.restartManually();
    monitor.stop();
    monitor.start();
    expect(children).toHaveLength(1);
    old.connected = false; old.emit("exit", 0); ready();
    expect(children).toHaveLength(2);
    expect(monitor.currentState()).toBe("ready");
    expect(monitor.recordingStatus()).toEqual(off);
  });

  it("propagates worker/write errors and malformed replies without changing the cached status", async () => {
    monitor.start(); ready();
    const failed = expect(monitor.recording("start")).rejects.toThrow("disk full");
    current().message({ type: "recording-reply", id: commandId(), error: "disk full", status: active });
    await failed;
    const malformed = expect(monitor.recording("start")).rejects.toThrow(/omitted status/);
    current().message({ type: "recording-reply", id: commandId() });
    await malformed;
    expect(monitor.recordingStatus()).toEqual(off);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["callback", "throw"])("handles IPC send failure via %s without leaking timers", async (mode) => {
    monitor.start(); ready();
    current().send.mockImplementationOnce((_message, cb) => {
      if (mode === "throw") throw new Error("channel closed");
      cb?.(new Error("channel closed")); return false;
    });
    await expect(monitor.recording("start")).rejects.toThrow(/channel closed/);
    expect(vi.getTimerCount()).toBe(0);
  });
});
