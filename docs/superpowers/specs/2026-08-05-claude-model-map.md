# Claude Model Map Specification

## Problem

Some Copilot accounts advertise capable GPT models but no usable Claude models. Claude Code and Claude Desktop still work best when the Anthropic gateway advertises current canonical Claude model IDs: their native model picker, context sizing, thinking UI, and tool protocol all key off those IDs.

copilot-reverse needs an opt-in compatibility mode that presents current native Claude identities to Anthropic clients while executing each request on a known GPT backend. Copilot's model lineup changes independently, so users must be able to override each backend without waiting for another copilot-reverse release. Existing discovery and routing behavior must remain unchanged unless the user explicitly enables the mode.

## User interface

The copilot-reverse TUI exposes one command:

- `/claude-map` — open a single-page interactive editor for the enabled state and all supported mappings.

The overview displays the four Claude identities, their effective GPT targets, `default` or `custom` markers, and `unavailable` when the configured target is absent from live Copilot discovery. Its actions are:

- enable or disable the map in the draft;
- edit any Claude row by choosing from deduplicated live model IDs beginning with `gpt-`;
- restore all default targets in the draft;
- save the full draft; or
- cancel without writing.

The backend picker preserves Copilot discovery order and marks the current choice. Escape returns from the backend picker to the overview without losing other draft edits. Escape from the overview cancels the editor. If no GPT backend is live, the editor explains that no targets are available and still permits enable/disable, reset, save, or cancel.

No persistence or worker restart occurs until Save. Save writes one complete settings snapshot and restarts the worker once. Disable preserves custom overrides so re-enabling restores them. A successful save tells the user to reopen Claude's `/model` picker and to restart Claude Code or Claude Desktop if their discovery cache remains stale. The command never deletes or rewrites a client's private discovery cache.

If persistence succeeds but the worker restart fails, the TUI reports both facts: preferences were saved, but activation is incomplete until `/restart` succeeds. It must not claim that the new routing behavior is active.

`/claude-map` takes no arguments. Obsolete `/claude-map on|off` and any other arguments return `usage: /claude-map`, do not change preferences, and do not restart the worker.

## Default mapping

| Claude client model | Default Copilot backend |
|---|---|
| `claude-fable-5-1` | `gpt-6-astra` |
| `claude-opus-5` | `gpt-5.6-sol` |
| `claude-sonnet-5` | `gpt-5.6-sol-fast` |
| `claude-haiku-4-5` | `gpt-5.6-luna` |

These are the only supported compatibility identities. Former compatibility aliases `claude-sonnet-4-6` and `claude-opus-4-8` are neither advertised nor specially routed.

`[1m]` is a Claude Code client suffix, not part of a map key. Resolution strips it before consulting the map.

## Default and persistence

The feature defaults to `off` for a missing, unreadable, corrupt, or non-boolean preference. Upgrading copilot-reverse therefore changes no discovery or routing behavior.

The state is persisted in the existing `prefs.json` store as an enabled boolean and an override record. Writing replaces the complete override snapshot while preserving chat-model, change-banner, and other preferences.

Override validation is fail-closed per entry:

- keys must be one of the four supported Claude IDs;
- values must be non-empty strings beginning with `gpt-`;
- unknown keys and invalid values are ignored independently, so one bad entry does not discard valid entries;
- an omitted or invalid entry uses its default target.

The worker snapshots the resolved settings at startup. A TUI save restarts the worker through the existing supervisor control API so the saved state takes effect atomically for new requests.

## Discovery behavior

### Disabled

Both discovery endpoints and request resolution behave exactly as before this feature:

- Anthropic `/anthropic/v1/models` canonicalizes real Copilot Claude IDs and passes non-Claude IDs through.
- OpenAI `/openai/models` lists real Copilot model IDs.
- No compatibility identity is synthesized or resolved.

### Enabled

OpenAI discovery remains unchanged and lists only real Copilot model IDs.

Anthropic discovery retains every real Copilot model entry and appends a Claude identity only when its effective GPT target is present in the live Copilot model list. A missing target hides its identity; there is no silent fallback to a different GPT model. The persisted override remains intact and automatically becomes active if that exact target returns to discovery later. If live Copilot discovery already contains a real Claude model with the same canonical identity, the real model wins: no synthetic duplicate is added and requests keep routing to the genuine Claude model.

Synthesized entries use canonical Claude IDs and native display names (`Fable 5.1`, `Opus 5`, and so on). Claude Code and Desktop must therefore look native: the mapping arrow is not included in Anthropic `display_name`.

The copilot-reverse TUI model picker is intentionally more diagnostic. It retains original GPT rows and labels available identities as `claude-opus-5 → gpt-5.6-sol`, without changing the submitted model value.

## Routing behavior

When enabled, request resolution follows this order:

1. strip the optional `[1m]` suffix;
2. resolve an exact supported Claude identity whose effective backend is live;
3. apply the existing user `modelMap` exact entry;
4. use existing fuzzy matching;
5. apply the existing `*` fallback or pass through.

When disabled, step 2 is absent.

Unavailable identities are not resolved even if a caller manually submits one. Removed legacy compatibility aliases receive no special routing. This preserves the discovery invariant: the compatibility layer never promises a backend that discovery did not confirm.

The resolved GPT ID is placed in the canonical request before provider selection. Consequently endpoint selection (`/chat/completions` versus `/responses`), reasoning support, metrics, and upstream errors all use the real GPT backend ID.

## Capability and context semantics

A synthesized identity inherits its effective GPT backend's live context limit. That limit determines:

- whether the canonical Claude ID carries `[1m]`;
- the context window displayed by the copilot-reverse picker;
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW` written by Claude setup;
- local and LAN setup context sizing.

The Claude identity's native/default window must not override the real GPT backend. If no live limit is available, the identity is still routable when the backend itself is live, but no fabricated numeric setup limit is written; canonical fallback behavior remains available for the ID itself.

## Non-goals

- No arbitrary Claude aliases; the editor controls four current canonical identities only.
- No non-GPT targets in the editor.
- No changes to OpenAI/Codex model names or discovery.
- No interception of Claude Code's own slash commands.
- No automatic Claude cache deletion.
- No claim that a GPT backend has Claude model quality or identical model-specific behavior; only the Anthropic client protocol and UI remain native.

## Acceptance criteria

1. With no preference, the map remains disabled and the full existing discovery/routing behavior is unchanged.
2. The default map is exactly the four current identities above; removed legacy aliases are absent from compatibility discovery and routing.
3. The interactive editor supports draft toggle, per-row live GPT selection, restore defaults, save, and cancel; only Save writes and restarts exactly once.
4. Valid custom overrides persist across restart. Invalid/unknown entries are ignored independently and unrelated preferences are preserved.
5. A configured backend that is currently unavailable remains persisted but its Claude identity is marked unavailable, not advertised, and not resolved.
6. Anthropic discovery includes only identities whose exact effective GPT targets are live, while retaining original GPT entries. A colliding real Claude identity is neither replaced nor rerouted. OpenAI discovery never contains synthesized identities.
7. A real Anthropic request using a published identity reaches the provider as the effective GPT ID and follows that backend's endpoint/reasoning capabilities; metrics record the GPT backend.
8. Alias context metadata comes from the effective GPT backend limit.
9. TUI interaction tests cover loading, no-GPT, edit, reset, cancel, save, unavailable, invalid arguments, disable reconciliation, and restart failure.
10. Saving only reports activation success after the replacement worker reaches `ready`; a pre-ready crash is returned as persisted-but-incomplete activation.
11. Hermetic E2E covers disabled, default, custom, unavailable, removed legacy, collision, context, and OpenAI-isolation paths.
12. Real CLI E2E drives `claude -p` through the first available default identity and records `SKIP`, never failure, if none of the default GPT targets is available.
