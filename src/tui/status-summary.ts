import type { WorkerState } from "../shared/control-types.js";
import type { WebSearchBackend } from "../shared/webiq-key.js";

// Status overview shown on startup and reflected in the HUD. GitHub's device-flow OAuth token has no
// real expiry (GitHub returns no expires_in for this app), so we report a LOGIN STATE, not a
// countdown: "connected" means the stored token still exchanges for a Copilot token, "expired" means
// it no longer does (revoked / re-auth needed), "signed-out" means there's no token at all.
export type GithubLoginState = "connected" | "expired" | "signed-out";
// We report the active web-search BACKEND: "copilot" = native/borrow, "webiq" = Microsoft Web IQ,
// "unavailable" = no backend usable (Copilot search disabled and no WebIQ key — run /webiq).
export type WebSearchState = WebSearchBackend;

export interface StatusInputs {
  hasToken: boolean;       // a GitHub token is stored
  tokenValid: boolean;     // that token still exchanges for a Copilot token (network-checked upstream)
  webSearch: WebSearchBackend; // resolved active backend (copilot | webiq | unavailable)
  worker: WorkerState;
  clients: { claude: boolean; codex: boolean; pi: boolean };
  // Optional account facts folded into the GitHub line when present. `identity` is the pre-formatted
  // "Name (login)" (or just the login); `plan` is the friendly Copilot plan label (from sku). Both are
  // best-effort — absent when the lookups fail or before they resolve, and the card omits them cleanly.
  identity?: string;
  plan?: string;
}

export interface StatusSummary {
  github: GithubLoginState;
  webSearch: WebSearchState;
  worker: WorkerState;
  clients: { claude: boolean; codex: boolean; pi: boolean };
  identity?: string;
  plan?: string;
}

export function githubLoginState(hasToken: boolean, tokenValid: boolean): GithubLoginState {
  if (!hasToken) return "signed-out";
  return tokenValid ? "connected" : "expired";
}

export function summarizeStatus(i: StatusInputs): StatusSummary {
  return {
    github: githubLoginState(i.hasToken, i.tokenValid),
    webSearch: i.webSearch,
    worker: i.worker,
    clients: i.clients,
    // Identity/plan only make sense when actually connected — an expired/signed-out token shouldn't
    // show a stale name. Guard here so callers can pass them unconditionally.
    ...(i.hasToken && i.tokenValid && i.identity ? { identity: i.identity } : {}),
    ...(i.hasToken && i.tokenValid && i.plan ? { plan: i.plan } : {}),
  };
}
