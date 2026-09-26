# GHE.com Login Implementation Plan

> Execute in order. The specification is `docs/superpowers/specs/2026-09-10-ghecom-login.md`. Every behavior change starts with a failing E2E or integration-level test before implementation.

## 1. Catalog acceptance cases

**Modify:** `e2e/cases.md`

Add EP-50 onward for legacy GitHub.com compatibility, provider selection, GHE.com validation, `gh`-missing behavior, safe child invocation, credential persistence/switch/logout, enterprise token expiry, REST routing, inference-origin propagation, and fail-closed behavior. Identify which cases run hermetically, in Docker, and against the real GHE.com account.

**Verify:** review every specification acceptance criterion against at least one case ID.

## 2. Write connection lifecycle E2E first

**Create:** `e2e/github-connection.e2e.test.ts`

Drive exported application services with a temporary data directory and injected process runner/server. Cover:

- legacy `{ghToken}` remains GitHub.com;
- explicit GitHub.com selection never touches the `gh` runner;
- GHE.com valid/invalid host matrix;
- missing `gh` returns installation guidance only on the enterprise branch;
- successful enterprise login saves only type/host;
- failed/cancelled login preserves prior connection;
- switching replaces one complete connection;
- logout clears project state without `gh logout`;
- enterprise token retrieval failures classify as reauthentication.

**RED:** `npx vitest run e2e/github-connection.e2e.test.ts`

## 3. Implement the connection and credential boundary

**Create:**
- `src/shared/github-connection.ts`
- `src/cli/gh-auth.ts`

**Modify:**
- `src/shared/creds.ts`
- `src/cli/auth.ts`
- `tests/shared/creds.test.ts`
- `tests/shared/github-connection.test.ts`
- `tests/cli/auth.test.ts`

Use a discriminated connection type and strict GHE.com hostname parser. Preserve legacy reads. Write metadata atomically. Define an injected `GhAuth` interface whose production implementation uses `execFile`/`spawn` argument arrays, inherited stdio for login, and captured non-logged stdout for token retrieval. Resolve executable-not-found into one centralized official-install message.

**GREEN:** `npx vitest run e2e/github-connection.e2e.test.ts tests/shared/creds.test.ts tests/shared/github-connection.test.ts tests/cli/auth.test.ts`

## 4. Write upstream routing E2E first

Extend `e2e/github-connection.e2e.test.ts` with a local fake GitHub/Copilot server and injectable origins. Assert:

- GitHub.com `/user` and token exchange retain their origins;
- GHE.com maps account REST to `https://api.HOST` and Copilot discovery to `https://HOST/api/v3/copilot_internal/user`;
- account discovery parses a verified `endpoints.api` into one session and uses the GitHub CLI OAuth token directly;
- models, chat, Responses, and borrowed search use that session origin;
- GHE.com missing/malformed/untrusted endpoint fails before any global Copilot request;
- refreshed session replaces token and origin atomically;
- no token appears in error output.

**RED:** `npx vitest run e2e/github-connection.e2e.test.ts`

## 5. Implement connection-aware Copilot sessions

**Modify:**
- `src/providers/copilot/token.ts`
- `src/providers/copilot/account.ts`
- `src/providers/copilot/models.ts`
- `src/providers/copilot/adapter.ts`
- `src/providers/copilot/responses-upstream.ts`
- `src/providers/copilot/borrow-search.ts`
- provider unit tests for each module

Introduce a cached `CopilotSession` containing bearer token, expiry, entitlement, and inference origin. The GitHub credential source and REST origin come from the active connection. Validate endpoint metadata independently from the opaque token. Keep the GitHub.com fallback; make GHE.com missing/invalid metadata a typed endpoint-contract failure. Route every Copilot operation through the same session source rather than independent constants.

**GREEN:** `npx vitest run e2e/github-connection.e2e.test.ts tests/providers/copilot`

## 6. Write CLI and TUI interaction tests first

**Modify:**
- `tests/cli/auth.test.ts`
- `tests/tui/app-interaction.test.tsx`

Cover keyboard selection/cancel/retry, hostname entry and validation, immediate GitHub.com device code display, enterprise progress/errors, double-submit protection, CLI TTY/non-TTY matrix, invalid option combinations, and recovery from expired enterprise credentials. Explicitly assert GitHub.com scenarios work with a `GhAuth` fake that throws if touched.

**RED:** targeted CLI/TUI test command.

## 7. Implement login selection and process propagation

**Create:** `src/tui/screens/github-login.tsx`

**Modify:**
- `src/cli/index.ts`
- `src/tui/app.tsx`
- `src/worker/index.ts`
- `src/supervisor/index.ts`
- `src/shared/control-types.ts` if host/status metadata is exposed
- relevant supervisor/status/TUI tests

Use the same login controller for startup, `login`, and `/login`. Parse Commander options before auth. Only instantiate/check the GitHub CLI adapter after GHE.com selection. After successful replacement, reset the in-process session, clear identity, and restart the worker. Worker and heartbeat build their sources from the active connection. `/logout` only clears project metadata.

**GREEN:** `npx vitest run tests/cli tests/tui tests/supervisor e2e/github-connection.e2e.test.ts`

## 8. Add Docker process-boundary coverage

**Modify:**
- `e2e/docker/http-e2e.mjs`
- Docker fixture/configuration files only as needed

Install a fake `gh` executable in the test image or inject one on `PATH`. Prove argument boundaries, absence behavior, token non-leakage, and worker/supervisor startup with enterprise metadata without contacting a real enterprise. Do not mock internal application modules in this layer.

**Verify:** build and run the HTTP Docker E2E command documented in `e2e/docker/README.md`.

## 9. Documentation and release metadata

**Modify:**
- `README.md`
- `e2e/RESULTS.md`
- `CHANGELOG.md` through the changeset command

**Create:** `.changes/<generated-ghecom-slug>.md`

Document supported account types, interactive and non-interactive login, strict hostname form, GitHub CLI dependency only for GHE.com, logout semantics, GHES non-support, and enterprise endpoint diagnostics. Add a minor changeset.

## 10. Full hermetic verification

Run in sequence and fix root causes without bypassing checks:

1. `npm run test:e2e`
2. `npm test`
3. `npm run build`
4. HTTP Docker E2E

Update `e2e/RESULTS.md` only from actual outputs.

## 11. Real regressions and GHE.com acceptance

First run the existing GitHub.com live integration and real CLI Docker matrix with the current mounted credential. GitHub.com must remain independent of `gh`.

Then ask the user to complete the interactive `gh auth login` for their real GHE.com host. Without exposing token contents, verify:

- selected enterprise identity and Copilot entitlement;
- actual GHE.com account-discovery endpoint metadata and its validated inference hostname;
- model discovery;
- one Claude CLI turn;
- one Codex CLI turn;
- a real tool-call loop;
- expired/missing enterprise credential recovery;
- `/logout` followed by successful `gh auth status --hostname HOST`.

The real GHE.com contract was verified against `msft.ghe.com`: `/api/v3/copilot_internal/user` returns `endpoints.api`, and the GitHub CLI OAuth token authenticates directly to that inference origin. Keep the sanitized fixture aligned with this shape; do not infer an endpoint from the bearer token or add a global fallback for GHE.com.

## 12. Final review

Run code simplification and code review agents over the exact diff, apply verified findings, rerun affected tests plus the full E2E suite, then report either:

- `DONE` with all hermetic, GitHub.com, and real GHE.com evidence; or
- `BLOCKED` naming the missing real enterprise gate and completed evidence.
