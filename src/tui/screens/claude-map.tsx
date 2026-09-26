import React, { useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import {
  CLAUDE_MODEL_ALIASES,
  CLAUDE_MODEL_DEFAULTS,
  resolveClaudeModelMap,
  type ClaudeModelAlias,
  type ClaudeModelOverrides,
} from "../../core/claude-model-map.js";
import type { ClaudeMapSettings } from "../../shared/prefs.js";
import { Select, type SelectItem } from "../components/select.js";
import { theme } from "../theme.js";

export interface ClaudeMapSaveResult {
  models?: string[];
  activationError?: string;
}

interface Props {
  settings: ClaudeMapSettings;
  loadModels: () => Promise<string[]>;
  onSave: (settings: ClaudeMapSettings) => Promise<ClaudeMapSaveResult>;
  onDone: (settings: ClaudeMapSettings, result: ClaudeMapSaveResult) => void;
  onCancel: () => void;
}

type Step = "loading" | "overview" | "backend" | "saving" | "error";

const displayName = (alias: ClaudeModelAlias): string => alias
  .replace(/^claude-/, "")
  .split("-")
  .map((part, index) => index === 0 ? part[0].toUpperCase() + part.slice(1) : part)
  .join(" ")
  .replace(/ (\d+) (\d+)$/, " $1.$2");

function uniqueGptModels(models: string[]): string[] {
  return [...new Set(models.filter((model) => model.startsWith("gpt-")))];
}

function effectiveOverrides(map: ReturnType<typeof resolveClaudeModelMap>): ClaudeModelOverrides {
  const overrides: ClaudeModelOverrides = {};
  for (const alias of CLAUDE_MODEL_ALIASES) {
    if (map[alias] !== CLAUDE_MODEL_DEFAULTS[alias]) overrides[alias] = map[alias];
  }
  return overrides;
}

export function ClaudeMapScreen({ settings, loadModels, onSave, onDone, onCancel }: Props) {
  const initialMap = useMemo(() => resolveClaudeModelMap(settings.overrides), [settings]);
  const [step, setStep] = useState<Step>("loading");
  const [enabled, setEnabled] = useState(settings.enabled);
  const [map, setMap] = useState(initialMap);
  const [gptModels, setGptModels] = useState<string[]>([]);
  const [editing, setEditing] = useState<ClaudeModelAlias | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    loadModels()
      .then((models) => { setGptModels(uniqueGptModels(models)); setStep("overview"); })
      .catch((reason) => { setError(reason instanceof Error ? reason.message : String(reason)); setStep("error"); });
  }, []);

  const save = async () => {
    const snapshot: ClaudeMapSettings = { enabled, overrides: effectiveOverrides(map) };
    setStep("saving");
    try {
      const result = await onSave(snapshot);
      onDone(snapshot, result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setStep("error");
    }
  };

  const overviewItems: SelectItem[] = [
    { label: enabled ? "disable Claude map" : "enable Claude map", value: "toggle" },
    ...CLAUDE_MODEL_ALIASES.map((alias) => ({ label: `edit ${displayName(alias)}`, value: alias })),
    { label: "restore all defaults", value: "reset" },
    { label: "save changes", value: "save" },
    { label: "cancel", value: "cancel" },
  ];

  const selectOverview = (value: string) => {
    if (value === "toggle") { setEnabled((current) => !current); return; }
    if (value === "reset") { setMap(resolveClaudeModelMap()); return; }
    if (value === "save") { void save(); return; }
    if (value === "cancel") { onCancel(); return; }
    setEditing(value as ClaudeModelAlias);
    setStep("backend");
  };

  const selectBackend = (backend: string) => {
    if (!editing) return;
    setMap((current) => ({ ...current, [editing]: backend }));
    setEditing(null);
    setStep("overview");
  };

  const row = (alias: ClaudeModelAlias) => {
    const backend = map[alias];
    const custom = backend !== CLAUDE_MODEL_DEFAULTS[alias];
    const live = gptModels.includes(backend);
    return (
      <Text key={alias}>
        <Text color={theme.output}>{alias} → {backend}</Text>
        <Text color={custom ? theme.accent : theme.muted}>{`  ${custom ? "custom" : "default"}`}</Text>
        {!live && <Text color={theme.error}>  unavailable</Text>}
      </Text>
    );
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={enabled ? theme.accent : theme.border} paddingX={1} marginBottom={1}>
      <Text color={theme.accent} bold>Claude model map  ·  {enabled ? "on" : "off"}</Text>
      {step === "loading" && <Text color={theme.muted}>loading models from Copilot…</Text>}
      {step === "saving" && <Text color={theme.muted}>saving preferences and restarting worker…</Text>}
      {step === "error" && (
        <Box flexDirection="column">
          <Text color={theme.error}>save failed: {error}</Text>
          <Text color={theme.muted}>press esc to cancel</Text>
          <Select items={[{ label: "back", value: "back" }]} onSubmit={() => onCancel()} onCancel={onCancel} />
        </Box>
      )}

      {(step === "overview" || step === "backend") && <Box flexDirection="column">{CLAUDE_MODEL_ALIASES.map(row)}</Box>}

      {step === "overview" && (
        <Box flexDirection="column">
          {!gptModels.length && <Text color={theme.error}>no live GPT backends found — mappings cannot be edited</Text>}
          <Text> </Text>
          <Select
            items={gptModels.length ? overviewItems : overviewItems.filter((item) => !item.value.startsWith("claude-"))}
            onSubmit={(item) => selectOverview(item.value)}
            onCancel={onCancel}
          />
        </Box>
      )}

      {step === "backend" && editing && (
        <Box flexDirection="column">
          <Text> </Text>
          <Text color={theme.accent}>choose {displayName(editing)} backend</Text>
          <Select
            items={gptModels.map((model) => ({ label: `${model}${model === map[editing] ? "  (current)" : ""}`, value: model }))}
            onSubmit={(item) => selectBackend(item.value)}
            onCancel={() => { setEditing(null); setStep("overview"); }}
          />
        </Box>
      )}
    </Box>
  );
}
