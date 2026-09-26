import React from "react";
import { Box, Text } from "ink";
import { Select } from "../components/select.js";
import { theme } from "../theme.js";

export interface ConfigInfo {
  openai: string;
  anthropic: string;
  supervisorPort: number;
  workerPort: number;
  dataDir: string;
}

export type ConfigAction = "model" | "setup-claude" | "setup-codex" | "setup-pi" | "network" | "back";

export function ConfigScreen({ info, model, clients, accessMode, onAction }: {
  info: ConfigInfo;
  model: string;
  clients: { claude: boolean; codex: boolean; pi: boolean };
  accessMode?: "localhost" | "lan";
  onAction: (action: ConfigAction) => void;
}) {
  const row = (k: string, v: string) => (
    <Text><Text color={theme.muted}>{k.padEnd(12)}</Text><Text color={theme.output}>{v}</Text></Text>
  );
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} marginBottom={1}>
      <Text color={theme.accent} bold>configuration</Text>
      {row("chat model", model)}
      {row("OpenAI", info.openai)}
      {row("Anthropic", info.anthropic)}
      {row("ports", `supervisor ${info.supervisorPort} · worker ${info.workerPort}`)}
      {accessMode && row("network", accessMode === "lan" ? "LAN (key required)" : "localhost (private)")}
      {row("clients", `claude ${clients.claude ? "✓" : "○"}  codex ${clients.codex ? "✓" : "○"}  pi ${clients.pi ? "✓" : "○"}`)}
      {row("data dir", info.dataDir)}
      <Text> </Text>
      <Select
        items={[
          { label: "change chat model", value: "model" },
          { label: "network access mode", value: "network" },
          { label: "configure Claude Code", value: "setup-claude" },
          { label: "configure Codex", value: "setup-codex" },
          { label: "configure pi", value: "setup-pi" },
          { label: "back", value: "back" },
        ]}
        onSubmit={(v) => onAction(v.value as ConfigAction)}
        onCancel={() => onAction("back")}
      />
    </Box>
  );
}
