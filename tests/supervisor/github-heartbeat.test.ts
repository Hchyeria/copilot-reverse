import { describe, it, expect, vi } from "vitest";
import {
  nextGithubStatus, GithubHeartbeat,
  GITHUB_HEARTBEAT_INTERVAL_MS, GITHUB_HEARTBEAT_INITIAL_DELAY_MS,
} from "../../src/supervisor/github-heartbeat.js";
import type { AuthProbe } from "../../src/providers/copilot/token.js";
import type { GithubStatus } from "../../src/shared/control-types.js";
import type { GitHubConnection } from "../../src/shared/github-connection.js";

const ok: AuthProbe = { ok: true, transient: false, detail: "token valid" };
const expired: AuthProbe = { ok: false, transient: false, detail: "GitHub login expired" };
const blip: AuthProbe = { ok: false, transient: true, detail: "ECONNRESET" };

describe("nextGithubStatus (pure reducer)", () => {
  it("signed-out when there is no token (probe ignored)", () => {
    expect(nextGithubStatus(undefined, false, null, 5)).toEqual({ ok: false, hasToken: false, checkedAt: 5, detail: "not logged in — run /login" });
  });
  it("connected on a successful probe", () => {
    expect(nextGithubStatus(undefined, true, ok, 7)).toEqual({ ok: true, hasToken: true, checkedAt: 7, detail: "token valid" });
  });
  it("expired on a definitive (non-transient) failure", () => {
    expect(nextGithubStatus(undefined, true, expired, 9)).toEqual({ ok: false, hasToken: true, checkedAt: 9, detail: "GitHub login expired" });
  });
  it("keeps the previous status on a transient failure (sticky, no flip)", () => {
    const prev: GithubStatus = { ok: true, hasToken: true, checkedAt: 1, detail: "token valid" };
    expect(nextGithubStatus(prev, true, blip, 99)).toBe(prev); // unchanged reference
  });
  it("stays pending (undefined) when the first probe is transient", () => {
    expect(nextGithubStatus(undefined, true, blip, 99)).toBeUndefined();
  });
});

describe("GithubHeartbeat", () => {
  it("runOnce → signed-out without calling the probe when there is no token", async () => {
    const probe = vi.fn();
    const hb = new GithubHeartbeat(() => null, probe as unknown as (t: string) => Promise<AuthProbe>, () => 42);
    await hb.runOnce();
    expect(probe).not.toHaveBeenCalled();
    expect(hb.current()).toEqual({ ok: false, hasToken: false, checkedAt: 42, detail: "not logged in — run /login" });
  });
  it("runOnce → connected when the token exchanges", async () => {
    const hb = new GithubHeartbeat(() => "gho", async () => ok, () => 1);
    await hb.runOnce();
    expect(hb.current()).toMatchObject({ ok: true, hasToken: true });
  });

  it("carries the active GHE.com hostname in status", async () => {
    const connection: GitHubConnection = { type: "ghecom", host: "acme.ghe.com" };
    const hb = new GithubHeartbeat(
      () => connection,
      async (selected) => {
        expect(selected).toEqual(connection);
        return ok;
      },
      () => 7,
    );
    await hb.runOnce();
    expect(hb.current()).toEqual({ ok: true, hasToken: true, checkedAt: 7, detail: "token valid", host: "acme.ghe.com" });
  });

  it("treats a missing connection as signed out without probing", async () => {
    const probe = vi.fn();
    const hb = new GithubHeartbeat(() => null, probe, () => 9);
    await hb.runOnce();
    expect(probe).not.toHaveBeenCalled();
    expect(hb.current()).toMatchObject({ ok: false, hasToken: false });
    expect(hb.current()).not.toHaveProperty("host");
  });
  it("runOnce → expired on a definitive failure", async () => {
    const hb = new GithubHeartbeat(() => "gho", async () => expired, () => 1);
    await hb.runOnce();
    expect(hb.current()).toMatchObject({ ok: false, hasToken: true });
  });
  it("a transient failure does not flip a previously-connected status", async () => {
    const probe = vi.fn<[], Promise<AuthProbe>>().mockResolvedValueOnce(ok).mockResolvedValueOnce(blip);
    const hb = new GithubHeartbeat(() => "gho", probe as unknown as (t: string) => Promise<AuthProbe>, () => 1);
    await hb.runOnce(); // connected
    await hb.runOnce(); // transient blip
    expect(hb.current()).toMatchObject({ ok: true });
  });

  it("does not carry a previous account's success across a connection switch", async () => {
    let connection: GitHubConnection = { type: "github", token: "old" };
    const probe = vi.fn().mockResolvedValueOnce(ok).mockResolvedValueOnce(blip);
    const hb = new GithubHeartbeat(() => connection, probe, () => 1);
    await hb.runOnce();
    connection = { type: "ghecom", host: "acme.ghe.com" };
    await hb.runOnce();
    expect(hb.current()).toBeUndefined();
  });

  it("discards a late probe result after the active connection changes", async () => {
    let connection: GitHubConnection = { type: "github", token: "old" };
    let release!: (probe: AuthProbe) => void;
    const pending = new Promise<AuthProbe>((resolve) => { release = resolve; });
    const hb = new GithubHeartbeat(() => connection, () => pending, () => 1);
    const run = hb.runOnce();
    connection = { type: "ghecom", host: "acme.ghe.com" };
    release(ok);
    await run;
    expect(hb.current()).toBeUndefined();
  });
  it("current() is undefined before the first probe", () => {
    const hb = new GithubHeartbeat(() => "gho", async () => ok);
    expect(hb.current()).toBeUndefined();
  });

  it("runOnce swallows an unexpected throw (so `void runOnce()` never becomes an unhandled rejection)", async () => {
    // The timer fires runOnce() unawaited; a throw escaping it would kill the in-process supervisor +
    // TUI. Simulate readToken throwing (e.g. a read race the source guard didn't cover).
    const readToken = () => { throw new Error("EBUSY"); };
    const hb = new GithubHeartbeat(readToken, async () => ok, () => 1);
    await expect(hb.runOnce()).resolves.toBeUndefined();
    expect(hb.current()).toBeUndefined(); // last-known status preserved (here: still pending)
  });
  it("runOnce clears inFlight after a throw so the next tick can still probe", async () => {
    const readToken = vi.fn()
      .mockImplementationOnce(() => { throw new Error("EBUSY"); })
      .mockImplementation(() => "gho");
    const hb = new GithubHeartbeat(readToken as unknown as () => string | null, async () => ok, () => 1);
    await hb.runOnce(); // throws internally, swallowed
    await hb.runOnce(); // must not be blocked by a stuck inFlight flag
    expect(hb.current()).toMatchObject({ ok: true });
  });

  it("start() probes after the initial delay, then every interval; stop() halts it", async () => {
    vi.useFakeTimers();
    try {
      const probe = vi.fn(async () => ok);
      const hb = new GithubHeartbeat(() => "gho", probe, () => 1);
      hb.start();
      expect(probe).toHaveBeenCalledTimes(0);
      await vi.advanceTimersByTimeAsync(GITHUB_HEARTBEAT_INITIAL_DELAY_MS);
      expect(probe).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(GITHUB_HEARTBEAT_INTERVAL_MS);
      expect(probe).toHaveBeenCalledTimes(2);
      hb.stop();
      await vi.advanceTimersByTimeAsync(GITHUB_HEARTBEAT_INTERVAL_MS * 3);
      expect(probe).toHaveBeenCalledTimes(2); // no further probes after stop
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors a custom interval/initial-delay (used by the container e2e for a fast cadence)", async () => {
    vi.useFakeTimers();
    try {
      const probe = vi.fn(async () => ok);
      const hb = new GithubHeartbeat(() => "gho", probe, () => 1, { intervalMs: 500, initialDelayMs: 100 });
      hb.start();
      await vi.advanceTimersByTimeAsync(100);
      expect(probe).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(500);
      expect(probe).toHaveBeenCalledTimes(2);
      hb.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("start() is idempotent — a second start() without stop() does not leak a second timer", async () => {
    vi.useFakeTimers();
    try {
      const probe = vi.fn(async () => ok);
      const hb = new GithubHeartbeat(() => "gho", probe, () => 1, { intervalMs: 500, initialDelayMs: 100 });
      hb.start();
      hb.start(); // second call must be a no-op, not a leaked parallel timer
      await vi.advanceTimersByTimeAsync(100);
      expect(probe).toHaveBeenCalledTimes(1); // one probe, not two
      await vi.advanceTimersByTimeAsync(500);
      expect(probe).toHaveBeenCalledTimes(2); // single cadence, not doubled
      hb.stop();
      await vi.advanceTimersByTimeAsync(2000);
      expect(probe).toHaveBeenCalledTimes(2); // stop() halts the single timer
    } finally {
      vi.useRealTimers();
    }
  });
});
