# GHE.com Login Specification

## Problem

copilot-reverse currently assumes every Copilot account is hosted on GitHub.com. It starts a GitHub.com device-code flow, stores one GitHub token in `creds.json`, and sends account and Copilot-token requests to fixed GitHub.com API endpoints. Users licensed through GitHub Enterprise Cloud with data residency instead sign in on `SUBDOMAIN.ghe.com` and use the enterprise-specific REST API at `api.SUBDOMAIN.ghe.com`.

The product must support GitHub.com and GHE.com without making GitHub CLI a dependency for existing GitHub.com users, copying enterprise credentials into a second store, or sending an enterprise token to an assumed global Copilot endpoint.

## Scope

This change supports:

- GitHub.com accounts using the existing embedded device-code flow; and
- GitHub Enterprise Cloud with data residency accounts whose web hostname is `SUBDOMAIN.ghe.com`.

GitHub Enterprise Server (GHES) is not supported. GitHub currently documents GHES Copilot CLI as an offline/BYOK provider flow, which is a different upstream-provider architecture rather than another hosted login endpoint. Ordinary GitHub Enterprise Cloud organizations on `github.com` continue to use the GitHub.com option.

Only public-CA HTTPS endpoints are supported. The application does not add custom CA configuration or an insecure TLS mode.

## Connection model and persistence

Exactly one copilot-reverse connection is active at a time:

```ts
type GitHubConnection =
  | { type: "github"; token: string }
  | { type: "ghecom"; host: string };
```

The representation on disk may use a versioned envelope, but it must preserve these invariants:

- GitHub.com keeps its token in `~/.copilot-reverse/creds.json` as today.
- GHE.com stores only its normalized hostname and an `authSource` identifying GitHub CLI. It never copies the enterprise token into `creds.json`, another project file, an environment variable, IPC, logs, or error text.
- Existing `{ "ghToken": "..." }` files migrate logically to a GitHub.com connection without user action.
- A successful login replaces the entire active connection atomically. There is no multi-account/profile UI.
- A corrupt or unreadable file remains a recoverable signed-out state.
- Logout removes the active copilot-reverse connection. For GHE.com it must not call `gh auth logout` or otherwise alter credentials used by other tools.

## Host validation

GHE.com input is a hostname, not a URL. It is trimmed, case-normalized to lower case, and accepted only when all of the following hold:

- it consists of DNS labels followed by `.ghe.com`;
- at least one non-empty label precedes `ghe.com`;
- labels use ASCII letters, digits, and internal hyphens, with DNS-compatible lengths;
- it contains no scheme, slash, backslash, query, fragment, user information, whitespace, or port; and
- it is neither `ghe.com` nor `github.com`, and suffix lookalikes such as `acme.ghe.com.evil.test` are rejected.

The accepted web host maps to the documented REST origin `https://api.<host>`. No request containing a credential may be made before validation succeeds.

## Login UX

### Interactive startup and `login`

When login is required in an interactive terminal, show a two-choice screen:

1. GitHub.com
2. GHE.com (Enterprise Cloud with data residency)

Choosing GitHub.com immediately starts the existing two-phase device flow and displays the verification URI and user code while polling.

Choosing GHE.com asks for the enterprise hostname, validates it locally, and only then checks for GitHub CLI. If `gh` is absent, stop before any authentication or network action and show an actionable installation message that points to the official GitHub CLI installation documentation. The application does not install software automatically and does not offer a pasted-token fallback.

When `gh` is available, execute `gh auth login --hostname HOST`. Arguments are passed without a shell. The child inherits the terminal needed for GitHub CLI's interaction. After it exits successfully, verify the selected host can yield an active credential and save only the GHE.com connection metadata.

The TUI `/login` command opens the same two-choice flow. Existing double-submit protection remains: one login may be in flight at a time.

### Non-interactive login

A non-TTY process cannot display the selector. `copilot-reverse login` therefore requires an explicit type:

- `copilot-reverse login --type github`
- `copilot-reverse login --type ghecom --host SUBDOMAIN.ghe.com`

`--host` is required for `ghecom` and invalid for `github`. Missing or contradictory arguments fail before authentication with an actionable usage error. GitHub.com's device flow may still print its code in a non-TTY process once its type is explicit.

### Critical GitHub CLI boundary

The executable check and every `gh` invocation are strictly inside the GHE.com branch. Selecting GitHub.com—at startup, with `login --type github`, or in `/login`—must not search for `gh`, invoke it, mention installing it, or change behavior when it is absent.

## Runtime credentials and endpoints

A single connection-aware credential source serves the TUI, supervisor heartbeat, and worker:

- GitHub.com reads the persisted token.
- GHE.com invokes `gh auth token --hostname HOST` without a shell, captures stdout only, trims the terminal newline, and treats empty output or a non-zero exit as reauthentication required. The token is kept only in process memory for the immediate authenticated request and is never included in diagnostics.

GitHub REST origins are deterministic:

- GitHub.com: `https://api.github.com`
- GHE.com: `https://api.SUBDOMAIN.ghe.com`

GitHub.com uses `https://api.github.com/copilot_internal/v2/token` to exchange its GitHub token. GHE.com instead calls the empirically verified `https://HOST/api/v3/copilot_internal/user`, reads `endpoints.api`, and uses the `gh` OAuth token directly as the Copilot bearer. This contract was verified against `msft.ghe.com`; no endpoint is inferred from token contents.

- GitHub.com preserves `https://api.githubcopilot.com` as its compatibility fallback when no explicit inference origin is returned.
- GHE.com is fail-closed: if account discovery omits a trusted inference origin, returns an invalid one, or reports chat disabled, model discovery and chat fail with a specific contract or entitlement message. They must never silently send the enterprise token to the GitHub.com fallback.
- Token, entitlement, and resolved inference origin form one cached session and refresh atomically. A new login or refresh cannot reuse the previous account's origin.
- Models, chat completions, Responses, and borrowed web-search calls all use the same resolved session origin.

## Status, expiry, and recovery

Status surfaces identify the selected host so users can distinguish `github.com` from their GHE.com account. Account lookup uses the selected REST origin.

A definitive GitHub.com exchange failure or a failed `gh auth token --hostname HOST` marks the connection expired. Interactive startup returns to the two-choice login screen rather than automatically forcing the previous host, allowing the user to switch providers. `/status` and chat preflight provide the selected host and tell the user to run `/login`.

Transient network or 5xx failures retain the existing last-known-good behavior and are not rewritten as credential expiry. Enterprise endpoint-contract errors are distinct from expired credentials and must explain that re-login will not fix an unsupported endpoint.

## Security and failure semantics

- Use `execFile`/`spawn` with an argument array and `shell: false`; a hostname must never enter a shell command string.
- Never log child stdout from `gh auth token`, authorization headers, Copilot tokens, or raw token-exchange payloads.
- Errors may name the normalized host and command purpose, never the token.
- Validate all hostnames and discovered URLs before attaching credentials.
- Discovered inference URLs must use HTTPS and contain no username, password, query, or fragment. Path normalization must not permit escaping the intended API origin.
- GitHub CLI absence is an installation error only for GHE.com. GitHub.com failures remain device-flow errors.
- Cancellation or failed GitHub CLI login leaves the previous active connection unchanged.

## Acceptance criteria

1. Existing GitHub.com users and legacy credentials continue to start, refresh, discover models, chat, and logout without GitHub CLI installed.
2. Interactive startup, `login`, and `/login` expose exactly GitHub.com and GHE.com; no GHES option is advertised.
3. GitHub CLI is checked and installation guidance is shown only after GHE.com is selected.
4. GHE.com host validation covers valid mixed-case input and rejects schemes, paths, credentials, ports, root domains, GitHub.com, Unicode/whitespace, malformed labels, and suffix lookalikes before any credential-bearing operation.
5. GHE.com login invokes `gh auth login --hostname HOST` safely, verifies the selected host, and persists no enterprise token.
6. Non-TTY login requires a valid `--type`; GHE.com also requires `--host`, while GitHub.com rejects `--host`.
7. Switching connection replaces one complete record. A failed or cancelled login preserves the old record. Logout removes only copilot-reverse state and leaves `gh auth status --hostname HOST` valid.
8. GHE.com account lookup uses `api.SUBDOMAIN.ghe.com/user`; Copilot discovery uses `SUBDOMAIN.ghe.com/api/v3/copilot_internal/user`, whose validated `endpoints.api` becomes the inference origin.
9. All Copilot upstream operations share one session-derived inference origin. GHE.com missing or invalid endpoint metadata fails closed and never calls `api.githubcopilot.com`.
10. Missing/revoked enterprise credentials return to login selection and produce no token output; transient failures remain distinguishable.
11. Hermetic E2E exercises selection, both auth branches, `gh` absence, strict host validation, safe child arguments, persistence, switching, logout, expired credentials, endpoint propagation, and enterprise fail-closed behavior through real process boundaries where practical.
12. Full E2E, full unit suite, build, and the existing real GitHub.com CLI matrix pass unchanged.
13. Final GHE.com acceptance uses a real enterprise host and account to verify GitHub CLI login, account identity, model discovery, one Claude turn, one Codex turn, tool use, credential expiry recovery, and non-destructive logout. Until that run passes, completion status is `BLOCKED`, not `DONE`.

## Non-goals

- GitHub Enterprise Server, GHES offline mode, or BYOK model providers.
- Multiple saved accounts or automatic account switching.
- Automatic GitHub CLI installation.
- Manual PAT entry or storage for GHE.com.
- Custom certificate authorities or disabled TLS verification.
- Changes to `/report` or changelog repository links; those identify the copilot-reverse project, not the login host.

## References

- [About GitHub Enterprise Cloud with data residency](https://docs.github.com/enterprise-cloud@latest/admin/data-residency/about-github-enterprise-cloud-with-data-residency)
- [GitHub Copilot with data residency](https://docs.github.com/en/enterprise-cloud@latest/admin/data-residency/github-copilot-with-data-residency)
- [Using GitHub Copilot with an account on GHE.com](https://docs.github.com/copilot/how-tos/personal-settings/using-github-copilot-with-an-account-on-ghecom)
- [GitHub CLI `gh auth login`](https://cli.github.com/manual/gh_auth_login)
- [GitHub CLI `gh auth token`](https://cli.github.com/manual/gh_auth_token)
- [GitHub CLI installation](https://github.com/cli/cli#installation)
