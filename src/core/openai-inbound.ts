import type { CanonicalRequest, CanonicalResponse, CanonicalChunk, CanonicalMessage, ContentBlock } from "./canonical.js";
import { joinText } from "./canonical.js";
import { reasoningFromEffort } from "./reasoning.js";

interface OpenAIImageUrl { url?: string }
interface OpenAIContentPart { type?: string; text?: string; image_url?: OpenAIImageUrl }
interface OpenAIMsg { role: string; content?: string | null | OpenAIContentPart[]; tool_calls?: any[]; tool_call_id?: string }

// OpenAI content may be a plain string or an array of text parts (clients that split long
// system/user prompts do this). Collapse text parts to a single string.
function textOf(content: OpenAIMsg["content"]): string {
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("");
  return content ?? "";
}
// Extract any image_url parts as canonical image blocks (vision support).
function imagesOf(content: OpenAIMsg["content"]): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((p): p is OpenAIContentPart => typeof p !== "string" && p?.type === "image_url" && !!p.image_url?.url)
    .map((p) => ({ type: "image", dataUrl: p.image_url!.url! }));
}
interface OpenAITool { type: "function"; function: { name: string; description?: string; parameters: Record<string, unknown> } }
interface OpenAIChatRequest {
  model: string; messages: OpenAIMsg[]; stream?: boolean;
  temperature?: number; max_tokens?: number; tools?: OpenAITool[];
  // OpenAI reasoning models (and Copilot's gpt-5.x / Claude on /chat) take a top-level effort enum.
  reasoning_effort?: string;
}

function msgToCanonical(m: OpenAIMsg): CanonicalMessage {
  const role = (["system", "user", "assistant", "tool"].includes(m.role) ? m.role : "user") as CanonicalMessage["role"];
  const content: ContentBlock[] = [];
  if (m.role === "tool" && m.tool_call_id) {
    // A tool message may carry image parts (a tool that returned a screenshot). Preserve them as
    // images[] so resize + token counting see them, instead of dropping them via textOf.
    const imgs = imagesOf(m.content).map((b) => (b as Extract<ContentBlock, { type: "image" }>).dataUrl);
    content.push({ type: "tool_result", toolUseId: m.tool_call_id, content: textOf(m.content), ...(imgs.length ? { images: imgs } : {}) });
  } else {
    const text = textOf(m.content);
    if (text) content.push({ type: "text", text });
    content.push(...imagesOf(m.content));
    for (const tc of m.tool_calls ?? []) {
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: safeJson(tc.function.arguments) });
    }
  }
  return { role, content };
}
function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return {}; } }

export function openaiRequestToCanonical(req: OpenAIChatRequest): CanonicalRequest {
  return {
    model: req.model,
    stream: Boolean(req.stream),
    temperature: req.temperature,
    maxTokens: req.max_tokens,
    tools: req.tools?.map((t) => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters })),
    messages: req.messages.map(msgToCanonical),
    reasoning: reasoningFromEffort(req.reasoning_effort),
  };
}

export function canonicalToOpenAIResponse(r: CanonicalResponse) {
  const toolCalls = r.content
    .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
    .map((b, i) => ({ index: i, id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } }));
  return {
    id: r.id, object: "chat.completion" as const, created: 0, model: r.model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: joinText(r.content) || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      finish_reason: r.finishReason === "tool_use" ? "tool_calls" : r.finishReason,
    }],
    usage: { prompt_tokens: r.usage.promptTokens, completion_tokens: r.usage.completionTokens, total_tokens: r.usage.promptTokens + r.usage.completionTokens },
  };
}

export function canonicalChunkToOpenAISSE(chunk: CanonicalChunk, id: string, model: string): string {
  if (chunk.done) {
    // A real OpenAI stream terminates with a CHOICE chunk carrying finish_reason, and only then the
    // optional usage-only chunk (stream_options.include_usage shape) and [DONE]. We used to skip
    // straight to usage/[DONE], never emitting finish_reason at all: a client that treats its absence
    // as a truncated response (pi: "Stream ended without finish_reason") rejects every reply. Codex
    // never tripped on it because it drives /responses, not /chat/completions.
    // "tool_use" is canonical; OpenAI spells it "tool_calls" — same mapping the non-streaming path uses.
    const finish = chunk.finishReason === "tool_use" ? "tool_calls" : (chunk.finishReason ?? "stop");
    const finishChunk = { id, object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta: {}, finish_reason: finish }] };
    let out = `data: ${JSON.stringify(finishChunk)}\n\n`;
    if (chunk.usage) {
      const u = { prompt_tokens: chunk.usage.promptTokens, completion_tokens: chunk.usage.completionTokens, total_tokens: chunk.usage.promptTokens + chunk.usage.completionTokens };
      const usageChunk = { id, object: "chat.completion.chunk", created: 0, model, choices: [], usage: u };
      out += `data: ${JSON.stringify(usageChunk)}\n\n`;
    }
    return out + "data: [DONE]\n\n";
  }
  let delta: Record<string, unknown> = {};
  if (chunk.kind === "text") delta = { content: chunk.delta };
  else if (chunk.kind === "tool_use_start") delta = { tool_calls: [{ index: chunk.index, id: chunk.id, type: "function", function: { name: chunk.name, arguments: "" } }] };
  else if (chunk.kind === "tool_use_delta") delta = { tool_calls: [{ index: chunk.index, function: { arguments: chunk.argsDelta } }] };
  const payload = { id, object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: null }] };
  return `data: ${JSON.stringify(payload)}\n\n`;
}
