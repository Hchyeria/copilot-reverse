import { anthropicChoice, findModelChoice, LONG_CONTEXT_SUFFIX, type ModelChoice } from "../core/model-choices.js";
import type { ProviderAdapter } from "../providers/types.js";
import { bestModelMatch } from "../core/fuzzy.js";
import { FALLBACK_MODELS } from "../providers/copilot/models.js";
import { stripOneM, DEFAULT_ONE_M_MODELS, toCanonical, type CanonicalModel } from "../core/model-canonical.js";
import { availableClaudeMappings, backendForClaudeAlias, resolveClaudeModelMap, type ClaudeModelMap } from "../core/claude-model-map.js";

export interface RouterOptions {
  claudeMapEnabled?: boolean;
  claudeModelMap?: ClaudeModelMap;
}

// M1: single provider. Model name is remapped to the provider's actual id.
export class Router {
  private available: string[] = [];
  private choices: ModelChoice[] = [];
  setModelChoices(choices: ModelChoice[]): void { this.choices = choices.map((c) => ({ ...c })); }
  // Undefined until discovery resolves; an explicitly empty set means the selected tier has no 1M models.
  private oneM: Set<string> | undefined;
  private limits: Record<string, number> = {};
  private liveDiscovery = false;
  private claudeModelMap: ClaudeModelMap;
  constructor(private providers: ProviderAdapter[], private modelMap: Record<string, string>, private opts: RouterOptions = {}) {
    this.claudeModelMap = opts.claudeModelMap ?? resolveClaudeModelMap();
  }
  // The live Copilot model list, used for fuzzy matching (set once fetched at worker startup).
  setAvailableModels(ids: string[], live = true): void { this.available = ids; this.liveDiscovery = live; }
  setModelLimits(limits: Record<string, number>): void { this.limits = { ...limits }; }
  // The set of models with a 1M window, from discovery. Ids arrive in Copilot's DOTTED form; store them
  // DASHED so is1M can compare against the canonical dashed ids the /v1/models mapper works with.
  setOneMModels(dottedIds: Iterable<string>): void {
    this.oneM = new Set([...dottedIds].map((id) => id.replace(/\./g, "-")));
  }
  // A discovered empty set must not re-enable long-context badges from hardcoded defaults.
  is1M(dashed: string): boolean {
    return this.oneM ? this.oneM.has(dashed) : DEFAULT_ONE_M_MODELS.has(dashed);
  }
  // Real models and their local budget choices; never synthesized Claude compatibility aliases.
  listModels(): string[] { return this.choices.length ? this.choices.map((c) => c.id) : this.available.length ? this.available : FALLBACK_MODELS; }

  private realClaudeModel(alias: string): string | undefined {
    return this.available.find((model) => model.replace(/\./g, "-") === alias);
  }

  // Anthropic discovery starts with the exact existing canonicalized list. When compatibility is enabled,
  // append only aliases whose exact GPT targets were observed in LIVE discovery. A real Copilot Claude id
  // always wins a name collision: compatibility must never replace or reroute a genuine model.
  listAnthropicModels(): CanonicalModel[] {
    const real = this.choices.length ? this.choices.map(anthropicChoice) : this.listModels().map((id) => toCanonical(id, (d) => this.is1M(d)));
    if (!this.opts.claudeMapEnabled || !this.liveDiscovery) return real;
    for (const { alias, backend } of availableClaudeMappings(this.available, this.claudeModelMap)) {
      if (this.realClaudeModel(alias)) continue;
      const choices = this.choices.filter((c) => c.upstreamId === backend);
      if (choices.length) {
        for (const c of choices) real.push(anthropicChoice({ ...c, upstreamId: alias,
          id: c.id === backend ? alias : `${alias}${LONG_CONTEXT_SUFFIX}`, name: `${alias} · ${c.name}` }));
      } else {
        const limit = this.limits[backend];
        real.push(toCanonical(alias, () => limit !== undefined && limit > 800_000));
      }
    }
    return real;
  }

  modelLimit(model: string): number | undefined {
    const choice = this.choiceFor(model);
    if (choice) {
      const backend = this.resolveModel(model);
      if (backend === choice.upstreamId) return choice.contextWindow;
      const variant = choice.id !== choice.upstreamId ? LONG_CONTEXT_SUFFIX : "";
      return findModelChoice(this.choices, `${backend}${variant}`)?.contextWindow ?? this.limits[backend];
    }
    const alias = stripOneM(model);
    const real = this.realClaudeModel(alias);
    const backend = !real && this.opts.claudeMapEnabled && this.liveDiscovery
      ? backendForClaudeAlias(alias, this.available, this.claudeModelMap)
      : undefined;
    return this.limits[backend ?? real ?? alias];
  }

  private choiceFor(requested: string): ModelChoice | undefined {
    const direct = findModelChoice(this.choices, requested);
    if (direct) return direct;
    const bare = stripOneM(requested);
    const long = bare.endsWith(LONG_CONTEXT_SUFFIX);
    const alias = long ? bare.slice(0, -LONG_CONTEXT_SUFFIX.length) : bare;
    if (this.opts.claudeMapEnabled && this.liveDiscovery && !this.realClaudeModel(alias)) {
      const backend = backendForClaudeAlias(alias, this.available, this.claudeModelMap);
      if (backend) return findModelChoice(this.choices, `${backend}${long ? LONG_CONTEXT_SUFFIX : ""}`);
    }
    return undefined;
  }

  resolveModel(requested: string): string {
    const choice = this.choiceFor(requested);
    if (choice) return this.modelMap[stripOneM(requested)] ?? this.modelMap[choice.upstreamId] ?? choice.upstreamId;
    // Previously generated client configs must keep working if startup discovery is unavailable.
    // Decoding a local identity does not advertise a budget/capability; the client retains its budget.
    // Do not fuzzy-match an unadvertised variant to an unrelated model or leak our suffix upstream.
    const bare = stripOneM(requested);
    if (bare.endsWith(LONG_CONTEXT_SUFFIX)) {
      const base = bare.slice(0, -LONG_CONTEXT_SUFFIX.length);
      const real = this.available.find((id) => id === base) ?? this.realClaudeModel(base);
      const backend = this.opts.claudeMapEnabled && this.liveDiscovery && !real
        ? backendForClaudeAlias(base, this.available, this.claudeModelMap) : undefined;
      return this.modelMap[bare] ?? this.modelMap[base] ?? backend ?? real ?? base;
    }
    // Claude Code appends [1m] to signal its 1M context window; Copilot doesn't know that id, so
    // strip it back to the canonical model before mapping/forwarding.
    requested = stripOneM(requested);
    if (this.opts.claudeMapEnabled && this.liveDiscovery && !this.realClaudeModel(requested)) {
      const backend = backendForClaudeAlias(requested, this.available, this.claudeModelMap);
      if (backend) return backend;
    }
    const mapped = this.modelMap[requested];
    if (mapped) return mapped;
    // Fuzzy-match a near-miss id (e.g. canonical claude-opus-4-8 -> Copilot claude-opus-4.8) to a real model.
    if (this.available.length) {
      const match = bestModelMatch(requested, this.available);
      if (match) return match;
    }
    return this.modelMap["*"] ?? requested;
  }
  pick(_model: string): ProviderAdapter {
    const p = this.providers[0];
    if (!p) throw new Error("no provider registered");
    return p;
  }
}
