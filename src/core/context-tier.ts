// Client-side prompt budget selection, not an upstream model id or inference flag.
export type ContextTier = "default" | "long_context";

export interface ContextMetadata {
  capabilities?: { limits?: { max_context_window_tokens?: number; max_prompt_tokens?: number } };
  billing?: { token_prices?: {
    default?: { max_prompt_tokens?: number; context_max?: number };
    long_context?: { max_prompt_tokens?: number; context_max?: number };
  } };
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

// New metadata calls this max_prompt_tokens; context_max is the older spelling.
// Missing pricing tiers retain the existing window behavior (not a blanket 272K cap).
export function contextBudget(model: ContextMetadata, tier: ContextTier = "default"): number | undefined {
  const limits = model.capabilities?.limits;
  const full = positive(limits?.max_context_window_tokens) ?? positive(limits?.max_prompt_tokens);
  const prices = model.billing?.token_prices;
  // A default budget is authoritative even if the account has no long-tier entry.
  const selected = prices?.[tier] ?? prices?.default;
  const budget = positive(selected?.max_prompt_tokens) ?? positive(selected?.context_max);
  if (budget !== undefined) return full === undefined ? budget : Math.min(budget, full);
  if (!prices?.long_context) return full;
  // With incomplete default-tier metadata prefer the advertised input budget over the full window.
  return tier === "default" ? positive(limits?.max_prompt_tokens) ?? full : full;
}
