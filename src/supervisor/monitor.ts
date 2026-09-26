import { fork, type ChildProcess } from "node:child_process";
import type { RestartPolicy, AppConfig } from "../shared/config.js";
import type { WorkerToSupervisor } from "../shared/ipc.js";
import type { WorkerState } from "../shared/control-types.js";

export interface RestartDecision { backoffMs: number; markedUnhealthy: boolean; crashesInWindow: number }

export class RestartController {
  private crashTimes: number[] = [];
  private consecutive = 0;
  constructor(private policy: RestartPolicy, private now: () => number = () => Date.now()) {}
  onCrash(): RestartDecision {
    const t = this.now();
    this.crashTimes.push(t);
    this.crashTimes = this.crashTimes.filter((ct) => t - ct < this.policy.windowMs);
    this.consecutive += 1;
    const backoffMs = Math.min(this.policy.baseBackoffMs * 2 ** (this.consecutive - 1), this.policy.maxBackoffMs);
    return { backoffMs, markedUnhealthy: this.crashTimes.length >= this.policy.maxCrashes, crashesInWindow: this.crashTimes.length };
  }
  reset(): void { this.consecutive = 0; this.crashTimes = []; }
}

export interface MonitorHooks {
  onStateChange(s: WorkerState): void;
  onCrash(d: RestartDecision, exitCode: number | null, stderrTail: string): void;
  onWorkerMessage(m: WorkerToSupervisor): void;
}

export class WorkerMonitor {
  private child?: ChildProcess;
  private controller: RestartController;
  private stderrTail = "";
  private state: WorkerState = "starting";
  private stopped = false;
  // The single pending respawn (crash backoff / unhealthy cooldown). Tracked so a manual restart or
  // stop() can CANCEL it — otherwise a backoff respawn fires alongside the restart's respawn and the
  // two race for :7891 (EADDRINUSE). Invariant: at most one respawn is ever scheduled at a time.
  private respawnTimer?: ReturnType<typeof setTimeout>;
  // True while a manual restart is waiting on the old worker's exit to spawn the replacement. A second
  // restart in that window must NOT spawn again (it would double-bind the port); the in-flight exit
  // handler already owns the next spawn, so we just let it proceed.
  private restartPromise?: Promise<void>;
  private resolveRestart?: () => void;
  private rejectRestart?: (error: Error) => void;
  // Optional: resolves the worker's BIND_HOST at EACH spawn from the live access mode (localhost →
  // loopback, lan → 0.0.0.0). Falls back to the static config.bindHost when not provided, so existing
  // callers/tests keep loopback. Because it's read per spawn, a manual restart after a mode change
  // re-binds the socket to the new posture.
  constructor(private config: AppConfig, private workerEntry: string, private hooks: MonitorHooks, private bindHostProvider?: () => string) {
    this.controller = new RestartController(config.restart);
  }
  start(): void { this.spawn(); }
  currentState(): WorkerState { return this.state; }
  private set(s: WorkerState): void { this.state = s; this.hooks.onStateChange(s); }
  private spawn(): void {
    this.set("starting");
    const bindHost = this.bindHostProvider?.() ?? this.config.bindHost;
    const child = fork(this.workerEntry, [], {
      env: { ...process.env, WORKER_PORT: String(this.config.workerPort), BIND_HOST: bindHost },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    this.child = child;
    this.stderrTail = "";
    child.stderr?.on("data", (d: Buffer) => { this.stderrTail = (this.stderrTail + d.toString()).slice(-4000); });
    child.on("message", (m: WorkerToSupervisor) => {
      if (m.type === "ready") {
        this.controller.reset(); this.set("ready");
        this.resolveRestart?.();
        this.clearRestartPromise();
      }
      this.hooks.onWorkerMessage(m);
    });
    child.on("exit", (code) => {
      if (this.stopped) return;
      if (this.rejectRestart) {
        this.rejectRestart(new Error(`worker exited before ready (exit ${code ?? "unknown"})${this.stderrTail ? `: ${this.stderrTail}` : ""}`));
        this.clearRestartPromise();
      }
      const d = this.controller.onCrash();
      this.hooks.onCrash(d, code, this.stderrTail);
      if (d.markedUnhealthy) {
        // Don't give up forever: a transient crash burst (token rotation, a flaky upstream) shouldn't
        // leave the daemon permanently dead. Mark unhealthy, then after a cooldown reset the window and
        // try once more — recovering on its own if the cause has passed.
        this.set("unhealthy");
        this.scheduleRespawn(this.config.restart.unhealthyCooldownMs, true);
        return;
      }
      this.set("crashed");
      this.scheduleRespawn(d.backoffMs, false);
    });
  }
  // Schedule the single pending respawn, replacing any already-pending one (cancel-then-set keeps the
  // at-most-one invariant). resetWindow clears the crash counter first (the unhealthy-cooldown path).
  private scheduleRespawn(delayMs: number, resetWindow: boolean): void {
    if (this.respawnTimer) clearTimeout(this.respawnTimer);
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = undefined;
      if (this.stopped) return;
      if (resetWindow) this.controller.reset();
      this.spawn();
    }, delayMs);
  }
  private clearRestartPromise(): void {
    this.restartPromise = undefined;
    this.resolveRestart = undefined;
    this.rejectRestart = undefined;
  }
  restartManually(): Promise<void> {
    // Concurrent callers observe the same replacement outcome; they must not trigger another spawn.
    if (this.restartPromise) return this.restartPromise;
    this.restartPromise = new Promise<void>((resolve, reject) => {
      this.resolveRestart = resolve;
      this.rejectRestart = reject;
    });
    this.controller.reset(); this.stopped = false;
    // Cancel any pending crash/cooldown respawn — otherwise it fires alongside our respawn below and
    // the two race for the port. We own the next spawn now.
    if (this.respawnTimer) { clearTimeout(this.respawnTimer); this.respawnTimer = undefined; }
    const child = this.child;
    // A live child still holds :7891 until it actually exits. kill() is async, so spawning on the next
    // line (the old behavior) raced the dying worker → "listen EADDRINUSE :7891". Defer the spawn to
    // the old child's REAL exit; resolve only after the replacement emits its ready IPC message.
    if (child && child.connected) {
      this.child = undefined;
      child.removeAllListeners("exit");
      child.once("exit", () => { if (!this.stopped) this.spawn(); });
      child.kill();
    } else {
      this.spawn();
    }
    return this.restartPromise;
  }
  stop(): void {
    this.stopped = true;
    if (this.rejectRestart) {
      this.rejectRestart(new Error("worker restart cancelled"));
      this.clearRestartPromise();
    }
    if (this.respawnTimer) { clearTimeout(this.respawnTimer); this.respawnTimer = undefined; }
    const child = this.child;
    if (!child || child.killed) return;
    // The IPC channel may already be torn down (e.g. right after a manual restart) — sending then
    // throws ERR_IPC_CHANNEL_CLOSED. Guard the graceful shutdown and fall back to a hard kill.
    try { if (child.connected) child.send({ type: "shutdown" }); } catch { /* channel already closed */ }
    child.kill();
  }
}
