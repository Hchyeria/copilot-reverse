// Turn a raw upstream error message into an actionable hint (agent-maestro v2.8.1/v2.6.0:
// structured context-window-exceeded + model_not_supported guidance instead of a bare 400).
import { GitHubReauthenticationRequiredError } from "../cli/auth.js";
import { CopilotAuthError, CopilotEndpointContractError, CopilotEntitlementError } from "../providers/copilot/token.js";
import { isTerminalUpstream } from "../providers/copilot/adapter.js";

export function errorHint(message: string): string {
  const m = message.toLowerCase();
  // An expired/revoked GitHub login — tell the user to re-authenticate from inside the app.
  if (/login expired|authentication_error|token exchange failed|unauthorized|\b401\b|\b403\b/.test(m)) {
    return "GitHub login expired — run /login to sign in again";
  }
  if (/context_length_exceeded|prompt is too long|maximum context|too many tokens|context window/.test(m)) {
    return "context window exceeded — the conversation is too long; /compact or switch to a larger-context model";
  }
  // Copilot's gateway rejected the request body at the HTTP layer (byte size, not tokens) — most often a
  // long agentic session that accreted many screenshots. Context editing clears old ones automatically,
  // but a single huge turn can still trip it. Point the user at compaction / trimming attachments.
  if (/\b413\b|request entity too large|payload too large|entity too large/.test(m)) {
    return "request too large — the payload exceeded the gateway limit; /compact or send fewer/smaller images";
  }
  if (/not supported|unknown model|invalid model|model_not_found|does not support/.test(m)) {
    return "model not supported — run /model to pick an available one";
  }
  return "";
}

// How a request handler should surface a thrown error. Classifying here (not per-endpoint) keeps the
// Anthropic + OpenAI + Responses catch blocks consistent.
//   - `status`: the HTTP status for a non-stream reply, or the status we'd have used pre-stream.
//   - `terminal`: true = a permanent client error (bad model, invalid body) — the client must NOT
//     retry. A retriable class (5xx/network/429) is false. This drives the SSE error *type*: a
//     terminal error becomes `invalid_request_error` (Anthropic) so Claude Code / the SDK fail fast
//     instead of retrying a 502-class `api_error` to their turn timeout (issue #50 P1 freeze).
export interface ErrorClass { status: number; terminal: boolean }
export function classifyError(err: unknown): ErrorClass {
  if (err instanceof CopilotAuthError || err instanceof GitHubReauthenticationRequiredError) return { status: 401, terminal: true };
  if (err instanceof CopilotEndpointContractError || err instanceof CopilotEntitlementError) return { status: 422, terminal: true };
  // A permanent upstream 4xx (model_not_supported, invalid_request_body, …) — surface it verbatim so
  // the caller sees the real status and stops retrying. 429/408 and 5xx fall through to a retriable 502.
  if (isTerminalUpstream(err)) return { status: err.status, terminal: true };
  return { status: 502, terminal: false };
}
