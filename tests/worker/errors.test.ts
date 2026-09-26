import { describe, it, expect } from "vitest";
import { classifyError, errorHint } from "../../src/worker/errors.js";
import { GitHubReauthenticationRequiredError } from "../../src/cli/auth.js";
import { CopilotEndpointContractError } from "../../src/providers/copilot/token.js";
import request from "supertest";
import { createWorkerApp } from "../../src/worker/server.js";
import { Router } from "../../src/worker/router.js";
import type { CanonicalChunk } from "../../src/core/canonical.js";
import type { ProviderAdapter } from "../../src/providers/types.js";

describe("errorHint", () => {
  it("explains a context-window overflow", () => {
    expect(errorHint("copilot completion failed: 400 — prompt is too long: 250000 tokens")).toMatch(/context window/i);
    expect(errorHint("context_length_exceeded")).toMatch(/context window/i);
  });
  it("explains an unsupported model", () => {
    expect(errorHint("the model `foo` does not support tools / is not supported")).toMatch(/\/model/);
  });
  it("returns empty for unknown errors", () => {
    expect(errorHint("some random failure")).toBe("");
  });
  it("matches several context-overflow phrasings", () => {
    expect(errorHint("maximum context length is 8192")).toMatch(/context window/i);
    expect(errorHint("too many tokens in the prompt")).toMatch(/context window/i);
  });
  it("matches several unsupported-model phrasings", () => {
    expect(errorHint("model_not_found: nope")).toMatch(/\/model/);
    expect(errorHint("invalid model specified")).toMatch(/\/model/);
  });
  it("detects an expired/revoked login and points to /login", () => {
    expect(errorHint("GitHub login expired — restart copilot-reverse to re-authenticate")).toMatch(/\/login/);
    expect(errorHint("authentication_error: token expired")).toMatch(/\/login/);
    expect(errorHint("copilot token exchange failed: 401")).toMatch(/\/login/);
    expect(errorHint("403 Forbidden")).toMatch(/\/login/);
  });
  it("detects an oversized request body (413) and suggests compacting / fewer screenshots", () => {
    expect(errorHint("copilot completion failed: 413 — Request Entity Too Large")).toMatch(/too large/i);
    expect(errorHint("copilot completion failed: 413 — Request Entity Too Large")).toMatch(/\/compact/);
    expect(errorHint("payload too large")).toMatch(/too large/i);
  });
});


describe("classifyError", () => {
  it("classifies GHE.com credential retrieval failures as terminal authentication errors", () => {
    expect(classifyError(new GitHubReauthenticationRequiredError("acme.ghe.com"))).toEqual({ status: 401, terminal: true });
  });

  it("classifies endpoint contract failures as terminal non-auth client errors", () => {
    expect(classifyError(new CopilotEndpointContractError({ type: "ghecom", host: "acme.ghe.com" }))).toEqual({ status: 422, terminal: true });
  });
});


describe("endpoint contract wire errors", () => {
  const failing: ProviderAdapter = {
    name: "copilot",
    complete: async () => { throw new CopilotEndpointContractError({ type: "ghecom", host: "acme.ghe.com" }); },
    async *stream(): AsyncIterable<CanonicalChunk> {
      yield { kind: "text", delta: "partial", done: false };
      throw new CopilotEndpointContractError({ type: "ghecom", host: "acme.ghe.com" });
    },
  };
  const app = () => createWorkerApp(new Router([failing], { "*": "gpt-5" }), () => {});

  it("returns HTTP 422 and a non-auth invalid_request_error for Anthropic JSON", async () => {
    const res = await request(app()).post("/anthropic/v1/messages").send({ model: "x", max_tokens: 8, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(422);
    expect(res.body.error.type).toBe("invalid_request_error");
  });

  it("emits terminal invalid_request_error for Anthropic SSE", async () => {
    const res = await request(app()).post("/anthropic/v1/messages").send({ model: "x", max_tokens: 8, stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(res.text).toContain('"type":"invalid_request_error"');
  });

  it("emits terminal invalid_request_error for OpenAI chat SSE", async () => {
    const res = await request(app()).post("/openai/chat/completions").send({ model: "x", stream: true, messages: [{ role: "user", content: "hi" }] });
    const frame = res.text.split("\n\n").filter((part) => part.startsWith("data: ")).map((part) => JSON.parse(part.slice(6))).at(-1);
    expect(frame.error.type).toBe("invalid_request_error");
  });

  it("emits terminal invalid_request_error for OpenAI Responses SSE", async () => {
    const res = await request(app()).post("/openai/responses").send({ model: "x", stream: true, input: "hi" });
    const event = res.text.split("\n\n").filter(Boolean).map((part) => JSON.parse(part.replace(/^data: /, ""))).at(-1);
    expect(event).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
  });
});
