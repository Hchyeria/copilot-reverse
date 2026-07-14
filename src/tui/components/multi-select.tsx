import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../theme.js";
import type { SelectItem } from "./select.js";

// Checkbox list: Select's sibling for "pick several". Shares its bounded scrolling window (a long
// Copilot model list must never overflow the terminal) and its key conventions, adding space to toggle
// and `a` to toggle every item at once. Like Select, only one should be mounted at a time.
export function MultiSelect({ items, initial = [], onSubmit, onCancel, windowSize = 10 }: {
  items: SelectItem[];
  initial?: string[];          // values checked when the list opens
  onSubmit: (values: string[]) => void;
  onCancel?: () => void;
  windowSize?: number;
}) {
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(initial));

  const toggle = (value: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value); else next.add(value);
      return next;
    });

  useInput((input, key) => {
    if (key.upArrow) setIdx((i) => (i - 1 + items.length) % items.length);
    else if (key.downArrow) setIdx((i) => (i + 1) % items.length);
    else if (input === " ") toggle(items[idx].value);
    else if (input === "a") setPicked((prev) => (prev.size === items.length ? new Set() : new Set(items.map((it) => it.value))));
    // Confirming an empty selection would write a provider with no models — a config that loads but
    // offers nothing. Ignore enter until at least one is checked; the footer says so.
    else if (key.return) { if (picked.size) onSubmit(items.filter((it) => picked.has(it.value)).map((it) => it.value)); }
    else if (key.escape) onCancel?.();
  });

  const n = items.length;
  const w = Math.min(windowSize, n);
  const start = Math.max(0, Math.min(idx - Math.floor(w / 2), n - w));
  const visible = items.slice(start, start + w);

  return (
    <Box flexDirection="column">
      {start > 0 && <Text color={theme.muted}>  ↑ {start} more</Text>}
      {visible.map((it, i) => {
        const real = start + i;
        const cur = real === idx;
        const on = picked.has(it.value);
        return (
          <Text key={it.value} color={cur ? theme.accent : on ? theme.output : theme.muted} bold={cur}>
            {cur ? "❯ " : "  "}{on ? "[x] " : "[ ] "}{it.label}
          </Text>
        );
      })}
      {start + w < n && <Text color={theme.muted}>  ↓ {n - start - w} more</Text>}
      <Text color={theme.muted}>
        ↑↓ move · space toggle · a all · enter confirm · esc cancel  ({picked.size} selected)
      </Text>
    </Box>
  );
}
