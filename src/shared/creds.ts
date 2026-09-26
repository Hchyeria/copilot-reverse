import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { normalizeGhecomHost, type GitHubConnection } from "./github-connection.js";

const file = (dir: string) => join(dir, "creds.json");

type CredentialFileSystem = Pick<typeof import("node:fs"), "writeFileSync" | "renameSync" | "rmSync">;

const credentialFileSystem: CredentialFileSystem = { writeFileSync, renameSync, rmSync };

export function writeGitHubConnection(
  connection: GitHubConnection,
  dir: string,
  fs: CredentialFileSystem = credentialFileSystem,
): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = file(dir);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const persisted = connection.type === "github"
    ? { ghToken: connection.token }
    : { type: "ghecom", host: normalizeGhecomHost(connection.host), authSource: "gh" };
  try {
    fs.writeFileSync(temporary, JSON.stringify(persisted), { mode: 0o600 });
    fs.renameSync(temporary, path);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function readGitHubConnection(dir: string): GitHubConnection | null {
  if (!existsSync(file(dir))) return null;
  try {
    const stored = JSON.parse(readFileSync(file(dir), "utf8")) as {
      ghToken?: unknown;
      type?: unknown;
      host?: unknown;
      authSource?: unknown;
    };
    if (typeof stored.ghToken === "string") return { type: "github", token: stored.ghToken };
    if (stored.type === "ghecom" && typeof stored.host === "string" && stored.authSource === "gh") {
      return { type: "ghecom", host: normalizeGhecomHost(stored.host) };
    }
    return null;
  } catch {
    return null;
  }
}

export function clearGitHubConnection(dir: string): void {
  rmSync(file(dir), { force: true });
}

// M1: plaintext token in the data dir (0600). Encryption-at-rest is M2.
export function writeGhToken(token: string, dir: string): void {
  writeGitHubConnection({ type: "github", token }, dir);
}
export function readGhToken(dir: string): string | null {
  const connection = readGitHubConnection(dir);
  return connection?.type === "github" ? connection.token : null;
}
// Whether a stored-token file exists at all — distinct from readGhToken, which also returns null when
// the file is present but momentarily unreadable. The "are you signed out?" gate wants existence (a
// transient lock on a real login should not read as signed out); the actual token validity is checked
// separately by exchanging it.
export function hasGhTokenFile(dir: string): boolean {
  return existsSync(file(dir));
}
// Remove the stored token (logout). No-op if there's nothing to remove.
export function clearGhToken(dir: string): void {
  clearGitHubConnection(dir);
}
