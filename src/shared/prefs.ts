import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeClaudeModelOverrides, type ClaudeModelOverrides } from "../core/claude-model-map.js";

// Small user-preferences store (e.g. the chosen chat model, change-banner view counts), persisted
// across launches.
const file = (dir: string) => join(dir, "prefs.json");

function read(dir: string): Record<string, unknown> {
  if (!existsSync(file(dir))) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file(dir), "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}
function write(dir: string, next: Record<string, unknown>): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file(dir), JSON.stringify(next));
}

export function readChatModel(dir: string): string | null {
  return (read(dir).chatModel as string | undefined) ?? null;
}

export function writeChatModel(dir: string, model: string): void {
  write(dir, { ...read(dir), chatModel: model });
}

export interface ClaudeMapSettings {
  enabled: boolean;
  overrides: ClaudeModelOverrides;
}

// Opt-in Claude-name → GPT-backend compatibility map. Validation fails closed per field: only a literal
// boolean enables it, while one malformed override cannot discard the other valid user choices.
export function readClaudeMapSettings(dir: string): ClaudeMapSettings {
  const prefs = read(dir);
  return {
    enabled: prefs.claudeMapEnabled === true,
    overrides: sanitizeClaudeModelOverrides(prefs.claudeModelMap),
  };
}

export function writeClaudeMapSettings(dir: string, settings: ClaudeMapSettings): void {
  const current = read(dir);
  write(dir, {
    ...current,
    claudeMapEnabled: settings.enabled === true,
    claudeModelMap: sanitizeClaudeModelOverrides(settings.overrides),
  });
}

export function readClaudeMapEnabled(dir: string): boolean {
  return readClaudeMapSettings(dir).enabled;
}

// Retained for the real-CLI harness and older callers that only toggle the mode. Custom choices survive.
export function writeClaudeMapEnabled(dir: string, enabled: boolean): void {
  writeClaudeMapSettings(dir, { ...readClaudeMapSettings(dir), enabled });
}

// "What's new" banner: show a change a few times then stop. Counts are keyed by an id (e.g. version),
// so a new release re-shows; bumping the count is what decides whether the banner appears again.
const seenKey = (id: string) => `seen:${id}`;
export function shouldShowChange(dir: string, id: string, maxShows = 3): boolean {
  return ((read(dir)[seenKey(id)] as number | undefined) ?? 0) < maxShows;
}
export function markChangeShown(dir: string, id: string): void {
  const cur = read(dir);
  write(dir, { ...cur, [seenKey(id)]: ((cur[seenKey(id)] as number | undefined) ?? 0) + 1 });
}
