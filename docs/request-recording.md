# Manual request recording

Use recording when investigating upstream errors, large contexts, or request/response translation. Recording is **off by default** and requires no change to client request bodies.

1. Run `/record-start` in the copilot-reverse TUI.
2. Reproduce the problem in a client pointing to this worker (Claude, Codex, pi, etc.).
3. Run `/record-end`. Use the directory printed by the command to inspect artifacts.

This captures **all clients sharing this worker**, including concurrent requests. Pi's direct `github-copilot` provider bypasses copilot-reverse and is not captured: select a provider pointing to the proxy first. It does not capture credential exchanges, model discovery, or WebIQ HTTP traffic. Copilot model calls in the main adapter and the optional borrow-search path are captured.

The TUI shows recording status and directory. Start is idempotent while already active. End stops enrolling new requests and flushes current response buffers; already recorded in-flight requests continue until finished. A new start creates another session without moving older in-flight recordings into it. Worker restart turns recording off; it never resumes silently.

## Files

```text
~/.copilot-reverse/recordings/<timestamp>-<session-id>/
  session.json
  <request-id>/
    inbound.json
    metadata.json
    result.json
    upstream-001/
      request.json
      metadata.json
      response-metadata.json
      response.body          # or response.sse for SSE
      result.json
    upstream-002/            # fallback or another model call, when applicable
```

- `inbound.json`: original JSON bytes before canonical translation (decoded HTTP entity, not compressed bytes/packet framing). Malformed JSON can therefore also be stored here.
- `request.json`: actual serialized JSON passed to the upstream fetch call, not reconstructed afterward. Compare this with inbound data to investigate translation.
- Metadata: method/path or safe upstream URL, explicitly allowlisted headers, byte counts, and timing milestones. Authorization, API-key, and cookie headers are excluded; URL query values and credentials are not persisted.
- `response.body`/`response.sse`: upstream body bytes consumed by the proxy, including non-success responses and HTTP-200 streams containing errors. Error bodies are preserved beyond the normal UI's truncated error summary. No SSE reformatting is applied.
- Result files: client/upstream status, transport outcome, metrics where available, and capture completeness. `complete` describes capture completeness, **not model success**. A completely saved 408 is complete; an interrupted response is not.

Each upstream attempt is separate. A route fallback does not overwrite the rejected request. The session carries a schema version and app version for future replay tooling. Replay commands and automatic retries are not part of this feature.

## Batch writes and timing

Response chunks are combined, not written individually. Flush after 250 ms idle, at most 1 second of continuous arrival, or 256 KiB accumulated, and on completion/error/end. Writes per file are ordered with backpressure, so slow disks do not create unlimited pending batches. Complete request artifacts are saved before their upstream call instead of waiting until the response ends.

`headersMs` measures from fetch invocation to response headers. `firstConsumedBodyMs` measures the first body chunk consumed by the recorder. These are **not upload-completion measurements** and cannot alone distinguish local upload stalls from Copilot's internal forwarding delays. Capturing requests adds disk I/O and may affect timing.

An upstream body intentionally abandoned by the proxy, a client disconnect, parser size rejection before the full body is available, or a stream failure can produce a partial artifact. Initial result files are marked in-progress/incomplete; do not infer completeness merely because a file exists. A force-kill/crash may lose the last unflushed batch. Filesystem writes are not an fsync durability guarantee.

## Privacy and storage failures

**Recorded bodies may contain private conversations, source code, tool output, and credentials embedded in text.** Header filtering does not sanitize bodies. Do not commit or upload the folder without reviewing it. Directories use mode 0700; files use 0600 (subject to platform permission semantics).

There is no automatic retention, disk quota, or deletion. Use `/record-end` promptly and delete recordings yourself when no longer needed. On disk/permission errors, proxy traffic continues; the recorder reports an incomplete warning through the TUI/status API. If disk writes are unavailable, even an incomplete marker may not be writable: absence of an artifact is not proof that a request never happened.
