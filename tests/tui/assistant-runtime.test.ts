import { describe, it, expect, vi, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createWorkerApp } from "../../src/worker/server.js";
import { Router } from "../../src/worker/router.js";
import type { ProviderAdapter } from "../../src/providers/types.js";
import { runAssistantTurn, type AssistantConfig, type QueryFn } from "../../src/tui/assistant/runtime.js";
import { makeOnChat } from "../../src/tui/assistant/on-chat.js";

// A fake provider whose stream the worker turns into Anthropic SSE.
const provider: ProviderAdapter = {
  name: "copilot",
  complete: async (req) => ({ id: "c1", model: req.model, content: [{ type: "text", text: "hello from copilot" }], finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } }),
  async *stream() {
    yield { kind: "text", delta: "hello ", done: false } as const;
    yield { kind: "text", delta: "from copilot", done: false } as const;
    yield { kind: "done", done: true, finishReason: "stop" } as const;
  },
};

function startWorker(): Promise<{ url: string; server: Server }> {
  const app = createWorkerApp(new Router([provider], { "*": "gpt-4o" }), () => {});
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}

// Parse Anthropic SSE text into the concatenated assistant text.
function textFromAnthropicSSE(sse: string): string {
  let out = "";
  for (const block of sse.split("\n\n")) {
    const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
    if (!dataLine) continue;
    try {
      const evt = JSON.parse(dataLine.slice(6));
      if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") out += evt.delta.text;
    } catch { /* skip non-JSON frames */ }
  }
  return out;
}

let openServer: Server | undefined;
afterEach(() => { openServer?.close(); openServer = undefined; });

describe("assistant runtime (stubbed SDK transport, real /v1/messages)", () => {
  it("on-chat -> runtime -> worker /v1/messages -> printed text, no live Copilot", async () => {
    const { url, server } = await startWorker();
    openServer = server;

    // Fake query() stands in for the bundled Claude Code CLI: it issues the real
    // streaming Anthropic request to copilot-reverse's own endpoint (cfg.workerBaseUrl),
    // then yields a synthetic SDK assistant message carrying the streamed text.
    const fakeQuery = ((params: { options?: { model?: string } }) => {
      const baseUrl = process.env.ANTHROPIC_BASE_URL!;
      const model = params.options?.model ?? "claude-opus-4-8";
      async function* gen() {
        const res = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] }),
        });
        const sse = await res.text();
        const text = textFromAnthropicSSE(sse);
        yield {
          type: "assistant",
          message: { id: "m1", type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
          parent_tool_use_id: null,
          uuid: "u1",
          session_id: "s1",
        };
      }
      return gen();
    }) as unknown as QueryFn;

    const cfg: AssistantConfig = { client: {} as any, workerBaseUrl: `${url}/anthropic`, apiKey: "copilot-reverse-local", model: "claude-opus-4-8" };
    const printed: string[] = [];
    const onChat = makeOnChat(cfg, (c, p, print) => runAssistantTurn(c, p, print, fakeQuery));
    await onChat("how is the proxy?", (l) => printed.push(l));

    expect(printed).toContain("hello from copilot");
  });

  it("surfaces a red error line if the transport throws", async () => {
    const throwingQuery = (() => { throw new Error("transport down"); }) as unknown as QueryFn;
    const cfg: AssistantConfig = { client: {} as any, workerBaseUrl: "http://127.0.0.1:1", apiKey: "k", model: "m" };
    const printed: string[] = [];
    const onChat = makeOnChat(cfg, (c, p, print) => runAssistantTurn(c, p, print, throwingQuery));
    await onChat("hi", (l) => printed.push(l));
    expect(printed.join("\n")).toMatch(/assistant error: transport down/);
  });

  it("sets Claude Code auto-compaction env from maxInputTokens so context compacts before overflow", async () => {
    const seen: Record<string, string | undefined> = {};
    const capturingQuery = (() => {
      seen.window = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
      seen.pct = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
      seen.attribution = process.env.CLAUDE_CODE_ATTRIBUTION_HEADER;
      seen.nonessential = process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
      async function* gen(): AsyncGenerator<never> { /* no messages */ }
      return gen();
    }) as unknown as QueryFn;
    const cfg: AssistantConfig = { client: {} as any, workerBaseUrl: "http://127.0.0.1:1", apiKey: "k", model: "gpt-4o", maxInputTokens: 64000 };
    await runAssistantTurn(cfg, "hi", () => {}, capturingQuery);
    expect(seen.window).toBe("64000");
    expect(seen.pct).toBe("80");
    expect(seen.attribution).toBe("0");
    expect(seen.nonessential).toBe("1");
  });

  it("prefers the per-model context window from modelLimits over the default", async () => {
    let window: string | undefined;
    const capturingQuery = (() => {
      window = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
      async function* gen(): AsyncGenerator<never> { /* no messages */ }
      return gen();
    }) as unknown as QueryFn;
    const cfg: AssistantConfig = { client: {} as any, workerBaseUrl: "http://127.0.0.1:1", apiKey: "k", model: "gpt-4o", maxInputTokens: 110000, modelLimits: { "gpt-4o": 64000 } };
    await runAssistantTurn(cfg, "hi", () => {}, capturingQuery);
    expect(window).toBe("64000"); // real per-model limit wins over the conservative default
  });

  it("switches GPT context budgets between turns without restarting the assistant", async () => {
    const windows: Array<string | undefined> = [];
    const models: Array<string | undefined> = [];
    const capturingQuery = ((params: { options?: { model?: string } }) => {
      windows.push(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
      models.push(params.options?.model);
      async function* gen(): AsyncGenerator<never> { /* no messages */ }
      return gen();
    }) as unknown as QueryFn;
    const cfg: AssistantConfig = { client: {} as AssistantConfig["client"], workerBaseUrl: "http://127.0.0.1:1", apiKey: "k", model: "gpt-6-astra", modelLimits: { "gpt-6-astra": 272000, "gpt-6-astra:long_context": 1000000 } };
    for (const model of ["gpt-6-astra", "gpt-6-astra:long_context", "gpt-6-astra"]) {
      await runAssistantTurn({ ...cfg, model }, "hi", () => {}, capturingQuery);
    }
    expect(windows).toEqual(["272000", "1000000", "272000"]);
    expect(models).toEqual(["gpt-6-astra", "gpt-6-astra:long_context", "gpt-6-astra"]);
  });

  it("passes the AbortController into the query so the turn is interruptible", async () => {
    let seen: AbortController | undefined;
    const capturingQuery = ((params: { options?: { abortController?: AbortController } }) => {
      seen = params.options?.abortController;
      async function* gen(): AsyncGenerator<never> { /* no messages */ }
      return gen();
    }) as unknown as QueryFn;
    const cfg: AssistantConfig = { client: {} as any, workerBaseUrl: "http://127.0.0.1:1", apiKey: "k", model: "m" };
    const ctrl = new AbortController();
    await runAssistantTurn(cfg, "hi", () => {}, capturingQuery, ctrl);
    expect(seen).toBe(ctrl);
  });

  it("surfaces an error line when the SDK ends with a result error instead of swallowing it", async () => {
    const errResultQuery = (() => {
      async function* gen(): AsyncGenerator<any> {
        yield { type: "result", subtype: "error_during_execution", duration_ms: 1, duration_api_ms: 1, is_error: true, num_turns: 1, total_cost_usd: 0, usage: {}, permission_denials: [], uuid: "u", session_id: "s" };
      }
      return gen();
    }) as unknown as QueryFn;
    const cfg: AssistantConfig = { client: {} as any, workerBaseUrl: "http://127.0.0.1:1", apiKey: "k", model: "m" };
    const printed: string[] = [];
    await runAssistantTurn(cfg, "hi", (l) => printed.push(l), errResultQuery);
    expect(printed.join("\n")).toMatch(/error_during_execution/);
  });

  it("streams partial text deltas and does not duplicate the final assistant message", async () => {
    const streamingQuery = (() => {
      const evt = (text: string) => ({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, parent_tool_use_id: null, uuid: "u", session_id: "s" });
      async function* gen(): AsyncGenerator<any> {
        yield evt("Hel");
        yield evt("lo");
        yield { type: "assistant", message: { id: "m1", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "Hello" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }, parent_tool_use_id: null, uuid: "u3", session_id: "s" };
      }
      return gen();
    }) as unknown as QueryFn;
    const cfg: AssistantConfig = { client: {} as any, workerBaseUrl: "http://127.0.0.1:1", apiKey: "k", model: "m" };
    const printed: string[] = [];
    await runAssistantTurn(cfg, "hi", (l) => printed.push(l), streamingQuery);
    // deltas are streamed incrementally ("Hel", "lo"); the final full assistant block is
    // NOT re-printed afterwards (otherwise the user sees the answer twice).
    expect(printed).toEqual(["Hel", "lo"]);
  });
});
