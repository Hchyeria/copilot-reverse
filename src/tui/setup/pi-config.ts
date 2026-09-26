import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { CopilotModelInfo } from "../../providers/copilot/models.js";
import { listPrice } from "../panels/metrics-agg.js";
import type { ApplyResult, PlaceOpts } from "./apply.js";
import type { Endpoint } from "./clients.js";

// pi (@earendil-works/pi-coding-agent) reads custom providers from ~/.pi/agent/models.json. Unlike
// Claude Code and Codex, pi has NO project-scoped config — getModelsPath() is always <agent dir>/
// models.json, so there is no `Scope` here and callers never ask for one.
//
// We write TWO providers, one per translation path the worker speaks: anthropic-messages (native
// cache_control, the path Claude Code drives) and openai-completions (the path Codex drives). Each
// provider carries ONLY the models that belong to its dialect — Claude models on the Anthropic
// surface, everything else on the OpenAI surface. Cross-listing (a gpt model under the Anthropic
// provider, or a claude model under the OpenAI one) advertises a model the upstream family rejects,
// so we split the picked list by family instead of duplicating it.
export const PI_ANTHROPIC_PROVIDER = "copilot-anthropic";
export const PI_OPENAI_PROVIDER = "copilot-openai";
export const PI_PROVIDER_IDS = [PI_ANTHROPIC_PROVIDER, PI_OPENAI_PROVIDER];

// pi's thinking levels (ModelThinkingLevel), weakest → strongest. "off" is handled separately: it maps
// to null, which is how pi says "this level sends no reasoning at all".
const PI_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type PiLevel = (typeof PI_LEVELS)[number];
type ThinkingLevelMap = Partial<Record<"off" | PiLevel, string | null>>;

export interface PiModel {
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}
export interface PiProvider { name: string; baseUrl: string; api: string; apiKey: string; models: PiModel[] }
export type PiProviders = Record<string, PiProvider>;

// Copilot advertises a per-model reasoning_effort enum that rarely matches pi's ladder exactly (a model
// may accept only low/medium/high, while pi will happily offer "max"). pi documents that a MISSING key
// falls back to the provider default — i.e. it would forward pi's own level verbatim, which upstream
// rejects with a 400 for a value it doesn't know. So we emit every level explicitly, clamping each to
// the nearest effort the model actually accepts (ties break downward, toward the cheaper effort).
function thinkingLevelMap(efforts: string[]): ThinkingLevelMap {
  const supported = efforts
    .map((e) => ({ e, rank: PI_LEVELS.indexOf(e as PiLevel) }))
    .filter((x) => x.rank >= 0)
    .sort((a, b) => a.rank - b.rank);
  // An enum of values pi has no name for (e.g. only "none") leaves nothing to clamp onto — every level
  // is unsupported, which is exactly what an all-null map says.
  const map: ThinkingLevelMap = { off: null };
  for (const level of PI_LEVELS) {
    if (!supported.length) { map[level] = null; continue; }
    const want = PI_LEVELS.indexOf(level);
    let best = supported[0];
    for (const s of supported) {
      if (Math.abs(s.rank - want) < Math.abs(best.rank - want)) best = s;
    }
    map[level] = best.e;
  }
  return map;
}

function piModel(m: CopilotModelInfo, api: string, baseUrl: string): PiModel {
  const reasoning = m.reasoningEfforts.length > 0;
  return {
    id: m.id,
    name: m.name,
    api,
    baseUrl,
    reasoning,
    ...(reasoning ? { thinkingLevelMap: thinkingLevelMap(m.reasoningEfforts) } : {}),
    input: m.vision ? ["text", "image"] : ["text"],
    cost: listPrice(m.id),
    contextWindow: m.contextWindow,
    maxTokens: m.maxOutputTokens,
  };
}

// True for Copilot's Claude family (ids are the raw dotted upstream form, e.g. "claude-opus-4.8",
// "claude-sonnet-5"). These belong ONLY on the Anthropic surface; everything else (gpt-*, o-series,
// gemini-*, …) belongs ONLY on the OpenAI surface.
export function isClaudeModel(id: string): boolean {
  return /^claude[-.]/i.test(id);
}

// The two provider blocks, split by model family. The base URLs are NOT interchangeable and
// aren't guesses: pi's built-in anthropic provider is "https://api.anthropic.com" (its SDK appends
// /v1/messages) while the openai one is "https://api.openai.com/v1" (appends /chat/completions) — so
// these land exactly on the worker's /anthropic/v1/messages and /openai/chat/completions mounts.
// Model ids stay in Copilot's raw dotted form (claude-opus-4.8): router.resolveModel runs on both
// worker routes, so a dotted id resolves as-is on either one — no canonicalization needed. The
// Anthropic provider lists only Claude models; the OpenAI provider lists only the rest.
export function buildPiConfig(models: CopilotModelInfo[], e: Endpoint): PiProviders {
  const anthropicBase = `http://${e.host}:${e.port}/anthropic`;
  const openaiBase = `http://${e.host}:${e.port}/openai`;
  const claude = models.filter((m) => isClaudeModel(m.id));
  const nonClaude = models.filter((m) => !isClaudeModel(m.id));
  return {
    [PI_ANTHROPIC_PROVIDER]: {
      name: "Copilot via copilot-reverse (Anthropic)",
      baseUrl: anthropicBase,
      api: "anthropic-messages",
      apiKey: e.apiKey,
      models: claude.map((m) => piModel(m, "anthropic-messages", anthropicBase)),
    },
    [PI_OPENAI_PROVIDER]: {
      name: "Copilot via copilot-reverse (OpenAI)",
      baseUrl: openaiBase,
      api: "openai-completions",
      apiKey: e.apiKey,
      models: nonClaude.map((m) => piModel(m, "openai-completions", openaiBase)),
    },
  };
}

export function piPath(o: PlaceOpts = {}): string {
  return join(o.home ?? homedir(), ".pi", "agent", "models.json");
}

function readConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  // A hand-edited models.json with a stray comma must not take the whole setup down — treat an
  // unparseable file as absent, exactly as applyClaude does with settings.json.
  try { return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch { return {}; }
}

// Merge our two providers into models.json, leaving every other provider (including pi's OWN built-in
// `github-copilot`, which talks to Copilot directly) and every other top-level key untouched.
export function applyPi(models: CopilotModelInfo[], e: Endpoint, o: PlaceOpts = {}): ApplyResult {
  const path = piPath(o);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  const cfg = readConfig(path);
  const providers = (cfg.providers && typeof cfg.providers === "object" ? cfg.providers : {}) as Record<string, unknown>;
  const ours = buildPiConfig(models, e);
  for (const [id, provider] of Object.entries(ours)) providers[id] = provider;
  cfg.providers = providers;
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
  return { path, changed: Object.keys(ours) };
}

// Inverse of applyPi: drop our two providers, keep everything else. `providers` itself is removed when
// it ends up empty, so a reset leaves no empty scaffolding behind.
export function resetPi(o: PlaceOpts = {}): ApplyResult {
  const path = piPath(o);
  if (!existsSync(path)) return { path, changed: [] };
  const cfg = readConfig(path);
  const providers = (cfg.providers && typeof cfg.providers === "object" ? cfg.providers : {}) as Record<string, unknown>;
  const changed: string[] = [];
  for (const id of PI_PROVIDER_IDS) {
    if (id in providers) { delete providers[id]; changed.push(id); }
  }
  if (Object.keys(providers).length) cfg.providers = providers; else delete cfg.providers;
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
  return { path, changed };
}

// Is OUR config present, and how many models does it advertise? Feeds the client status surfaces (HUD,
// /config, dashboard). Mirrors the "is this ours?" test the other clients use — a loopback base URL —
// so a user's own hand-written provider is never mistaken for ours. The two providers hold disjoint
// families (Claude vs the rest), so the model count is their SUM, not the max of either.
export function readPiStatus(o: PlaceOpts = {}): { on: boolean; models: number } {
  const cfg = readConfig(piPath(o));
  const providers = (cfg.providers && typeof cfg.providers === "object" ? cfg.providers : {}) as Record<string, { baseUrl?: unknown; models?: unknown }>;
  let models = 0;
  let on = false;
  for (const id of PI_PROVIDER_IDS) {
    const p = providers[id];
    if (!p || typeof p.baseUrl !== "string" || !/127\.0\.0\.1|localhost/.test(p.baseUrl)) continue;
    on = true;
    models += Array.isArray(p.models) ? p.models.length : 0;
  }
  return { on, models };
}
