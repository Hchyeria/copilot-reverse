import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { Select } from "../components/select.js";
import { theme } from "../theme.js";
import { normalizeGhecomHost } from "../../shared/github-connection.js";
import type { LoginRequest } from "../../cli/auth.js";

export function GitHubLoginScreen({ onSubmit, onCancel }: {
  onSubmit: (request: LoginRequest) => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<"pick" | "ghecom">("pick");
  const [host, setHost] = useState("");
  const [error, setError] = useState("");

  useInput((input, key) => {
    if (type !== "ghecom") return;
    if (key.escape) { onCancel(); return; }
    if (key.return) {
      try {
        onSubmit({ type: "ghecom", host: normalizeGhecomHost(host) });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      return;
    }
    if (key.backspace || key.delete) { setHost((value) => value.slice(0, -1)); setError(""); return; }
    if (input && !key.ctrl && !key.meta) { setHost((value) => value + input); setError(""); }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginBottom={1}>
      <Text color={theme.accent} bold>GitHub login</Text>
      {type === "pick" ? (
        <Select
          items={[
            { label: "GitHub.com", value: "github" },
            { label: "GHE.com (Enterprise Cloud with data residency)", value: "ghecom" },
          ]}
          onSubmit={(item) => item.value === "github" ? onSubmit({ type: "github" }) : setType("ghecom")}
          onCancel={onCancel}
        />
      ) : (
        <>
          <Text color={theme.muted}>Enter the hostname only, for example acme.ghe.com · enter confirm · esc cancel</Text>
          <Box><Text color={theme.prompt}>hostname › </Text><Text>{host}</Text><Text inverse> </Text></Box>
          {error && <Text color={theme.error}>{error}</Text>}
        </>
      )}
    </Box>
  );
}
