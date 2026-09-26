import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { MultiSelect } from "../components/multi-select.js";
import { theme } from "../theme.js";
import { formatContextWindow } from "../../shared/format.js";
import type { ApplyResult } from "../setup/apply.js";
import { PI_ANTHROPIC_PROVIDER, PI_OPENAI_PROVIDER, isClaudeModel } from "../setup/pi-config.js";
import type { CopilotModelInfo } from "../../providers/copilot/models.js";

type Step = "loading" | "pick" | "applying" | "done" | "error";

export interface PiScreenProps {
  // Live Copilot model list, and the FS write. Both injected so the App owns the real side effects and
  // tests can stub them — same split as the setup wizard's `apply` and the skill screen's `install`.
  loadCatalog: () => Promise<CopilotModelInfo[]>;
  apply: (models: CopilotModelInfo[]) => Promise<ApplyResult>;
  onDone: (result: ApplyResult, models: CopilotModelInfo[]) => void;
  onCancel: () => void;
  current?: string; // the chat model, pre-checked so the common case is one keypress
}

// A model's line in the picker: name, id, window, and the badges that decide what pi can do with it.
export function piModelLabel(m: CopilotModelInfo): string {
  const win = formatContextWindow(m.contextWindow);
  const tags = [m.reasoningEfforts.length ? "reasoning" : "", m.vision ? "vision" : ""].filter(Boolean);
  return [
    m.name === m.id ? m.id : `${m.name} (${m.id})`,
    win ? `· ${win}` : "",
    tags.length ? `· ${tags.join(" ")}` : "",
  ].filter(Boolean).join("  ");
}

function Dismiss({ onDismiss }: { onDismiss: () => void }) {
  useInput(() => onDismiss());
  return <Text color={theme.muted}>press any key to continue</Text>;
}

export function PiScreen({ loadCatalog, apply, onDone, onCancel, current }: PiScreenProps) {
  const [step, setStep] = useState<Step>("loading");
  const [catalog, setCatalog] = useState<CopilotModelInfo[]>([]);
  const [chosen, setChosen] = useState<CopilotModelInfo[]>([]);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    loadCatalog()
      .then((c) => { setCatalog(c); setStep("pick"); })
      .catch((x) => { setErr(x instanceof Error ? x.message : String(x)); setStep("error"); });
  }, []);

  async function doApply(ids: string[]) {
    const models = catalog.filter((m) => ids.includes(m.id));
    setChosen(models);
    setStep("applying");
    try { const r = await apply(models); setResult(r); setStep("done"); }
    catch (x) { setErr(x instanceof Error ? x.message : String(x)); setStep("error"); }
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginBottom={1}>
      <Text color={theme.accent} bold>configure pi{step === "pick" ? "  ·  choose the models to add" : ""}</Text>

      {step === "loading" && <Text color={theme.muted}>loading models from Copilot…</Text>}

      {step === "pick" && (
        catalog.length === 0
          // An empty catalog means discovery failed or timed out. Writing a models.json from that would
          // produce a provider with no models — say so instead, and leave the file untouched.
          ? <Box flexDirection="column">
              <Text color={theme.error}>could not reach Copilot's model list — try again in a moment</Text>
              <Dismiss onDismiss={onCancel} />
            </Box>
          : <MultiSelect
              items={catalog.map((m) => ({ label: piModelLabel(m), value: m.id }))}
              initial={current && catalog.some((m) => m.id === current) ? [current] : []}
              onSubmit={(ids) => void doApply(ids)}
              onCancel={onCancel}
            />
      )}

      {step === "applying" && <Text color={theme.muted}>writing pi config…</Text>}

      {step === "done" && result && (() => {
        // Each surface lists only its own family, so the run hint must too: a Claude example for the
        // Anthropic provider, a non-Claude example for the OpenAI provider. Show only the lines that
        // actually have a model behind them.
        const claudeEg = chosen.find((m) => isClaudeModel(m.id));
        const openaiEg = chosen.find((m) => !isClaudeModel(m.id));
        return (
        <Box flexDirection="column">
          <Text color={theme.ready}>✓ added {chosen.length} model{chosen.length === 1 ? "" : "s"} to pi</Text>
          <Text color={theme.output}>wrote {result.path}</Text>
          <Text color={theme.muted}>providers: {result.changed.join(", ")}</Text>
          <Text> </Text>
          <Text color={theme.muted}>run a model:</Text>
          {claudeEg && <Text color={theme.output}>  pi --provider {PI_ANTHROPIC_PROVIDER} --model {claudeEg.id}</Text>}
          {openaiEg && <Text color={theme.output}>  pi --provider {PI_OPENAI_PROVIDER} --model {openaiEg.id}</Text>}
          <Dismiss onDismiss={() => onDone(result, chosen)} />
        </Box>
        );
      })()}

      {step === "error" && (
        <Box flexDirection="column">
          <Text color={theme.error}>failed: {err}</Text>
          <Dismiss onDismiss={onCancel} />
        </Box>
      )}
    </Box>
  );
}
