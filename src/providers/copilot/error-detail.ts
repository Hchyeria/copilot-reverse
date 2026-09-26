import { oneLine } from "../../shared/format.js";

const MIN_REDACTABLE_TOKEN_LENGTH = 8;

function redactExactToken(value: string, token: string): string {
  return token.length >= MIN_REDACTABLE_TOKEN_LENGTH ? value.replaceAll(token, "[REDACTED]") : value;
}

export async function upstreamErrorDetail(res: Response, token: string): Promise<string> {
  try {
    const body = JSON.parse(await res.text()) as { error?: { code?: unknown; message?: unknown } };
    const code = typeof body.error?.code === "string" ? body.error.code : "";
    const message = typeof body.error?.message === "string" ? body.error.message : "";
    const detail = oneLine(redactExactToken([code, message].filter(Boolean).join(": "), token), 400);
    return detail ? ` — ${detail}` : "";
  } catch {
    return "";
  }
}
