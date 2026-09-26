import type { GhAuth } from "../cli/gh-auth.js";
import { retrieveGitHubToken } from "../cli/auth.js";
import { CopilotAuthError, CopilotTokenStore, type AuthProbe } from "../providers/copilot/token.js";
import { GitHubReauthenticationRequiredError } from "../cli/auth.js";
import type { GitHubConnection } from "../shared/github-connection.js";

export function createWorkerCopilotTokenStore(
  connection: GitHubConnection,
  gh: Pick<GhAuth, "token">,
  fetchFn: typeof fetch = fetch,
): CopilotTokenStore {
  const githubToken = connection.type === "github"
    ? connection.token
    : () => retrieveGitHubToken(connection, gh as GhAuth);
  return new CopilotTokenStore(githubToken, fetchFn, undefined, { connection });
}

export async function probeGitHubConnection(
  connection: GitHubConnection,
  gh: Pick<GhAuth, "token">,
  fetchFn: typeof fetch = fetch,
): Promise<AuthProbe> {
  try {
    await createWorkerCopilotTokenStore(connection, gh, fetchFn).getSession();
    return { ok: true, transient: false, detail: "token valid" };
  } catch (error) {
    if (error instanceof GitHubReauthenticationRequiredError) {
      return { ok: false, transient: false, detail: error.message };
    }
    if (error instanceof CopilotAuthError && (error.status === 401 || error.status === 403)) {
      return { ok: false, transient: false, detail: error.message };
    }
    return { ok: false, transient: true, detail: error instanceof Error ? error.message : String(error) };
  }
}
