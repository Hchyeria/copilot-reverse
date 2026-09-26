import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loginGitHubConnection, type LoginRequest } from "./auth.js";
import { ghAuth as productionGhAuth, type GhAuth } from "./gh-auth.js";
import { normalizeGhecomHost, type GitHubConnection } from "../shared/github-connection.js";
import { clearGitHubConnection, readGitHubConnection, writeGitHubConnection } from "../shared/creds.js";

export interface LoginPrompt {
  chooseType(): Promise<"github" | "ghecom" | null>;
  readHost(): Promise<string>;
  close(): void;
}

export interface LoginOptions {
  type?: string;
  host?: string;
}

export function createStdioLoginPrompt(): LoginPrompt {
  const readline = createInterface({ input: stdin, output: stdout });
  return {
    async chooseType() {
      const answer = (await readline.question("Login provider: [1] GitHub.com  [2] GHE.com  [q] cancel\n> ")).trim().toLowerCase();
      if (answer === "1" || answer === "github" || answer === "github.com") return "github";
      if (answer === "2" || answer === "ghecom" || answer === "ghe.com") return "ghecom";
      if (answer === "q" || answer === "quit" || answer === "") return null;
      throw new Error("Choose GitHub.com (1) or GHE.com (2).");
    },
    readHost: async () => readline.question("GHE.com hostname (for example acme.ghe.com): "),
    close: () => readline.close(),
  };
}

export async function resolveLoginRequest(
  options: LoginOptions,
  isTTY: boolean,
  prompt: LoginPrompt,
): Promise<LoginRequest | null> {
  if (options.type !== undefined && options.type !== "github" && options.type !== "ghecom") {
    throw new Error("--type must be github or ghecom");
  }
  if (!isTTY && options.type === undefined) throw new Error("Non-interactive login requires --type github|ghecom");

  const type = options.type ?? await prompt.chooseType();
  if (!type) return null;
  if (type === "github") {
    if (options.host !== undefined) throw new Error("--host is only valid with --type ghecom");
    return { type: "github" };
  }

  const host = options.host ?? (isTTY ? await prompt.readHost() : undefined);
  if (!host) throw new Error("GHE.com login requires --host SUBDOMAIN.ghe.com");
  return { type: "ghecom", host: normalizeGhecomHost(host) };
}

export interface LoginCommandResult {
  completed: boolean;
  connection?: GitHubConnection;
  previous?: GitHubConnection | null;
}

export async function runLoginCommand(
  options: LoginOptions,
  deps: {
    isTTY: boolean;
    dir: string;
    prompt?: LoginPrompt;
    ghAuth?: GhAuth;
    fetchFn?: typeof fetch;
    log?: (message: string) => void;
    activate?: (connection: GitHubConnection) => Promise<void>;
  },
): Promise<LoginCommandResult> {
  const prompt = deps.prompt ?? createStdioLoginPrompt();
  try {
    const request = await resolveLoginRequest(options, deps.isTTY, prompt);
    if (!request) return { completed: false };
    const previous = readGitHubConnection(deps.dir);
    await loginGitHubConnection(request, deps.dir, {
      ghAuth: deps.ghAuth ?? productionGhAuth,
      fetchFn: deps.fetchFn,
      log: deps.log,
    });
    const connection = readGitHubConnection(deps.dir);
    if (!connection) throw new Error("GitHub login completed without saving a connection");
    try {
      await deps.activate?.(connection);
    } catch (error) {
      if (previous) writeGitHubConnection(previous, deps.dir);
      else clearGitHubConnection(deps.dir);
      throw error;
    }
    return { completed: true, connection, previous };
  } finally {
    prompt.close();
  }
}
