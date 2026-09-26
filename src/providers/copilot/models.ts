import { CopilotEndpointContractError } from "./token.js";
import { copilotUrl, DEFAULT_COPILOT_INFERENCE_ORIGIN, readCopilotSession, type CopilotSessionSource } from "./session.js";

// Live model list from Copilot. Falls back to a curated list if the endpoint is unavailable.
export const FALLBACK_MODELS = ["gpt-4o", "gpt-4o-mini", "claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5", "claude-fable-5-1", "o3-mini"];

const HEADERS = (token: string) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  "editor-version": "vscode/1.95.0",
  "copilot-integration-id": "vscode-chat",
});

const DEFAULT_TIMEOUT_MS = 8000;

// Only the slice of Copilot's /models payload we actually read. `name`, `vision` and
// `max_output_tokens` are consumed solely by fetchCopilotModelCatalog (the pi setup needs a full model
// definition, not just an id); every other selector below predates them and ignores them.
interface RawModel {
  id?: string;
  name?: string;
  model_picker_enabled?: boolean;
  supported_endpoints?: string[];
  capabilities?: {
    type?: string;
    limits?: { max_prompt_tokens?: number; max_context_window_tokens?: number; max_output_tokens?: number };
    supports?: { reasoning_effort?: string[]; vision?: boolean };
  };
}

// A stalled Copilot endpoint must never hang the model picker forever — abort after timeoutMs.
type TokenOrSessionSource = string | CopilotSessionSource;

async function getModels(source: TokenOrSessionSource, fetchFn: typeof fetch, timeoutMs: number): Promise<RawModel[] | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const session = typeof source === "string"
      ? { token: source, inferenceOrigin: DEFAULT_COPILOT_INFERENCE_ORIGIN }
      : await readCopilotSession(source);
    const res = await fetchFn(copilotUrl(session.inferenceOrigin, "/models"), { headers: HEADERS(session.token), signal: ctrl.signal });
    if (!res.ok) return null;
    return ((await res.json()) as { data?: unknown[] }).data as never ?? [];
  } catch (error) {
    if (typeof source !== "string" && error instanceof CopilotEndpointContractError) throw error;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchCopilotModels(token: TokenOrSessionSource, fetchFn: typeof fetch = fetch, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string[]> {
  const data = await getModels(token, fetchFn, timeoutMs);
  if (!data) return FALLBACK_MODELS;
  const ids = [...new Set(data.map((m) => m.id).filter((x): x is string => Boolean(x)))];
  return ids.length ? ids : FALLBACK_MODELS;
}

// Map of model id -> the Copilot API endpoints it supports (e.g. ["/responses","ws:/responses"]).
// Used to route each request to the right upstream: newer gpt-5.x models are /responses-only and
// reject /chat/completions. Returns {} on failure so the adapter falls back to chat/completions.
export async function fetchModelEndpoints(token: TokenOrSessionSource, fetchFn: typeof fetch = fetch, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Record<string, string[]>> {
  const data = await getModels(token, fetchFn, timeoutMs);
  if (!data) return {};
  const out: Record<string, string[]> = {};
  for (const m of data) {
    if (m.id && Array.isArray(m.supported_endpoints) && m.supported_endpoints.length) out[m.id] = m.supported_endpoints;
  }
  return out;
}

// Set of model ids whose capabilities advertise a reasoning_effort enum. The adapter consults this
// before adding `reasoning_effort` to a /chat body: sending it to a model that doesn't support it (e.g.
// gpt-4o) is a hard 400 (`invalid_reasoning_effort`). Returns an empty set on failure/timeout, so the
// adapter omits reasoning_effort until discovery resolves — safe (a turn just runs without reasoning)
// rather than a 400. Only ids with a non-empty reasoning_effort array are included.
export async function fetchModelReasoningSupport(token: TokenOrSessionSource, fetchFn: typeof fetch = fetch, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Set<string>> {
  const data = await getModels(token, fetchFn, timeoutMs);
  const out = new Set<string>();
  if (!data) return out;
  for (const m of data) {
    if (m.id && Array.isArray(m.capabilities?.supports?.reasoning_effort) && m.capabilities.supports.reasoning_effort.length) out.add(m.id);
  }
  return out;
}

// Set of model ids whose advertised context window reaches ~1M tokens (dotted upstream form). Feeds the
// outbound /v1/models mapper's is1M oracle, so the [1m] picker badge follows the REAL upstream window
// instead of a hardcoded list — a new 1M model (claude-sonnet-5, or any future family) badges with zero
// code changes. Threshold 800K matches clients.ts's context-window suffix rule (max_prompt_tokens 936K
// also clears it). Returns an empty set on failure/timeout, so callers fall back to the default set.
export async function fetchModelOneMSupport(token: TokenOrSessionSource, fetchFn: typeof fetch = fetch, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Set<string>> {
  const data = await getModels(token, fetchFn, timeoutMs);
  const out = new Set<string>();
  if (!data) return out;
  for (const m of data) {
    const w = m.capabilities?.limits?.max_context_window_tokens ?? m.capabilities?.limits?.max_prompt_tokens;
    if (m.id && typeof w === "number" && w > 800_000) out.add(m.id);
  }
  return out;
}

// Map of model id -> its real input/context window, used to size auto-compaction per model and
// to show the window in the picker. Returns {} on failure/timeout so callers fall back gracefully.
export async function fetchModelLimits(token: TokenOrSessionSource, fetchFn: typeof fetch = fetch, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Record<string, number>> {
  const data = await getModels(token, fetchFn, timeoutMs);
  if (!data) return {};
  const out: Record<string, number> = {};
  for (const m of data) {
    // Prefer the headline context window (so a 1M model shows as 1M); fall back to the prompt budget.
    const limit = m.capabilities?.limits?.max_context_window_tokens ?? m.capabilities?.limits?.max_prompt_tokens;
    if (m.id && typeof limit === "number") out[m.id] = limit;
  }
  return out;
}

// A model's FULL upstream definition. The other selectors above each project one field out of /models
// because that's all their caller needs; a third-party client config (pi's models.json) has to state
// every property of a model up front — id, display name, window, output cap, image support, reasoning
// levels — so it gets the whole record in one pass rather than five overlapping fetches.
export interface CopilotModelInfo {
  id: string;
  name: string;              // friendly upstream name ("Claude Opus 4.8"); falls back to the id
  contextWindow: number;
  maxOutputTokens: number;
  vision: boolean;           // accepts image input
  reasoningEfforts: string[];// the effort enum this model accepts; empty = not a reasoning model
}

// Defaults for a model whose payload omits a limit — conservative enough to be safe on any model
// (under-reporting a window costs an early compaction; over-reporting costs a hard upstream 400).
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_OUTPUT = 16_384;

// Every chat model, with the full metadata a client config needs. Embeddings are filtered out
// (capabilities.type !== "chat") so they can never reach a picker or a generated config. Returns []
// on failure/timeout — same graceful-degradation contract as its siblings, letting a caller say "the
// model list is unreachable" instead of writing a config built from guesses.
export async function fetchCopilotModelCatalog(token: TokenOrSessionSource, fetchFn: typeof fetch = fetch, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CopilotModelInfo[]> {
  const data = await getModels(token, fetchFn, timeoutMs);
  if (!data) return [];
  const out: CopilotModelInfo[] = [];
  const seen = new Set<string>();
  for (const m of data) {
    if (!m.id || seen.has(m.id)) continue;
    // `type` is absent on some entries; treat "missing" as chat and only exclude an explicit non-chat.
    if (m.capabilities?.type && m.capabilities.type !== "chat") continue;
    seen.add(m.id);
    const lim = m.capabilities?.limits;
    out.push({
      id: m.id,
      name: m.name || m.id,
      contextWindow: lim?.max_context_window_tokens ?? lim?.max_prompt_tokens ?? DEFAULT_CONTEXT_WINDOW,
      maxOutputTokens: lim?.max_output_tokens ?? DEFAULT_MAX_OUTPUT,
      vision: m.capabilities?.supports?.vision === true,
      reasoningEfforts: m.capabilities?.supports?.reasoning_effort ?? [],
    });
  }
  return out;
}

export interface CopilotModelDiscovery {
  ids: string[];
  // False means ids came from FALLBACK_MODELS after discovery failed. Compatibility aliases require
  // positive live evidence, so the Router may list these ids but must not synthesize mappings from them.
  live: boolean;
  endpoints: Record<string, string[]>;
  reasoning: Set<string>;
  reasoningEfforts: Record<string, string[]>;
  oneM: Set<string>;
  limits: Record<string, number>;
}

// One upstream request supplies every model capability consumer. Besides avoiding five identical calls,
// this guarantees aliases are filtered and badged from one coherent snapshot of the account's model list.
export async function fetchModelDiscovery(token: TokenOrSessionSource, fetchFn: typeof fetch = fetch, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CopilotModelDiscovery> {
  const data = await getModels(token, fetchFn, timeoutMs);
  if (!data) return { ids: FALLBACK_MODELS, live: false, endpoints: {}, reasoning: new Set(), reasoningEfforts: {}, oneM: new Set(), limits: {} };
  const ids = [...new Set(data.map((m) => m.id).filter((id): id is string => Boolean(id)))];
  const endpoints: Record<string, string[]> = {};
  const reasoning = new Set<string>();
  const reasoningEfforts: Record<string, string[]> = {};
  const oneM = new Set<string>();
  const limits: Record<string, number> = {};
  for (const m of data) {
    if (!m.id) continue;
    if (Array.isArray(m.supported_endpoints) && m.supported_endpoints.length) endpoints[m.id] = m.supported_endpoints;
    if (Array.isArray(m.capabilities?.supports?.reasoning_effort) && m.capabilities.supports.reasoning_effort.length) {
      reasoning.add(m.id);
      reasoningEfforts[m.id] = m.capabilities.supports.reasoning_effort;
    }
    const limit = m.capabilities?.limits?.max_context_window_tokens ?? m.capabilities?.limits?.max_prompt_tokens;
    if (typeof limit === "number") {
      limits[m.id] = limit;
      if (limit > 800_000) oneM.add(m.id);
    }
  }
  return { ids: ids.length ? ids : FALLBACK_MODELS, live: ids.length > 0, endpoints, reasoning, reasoningEfforts, oneM, limits };
}
