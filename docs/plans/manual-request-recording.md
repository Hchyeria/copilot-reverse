# Manual request recording implementation plan

## Goal and agreed scope

Provide TUI `/record-start` and `/record-end` commands for manually capturing requests through the current copilot-reverse worker. The artifacts must support subsequent debugging and replay of actual requests, including upstream 408/429/413 errors. This phase captures evidence; it does not implement replay, automatic retries, or diagnose the existing remote timeout conclusively.

Agreed behavior:

- Recording is OFF by default and resets to OFF when the worker restarts.
- Record all authenticated proxy requests admitted while recording is active, including requests from different clients and concurrent requests.
- Pi's direct `github-copilot` traffic is outside this proxy and cannot be captured.
- Save complete inbound request bodies, actual serialized upstream request bodies and parameters, allowlisted HTTP headers, full upstream response bodies (including SSE), errors, byte counts, and timing metadata.
- `/record-end` stops enrolling new requests. Existing recorded requests finish their recordings; stopping must not wait for a model turn to finish.
- Duplicate start/end commands are harmless. Starting again creates a new session only when no session is accepting requests; older in-flight captures retain their original session.
- No automatic trigger, history ring buffer, cleanup, retention quota, online replay, or tool execution.
- Files are manually managed by the user. Capture failures warn clearly and mark artifacts incomplete where possible, without blocking normal proxy service.

## Worktree and change discipline

- Worktree: `/Users/hchyeria/Git/copilot-reverse-recording`.
- Branch: `feat/manual-request-recording`.
- Base: `bf36a92`; do not copy or overwrite the original checkout's uncommitted changes.
- Local work only: no fetch, push, PR creation, or merge.
- A preliminary `src/shared/recording.ts` type file exists; no recording runtime has been implemented yet.

## Architecture

### 1. Worker-owned recorder

Add a focused recording module under `src/worker/recording/` (or one file if sufficiently small). It owns session lifecycle, per-request directories, capture completeness, and batched response writes. It exposes a small interface for start/end/status, request enrollment, upstream capture, and flush/finalization.

Use asynchronous filesystem operations. Create recording/session/request directories with mode 0700 and files with mode 0600. Generate directory names from timestamps and random IDs, never from request-supplied strings. Do not persist credentials or arbitrary headers: use explicit request/response header allowlists for routing/API metadata, content type, request IDs, rate-limit diagnostics, and retry hints. Bodies remain unchanged and may themselves contain sensitive information; warn the user accordingly.

Recording storage:

```text
~/.copilot-reverse/recordings/<session-time>-<session-id>/
  session.json
  <request-id>/
    inbound.json
    metadata.json
    upstream-001/
      request.json
      metadata.json
      response.sse | response.body
      result.json
    result.json
```

One inbound request can produce multiple upstream calls (endpoint fallback and gateway tool rounds). Give each attempt a separate numbered directory; never overwrite the first attempt with the last. Persist schema version and application version so future replay tooling can interpret artifacts.

`inbound.json` holds the original JSON bytes exposed by the body parser before canonical conversion. Document that this is the decoded entity, not packet capture: compressed transfer framing and TLS are not preserved. Capture actual outbound serialized bytes at the fetch boundary rather than reconstructing them from canonical data later.

### 2. Request context and capture boundaries

Integrate enrollment in `src/worker/server.ts`, after access control but before request-body conversion. Avoid capturing authentication failures or secrets from authentication endpoints. Capture malformed-body/parser failures when possible, clearly labeling partial or missing bodies rather than claiming completeness.

Use request-scoped context (e.g. AsyncLocalStorage) to associate upstream fetch calls and metric/finalization events with the correct inbound recording. Concurrency tests must demonstrate no cross-request mixing. Requests that began with recording disabled must not become partially enrolled when start is called midway through processing.

Inject a recording fetch wrapper into `CopilotAdapter` in `src/worker/index.ts`, retaining the adapter's existing fetch injection seam. Keep model-discovery and credential exchange requests outside capture. Inspect gateway tool/borrow paths and either capture their relevant model calls with the same context or explicitly document any excluded external-service boundary; never silently claim coverage that is absent.

The wrapper must preserve returned response status, headers, body bytes, stream errors, cancellation, and downstream timing behavior. Do not use an unbounded independent `Response.clone()` consumer. Prefer a read-through wrapper that captures each consumed chunk with bounded batching/backpressure. Mark early termination/cancellation incomplete. If the application intentionally abandons an upstream body, do not label its capture complete or launch unlimited background draining.

Full error bodies must be captured before existing human-readable error formatting truncates them. Record both upstream status and client-facing outcome; HTTP 200 with an SSE error must retain its raw stream and must not be mislabeled as a transport failure.

### 3. Debounced, bounded batch writes

User requirement: do not write one filesystem operation per response chunk.

Initial settings:

- Trailing debounce: 250 ms.
- Maximum wait under continuous traffic: 1 second.
- Flush threshold: 256 KiB buffered response data.
- Flush on stream completion/error/cancellation and `/record-end` for already buffered data; continue capturing in-flight requests afterward.
- Serialize writes per file to preserve byte order and prevent races.
- Bound queued writes as well as the current buffer; apply backpressure rather than accumulate an unlimited chain of pending buffers on slow disks.
- Save complete request artifacts before initiating their associated upstream call; request-body persistence is not held behind the response debounce timer.
- Write summaries at meaningful lifecycle boundaries rather than on every chunk.

These are application writes, not an fsync durability guarantee. A crash or force-kill can lose the last unflushed data. Persist an initial incomplete/in-progress marker and only mark complete after successful final writes. If even the incomplete marker cannot be written, expose the failure through recording status and stderr/TUI warning.

### 4. Control plane

Extend the existing supervisor-worker IPC rather than expose unauthenticated recording controls on the worker's LAN-accessible HTTP listener.

Relevant files:

- `src/shared/recording.ts`: serializable status/action types.
- `src/shared/ipc.ts`: correlated recording command/reply messages and status/warning updates.
- `src/supervisor/monitor.ts`: bounded command/reply handling; reject pending commands when a worker exits/restarts/disconnects. Ensure callbacks/timeouts are cleaned up.
- `src/worker/index.ts`: dispatch start/end/status, publish recording state, and flush best-effort on normal shutdown.
- `src/supervisor/index.ts`: bridge commands and status to the control API; invalidate stale recording status on worker replacement.
- `src/supervisor/api.ts`: loopback control endpoints for start/end and recording status, with explicit errors when the worker is unavailable.
- `src/shared/control-types.ts`: optional recording status in `/api/status` for compatibility with existing callers/tests.

Do not restart the live user's daemon during development. Do not claim recording automatically recovers after crashes.

### 5. TUI

Relevant files:

- `src/tui/daemon-client.ts`: typed recording calls that check HTTP status and report actionable errors.
- `src/tui/slash/commands.ts`: register both commands for execution, help, and autocomplete; show directory, counts, and sensitive-data warning.
- `src/tui/app.tsx`: persistent REC indicator and path from worker-authoritative status, plus visible incomplete/write-failure warnings. Use existing status refresh flow without unnecessary redraw churn; refresh immediately after local commands where practical.

When end returns, distinguish stopped enrollment from still-draining captures. Starting/stopping from another TUI must eventually be reflected by the status refresh. A dead/restarted worker must not leave the HUD claiming recording is active.

## Implementation sequence

1. Finish integration mapping; verify interfaces and test conventions. Keep this plan updated for justified changes.
2. Write recorder/batched-writer tests, then implement the worker-local recording module.
3. Write request/fetch integration tests, then integrate inbound enrollment, exact outbound capture, response streaming, and result finalization.
4. Write control lifecycle tests, then add IPC/control API integration.
5. Write slash-command/HUD tests, then add the TUI controls and status display.
6. Add a hermetic docker HTTP case covering manual start/request/error/end and recording artifacts. Add documentation and a minor changeset.
7. Run targeted tests, the full Vitest/e2e suite, build, and available docker HTTP e2e. Update `e2e/RESULTS.md` with actual results and explicit skipped/blocked gates.
8. Review the actual diff, verify no sensitive fixtures or generated recording artifacts are staged, and make an explicit-path local commit. Report branch, commit, test evidence, and limitations. No merge or remote operations.

## Required tests and acceptance criteria

### Storage and batching

- Disabled mode creates no recording directories and adds no response buffering.
- Start/end are idempotent; sessions and concurrent requests have distinct paths.
- UTF-8 byte counts match stored bodies, including non-ASCII text and chunk boundaries inside multibyte sequences.
- No truncation of large requests or upstream error bodies.
- Allowlisted headers retain diagnostic fields; authorization, cookies, API keys, and URL credentials never appear in metadata.
- Files/directories have private permissions (where supported).
- Small chunks batch; continuous data flushes by maximum delay; threshold flushes by size; end/error flushes remaining data; serialized append preserves bytes exactly.
- Slow/erroring storage cannot create unbounded write queues or unhandled rejections; proxy responses remain usable and status reports incomplete capture.

### HTTP/upstream integration

- Cover OpenAI chat, OpenAI Responses, and Anthropic entry points using mock upstreams; verify inbound versus transformed outbound contents.
- Success, exact reported 408 body, 429 with retry header, 413, network exception, stream read error, HTTP-200 error SSE, cancellation, and empty response cases.
- Multiple upstream attempts for a single inbound request stay distinct.
- Concurrent requests do not mix artifacts.
- Stop while a stream is active flushes current bytes, excludes new requests, and allows the old stream to finish recording. A new recording session cannot steal the old request's writes.
- Metadata does not claim upload-phase timing that fetch cannot measure. Define recorded timing milestones precisely (request received, capture persisted, fetch started, headers received, first consumed body chunk, body finished).

### Control/TUI

- Commands appear in help/autocomplete and report state/path.
- Unavailable worker, command timeout, worker restart, and write failure are surfaced accurately.
- Recording controls cannot be invoked through the public worker proxy routes.
- HUD reflects active, stopped/draining, warning, and restart-to-off states.

### Repository gates

- Full test suite and build green.
- Hermetic HTTP docker coverage runs when Docker is available; otherwise record the blocker without claiming success.
- No live Copilot CLI replay is needed to test capture byte fidelity. The live CLI e2e remains required before any future merge per repository policy; obtain explicit approval before spending live quota or modifying running services.
- Add a minor changeset for the new observable feature and user documentation of recording scope, privacy, batching, storage management, and limitations.

## Implementation and validation notes

- Runtime implemented in `src/worker/recording/{recorder,batch-writer}.ts`; control/TUI integration follows the plan above.
- Additional hermetic real-worker IPC/HTTP test added at `tests/e2e/recording-control.test.ts`. It boots source via the existing tsx development dependency, uses an isolated HOME/free port, and disables upstream fetch. It does not depend on stale `dist/` output or the user's live daemon.
- Session version metadata and per-attempt files are implemented. Timing labels describe fetch start/headers/body consumption, not upload completion.
- Model borrow calls use the recording fetch wrapper. WebIQ HTTP calls are explicitly excluded; subsequent model calls containing tool results remain recorded.
- Local gates: full suite 84 files/780 tests; e2e 10 files/49 tests; TypeScript build; diff and Docker script syntax checks all pass.
- Container execution is blocked because Docker is not installed. Docker HTTP cases are added but unexecuted; live CLI fidelity is also unexecuted. No merge or live-daemon update is authorized by these local results.
- The implementation intentionally leaves an in-progress marker for hard crashes and documents missing parser/abandoned stream bytes. It does not claim arbitrary failures can always be replayed fully.

## Non-goals and known limitations

- Recording does not prove whether the existing 408 originates in the local network, Copilot ingress, or an internal upstream hop.
- No replay CLI, token refresh capture, automatic shrinking, retry policy changes, quota workaround, packet capture, or upload-progress instrumentation.
- User controls disk usage manually; no promise of successful capture when storage is unavailable.
- Complete body capture is guaranteed only when bytes reach/are consumed by the proxy and recording writes succeed. Partial uploads, unread/abandoned upstream tails, process crashes, and disk failures are labeled rather than hidden.
