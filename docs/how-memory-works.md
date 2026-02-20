# How Memory Works

*As of: February 2026*

## Overview

The agent has a persistent memory file (`prompts/MEMORY.md`) that it can read and write to across conversations. This is entirely self-directed — the agent decides when to read, what's worth remembering, and how to structure the file.

## Tools

**`memory_read`** — Reads the full contents of MEMORY.md and returns it. No parameters.

**`memory_update`** — Two modes:
- `append` — Adds content to the end of the file
- `rewrite` — Replaces the entire file with new content

## How It Gets Used

1. The system prompt instructs the agent to "check your MEMORY.md at the start of conversations for relevant context"
2. The agent calls `memory_read` as a tool use (costs one iteration of the agent loop)
3. The system prompt also instructs the agent to "update MEMORY.md when you learn important new facts about Brendan or ongoing projects"
4. The agent calls `memory_update` when it decides something is worth persisting

There is no automatic injection — memory is not included in the system prompt or prepended to messages. The agent must actively choose to read it via a tool call each time.

## Current Limitations

- **No guarantee of reading**: The instruction to check memory at conversation start is advisory, not enforced. The agent may skip it to save a tool call iteration.
- **No structured schema**: The file format is free-form markdown managed by the agent. It could append duplicates, let the file grow unwieldy, or lose structure over time.
- **Full file rewrites**: The `rewrite` mode replaces the entire file, which is risky if the agent hallucinates or forgets existing content it hasn't re-read recently.
- **No size management**: There's no cap on file size. As memory grows, it could become expensive to include in context.
- **Single file**: All memory lives in one file — no separation between facts, preferences, project context, etc.

## Ideas for Future Improvements

- **Auto-inject into system prompt**: Read MEMORY.md at the start of each `runAgentLoop` call and append it to the system prompt. This guarantees memory is always available without burning a tool call, at the cost of extra input tokens.
- **Structured sections with timestamps**: Enforce a schema (e.g., YAML frontmatter or defined markdown sections) so the agent updates specific sections rather than doing full rewrites. Include "last updated" dates per section so stale info is visible.
- **Size limits and summarization**: Cap the file at a certain size (e.g., 4K chars). When it exceeds the limit, ask the agent to summarize/condense before appending more. Or automatically truncate the oldest entries.
- **Semantic memory with embeddings**: Replace the flat file with a vector store. The agent writes memory entries, and at conversation start, relevant memories are retrieved based on the current message. More scalable but adds complexity.
- **Append-only log with periodic compaction**: Instead of rewrite, use append-only entries with timestamps. Periodically (e.g., via a scheduled task), ask the agent to compact/summarize the log into a clean state.
- **Separate memory files**: Split into categories like `facts.md`, `preferences.md`, `projects.md` so the agent can read only what's relevant rather than the entire memory every time.
