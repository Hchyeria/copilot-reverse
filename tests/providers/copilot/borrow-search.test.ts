import { describe, it, expect, vi } from "vitest";
import { borrowSearch, extractCitations, extractText, formatBorrowSources } from "../../../src/providers/copilot/borrow-search.js";

const tokenStore = { get: async () => "cop-tok" };

// A realistic Copilot /responses web_search result: a web_search_call item, a reasoning item, and a
// final message whose output_text carries url_citation annotations.
const searchResult = {
  id: "resp_b1", model: "gpt-5-mini", status: "completed",
  output: [
    { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "rust 2024 edition" } },
    { type: "reasoning", id: "rs_1", summary: [] },
    {
      type: "message", id: "msg_1", role: "assistant",
      content: [{
        type: "output_text", text: "The Rust 2024 edition shipped in Rust 1.85.",
        annotations: [
          { type: "url_citation", url: "https://blog.rust-lang.org/2025/02/20/rust-1.85.0", title: "Announcing Rust 1.85.0", start_index: 0, end_index: 10 },
          { type: "url_citation", url: "https://doc.rust-lang.org/edition-guide/", title: "Edition Guide", start_index: 11, end_index: 20 },
          { type: "url_citation", url: "https://blog.rust-lang.org/2025/02/20/rust-1.85.0", title: "Announcing Rust 1.85.0 (dup)" },
        ],
      }],
    },
  ],
  usage: { input_tokens: 50, output_tokens: 30 },
};
const okResponse = () => new Response(JSON.stringify(searchResult), { status: 200, headers: { "content-type": "application/json" } });

describe("extractCitations", () => {
  it("maps url_citation annotations to {title,url}, de-duplicated by url", () => {
    const sources = extractCitations(searchResult.output);
    expect(sources).toEqual([
      { title: "Announcing Rust 1.85.0", url: "https://blog.rust-lang.org/2025/02/20/rust-1.85.0" },
      { title: "Edition Guide", url: "https://doc.rust-lang.org/edition-guide/" },
    ]);
  });
  it("falls back to the url as title when none is given", () => {
    const sources = extractCitations([{ type: "message", content: [{ type: "output_text", annotations: [{ type: "url_citation", url: "https://x" }] }] }]);
    expect(sources).toEqual([{ title: "https://x", url: "https://x" }]);
  });
  it("ignores non-citation annotations and non-message items", () => {
    expect(extractCitations([{ type: "web_search_call", id: "ws" }, { type: "message", content: [{ type: "output_text", annotations: [{ type: "file_citation", file_id: "f" }] }] }])).toEqual([]);
  });
});

describe("extractText", () => {
  it("concatenates output_text across message items", () => {
    expect(extractText(searchResult.output)).toBe("The Rust 2024 edition shipped in Rust 1.85.");
  });
});

describe("borrowSearch", () => {
  it("POSTs gpt-5-mini + web_search tool to the responses URL with copilot headers, returns sources+text", async () => {
    let url = ""; let init: RequestInit | undefined;
    const f = vi.fn(async (u: string, i: RequestInit) => { url = u; init = i; return okResponse(); });
    const out = await borrowSearch(tokenStore, "rust 2024 edition", f as unknown as typeof fetch);
    expect(url).toBe("https://api.githubcopilot.com/responses");
    const body = JSON.parse(init!.body as string);
    expect(body.model).toBe("gpt-5-mini");
    expect(body.input).toBe("rust 2024 edition");
    expect(body.tools).toEqual([{ type: "web_search" }]);
    expect(body.reasoning).toEqual({ effort: "low" }); // low effort = ~5-6x faster, citations intact
    expect(body.stream).toBe(false);
    const h = init!.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer cop-tok");
    expect(h["copilot-integration-id"]).toBe("vscode-chat");
    expect(h["openai-intent"]).toBeTruthy();
    expect(out).toEqual({ ok: true, sources: extractCitations(searchResult.output), text: "The Rust 2024 edition shipped in Rust 1.85." });
  });


  it("uses the session inference origin for borrowed search", async () => {
    const source = {
      get: async () => "legacy-token",
      getSession: async () => ({ token: "enterprise-token", expiresAtMs: 9_999_999_999_000, inferenceOrigin: "https://copilot.acme.ghe.com" }),
    };
    const f = vi.fn(async () => okResponse());

    await borrowSearch(source, "query", f as unknown as typeof fetch);

    expect(f.mock.calls[0][0]).toBe("https://copilot.acme.ghe.com/responses");
    expect((f.mock.calls[0][1] as RequestInit).headers).toMatchObject({ authorization: "Bearer enterprise-token" });
  });

  it("returns ok with empty sources when nothing was cited", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "no citations" }] }] }), { status: 200 }));
    const out = await borrowSearch(tokenStore, "q", f as unknown as typeof fetch);
    expect(out).toEqual({ ok: true, sources: [], text: "no citations" });
  });


  it("keeps structured diagnostics while redacting a multi-line bearer token sentinel", async () => {
    const token = "enterprise-token-sentinel";
    const source = { get: async () => token };
    const body = JSON.stringify({ error: { code: "search_failed", message: `first ${token}
second ${token}` } });
    const f = vi.fn(async () => new Response(body, { status: 400 }));
    const out = await borrowSearch(source, "query", f as unknown as typeof fetch);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toContain("search_failed: first [REDACTED] second [REDACTED]");
      expect(out.error).not.toContain(token);
      expect(out.error).not.toContain("\n");
    }
  });

  it("does not include the bearer token or raw upstream body in borrow errors", async () => {
    const source = {
      get: async () => "legacy-token",
      getSession: async () => ({ token: "enterprise-secret", expiresAtMs: 9_999_999_999_000, inferenceOrigin: "https://copilot.acme.ghe.com" }),
    };
    const f = vi.fn(async () => new Response("raw-upstream-secret-body", { status: 500 }));

    const out = await borrowSearch(source, "query", f as unknown as typeof fetch);

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toMatch(/borrow search failed: 500/);
      expect(out.error).not.toContain("enterprise-secret");
      expect(out.error).not.toContain("raw-upstream-secret-body");
    }
  });

  it("returns an error string (not a throw) on a non-ok response", async () => {
    const f = vi.fn(async () => new Response("nope", { status: 400 }));
    const out = await borrowSearch(tokenStore, "q", f as unknown as typeof fetch);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/400/);
  });

  it("returns an error when the token cannot be obtained", async () => {
    const badStore = { get: async () => { throw new Error("login expired"); } };
    const out = await borrowSearch(badStore, "q", vi.fn() as unknown as typeof fetch);
    expect(out.ok).toBe(false);
  });

  it("times out instead of hanging when the upstream stalls", async () => {
    // fetch that honors the abort signal but otherwise never resolves (the gpt-5-mini "high demand" hang).
    const hangingFetch = (_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
      init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
    const out = await borrowSearch(tokenStore, "q", hangingFetch as unknown as typeof fetch, 20);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/timed out/i);
  });

  it("rejects an empty query without calling fetch", async () => {
    const f = vi.fn();
    const out = await borrowSearch(tokenStore, "  ", f as unknown as typeof fetch);
    expect(out.ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("formatBorrowSources", () => {
  it("renders a numbered title+url list", () => {
    const text = formatBorrowSources([{ title: "A", url: "https://a" }, { title: "B", url: "https://b" }]);
    expect(text).toContain("[1] A");
    expect(text).toContain("https://a");
    expect(text).toContain("[2] B");
  });
  it("says no results on an empty list", () => {
    expect(formatBorrowSources([])).toMatch(/no results/i);
  });
});
