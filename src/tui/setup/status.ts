import { existsSync, readFileSync } from "node:fs";
import { claudePath, codexPath, type Scope } from "./apply.js";
import { readPiStatus } from "./pi-config.js";

// HUD status derived from the REAL config files (not a remembered command flag), per scope. Each
// scope reports whether copilot-reverse wrote it AND the model it pinned, so /status can show
// "claude user · claude-opus-4.8" instead of a bare check.
export interface ScopeStatus { user: boolean; project: boolean; userModel?: string; projectModel?: string }
export interface ClientStatus { claude: ScopeStatus; codex: ScopeStatus; pi: ScopeStatus }
export interface StatusOpts { home?: string; cwd?: string }

// A copilot-reverse-written endpoint always points at the local loopback proxy — this lets us tell our
// own config apart from a user's pre-existing ANTHROPIC_BASE_URL / OPENAI_BASE_URL.
const isCopilotReverse = (v: unknown): boolean => typeof v === "string" && /127\.0\.0\.1|localhost/.test(v);

function claudeScope(scope: Scope, o: StatusOpts): { on: boolean; model?: string } {
  const p = claudePath(scope, o);
  if (!existsSync(p)) return { on: false };
  try {
    const s = JSON.parse(readFileSync(p, "utf8")) as { env?: Record<string, unknown> };
    if (!isCopilotReverse(s.env?.ANTHROPIC_BASE_URL)) return { on: false };
    return { on: true, model: typeof s.env?.ANTHROPIC_MODEL === "string" ? s.env.ANTHROPIC_MODEL : undefined };
  } catch { return { on: false }; }
}

function codexScope(scope: Scope, o: StatusOpts): { on: boolean; model?: string } {
  const p = codexPath(scope, o);
  if (!existsSync(p)) return { on: false };
  try {
    const txt = readFileSync(p, "utf8");
    const base = /^OPENAI_BASE_URL=(.*)$/m.exec(txt);
    if (!base || !isCopilotReverse(base[1])) return { on: false };
    return { on: true, model: /^OPENAI_MODEL=(.*)$/m.exec(txt)?.[1] };
  } catch { return { on: false }; }
}

// pi has no project-scoped config (its models.json is always ~/.pi/agent/models.json), so `project` is
// permanently false — the surfaces render that cell as n/a rather than "off". It also pins no single
// model: we write a whole list, so the "model" slot reports the count instead ("12 models").
function piScopeStatus(o: StatusOpts): ScopeStatus {
  const { on, models } = readPiStatus(o);
  return { user: on, project: false, userModel: on ? `${models} model${models === 1 ? "" : "s"}` : undefined };
}

export function readClientStatus(o: StatusOpts = {}): ClientStatus {
  const cu = claudeScope("global", o), cp = claudeScope("project", o);
  const xu = codexScope("global", o), xp = codexScope("project", o);
  return {
    claude: { user: cu.on, project: cp.on, userModel: cu.model, projectModel: cp.model },
    codex: { user: xu.on, project: xp.on, userModel: xu.model, projectModel: xp.model },
    pi: piScopeStatus(o),
  };
}
