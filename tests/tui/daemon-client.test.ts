import { describe, it, expect, vi } from "vitest";
import { DaemonClient } from "../../src/tui/daemon-client.js";
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

describe("DaemonClient", () => {
  it("reads status", async () => {
    const f = vi.fn(async () => json({ workerState: "ready", restarts: [] }));
    const c = new DaemonClient("http://x", f as unknown as typeof fetch);
    expect((await c.status()).workerState).toBe("ready");
  });
  it("posts restart and rejects a failed replacement", async () => {
    const f = vi.fn(async () => json({ ok: true }));
    await new DaemonClient("http://x", f as unknown as typeof fetch).restart();
    expect((f.mock.calls[0][1] as RequestInit).method).toBe("POST");

    const failed = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "worker exited before ready" }), { status: 503, headers: { "content-type": "application/json" } }));
    await expect(new DaemonClient("http://x", failed as unknown as typeof fetch).restart()).rejects.toThrow("worker exited before ready");
  });
  it("rejects non-OK control responses even when the body is not JSON", async () => {
    const f = vi.fn(async () => new Response("unavailable", { status: 502 }));
    await expect(new DaemonClient("http://x", f as unknown as typeof fetch).restart()).rejects.toThrow(/502/);
  });
  it("runs doctor", async () => {
    const f = vi.fn(async () => json({ checks: [{ name: "x", ok: true, detail: "d" }] }));
    expect((await new DaemonClient("http://x", f as unknown as typeof fetch).doctor())[0].ok).toBe(true);
  });
  it("doctor light hits /api/doctor; ping adds ?ping=1", async () => {
    const f = vi.fn(async () => json({ checks: [] }));
    const c = new DaemonClient("http://x", f as unknown as typeof fetch);
    await c.doctor();
    await c.doctor(true);
    expect(f.mock.calls[0][0]).toBe("http://x/api/doctor");
    expect(f.mock.calls[1][0]).toBe("http://x/api/doctor?ping=1");
  });
  it("posts stop and start to the right paths", async () => {
    const f = vi.fn(async () => json({ ok: true }));
    const c = new DaemonClient("http://x", f as unknown as typeof fetch);
    await c.stop();
    await c.start();
    expect(f.mock.calls[0][0]).toBe("http://x/api/stop");
    expect(f.mock.calls[1][0]).toBe("http://x/api/start");
  });
  it("posts recording commands and returns the worker status", async () => {
    const status = { active: true, directory: "/private/session", requests: 2, inFlight: 1 };
    const f = vi.fn(async (_url: string, _init?: RequestInit) => json(status));
    const c = new DaemonClient("http://x", f as typeof fetch);
    expect(await c.recordStart()).toEqual(status);
    expect(await c.recordEnd()).toEqual(status);
    expect(f.mock.calls).toEqual([
      ["http://x/api/recording/start", { method: "POST" }],
      ["http://x/api/recording/end", { method: "POST" }],
    ]);
  });
  it.each(["recordStart", "recordEnd"] as const)("%s checks HTTP status and surfaces the supervisor error", async (method) => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: "worker disconnected" }), { status: 503 }));
    await expect(new DaemonClient("http://x", f as typeof fetch)[method]()).rejects.toThrow(/HTTP 503.*worker disconnected/);
  });
  it("offers an actionable fallback for an older supervisor's non-JSON error", async () => {
    const f = vi.fn(async () => new Response("not found", { status: 404 }));
    await expect(new DaemonClient("http://x", f as typeof fetch).recordStart()).rejects.toThrow(/HTTP 404.*check \/status/);
  });
  it("unwraps the requests array", async () => {
    const f = vi.fn(async () => json({ requests: [{ ts: 1, endpoint: "/v1/messages", model: "m", status: 200, latencyMs: 4 }] }));
    const reqs = await new DaemonClient("http://x", f as unknown as typeof fetch).requests();
    expect(reqs[0].model).toBe("m");
  });
});
