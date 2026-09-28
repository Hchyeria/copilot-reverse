import { availableClaudeMappings, type ClaudeModelMap } from "../core/claude-model-map.js";

// Shared mutable map consumed by picker, client setup and the assistant. Replace the previous
// snapshot, then add only synthetic aliases for live backends (real Claude identities always win).
export function updateModelBudgets(target: Record<string, number>, ids: string[], limits: Record<string, number>, live: boolean, mapEnabled: boolean, map: ClaudeModelMap): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, limits);
  if (!live || !mapEnabled) return;
  for (const { alias, backend } of availableClaudeMappings(ids, map)) {
    if (limits[backend] !== undefined) target[alias] = limits[backend];
  }
}
