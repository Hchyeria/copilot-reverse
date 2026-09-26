import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { openDb, recordRestart, recordRequest } from "./db.js";
import { WorkerMonitor } from "./monitor.js";
import { EventBus } from "./events.js";
import { createControlApp } from "./api.js";
import { defaultConfig, workerBindHost } from "../shared/config.js";
import { dataDir, dbPath } from "../shared/paths.js";
import { readGitHubConnection } from "../shared/creds.js";
import { readAccessMode } from "../shared/network.js";
import { probeGitHubConnection } from "../worker/copilot-session.js";
import { ghAuth } from "../cli/gh-auth.js";
import { GithubHeartbeat, SIGNED_OUT_DETAIL } from "./github-heartbeat.js";
import { appendCrashLog } from "../shared/crash-log.js";
import { buildDoctorChecks } from "./doctor.js";
import { distinctConfiguredModels, pingViaProxy } from "./doctor-probes.js";
import { readClientStatus } from "../tui/setup/status.js";
import { readWebIqKey, readWebSearchMode, resolveWebSearchBackend } from "../shared/webiq-key.js";
import type { WorkerState, DoctorCheck } from "../shared/control-types.js";

export function startSupervisor(): { stop: () => void } {
  const config = defaultConfig();
  mkdirSync(dataDir(), { recursive: true });
  const db = openDb(dbPath());
  const bus = new EventBus();
  const workerEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "worker", "index.js");

  let state: WorkerState = "starting";
  const monitor = new WorkerMonitor(config, workerEntry, {
    onStateChange: (s) => { state = s; bus.emit("state", { state: s }); },
    onCrash: (d, exitCode, stderrTail) => {
      recordRestart(db, { ts: Date.now(), reason: d.markedUnhealthy ? "unhealthy" : "crash", exitCode, stderrTail, backoffMs: d.backoffMs, markedUnhealthy: d.markedUnhealthy ? 1 : 0 });
      // Also persist to crash.log so a worker crash is diagnosable post-mortem — the DB stderrTail can
      // be empty if the worker died before flushing; this keeps whatever it did emit.
      appendCrashLog("worker-crash", `exit=${exitCode} unhealthy=${d.markedUnhealthy} backoff=${d.backoffMs}ms\n${stderrTail || "(no stderr captured)"}`);
      bus.emit("crash", { exitCode, ...d });
    },
    onWorkerMessage: (m) => {
      if (m.type === "request-metric") {
        const sample = { ts: Date.now(), endpoint: m.endpoint, model: m.model, status: m.status, latencyMs: m.latencyMs, tokensIn: m.tokensIn, tokensOut: m.tokensOut, error: m.error };
        recordRequest(db, sample);
        bus.emit("metric", sample);
      }
    },
  // Bind the worker proxy per the LIVE access mode each spawn: localhost → loopback, lan → 0.0.0.0.
  // The control API below stays loopback always (the control plane is never on the network).
  }, () => workerBindHost(readAccessMode(dataDir()), config));

  const workerBase = `http://${config.bindHost}:${config.workerPort}`;

  // Periodically re-check the GitHub token so the UI reflects an expired/revoked login within ~60s,
  // instead of only on the next failed request or a manual /status. Declared before doctor() so the
  // light /doctor can reuse its cached status instead of hammering GitHub on the 2s dashboard poll.
  const heartbeat = new GithubHeartbeat(
    () => readGitHubConnection(dataDir()),
    (connection) => typeof connection === "string"
      ? probeGitHubConnection({ type: "github", token: connection }, ghAuth)
      : probeGitHubConnection(connection, ghAuth),
    undefined,
    { intervalMs: config.heartbeat.intervalMs, initialDelayMs: config.heartbeat.initialDelayMs },
  );

  // Advertised models, proxied from the worker (same source the picker uses) — shared by /doctor's
  // "models" check and the dashboard's /api/models panel so they never disagree.
  const listModels = async (): Promise<{ id: string; display_name?: string }[]> => {
    const r = await fetch(`${workerBase}/anthropic/v1/models`);
    if (!r.ok) throw new Error(`worker /models → ${r.status}`);
    return ((await r.json()) as { data?: { id: string; display_name?: string }[] }).data ?? [];
  };
  // /doctor is the user's self-check. Light mode (the dashboard's 2s poll, /report) is cheap and
  // upstream-free; ping mode (the on-demand TUI /doctor) adds one real 1-token request per
  // client-configured model. Probes are injected so the check logic stays pure + unit-tested.
  const doctor = async (ping = false): Promise<DoctorCheck[]> =>
    buildDoctorChecks({
      githubAuth: async (live) => {
        const connection = readGitHubConnection(dataDir());
        if (!connection) return { ok: false, detail: SIGNED_OUT_DETAIL };
        if (!live) {
          const cached = heartbeat.current();
          if (cached) return { ok: cached.ok, detail: cached.detail };
          return { ok: false, detail: "checking… (login probe pending)" };
        }
        const probe = await probeGitHubConnection(connection, ghAuth);
        return { ok: probe.ok, detail: probe.detail };
      },
      workerState: () => state,
      webBackend: () => resolveWebSearchBackend(readWebSearchMode(dataDir()), Boolean(readWebIqKey(dataDir()))),
      listModels: async () => (await listModels()).map((m) => m.id),
      configuredModels: () => distinctConfiguredModels(readClientStatus()),
      pingModel: (m) => pingViaProxy(workerBase, m),
    }, { ping });


  const app = createControlApp({
    db, getState: () => state,
    restart: () => monitor.restartManually(),
    stop: () => monitor.stop(),
    start: () => monitor.start(),
    doctor,
    github: () => heartbeat.current(),
    clients: () => readClientStatus(),
    models: listModels,
    subscribe: (send) => bus.subscribe(send),
  });

  app.listen(config.supervisorPort, config.bindHost, () => monitor.start());
  heartbeat.start();
  process.on("SIGINT", () => { heartbeat.stop(); monitor.stop(); process.exit(0); });
  process.on("SIGTERM", () => { heartbeat.stop(); monitor.stop(); process.exit(0); });
  return { stop: () => { heartbeat.stop(); monitor.stop(); } };
}

// Allow `node dist/supervisor/index.js` to boot the daemon directly.
if (process.argv[1] && process.argv[1].endsWith(join("supervisor", "index.js"))) startSupervisor();
