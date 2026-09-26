import { copilotUrl, readCopilotSession, type CopilotSessionSource } from "./session.js";
import { upstreamErrorDetail } from "./error-detail.js";

// "Borrow" web search backend. Copilot's native web_search hosted tool works only for gpt-5-class
// models, NOT Claude. So for Claude Code's gateway-run web_search/web_fetch, we run a gpt-5-mini
// /responses call WITH the native web_search tool internally, extract the url_citation sources, and
// feed those back to Claude as the tool_result. Claude never sees gpt-5 — it just gets grounded
// sources using only the Copilot token (no WebIQ key needed). This is the DEFAULT Claude backend.

export interface BorrowSource { title: string; url: string }
export type BorrowOutcome = { ok: true; sources: BorrowSource[]; text: string } | { ok: false; error: string };

// Same identity headers as the chat adapter, plus openai-intent (the /responses host expects it).
function headers(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`, "content-type": "application/json",
    "editor-version": "vscode/1.95.0", "copilot-integration-id": "vscode-chat", "openai-intent": "conversation-edits",
  };
}

// Pull {title,url} from every url_citation annotation across message output_text parts, de-duped by url.
export function extractCitations(output: any[]): BorrowSource[] {
  const seen = new Set<string>();
  const sources: BorrowSource[] = [];
  for (const item of output ?? []) {
    if (item?.type !== "message") continue;
    for (const part of item.content ?? []) {
      for (const ann of part?.annotations ?? []) {
        if (ann?.type !== "url_citation" || !ann.url || seen.has(ann.url)) continue;
        seen.add(ann.url);
        sources.push({ title: ann.title || ann.url, url: ann.url });
      }
    }
  }
  return sources;
}

// gpt-5's own prose answer (concatenated output_text). We feed Claude the SOURCES, not this — but it
// is handy for web_fetch ("open this URL and extract…") where the extracted content is the payload.
export function extractText(output: any[]): string {
  let text = "";
  for (const item of output ?? []) {
    if (item?.type !== "message") continue;
    for (const part of item.content ?? []) if (part?.type === "output_text" && part.text) text += part.text;
  }
  return text;
}

// Run one internal gpt-5-mini web_search. `input` is the full instruction (a query for web_search, or
// "Open {url} and extract its content" for web_fetch). Never throws — failures become an error string
// so the gateway tool loop can degrade gracefully. Bounded by a timeout so a congested upstream (gpt-5-
// mini is prone to "high demand" stalls) fails fast instead of hanging the whole turn for minutes.
const DEFAULT_TIMEOUT_MS = 30_000;
export async function borrowSearch(tokenStore: CopilotSessionSource, input: string, fetchFn: typeof fetch = fetch, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<BorrowOutcome> {
  if (!input.trim()) return { ok: false, error: "borrow search error: empty query" };
  let session;
  try { session = await readCopilotSession(tokenStore); }
  catch (e) { return { ok: false, error: `borrow search unavailable: ${e instanceof Error ? e.message : String(e)}` }; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(copilotUrl(session.inferenceOrigin, "/responses"), {
      method: "POST", headers: headers(session.token), signal: ctrl.signal,
      // reasoning.effort "low" is a ~5-6x speedup (≈30s→≈5s, and far less variance) vs the default:
      // we discard gpt-5's prose and keep only the citations, so the heavy reasoning it would otherwise
      // do before/after the search is wasted. ("minimal" is rejected by the API alongside web_search.)
      body: JSON.stringify({ model: "gpt-5-mini", input, stream: false, tools: [{ type: "web_search" }], reasoning: { effort: "low" } }),
    });
    if (!res.ok) {
      return { ok: false, error: `borrow search failed: ${res.status}${await upstreamErrorDetail(res, session.token)}` };
    }
    const data = (await res.json()) as { output?: any[] };
    return { ok: true, sources: extractCitations(data.output ?? []), text: extractText(data.output ?? []) };
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "AbortError";
    return { ok: false, error: timedOut ? `borrow search timed out after ${timeoutMs}ms` : "borrow search failed: could not reach Copilot" };
  } finally {
    clearTimeout(timer);
  }
}

// Render the borrowed sources as the tool_result text fed back to the model — numbered title+url so
// the model can cite them. (We deliberately hand back sources, not gpt-5's prose, for web_search.)
export function formatBorrowSources(sources: BorrowSource[]): string {
  if (!sources.length) return "no results found";
  return sources.map((s, i) => `[${i + 1}] ${s.title}\n${s.url}`).join("\n\n");
}
