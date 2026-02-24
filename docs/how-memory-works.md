# How Memory Works

*Updated: February 2026*

## Overview

The agent has a persistent memory file (`data/MEMORY.md`) that stores durable facts, preferences, and guardrails. Memory is automatically injected into the system prompt on every API call, so the agent always has it in context. The agent can update memory via tool calls when it learns something new.

The file is gitignored (lives in `data/` alongside the SQLite database) since it contains personal information.

## Auto-Injection

`loadSystemPrompt()` reads MEMORY.md and appends it to the system prompt each turn. The memory is wrapped with a heading and brief framing so the agent knows what it is. This guarantees memory is always available without the agent spending a tool call to read it.

## Tools

**`memory_read`** — Reads the full contents of MEMORY.md and returns it. Rarely needed since memory is auto-injected, but still available.

**`memory_update`** — Two modes:
- `append` — Adds content to the end of the file
- `rewrite` — Replaces the entire file with new content

## What Goes in Memory

The file has a self-documented rule at the top: only store info that will still matter in ~3+ months AND changes behavior. Current sections:

- **About Me** — Name, location, timezone, family, interests
- **Interaction Preferences** — Communication style, engineering preferences, tone
- **Safety + Guardrails** — Secrets policy, shell command rules, file write policy
- **Machine / Runtime** — Mac Mini setup and agent capabilities
- **Memory Management Policy** — Rules for what to store and how to maintain the file

Operational instructions that the system prompt already covers (e.g., how to use tools, agent behavior defaults) belong in `SYSTEM_PROMPT.md`, not in memory.

## Current Limitations

- **No structured schema**: The file format is free-form markdown managed by the agent. It could append duplicates, let the file grow unwieldy, or lose structure over time.
- **Full file rewrites**: The `rewrite` mode replaces the entire file, which is risky if the agent hallucinates or forgets existing content.
- **No size management**: There's no cap on file size. As memory grows, it adds more input tokens to every API call.
- **Single file**: All memory lives in one file — no separation between facts, preferences, project context, etc.

## Ideas for Future Improvements

- **Structured sections with timestamps**: Enforce a schema (e.g., YAML frontmatter or defined markdown sections) so the agent updates specific sections rather than doing full rewrites. Include "last updated" dates per section so stale info is visible.
- **Size limits and summarization**: Cap the file at a certain size (e.g., 4K chars). When it exceeds the limit, ask the agent to summarize/condense before appending more. Or automatically truncate the oldest entries.
- **Semantic memory with embeddings**: Replace the flat file with a vector store. The agent writes memory entries, and at conversation start, relevant memories are retrieved based on the current message. More scalable but adds complexity.
- **Append-only log with periodic compaction**: Instead of rewrite, use append-only entries with timestamps. Periodically (e.g., via a scheduled task), ask the agent to compact/summarize the log into a clean state.
- **Separate memory files**: Split into categories like `facts.md`, `preferences.md`, `projects.md` so the agent can read only what's relevant rather than the entire memory every time.
