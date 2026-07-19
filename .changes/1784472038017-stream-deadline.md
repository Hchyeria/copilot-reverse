---
bump: patch
---
Fix runaway-stream error text mislabeling a wall-clock timeout as model degeneration, and raise the streaming deadline from 2 to 10 minutes. A long-but-healthy turn (e.g. Claude Opus over a 1M window streaming reasoning + a long answer) was being cut at 120s and reported as "model degenerated, ended early as max_tokens" — now such a cut says "wall-clock timeout" (only genuine repetition/max_output cuts blame the model), and the 10-minute backstop leaves legitimate long turns intact.
