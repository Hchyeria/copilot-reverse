import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RequestHandler } from "express";
import type { RecordingStatus } from "../../shared/recording.js";
import type { MetricSink } from "../server.js";
import { BatchWriter, type BatchOptions } from "./batch-writer.js";
import { APP_VERSION } from "../../version.js";

const HEADER_NAMES = new Set([
  "content-type", "content-length", "content-encoding", "accept", "user-agent",
  "editor-version", "copilot-integration-id", "openai-intent", "anthropic-version", "anthropic-beta",
  "openai-beta", "x-request-id", "request-id", "x-github-request-id", "x-ms-request-id",
  "retry-after", "retry-after-ms", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset",
  "x-ratelimit-limit-requests", "x-ratelimit-remaining-requests", "x-ratelimit-reset-requests",
  "x-ratelimit-limit-tokens", "x-ratelimit-remaining-tokens", "x-ratelimit-reset-tokens",
]);
export function diagnosticHeaders(headers: HeadersInit): Record<string, string> {
  return Object.fromEntries([...new Headers(headers)].filter(([key]) => HEADER_NAMES.has(key)));
}
function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(/(Bearer\s+)[^\s"']+/gi, "$1<REDACTED>");
}
function safeUrl(input: string): string {
  const url = new URL(input, "http://localhost");
  // Query values can carry credentials; current Copilot model endpoints have none.
  return `${url.origin}${url.pathname}`;
}
async function json(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}
interface Session {
  directory: string;
  requests: number;
  active: boolean;
  startedAt: string;
  endedAt?: string;
  warning?: string;
}
interface Attempt {
  directory: string;
  writer?: BatchWriter;
  finish: (outcome: string, error?: unknown) => Promise<void>;
}

class RequestCapture {
  readonly id = randomUUID();
  readonly directory: string;
  readonly startedAt = Date.now();
  private raw?: Buffer;
  private inboundWrite?: Promise<void>;
  private initialized: Promise<void>;
  private attempts: Attempt[] = [];
  private finalizing?: Promise<void>;
  private incomplete = false;
  private warnings: string[] = [];
  private metric?: Parameters<MetricSink>[0];

  constructor(readonly session: Session, private recorder: RequestRecorder,
    private method: string, private path: string, private headers: Record<string, string>) {
    this.directory = join(session.directory, this.id);
    this.initialized = this.safe(async () => {
      await mkdir(this.directory, { mode: 0o700 });
      await json(join(this.directory, "metadata.json"), {
        schemaVersion: 1, requestId: this.id, method, path, headers,
        receivedAt: new Date(this.startedAt).toISOString(),
      });
      await json(join(this.directory, "result.json"), { complete: false, outcome: "in-progress" });
    });
  }
  setBody(body: Buffer): void { this.raw = body; }
  setMetric(metric: Parameters<MetricSink>[0]): void { this.metric = metric; }
  fail(e: unknown): void {
    this.incomplete = true;
    // Do not send arbitrary filesystem error details (or request bodies) to IPC/TUI.
    const code = (e as NodeJS.ErrnoException)?.code ?? "write-error";
    const warning = `Recording incomplete (${code}): ${this.directory}`;
    if (!this.warnings.includes(warning)) { this.warnings.push(warning); this.recorder.warn(this.session, warning); }
  }
  private async safe(fn: () => Promise<void>): Promise<void> {
    try { await fn(); } catch (e) { this.fail(e); }
  }
  private saveInbound(): Promise<void> {
    return this.inboundWrite ??= (async () => {
      await this.initialized;
      await this.safe(async () => {
        if (this.raw === undefined) { this.incomplete = true; return; }
        const bytes = this.raw.length;
        await writeFile(join(this.directory, "inbound.json"), this.raw, { mode: 0o600 });
        await json(join(this.directory, "metadata.json"), {
          schemaVersion: 1, requestId: this.id, method: this.method, path: this.path, headers: this.headers,
          receivedAt: new Date(this.startedAt).toISOString(), inboundBytes: bytes,
          bodyEncoding: "decoded HTTP entity; original JSON bytes before canonical conversion",
        });
      });
      this.raw = undefined;
    })();
  }

  async fetch(fetchFn: typeof fetch, input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
    if (this.finalizing) return fetchFn(input, init);
    await this.saveInbound();
    const directory = join(this.directory, `upstream-${String(this.attempts.length + 1).padStart(3, "0")}`);
    let startedAt = Date.now();
    let responseBytes = 0;
    let headersAt: number | undefined;
    let firstBodyAt: number | undefined;
    let status: number | undefined;
    let bodyComplete = false;
    let ended: Promise<void> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const attempt: Attempt = {
      directory,
      finish: (outcome, error) => ended ??= (async () => {
        if (!bodyComplete && reader) {
          // An adapter may stop consuming early (deadline/runaway). Never claim a full response.
          try { await reader.cancel(); } catch { /* stream already failed */ }
        }
        await attempt.writer?.close();
        if (!bodyComplete) this.incomplete = true;
        await this.safe(() => json(join(directory, "result.json"), {
          complete: bodyComplete && !this.warnings.length, outcome, status, responseBytes,
          fetchStartedAt: new Date(startedAt).toISOString(),
          headersMs: headersAt === undefined ? undefined : headersAt - startedAt,
          firstConsumedBodyMs: firstBodyAt === undefined ? undefined : firstBodyAt - startedAt,
          elapsedMs: Date.now() - startedAt,
          error: error === undefined ? undefined : errorText(error),
        }));
      })(),
    };
    this.attempts.push(attempt);
    await this.safe(async () => {
      await mkdir(directory, { mode: 0o700 });
      // CopilotAdapter passes the actual serialized JSON string here. Unsupported bodies are
      // explicit capture gaps rather than consuming a request stream and changing its semantics.
      if (typeof init?.body !== "string") {
        this.incomplete = true;
        await json(join(directory, "request-unavailable.json"), { reason: "expected serialized JSON string" });
      } else {
        await writeFile(join(directory, "request.json"), init.body, { mode: 0o600 });
      }
      const url = input instanceof Request ? input.url : String(input);
      await json(join(directory, "metadata.json"), {
        method: init?.method ?? "GET", url: safeUrl(url),
        headers: diagnosticHeaders(init?.headers ?? {}),
        requestBytes: typeof init?.body === "string" ? Buffer.byteLength(init.body) : undefined,
        requestSavedAt: new Date().toISOString(),
      });
      await json(join(directory, "result.json"), { complete: false, outcome: "in-progress" });
    });
    let response: Response;
    startedAt = Date.now();
    try { response = await fetchFn(input, init); }
    catch (e) { await attempt.finish("fetch-error", e); throw e; }
    // The client can disappear while fetch is still waiting for headers. That attempt was
    // finalized as incomplete; do not reopen its writer or change the original fetch behavior.
    if (ended) return response;
    headersAt = Date.now(); status = response.status;
    await this.safe(() => json(join(directory, "response-metadata.json"), {
      status, statusText: response.statusText, headers: diagnosticHeaders(response.headers),
      headersReceivedAt: new Date(headersAt!).toISOString(),
    }));
    const filename = response.headers.get("content-type")?.includes("text/event-stream") ? "response.sse" : "response.body";
    await this.safe(() => writeFile(join(directory, filename), Buffer.alloc(0), { mode: 0o600 }));
    if (ended) return response;
    attempt.writer = new BatchWriter(join(directory, filename), (e) => this.fail(e), this.recorder.batchOptions);
    if (!response.body) {
      bodyComplete = true; await attempt.finish("complete"); return response;
    }
    reader = response.body.getReader();
    // No clone/tee: capture exactly the stream consumed by the adapter, with backpressure.
    const stream = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const { done, value } = await reader!.read();
          if (done) { bodyComplete = true; await attempt.finish("complete"); controller.close(); return; }
          firstBodyAt ??= Date.now(); responseBytes += value.byteLength;
          await attempt.writer!.append(value);
          controller.enqueue(value);
        } catch (e) { await attempt.finish("stream-error", e); controller.error(e); }
      },
      cancel: async (reason) => { await attempt.finish("cancelled", reason); },
    }, { highWaterMark: 0 });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  }

  async flush(): Promise<void> { await Promise.all(this.attempts.map((a) => a.writer?.flush())); }
  finish(clientStatus: number, aborted: boolean): Promise<void> {
    return this.finalizing ??= (async () => {
      await this.saveInbound();
      await Promise.all(this.attempts.map((a) => a.finish("consumer-ended")));
      await this.safe(() => json(join(this.directory, "result.json"), {
        complete: !this.incomplete && !aborted, outcome: aborted ? "client-disconnected" : "finished",
        clientStatus, elapsedMs: Date.now() - this.startedAt, upstreamAttempts: this.attempts.length,
        metric: this.metric, warnings: this.warnings,
      }));
      this.recorder.finished(this);
    })();
  }
}

export class RequestRecorder {
  private context = new AsyncLocalStorage<RequestCapture>();
  private current?: Session;
  private last?: Session;
  private latestWarning?: string;
  private captures = new Set<RequestCapture>();
  private changing: Promise<unknown> = Promise.resolve();
  constructor(private root: string, private onStatus: (status: RecordingStatus) => void = () => {},
    readonly batchOptions: BatchOptions = {}) {}

  status(): RecordingStatus {
    const session = this.current ?? this.last;
    return {
      active: Boolean(this.current), directory: session?.directory, requests: session?.requests ?? 0,
      inFlight: this.captures.size, warning: this.latestWarning ?? session?.warning,
    };
  }
  private emit(): void { try { this.onStatus(this.status()); } catch { /* diagnostics cannot break traffic */ } }
  warn(session: Session, warning: string): void { session.warning = warning; this.latestWarning = warning; this.emit(); }
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.changing.then(fn); this.changing = p.catch(() => {}); return p;
  }
  start(): Promise<RecordingStatus> {
    return this.serialize(async () => {
      if (this.current) return this.status();
      const startedAt = new Date().toISOString();
      const directory = join(this.root, `${startedAt.replace(/[:.]/g, "-")}-${randomUUID()}`);
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await mkdir(directory, { mode: 0o700 });
      const session: Session = { directory, startedAt, active: true, requests: 0 };
      await json(join(directory, "session.json"), { schemaVersion: 1, appVersion: APP_VERSION, ...session });
      this.current = this.last = session; this.latestWarning = undefined; this.emit(); return this.status();
    });
  }
  end(): Promise<RecordingStatus> {
    return this.serialize(async () => {
      const session = this.current;
      this.current = undefined;
      if (session) {
        session.active = false; session.endedAt = new Date().toISOString();
        try { await json(join(session.directory, "session.json"), { schemaVersion: 1, appVersion: APP_VERSION, ...session }); }
        catch { this.warn(session, `Recording incomplete: unable to save session summary (${session.directory})`); }
      }
      // Only flush bytes already captured; never wait for an upstream turn to end.
      await Promise.all([...this.captures].map((c) => c.flush()));
      this.emit(); return this.status();
    });
  }
  finished(capture: RequestCapture): void { this.captures.delete(capture); this.emit(); }
  metric: MetricSink = (metric) => { this.context.getStore()?.setMetric(metric); };
  // express.json verify callback runs before the original buffer is discarded/transformed.
  body = (_req: unknown, _res: unknown, buffer: Buffer): void => { this.context.getStore()?.setBody(buffer); };
  middleware: RequestHandler = (req, res, next) => {
    const session = this.current;
    if (!session || req.method !== "POST" || !/^\/(openai|anthropic)\//.test(req.path)) { next(); return; }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (HEADER_NAMES.has(name) && value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const capture = new RequestCapture(session, this, req.method, req.path, diagnosticHeaders(headers));
    session.requests++; this.captures.add(capture); this.emit();
    res.once("finish", () => { void capture.finish(res.statusCode, false); });
    res.once("close", () => { void capture.finish(res.statusCode, !res.writableFinished); });
    this.context.run(capture, next);
  };
  wrapFetch(fetchFn: typeof fetch): typeof fetch {
    return ((input, init) => {
      const capture = this.context.getStore();
      return capture ? capture.fetch(fetchFn, input, init) : fetchFn(input, init);
    }) as typeof fetch;
  }
}
