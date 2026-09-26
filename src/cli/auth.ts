import { requestDeviceCode, pollForToken, type DeviceCode } from "../providers/copilot/auth.js";
import { clearGitHubConnection, writeGhToken, writeGitHubConnection } from "../shared/creds.js";
import { normalizeGhecomHost, type GitHubConnection } from "../shared/github-connection.js";
import { GH_INSTALL_MESSAGE, ghAuth as productionGhAuth, type GhAuth } from "./gh-auth.js";

export { normalizeGhecomHost } from "../shared/github-connection.js";

export interface PendingLogin {
  code: DeviceCode;              // verification URL + user_code — show this immediately
  complete: () => Promise<void>; // blocks on authorization, then persists the token
}

// Two-phase device login. `beginDeviceLogin` returns the verification code right away so a caller
// can surface it to the user; `complete()` then blocks on authorization and writes the token.
// Splitting these is what lets the TUI render the code while the poll is still pending — folding
// both into one call buffers the code behind the blocking poll, and the user can't authorize a
// code they can't see.
export async function beginDeviceLogin(dir: string, fetchFn: typeof fetch = fetch): Promise<PendingLogin> {
  const code = await requestDeviceCode(fetchFn);
  return {
    code,
    complete: async () => {
      const token = await pollForToken(code.device_code, code.interval * 1000, fetchFn);
      writeGhToken(token, dir);
    },
  };
}

export async function runDeviceLogin(dir: string, fetchFn: typeof fetch = fetch, log: (m: string) => void = console.log): Promise<void> {
  const { code, complete } = await beginDeviceLogin(dir, fetchFn);
  log(`\nOpen ${code.verification_uri} and enter code: ${code.user_code}\n`);
  await complete();
  log("GitHub authorization complete.");
}

export class GitHubReauthenticationRequiredError extends Error {
  readonly code = "GITHUB_REAUTHENTICATION_REQUIRED";

  constructor(host: string) {
    super(`GitHub credentials for ${host} require reauthentication.`);
    this.name = "GitHubReauthenticationRequiredError";
  }
}

export async function retrieveGitHubToken(
  connection: GitHubConnection,
  gh: GhAuth = productionGhAuth,
): Promise<string> {
  if (connection.type === "github") return connection.token;
  try {
    const token = await gh.token(connection.host);
    if (token) return token;
  } catch {
    // Child-process details may contain credential output; expose only the classified error below.
  }
  throw new GitHubReauthenticationRequiredError(connection.host);
}

export type LoginRequest = { type: "github" } | { type: "ghecom"; host: string };

export async function loginGitHubConnection(
  request: LoginRequest,
  dir: string,
  options: { fetchFn?: typeof fetch; log?: (message: string) => void; ghAuth?: GhAuth } = {},
): Promise<void> {
  if (request.type === "github") {
    await runDeviceLogin(dir, options.fetchFn ?? fetch, options.log ?? console.log);
    return;
  }

  const host = normalizeGhecomHost(request.host);
  const gh = options.ghAuth ?? productionGhAuth;
  if (!await gh.isAvailable()) throw new Error(GH_INSTALL_MESSAGE);
  try {
    await retrieveGitHubToken({ type: "ghecom", host }, gh);
  } catch (error) {
    if (!(error instanceof GitHubReauthenticationRequiredError)) throw error;
    await gh.login(host);
    await retrieveGitHubToken({ type: "ghecom", host }, gh);
  }
  writeGitHubConnection({ type: "ghecom", host }, dir);
}

export function logoutGitHubConnection(dir: string): void {
  clearGitHubConnection(dir);
}
