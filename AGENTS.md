# Agent guidance

Personal-use project. Changesets, changelog entries, version bumps, and publishing are optional; only do release work when requested.

## Git workflow

- Use a dedicated worktree and branch for features and bug fixes. Small single-file edits, docs changes, and investigations may stay in the current tree.
- Preserve unrelated local changes. Stage explicit paths with `git add <path>`; never use `git add .` or `git add -A`.
- Create new commits rather than amending published commits.
- Open a PR when the branch is ready; leave it for human review. Merge only with explicit authorization for that specific PR.
- After merge or abandonment, clean up the task's worktree and branch. After merge, fast-forward local `master` from `origin/master`, preserving local changes.

## Verification

- For code changes, run `npm test` and `npm run build`; report failures or skipped checks.
- For request/response, metrics, or supervision changes, add regression coverage in `e2e/docker/http-e2e.mjs` (hermetic, no live quota).
- For CLI compatibility changes, cover a real user flow and its relevant edge case in `e2e/docker/cli-e2e.sh`, using the actual client rather than synthetic HTTP. Missing optional credentials should produce a recorded skip.
- Before merging behavior changes, pass the live Copilot CLI e2e. Read [Docker e2e instructions](e2e/docker/README.md) for setup and read-only credential mounting; hermetic tests alone do not replace this check.
- When running e2e, record results in [e2e/RESULTS.md](e2e/RESULTS.md); when adding cases, update [e2e/cases.md](e2e/cases.md). Docs-only changes need no tests.

## Architecture

- **TUI** — Ink terminal app with REPL, slash commands, and an assistant.
- **Supervisor** — control API, SQLite, and worker supervision.
- **Worker** — OpenAI/Anthropic-compatible endpoints translated to Copilot, including tool calls.

Runtime data lives in `~/.copilot-reverse`.
