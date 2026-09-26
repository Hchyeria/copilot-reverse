import type { CopilotEntitlement } from "./account.js";

export const DEFAULT_COPILOT_INFERENCE_ORIGIN = "https://api.githubcopilot.com";

export interface CopilotSession {
  token: string;
  expiresAtMs: number;
  entitlement?: CopilotEntitlement;
  inferenceOrigin: string;
}

export interface CopilotSessionSource {
  get(): Promise<string>;
  getSession?(): Promise<CopilotSession>;
}

export async function readCopilotSession(source: CopilotSessionSource): Promise<CopilotSession> {
  if (source.getSession) return source.getSession();
  return {
    token: await source.get(),
    expiresAtMs: Number.POSITIVE_INFINITY,
    inferenceOrigin: DEFAULT_COPILOT_INFERENCE_ORIGIN,
  };
}

export function copilotUrl(origin: string, path: "/models" | "/chat/completions" | "/responses"): string {
  return new URL(path, `${origin}/`).toString();
}
