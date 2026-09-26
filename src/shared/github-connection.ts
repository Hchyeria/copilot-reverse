export type GitHubConnection =
  | { type: "github"; token: string }
  | { type: "ghecom"; host: string };

const GHECOM_SUFFIX = ".ghe.com";
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeGhecomHost(input: string): string {
  if (input !== input.trim() || !/^[\x00-\x7f]*$/.test(input)) {
    throw new Error("Invalid GHE.com hostname.");
  }

  const host = input.toLowerCase();
  if (!host.endsWith(GHECOM_SUFFIX) || host.length > 253) {
    throw new Error("Invalid GHE.com hostname.");
  }

  const prefix = host.slice(0, -GHECOM_SUFFIX.length);
  if (!prefix || !prefix.split(".").every((label) => DNS_LABEL.test(label))) {
    throw new Error("Invalid GHE.com hostname.");
  }

  return host;
}

export function githubRestOrigin(connection: GitHubConnection): string {
  return connection.type === "github"
    ? "https://api.github.com"
    : `https://api.${normalizeGhecomHost(connection.host)}`;
}
