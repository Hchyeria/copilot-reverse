import { stripOneM } from "./model-canonical.js";

export const CLAUDE_MODEL_ALIASES = [
  "claude-fable-5-1",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5",
] as const;

export type ClaudeModelAlias = typeof CLAUDE_MODEL_ALIASES[number];
export type ClaudeModelMap = Record<ClaudeModelAlias, string>;
export type ClaudeModelOverrides = Partial<ClaudeModelMap>;

export const CLAUDE_MODEL_DEFAULTS: ClaudeModelMap = {
  "claude-fable-5-1": "gpt-6-astra",
  "claude-opus-5": "gpt-5.6-sol",
  "claude-sonnet-5": "gpt-5.6-sol-fast",
  "claude-haiku-4-5": "gpt-5.6-luna",
};

export interface ClaudeModelMapping {
  alias: ClaudeModelAlias;
  backend: string;
}

const aliases = new Set<string>(CLAUDE_MODEL_ALIASES);
const isAlias = (value: string): value is ClaudeModelAlias => aliases.has(value);
const isGptBackend = (value: unknown): value is string => typeof value === "string" && /^gpt-[a-z0-9][a-z0-9._-]*$/i.test(value);

export function sanitizeClaudeModelOverrides(raw: unknown): ClaudeModelOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ClaudeModelOverrides = {};
  for (const [alias, backend] of Object.entries(raw)) {
    if (isAlias(alias) && isGptBackend(backend)) out[alias] = backend;
  }
  return out;
}

export function resolveClaudeModelMap(raw?: unknown): ClaudeModelMap {
  return { ...CLAUDE_MODEL_DEFAULTS, ...sanitizeClaudeModelOverrides(raw) };
}

function entries(map: ClaudeModelMap = CLAUDE_MODEL_DEFAULTS): ClaudeModelMapping[] {
  return CLAUDE_MODEL_ALIASES.map((alias) => ({ alias, backend: map[alias] }));
}

export function availableClaudeMappings(available: Iterable<string>, map: ClaudeModelMap = CLAUDE_MODEL_DEFAULTS): ClaudeModelMapping[] {
  const live = new Set(available);
  const canonical = new Set([...live].map((model) => model.replace(/\./g, "-")));
  return entries(map).filter(({ alias, backend }) => live.has(backend) && !canonical.has(alias));
}

export function backendForClaudeAlias(model: string, available: Iterable<string>, map: ClaudeModelMap = CLAUDE_MODEL_DEFAULTS): string | undefined {
  const alias = stripOneM(model);
  if (!isAlias(alias)) return undefined;
  const live = new Set(available);
  if ([...live].some((candidate) => candidate.replace(/\./g, "-") === alias)) return undefined;
  const backend = map[alias];
  return live.has(backend) ? backend : undefined;
}

export function mappedModelIds(available: string[], map: ClaudeModelMap = CLAUDE_MODEL_DEFAULTS): string[] {
  const out = [...available];
  const seen = new Set(out);
  for (const { alias } of availableClaudeMappings(available, map)) {
    if (!seen.has(alias)) { out.push(alias); seen.add(alias); }
  }
  return out;
}

export function modelMapDisplay(model: string, available: Iterable<string>, map: ClaudeModelMap = CLAUDE_MODEL_DEFAULTS): string {
  const backend = backendForClaudeAlias(model, available, map);
  return backend ? `${stripOneM(model)} → ${backend}` : model;
}

export function claudeMapLines(map: ClaudeModelMap = CLAUDE_MODEL_DEFAULTS): string[] {
  return entries(map).map(({ alias, backend }) => `${alias} → ${backend}`);
}
