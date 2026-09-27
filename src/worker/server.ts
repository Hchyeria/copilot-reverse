import express, { type Express } from "express";
import type { Router } from "./router.js";
import { mountOpenAI } from "./openai-server.js";
import { mountAnthropic } from "./anthropic-server.js";
import { requireAccess, type AccessControl } from "./auth.js";
import type { GatewayToolRunner } from "../core/server-tools.js";
import type { RequestRecorder } from "./recording/recorder.js";

export type MetricSink = (m: { endpoint: string; model: string; status: number; latencyMs: number; tokensIn?: number; tokensOut?: number; error?: string }) => void;

// Default access control: localhost mode, not exposed, no key — i.e. serve everything, exactly as
// before access modes existed. Tests and any caller that doesn't pass `access` get the original open
// behavior.
const OPEN: AccessControl = { mode: () => "localhost", key: () => null, exposed: false };

export function createWorkerApp(router: Router, onMetric: MetricSink, gatewayRunner?: GatewayToolRunner, access: AccessControl = OPEN, isLocal?: (req: { socket: { remoteAddress?: string } }) => boolean, recorder?: RequestRecorder): Express {
  const app = express();
  // Readiness probe stays OPEN above the auth gate — the supervisor must reach /healthz to know the
  // worker is up even in LAN mode (it's a no-secret GET, not a proxy path).
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  // Gate BEFORE the body parser: the key lives in headers, so an unauthenticated remote request is
  // rejected without ever buffering its (up-to-20mb) body. Healthz above is already answered. `isLocal`
  // is forwarded so tests can simulate a remote peer (real requests use the socket's remoteAddress).
  app.use(requireAccess(access, isLocal));
  if (recorder) app.use(recorder.middleware);
  app.use(express.json({ limit: "20mb", verify: recorder?.body }));
  const metric: MetricSink = (sample) => { recorder?.metric(sample); onMetric(sample); };
  mountOpenAI(app, router, metric);
  mountAnthropic(app, router, metric, gatewayRunner);
  return app;
}

