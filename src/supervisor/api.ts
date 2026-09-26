import express, { type Express } from "express";
import { listRestarts, recentRequests, aggregateRequests, recentErrorRows, type Db } from "./db.js";
import { dashboardHtml } from "./dashboard.js";
import type { WorkerState, DoctorCheck, GithubStatus } from "../shared/control-types.js";
import type { ClientStatus } from "../tui/setup/status.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DashModel { id: string; display_name?: string }
export interface ControlDeps {
  db: Db;
  getState: () => WorkerState;
  restart: () => void | Promise<void>;
  stop: () => void;
  start: () => void;
  doctor: (ping?: boolean) => Promise<DoctorCheck[]>;
  github: () => GithubStatus | undefined;
  clients: () => ClientStatus;          // per-scope Claude/Codex config read from the real files
  models: () => Promise<DashModel[]>;   // advertised models (proxied from the worker), for the dashboard
  now?: () => number;                   // clock for the 24h metrics window; injectable for tests
  subscribe: (send: (event: string, data: unknown) => void) => () => void;
}

export function createControlApp(deps: ControlDeps): Express {
  const app = express();
  app.use(express.json());
  app.get("/", (_req, res) => res.type("html").send(dashboardHtml()));
  app.get("/api/status", (_req, res) => res.json({ workerState: deps.getState(), restarts: listRestarts(deps.db, 50), github: deps.github() }));
  app.post("/api/restart", async (_req, res) => {
    try { await deps.restart(); res.json({ ok: true }); }
    catch (e) { res.status(503).json({ ok: false, error: e instanceof Error ? e.message : String(e) }); }
  });
  app.post("/api/stop", (_req, res) => { deps.stop(); res.json({ ok: true }); });
  app.post("/api/start", (_req, res) => { deps.start(); res.json({ ok: true }); });
  // ?ping=1 opts into the slower per-model connectivity probe (real 1-token requests); the dashboard's
  // 2s poll omits it and gets the cheap, upstream-free checks. Only the on-demand TUI /doctor sets it.
  app.get("/api/doctor", async (req, res) => res.json({ checks: await deps.doctor(req.query.ping === "1") }));
  app.get("/api/requests", (_req, res) => res.json({ requests: recentRequests(deps.db, 100) }));
  // Real metrics: lifetime + last-24h rollups computed in SQL over the WHOLE request_log (not a capped
  // 100-row fetch), plus the recent error rows. This is what /metrics renders — "100 reqs" used to be
  // a display ceiling, not a count.
  app.get("/api/metrics", (_req, res) => {
    const now = (deps.now ?? Date.now)();
    res.json({
      all: aggregateRequests(deps.db),
      day: aggregateRequests(deps.db, now - DAY_MS),
      recentErrors: recentErrorRows(deps.db, 20),
    });
  });
  app.get("/api/clients", (_req, res) => res.json(deps.clients()));
  // Proxied from the worker so the dashboard shows the SAME models the picker advertises. Best-effort:
  // an empty list (worker momentarily down) renders as "discovery unavailable", not a 500.
  app.get("/api/models", async (_req, res) => { try { res.json({ models: await deps.models() }); } catch { res.json({ models: [] }); } });
  app.get("/api/events", (req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.flushHeaders?.();
    let off = () => {};
    // Writing to a socket that died between broadcasts throws synchronously (ERR_STREAM_DESTROYED /
    // EPIPE). emit() calls this on the worker-message path, so an uncaught throw would crash the
    // in-process supervisor + TUI. Swallow the write error and unsubscribe — a dead connection should
    // be dropped, not retried.
    const send = (event: string, data: unknown) => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
      catch { off(); }
    };
    // Subscribe BEFORE the first write so that if the hello frame throws (socket already dead), the
    // catch's off() refers to the real unsubscribe rather than the no-op default — otherwise a dead
    // connection would stay subscribed until the next emit or 'close'.
    off = deps.subscribe(send);
    send("hello", { state: deps.getState() });
    req.on("close", off);
  });
  return app;
}
