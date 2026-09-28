import { contextBudget, type ContextMetadata } from "./context-tier.js";
import { stripOneM, toCanonical } from "./model-canonical.js";

// Local identities only: never send this suffix to Copilot. A bare id always means standard budget.
export const LONG_CONTEXT_SUFFIX = ":long_context";
export interface ModelChoice {
  id: string;
  upstreamId: string;
  name: string;
  contextWindow?: number;
}

export function modelChoices(model: ContextMetadata & { id: string; name?: string }): ModelChoice[] {
  const standard = contextBudget(model);
  const long = contextBudget(model, "long_context");
  const name = model.name || model.id;
  const out: ModelChoice[] = [{ id: model.id, upstreamId: model.id, name, contextWindow: standard }];
  // Only positive upstream evidence creates a second choice, never a guessed model family limit.
  if (model.billing?.token_prices?.long_context && standard !== undefined && long !== undefined && long > standard) {
    out[0].name = `${name} · default · ${formatBudget(standard)}`;
    out.push({ id: `${model.id}${LONG_CONTEXT_SUFFIX}`, upstreamId: model.id,
      name: `${name} · long context · ${formatBudget(long)}`, contextWindow: long });
  }
  return out;
}

function formatBudget(n: number): string { return n >= 1_000_000 ? `${n / 1_000_000}M` : `${n / 1000}K`; }

export function anthropicChoice(choice: ModelChoice): { id: string; display_name: string } {
  const canonical = toCanonical(choice.upstreamId, () => false);
  const variant = choice.id !== choice.upstreamId && choice.id.endsWith(LONG_CONTEXT_SUFFIX) ? LONG_CONTEXT_SUFFIX : "";
  const badge = choice.upstreamId.startsWith("claude-") && (choice.contextWindow ?? 0) > 800_000 ? "[1m]" : "";
  return { id: `${canonical.id}${variant}${badge}`, display_name: choice.name };
}

// Exact local/canonical choice lookup. Unknown variants must not be silently routed by fuzzy matching.
export function findModelChoice(choices: ModelChoice[], requested: string): ModelChoice | undefined {
  return choices.find((c) => c.id === requested)
    ?? choices.find((c) => stripOneM(c.id) === stripOneM(requested) || stripOneM(anthropicChoice(c).id) === stripOneM(requested));
}
