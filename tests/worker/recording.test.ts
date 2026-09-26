import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { BatchWriter } from "../../src/worker/recording/batch-writer.js";
import { RequestRecorder } from "../../src/worker/recording/recorder.js";
import { createWorkerApp } from "../../src/worker/server.js";
import { Router } from "../../src/worker/router.js";
import { CopilotAdapter } from "../../src/providers/copilot/adapter.js";

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function root() { const p = await mkdtemp(join(tmpdir(), "record-test-")); roots.push(p); return join(p, "recordings"); }
async function settle(recorder: RequestRecorder) {
  await vi.waitFor(() => expect(recorder.status().inFlight).toBe(0));
}
async function directories(path: string) { return (await readdir(path, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => join(path, d.name)); }
function harness(recorder: RequestRecorder, fn: typeof fetch, endpoints = ["/responses"]) {
  const adapter = new CopilotAdapter({ get: async () => "secret-token" }, recorder.wrapFetch(fn), () => endpoints);
  return createWorkerApp(new Router([adapter], {}), () => {}, undefined, undefined, undefined, recorder);
}
const response = (text = "ok") => new Response(JSON.stringify({ id: "r1", model: "gpt-test", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { input_tokens: 5, output_tokens: 1 } }), { headers: { "content-type": "application/json" } });

describe("batch response writes", () => {
  it("debounces, flushes continuously by max wait, and preserves bytes on close", async () => {
    vi.useFakeTimers();
    const writes: Buffer[] = [];
    const write = vi.fn(async (_path, data) => { writes.push(Buffer.from(data)); }) as any;
    const writer = new BatchWriter("unused", () => {}, { debounceMs: 250, maxWaitMs: 1000 }, write);
    for (let i = 0; i < 9; i++) { await writer.append(Buffer.from(String(i))); await vi.advanceTimersByTimeAsync(100); }
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(write).toHaveBeenCalledTimes(1);
    await writer.append(Buffer.from("尾"));
    await writer.close();
    expect(Buffer.concat(writes).toString()).toBe("012345678尾");
    await vi.advanceTimersByTimeAsync(2000);
    expect(write).toHaveBeenCalledTimes(2);
  });
  it("flushes a small idle batch after the debounce interval", async () => {
    vi.useFakeTimers();
    const write = vi.fn(async () => {}) as any;
    const writer = new BatchWriter("unused", () => {}, {}, write);
    await writer.append(Buffer.from("a")); await vi.advanceTimersByTimeAsync(200);
    await writer.append(Buffer.from("b")); await vi.advanceTimersByTimeAsync(249);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][1].toString()).toBe("ab"); await writer.close();
  });
  it("flushes by size and waits for a slow append rather than queuing buffers", async () => {
    let release!: () => void;
    const write = vi.fn(() => new Promise<void>((r) => { release = r; })) as any;
    const writer = new BatchWriter("unused", () => {}, { maxBytes: 3 }, write);
    const first = writer.append(Buffer.from("abc"));
    let nextDone = false;
    const second = writer.append(Buffer.from("d")).then(() => { nextDone = true; });
    await Promise.resolve(); expect(nextDone).toBe(false); expect(write).toHaveBeenCalledTimes(1);
    release(); await first; await second;
    const close = writer.close(); await Promise.resolve(); release(); await close;
    expect(write).toHaveBeenCalledTimes(2);
  });
  it("reports storage failure once and keeps accepting proxy data without throwing", async () => {
    const error = vi.fn(); const write = vi.fn(async () => { throw new Error("disk full"); }) as any;
    const writer = new BatchWriter("unused", error, { maxBytes: 1 }, write);
    await writer.append(Buffer.from("a")); await writer.append(Buffer.from("b")); await writer.close();
    expect(error).toHaveBeenCalledTimes(1); expect(write).toHaveBeenCalledTimes(1);
  });
});

describe("manual request recorder", () => {
  it("does nothing while off; captures original JSON, actual outbound bytes, full response and safe headers", async () => {
    const path = await root(); const recorder = new RequestRecorder(path);
    let actual = "";
    const fn = vi.fn(async (_url, init) => { actual = init?.body as string; return response("你好"); }) as unknown as typeof fetch;
    const app = harness(recorder, fn);
    const body = '{ "model": "gpt-test", "messages": [{"role":"user","content":"你好"}], "max_tokens": 20 }';
    await request(app).post("/openai/chat/completions").set("Content-Type", "application/json").send(body).expect(200);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    const started = await recorder.start(); expect((await recorder.start()).directory).toBe(started.directory);
    await request(app).post("/openai/chat/completions").set("Content-Type", "application/json").set("Authorization", "Bearer client-secret").set("Cookie", "s=cookie-secret").send(body).expect(200);
    await settle(recorder);
    const [dir] = await directories(started.directory!);
    expect(await readFile(join(dir, "inbound.json"), "utf8")).toBe(body);
    const metadata = JSON.parse(await readFile(join(dir, "metadata.json"), "utf8"));
    expect(metadata.inboundBytes).toBe(Buffer.byteLength(body));
    expect(JSON.stringify(metadata)).not.toMatch(/client-secret|cookie-secret|authorization/i);
    const upstream = join(dir, "upstream-001");
    expect(await readFile(join(upstream, "request.json"), "utf8")).toBe(actual);
    expect(JSON.parse(actual)).toMatchObject({ max_output_tokens: 20, model: "gpt-test" });
    const outMeta = await readFile(join(upstream, "metadata.json"), "utf8");
    expect(outMeta).not.toContain("secret-token");
    expect(await readFile(join(upstream, "response.body"), "utf8")).toContain("你好");
    expect(JSON.parse(await readFile(join(dir, "result.json"), "utf8"))).toMatchObject({ complete: true, clientStatus: 200 });
    if (process.platform !== "win32") {
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(dir, "inbound.json"))).mode & 0o777).toBe(0o600);
    }
    await recorder.end();
    await request(app).post("/openai/chat/completions").send(JSON.parse(body)).expect(200);
    expect(await directories(started.directory!)).toHaveLength(1);
  });

  it("keeps a large request intact without a capture size cutoff", async () => {
    const recorder = new RequestRecorder(await root()); const session = await recorder.start();
    const text = "大".repeat(400_000);
    const app = harness(recorder, (async () => response()) as typeof fetch);
    await request(app).post("/openai/chat/completions").send({ model: "gpt-test", messages: [{ role: "user", content: text }] }).expect(200);
    await settle(recorder);
    const [dir] = await directories(session.directory!);
    expect(JSON.parse(await readFile(join(dir, "inbound.json"), "utf8")).messages[0].content).toBe(text);
    expect(JSON.parse(await readFile(join(dir, "upstream-001", "request.json"), "utf8")).input[0].content[0].text).toBe(text);
  });

  it.each([408, 429, 413])("retains complete %s error even though adapter formats a truncated message", async (status) => {
    const recorder = new RequestRecorder(await root()); const started = await recorder.start();
    const error = JSON.stringify({ error: { message: "Timed out reading request body. Try again, or use a smaller request size." + "x".repeat(2000), code: "user_request_timeout" } });
    const app = harness(recorder, (async () => new Response(error, { status, headers: { "content-type": "application/json", "retry-after": "10", "x-request-id": "upstream-id", "set-cookie": "secret" } })) as typeof fetch);
    await request(app).post("/openai/chat/completions").send({ model: "gpt-test", stream: true, messages: [] });
    await settle(recorder);
    const [dir] = await directories(started.directory!); const upstream = join(dir, "upstream-001");
    expect(await readFile(join(upstream, "response.body"), "utf8")).toBe(error);
    expect(JSON.parse(await readFile(join(upstream, "result.json"), "utf8"))).toMatchObject({ complete: true, status });
    const meta = await readFile(join(upstream, "response-metadata.json"), "utf8");
    expect(meta).toContain("retry-after"); expect(meta).toContain("upstream-id"); expect(meta).not.toContain("secret");
  });

  it("separates concurrent requests and endpoint fallback attempts", async () => {
    const recorder = new RequestRecorder(await root()); const started = await recorder.start();
    const fn = (async (url, init) => {
      if (String(url).endsWith("/chat/completions")) return new Response('{"error":"use the responses"}', { status: 400 });
      return response(JSON.parse(init?.body as string).input[0].content[0].text);
    }) as typeof fetch;
    const app = harness(recorder, fn, ["/chat/completions", "/responses"]);
    await Promise.all(["alpha", "beta"].map((text) => request(app).post("/openai/chat/completions").send({ model: "gpt-test", messages: [{ role: "user", content: text }] }).expect(200)));
    await settle(recorder);
    const dirs = await directories(started.directory!); expect(dirs).toHaveLength(2);
    for (const dir of dirs) {
      const inbound = JSON.parse(await readFile(join(dir, "inbound.json"), "utf8"));
      expect(await directories(dir)).toHaveLength(2);
      expect(await readFile(join(dir, "upstream-002", "response.body"), "utf8")).toContain(inbound.messages[0].content);
    }
  });

  it("records a fetch exception and still returns the normal proxy failure", async () => {
    const recorder = new RequestRecorder(await root()); const started = await recorder.start();
    const app = harness(recorder, (async () => { throw new Error("fetch failed"); }) as typeof fetch);
    await request(app).post("/openai/responses").send({ model: "gpt-test", input: "hello" }).expect(502);
    await settle(recorder);
    const [dir] = await directories(started.directory!);
    expect(JSON.parse(await readFile(join(dir, "upstream-001", "result.json"), "utf8"))).toMatchObject({ outcome: "fetch-error", error: "fetch failed" });
  });

  it("ends enrollment without cutting off an in-flight stream, even when another session starts", async () => {
    const recorder = new RequestRecorder(await root()); const firstSession = await recorder.start();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    let arrived!: () => void;
    const fetching = new Promise<void>((r) => { arrived = r; });
    const app = harness(recorder, (async () => {
      arrived();
      return new Response(new ReadableStream({ start(c) { source = c; } }), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch);
    const running = request(app).post("/openai/chat/completions").send({ model: "gpt-test", messages: [], stream: true }).then((r) => r);
    await fetching;
    const prefix = 'data: {"type":"response.output_text.delta","delta":"first"}\n\n';
    source.enqueue(Buffer.from(prefix));
    const stopped = await recorder.end();
    expect(stopped.active).toBe(false); expect(stopped.inFlight).toBe(1);
    const nextSession = await recorder.start(); expect(nextSession.directory).not.toBe(firstSession.directory);
    const suffix = 'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n';
    source.enqueue(Buffer.from(suffix)); source.close();
    expect((await running).status).toBe(200); await settle(recorder);
    const [dir] = await directories(firstSession.directory!);
    expect(await readFile(join(dir, "upstream-001", "response.sse"), "utf8")).toBe(prefix + suffix);
    expect(await directories(nextSession.directory!)).toHaveLength(0);
    expect(JSON.parse(await readFile(join(dir, "result.json"), "utf8"))).toMatchObject({ complete: true });
    await recorder.end();
  });

  it("does not partially enroll a request that began before start", async () => {
    const recorder = new RequestRecorder(await root());
    let release!: () => void; let arrived!: () => void;
    const pending = new Promise<void>((r) => { release = r; });
    const seen = new Promise<void>((r) => { arrived = r; });
    const app = harness(recorder, (async () => { arrived(); await pending; return response(); }) as typeof fetch);
    const running = request(app).post("/openai/responses").send({ model: "gpt-test", input: "hi" }).then((r) => r);
    await seen; const session = await recorder.start(); release();
    await running;
    expect(await directories(session.directory!)).toHaveLength(0);
  });

  it("captures Anthropic and Responses ingress as well as malformed JSON", async () => {
    const recorder = new RequestRecorder(await root()); const session = await recorder.start();
    const app = harness(recorder, (async () => response()) as typeof fetch);
    await request(app).post("/anthropic/v1/messages").send({ model: "gpt-test", max_tokens: 20, messages: [{ role: "user", content: "anthropic" }] }).expect(200);
    await request(app).post("/openai/responses").send({ model: "gpt-test", input: "responses" }).expect(200);
    await request(app).post("/openai/responses").set("Content-Type", "application/json").send("{bad").expect(400);
    await settle(recorder);
    const dirs = await directories(session.directory!); expect(dirs).toHaveLength(3);
    expect((await Promise.all(dirs.map((d) => readFile(join(d, "inbound.json"), "utf8"))))).toContain("{bad");
  });

  it("marks stream errors incomplete and preserves bytes received before the error", async () => {
    const recorder = new RequestRecorder(await root()); const session = await recorder.start();
    let count = 0;
    const prefix = 'data: {"type":"response.output_text.delta","delta":"hi"}\n\n';
    const app = harness(recorder, (async () => new Response(new ReadableStream({ pull(c) {
      if (!count++) c.enqueue(Buffer.from(prefix)); else c.error(new Error("broken upstream"));
    } }), { headers: { "content-type": "text/event-stream" } })) as typeof fetch);
    await request(app).post("/openai/chat/completions").send({ model: "gpt-test", messages: [], stream: true });
    await settle(recorder);
    const [dir] = await directories(session.directory!);
    expect(await readFile(join(dir, "upstream-001", "response.sse"), "utf8")).toBe(prefix);
    expect(JSON.parse(await readFile(join(dir, "upstream-001", "result.json"), "utf8"))).toMatchObject({ complete: false, outcome: "stream-error", error: "broken upstream" });
    expect(JSON.parse(await readFile(join(dir, "result.json"), "utf8"))).toMatchObject({ complete: false });
  });

  it("does not block proxy traffic when recording storage disappears", async () => {
    const warnings: unknown[] = [];
    const recorder = new RequestRecorder(await root(), (s) => { if (s.warning) warnings.push(s.warning); });
    const session = await recorder.start(); await rm(session.directory!, { recursive: true });
    const app = harness(recorder, (async () => response()) as typeof fetch);
    await request(app).post("/openai/responses").send({ model: "gpt-test", input: "hi" }).expect(200);
    await settle(recorder); expect(warnings.length).toBeGreaterThan(0); expect(recorder.status().warning).toContain("incomplete");
  });

  it("streams exact SSE bytes with batching, including a 200 error event", async () => {
    const recorder = new RequestRecorder(await root()); const started = await recorder.start();
    const data = 'data: {"type":"response.output_text.delta","delta":"你好"}\n\ndata: {"type":"error","message":"upstream stream failure"}\n\n';
    const bytes = Buffer.from(data);
    const app = harness(recorder, (async () => new Response(new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } }), { headers: { "content-type": "text/event-stream" } })) as typeof fetch);
    await request(app).post("/openai/chat/completions").send({ model: "gpt-test", messages: [], stream: true }).expect(200);
    await settle(recorder);
    const [dir] = await directories(started.directory!);
    expect(await readFile(join(dir, "upstream-001", "response.sse"), "utf8")).toBe(data);
  });
});
