import type { AuthProbe } from "../providers/copilot/token.js";
import type { GithubStatus } from "../shared/control-types.js";
import type { GitHubConnection } from "../shared/github-connection.js";
import { appendCrashLog } from "../shared/crash-log.js";

// How often the supervisor re-checks the GitHub token. Token failure is rare (revoke / re-auth) and
// GitHub rate-limits, so a slow cadence is plenty; an initial short delay populates the status soon
// after boot without racing worker startup.
export const GITHUB_HEARTBEAT_INTERVAL_MS = 60_000;
export const GITHUB_HEARTBEAT_INITIAL_DELAY_MS = 2_000;

// Shared so /doctor and the heartbeat show the same remediation hint for the signed-out state.
export const SIGNED_OUT_DETAIL = "not logged in — run /login";

// Pure reducer: given the prior cached status, whether a token is on disk, and the latest probe
// result, decide the next cached status. Transient errors are sticky — they keep the prior status —
// so a brief blip doesn't flip a connected session to "expired". Caveat (see probeGithubAuth): the
// stickiness is unbounded, and if the FIRST probe is transient (prev still undefined) the status stays
// undefined / "pending", so /api/status omits `github` and the HUD shows no badge until a non-transient
// result lands.
export function nextGithubStatus(
  prev: GithubStatus | undefined,
  hasToken: boolean,
  probe: AuthProbe | null,
  now: number,
): GithubStatus | undefined {
  if (!hasToken) return { ok: false, hasToken: false, checkedAt: now, detail: SIGNED_OUT_DETAIL };
  if (probe && probe.transient) return prev; // keep last-known-good (or stay pending if none yet)
  if (!probe) return prev;
  return { ok: probe.ok, hasToken: true, checkedAt: now, detail: probe.detail };
}

// Periodically probes the GitHub token in the supervisor process and caches a GithubStatus the control
// API exposes via /api/status. Dependencies are injected for testing (token reader, probe, clock).
export class GithubHeartbeat {
  private status: GithubStatus | undefined;
  private connectionKey: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private inFlight = false;
  private intervalMs: number;
  private initialDelayMs: number;

  constructor(
    private readConnection: () => string | GitHubConnection | null,
    private probe: (connection: string | GitHubConnection) => Promise<AuthProbe>,
    private now: () => number = () => Date.now(),
    opts: { intervalMs?: number; initialDelayMs?: number } = {},
  ) {
    this.intervalMs = opts.intervalMs ?? GITHUB_HEARTBEAT_INTERVAL_MS;
    this.initialDelayMs = opts.initialDelayMs ?? GITHUB_HEARTBEAT_INITIAL_DELAY_MS;
  }

  current(): GithubStatus | undefined { return this.status; }

  // One probe cycle. Reads the token first: no token → signed-out, and the network probe is skipped.
  // Guarded so a slow probe (up to ~8s) can't overlap the next tick.
  async runOnce(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const connection = this.readConnection();
      const keyOf = (value: string | GitHubConnection | null): string | undefined => {
        if (!value) return undefined;
        if (typeof value === "string") return `legacy:${value}`;
        return value.type === "github" ? `github:${value.token}` : `ghecom:${value.host}`;
      };
      const startedKey = keyOf(connection);
      if (startedKey !== this.connectionKey) {
        this.status = undefined;
        this.connectionKey = startedKey;
      }
      const probe = connection ? await this.probe(connection) : null;
      if (this.stopped) return;
      const current = this.readConnection();
      const currentKey = keyOf(current);
      if (currentKey !== startedKey) {
        this.status = undefined;
        this.connectionKey = currentKey;
        return;
      }
      const next = nextGithubStatus(this.status, Boolean(connection), probe, this.now());
      this.status = next && connection && typeof connection !== "string"
        ? { ...next, host: connection.type === "github" ? "github.com" : connection.host }
        : next;
    } catch (e) {
      // Defense in depth: readToken()/probe() are not expected to throw (readGhToken returns null on a
      // bad read, probeGithubAuth never throws), but the timer fires this as `void runOnce()` — an
      // unhandled rejection here would kill the in-process supervisor + TUI. Keep the last-known status,
      // but log it: a throw here means a real (unexpected) defect, and swallowing it silently would
      // freeze the badge with no trace.
      appendCrashLog("github-heartbeat", e);
    } finally {
      this.inFlight = false;
    }
  }

  start(): void {
    if (this.timer) return; // idempotent: don't leak a second timer if start() is called twice
    this.stopped = false;
    const tick = () => { void this.runOnce(); };
    this.timer = setTimeout(() => {
      tick();
      this.timer = setInterval(tick, this.intervalMs);
    }, this.initialDelayMs);
  }

  stop(): void {
    this.stopped = true;
    // The timer handle is either the initial setTimeout or the later setInterval; clearing both kinds
    // is safe with either function in Node.
    if (this.timer) { clearTimeout(this.timer); clearInterval(this.timer); this.timer = undefined; }
  }
}
