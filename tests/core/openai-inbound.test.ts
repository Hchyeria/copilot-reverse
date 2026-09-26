import { describe, it, expect } from "vitest";
import {
  openaiRequestToCanonical,
  canonicalToOpenAIResponse,
  canonicalChunkToOpenAISSE,
} from "../../src/core/openai-inbound.js";
import type { CanonicalResponse } from "../../src/core/canonical.js";

describe("openai inbound", () => {
  it("normalizes request incl tools", () => {
    const c = openaiRequestToCanonical({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
      stream: true,
      tools: [{ type: "function", function: { name: "now", description: "time", parameters: { type: "object", properties: {} } } }],
    });
    expect(c.model).toBe("gpt-4o");
    expect(c.stream).toBe(true);
    expect(c.tools?.[0].name).toBe("now");
    expect(c.messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "hi" }] });
  });

  it("builds OpenAI response from canonical text", () => {
    const r: CanonicalResponse = {
      id: "r1", model: "gpt-4o",
      content: [{ type: "text", text: "hello" }],
      finishReason: "stop",
      usage: { promptTokens: 3, completionTokens: 1 },
    };
    const out = canonicalToOpenAIResponse(r);
    expect(out.choices[0].message.content).toBe("hello");
    expect(out.usage.total_tokens).toBe(4);
  });

  it("formats a text SSE chunk and closes with a finish_reason chunk before [DONE]", () => {
    expect(canonicalChunkToOpenAISSE({ kind: "text", delta: "he", done: false }, "id", "m")).toContain('"content":"he"');
    // A stream that ends WITHOUT a finish_reason chunk reads as truncated to a strict client (pi
    // rejects it outright: "Stream ended without finish_reason"), so the terminal choice is mandatory.
    const out = canonicalChunkToOpenAISSE({ kind: "done", done: true }, "id", "m");
    expect(out).toContain('"finish_reason":"stop"');
    expect(out).toContain('"delta":{}');
    expect(out.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("maps a tool-call finish to OpenAI's tool_calls, like the non-streaming path", () => {
    const out = canonicalChunkToOpenAISSE({ kind: "done", done: true, finishReason: "tool_use" }, "id", "m");
    expect(out).toContain('"finish_reason":"tool_calls"');
  });

  it("emits finish_reason, then usage, then [DONE] when the done chunk carries usage", () => {
    const out = canonicalChunkToOpenAISSE({ kind: "done", done: true, usage: { promptTokens: 12, completionTokens: 3 } }, "id", "m");
    expect(out).toContain('"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}');
    expect(out.trimEnd().endsWith("data: [DONE]")).toBe(true);
    // Order matters: the finish chunk precedes the usage-only chunk, as in a real OpenAI stream.
    expect(out.indexOf('"finish_reason":"stop"')).toBeLessThan(out.indexOf('"usage"'));
  });

  it("normalizes array-of-text-block content (split system prompts) into a single text block", () => {
    const c = openaiRequestToCanonical({
      model: "gpt-4o",
      messages: [{ role: "system", content: [{ type: "text", text: "You are " }, { type: "text", text: "helpful" }] } as any],
    });
    expect(c.messages[0]).toEqual({ role: "system", content: [{ type: "text", text: "You are helpful" }] });
  });

  it("extracts image_url parts as canonical image blocks (vision)", () => {
    const c = openaiRequestToCanonical({
      model: "gpt-4o",
      messages: [{ role: "user", content: [
        { type: "text", text: "describe" },
        { type: "image_url", image_url: { url: "data:image/png;base64,ZZZ" } },
      ] } as any],
    });
    expect(c.messages[0].content).toEqual([
      { type: "text", text: "describe" },
      { type: "image", dataUrl: "data:image/png;base64,ZZZ" },
    ]);
  });

  it("carries reasoning_effort through to canonical reasoning", () => {
    const c = openaiRequestToCanonical({
      model: "gpt-5.5", messages: [{ role: "user", content: "think hard" }],
      reasoning_effort: "high",
    } as any);
    expect(c.reasoning).toEqual({ effort: "high" });
  });

  it("leaves reasoning undefined when no reasoning_effort is sent", () => {
    const c = openaiRequestToCanonical({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    expect(c.reasoning).toBeUndefined();
  });
});
