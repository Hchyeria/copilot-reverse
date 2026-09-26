import { githubRestOrigin, type GitHubConnection } from "../../shared/github-connection.js";

// Who's logged in + what Copilot plan they're on. Both are read-only account facts surfaced on the
// status card. The username comes from GitHub's /user; the plan (sku) rides along on the Copilot token
// exchange we already perform (see token.ts) — no extra call is needed for it.

export interface GithubUser {
  login: string;      // the GitHub handle, e.g. "canwa_microsoft"
  name: string | null; // the display name, e.g. "Can Wang"; null if the account set none
}

// Fetch the authenticated user's identity. Best-effort: a failure (network, rate-limit, revoked token)
// returns null rather than throwing — the caller shows the login state without a name, never breaks the
// card. Timed out so a slow/hanging GitHub can't stall startup.
export type GithubUserAuth = string | { connection: GitHubConnection; token: string };

export async function fetchGithubUser(auth: GithubUserAuth, fetchFn: typeof fetch = fetch, timeoutMs = 5000): Promise<GithubUser | null> {
  const ghToken = typeof auth === "string" ? auth : auth.token;
  const restOrigin = typeof auth === "string" ? "https://api.github.com" : githubRestOrigin(auth.connection);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${restOrigin}/user`, {
      headers: { authorization: `token ${ghToken}`, accept: "application/json", "user-agent": "copilot-reverse" },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { login?: string; name?: string | null };
    if (!j.login) return null;
    return { login: j.login, name: j.name ?? null };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The Copilot entitlement fields the token exchange returns (a subset — only what we surface). `sku` is
// the plan identifier (e.g. "copilot_enterprise_seat_quota"); `chatEnabled` gates chat; `individual`
// distinguishes a personal plan from an org/enterprise seat.
export interface CopilotEntitlement {
  sku: string;
  chatEnabled: boolean;
  individual: boolean;
}

// Friendly plan label from the raw sku. Copilot's sku strings are internal ("copilot_enterprise_seat_
// quota"); map the known families to human names and fall back to a cleaned-up form of the raw sku so
// an unrecognized/new plan still shows *something* sensible instead of breaking or reading as unknown.
export function skuLabel(sku: string): string {
  const s = sku.toLowerCase();
  if (s.includes("enterprise")) return "Copilot Enterprise";
  if (s.includes("business")) return "Copilot Business";
  if (s.includes("individual") || s.includes("pro")) return "Copilot Pro";
  if (s.includes("free")) return "Copilot Free";
  // Unknown sku: title-case the raw token so it's at least legible (copilot_x_seat → "Copilot X Seat").
  const cleaned = sku.replace(/_/g, " ").replace(/\bquota\b|\bseat\b/gi, "").trim();
  return cleaned ? cleaned.replace(/\b\w/g, (c) => c.toUpperCase()) : sku;
}

// "Can Wang (canwa_microsoft)" when a display name exists, else just the handle. Null user → empty
// string so callers can append it unconditionally without a dangling separator.
export function formatIdentity(user: GithubUser | null | undefined): string {
  if (!user) return "";
  return user.name && user.name !== user.login ? `${user.name} (${user.login})` : user.login;
}
