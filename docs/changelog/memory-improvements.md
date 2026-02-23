# Memory Improvements: Local-Only + Auto-Inject

**Date:** 2026-02-23

## What changed

### Moved MEMORY.md out of git

MEMORY.md was tracked in `prompts/MEMORY.md` and committed to the repo. Since it contains personal info (and will accumulate more over time), it now lives in `data/MEMORY.md` — which is already gitignored along with the SQLite database and other runtime state.

### Auto-inject memory into system prompt

Previously, the agent had to spend a tool call on `memory_read` at the start of each conversation to access its persistent memory. This was advisory — the system prompt told it to check memory, but it could skip it.

Now, `loadSystemPrompt()` reads MEMORY.md and appends it to the system prompt automatically. The agent always has memory in context without burning an iteration of the agent loop. The `memory_read` tool still exists (harmless to keep), and `memory_update` is unchanged.

### Trimmed redundancy in MEMORY.md

Removed the "Agent Behavior Defaults" section from MEMORY.md since it duplicated instructions already in the system prompt. Memory is now focused on durable facts about the user, preferences, and guardrails — not operational instructions the system prompt already covers.
