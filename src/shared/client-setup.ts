import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Whether the user has applied copilot-reverse config for each client. Surfaced in the TUI HUD;
// written by the /setup-* flow once it actually applies config.
export interface ClientSetupState { claude: boolean; codex: boolean; pi: boolean }

const file = (dir: string) => join(dir, "clients.json");
const NONE: ClientSetupState = { claude: false, codex: false, pi: false };

export function readClientSetup(dir: string): ClientSetupState {
  if (!existsSync(file(dir))) return { ...NONE };
  try {
    const d = JSON.parse(readFileSync(file(dir), "utf8")) as Partial<ClientSetupState>;
    // Each flag is read independently, so a clients.json written before pi was a client still parses —
    // it just reports pi: false.
    return { claude: Boolean(d.claude), codex: Boolean(d.codex), pi: Boolean(d.pi) };
  } catch {
    return { ...NONE };
  }
}

export function writeClientSetup(dir: string, state: ClientSetupState): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file(dir), JSON.stringify(state));
}
