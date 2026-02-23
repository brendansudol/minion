# Split Lanes: Async Claude Code + Chat Queue

**PR:** [#3](https://github.com/brendansudol/minion/pull/3) | **Merged:** 2026-02-22

## Problem

`claude_code` used `execSync`, which blocked the entire event loop for up to 5 minutes. During that time, the bot couldn't respond to messages, and scheduler tasks could interleave with user turns on the same chat, corrupting conversation history.

## What changed

### Async background jobs

The `claude_code` tool now spawns a child process via `spawn` instead of `execSync`. It returns immediately with a job ID, and the result is posted as a separate message when the job completes (or fails/times out).

Key components:
- `runClaudeCodeAsync` — spawns `claude` CLI, streams stdout line-by-line, enforces a 5-minute timeout, and posts the result back to the chat
- `parseStreamJsonLine` — extracts result text from Claude's `stream-json` output format
- `activeJobs` map — tracks running child processes for graceful shutdown

### Per-chat serialization

`enqueueChatTask` creates a per-chat promise chain so that user messages, photo handling, and scheduled tasks targeting the same chat execute one at a time. This prevents message interleaving and history corruption.

### Consistent message sending

`sendChatMessage` extracts the repeated pattern of splitting long messages + sending with Markdown formatting + falling back to plain text. Used across all message-sending paths.

### Scheduler hardening

The scheduler now advances `next_run` *before* enqueueing the task (claim-first), preventing duplicate runs when a task takes longer than the scheduler interval.

### Graceful shutdown

On SIGTERM/SIGINT, active background child processes are killed before the bot shuts down.

## What was descoped from the original plan

The [original spec](../archive/split-lanes-mvp-plan.md) included a SQLite `jobs` table, `/jobs` and `/job <id>` commands, and a formal job queue worker. The implementation used a simpler in-memory approach (job counter + `activeJobs` map) since persistence and job inspection weren't needed for MVP.
