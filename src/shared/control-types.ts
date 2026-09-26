export type WorkerState = "starting" | "ready" | "crashed" | "unhealthy";

export interface RestartRow {
  ts: number;
  reason: string;
  exitCode: number | null;
  stderrTail: string;
  markedUnhealthy: 0 | 1;
}
// Result of the supervisor's GitHub-token heartbeat. `hasToken` keeps "signed-out" (no token on disk)
// distinct from "expired" (token present but no longer exchanges) without parsing `detail`.
export interface GithubStatus {
  ok: boolean;        // the active GitHub connection currently exchanges for a Copilot token
  hasToken: boolean;  // an active GitHub connection is configured
  checkedAt: number;  // ms epoch of the last completed probe
  detail: string;     // "token valid" | auth-error message | "not logged in — run /login"
  host?: string;      // github.com or the selected GHE.com hostname
}
export interface StatusResponse {
  workerState: WorkerState;
  restarts: RestartRow[];
  github?: GithubStatus; // absent until the heartbeat's first probe completes
}
export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}
export interface MetricSample {
  ts: number;
  endpoint: string;
  model: string;
  status: number;
  latencyMs: number;
  tokensIn?: number;  // prompt tokens (input); absent if upstream reported none
  tokensOut?: number; // completion tokens (output); absent if upstream reported none
  error?: string; // failure message for non-2xx requests; absent on success
}

// Per-model rollup computed in SQL over the WHOLE request_log (not a capped fetch). Cost is added
// later in the TUI from list prices; the supervisor only knows counts/latency/tokens.
export interface ModelRollup {
  model: string;
  count: number;
  errors: number;
  avgMs: number;
  tokensIn: number;
  tokensOut: number;
}
// One time-window's totals + per-model breakdown. `total` is a real COUNT(*), not min(rows, 100).
export interface MetricsWindow {
  total: number;
  errors: number;
  tokensIn: number;
  tokensOut: number;
  byModel: ModelRollup[];
}
// /api/metrics payload: lifetime + last-24h rollups, and the recent error rows for display.
export interface MetricsResponse {
  all: MetricsWindow;
  day: MetricsWindow;
  recentErrors: MetricSample[];
}
