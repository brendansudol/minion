# Minion Ideas Backlog

## How to Use This File

This file is for feature and capability ideas that are worth keeping, but not yet committed for implementation.

- Keep entries concise and decision-oriented.
- Promote an idea to `docs/todo.md` only when the scope and acceptance criteria are clear.
- Move ideas that no longer fit to the parking lot instead of deleting them.

## Prioritization Rubric

- `Impact`: `High` | `Medium` | `Low`
- `Complexity`: `S` | `M` | `L`
- `Alignment`: `Strong` | `Moderate` | `Weak` (with Minion's minimal personal-assistant philosophy)
- `Status`: `Backlog` | `Planned` | `In Progress` | `Done` | `Rejected`

## Ideas (Uncommitted)

### One-shot reminders (auto-disable)
- `Idea`: Add a `one_shot` flag so reminder-style scheduled tasks disable themselves after the first run.
- `Why it fits Minion`: Reduces reminder footguns without adding architectural complexity.
- `Expected impact`: High
- `Complexity`: S
- `Dependencies`: `scheduled_tasks` schema update and scheduler logic.
- `Alignment`: Strong
- `Status`: Backlog

### /compact conversation compaction
- `Idea`: Add a `/compact` command that summarizes recent context and sets a compaction boundary so old turns are not always sent.
- `Why it fits Minion`: Keeps context lean and costs predictable for active use.
- `Expected impact`: High
- `Complexity`: M
- `Dependencies`: `state` table usage and history loading changes.
- `Alignment`: Strong
- `Status`: Backlog

### Async tool execution for bash/claude_code
- `Idea`: Replace sync execution (`execSync`) with async execution to avoid freezing the process during long tool calls.
- `Why it fits Minion`: Improves reliability without introducing heavy orchestration.
- `Expected impact`: High
- `Complexity`: M
- `Dependencies`: Tool execution refactor and typing-indicator handling.
- `Alignment`: Strong
- `Status`: Backlog

### Risky-command approval mode
- `Idea`: Require explicit user confirmation before running risky commands (destructive operations, sensitive paths, major network/system changes).
- `Why it fits Minion`: Adds practical safety while preserving power-user workflows.
- `Expected impact`: High
- `Complexity`: M
- `Dependencies`: Command risk classification and confirmation flow.
- `Alignment`: Strong
- `Status`: Backlog

### Daily briefing framework
- `Idea`: Add a consistent daily briefing output template (calendar, weather, unread mail, top reminders).
- `Why it fits Minion`: Directly supports personal assistant use with recurring value.
- `Expected impact`: Medium
- `Complexity`: S
- `Dependencies`: Existing tools and scheduler.
- `Alignment`: Strong
- `Status`: Backlog

### Inbox capture + triage digest
- `Idea`: Support lightweight "capture this" flow into an inbox list and send a daily triage summary.
- `Why it fits Minion`: Improves personal task hygiene with minimal overhead.
- `Expected impact`: Medium
- `Complexity`: M
- `Dependencies`: Simple storage format (markdown or DB) and summary prompt.
- `Alignment`: Strong
- `Status`: Backlog

### Follow-up memory commitments
- `Idea`: Persist explicit commitments made by Minion ("I'll remind you Friday") and check/follow through automatically.
- `Why it fits Minion`: Improves trust and reliability for assistant promises.
- `Expected impact`: High
- `Complexity`: M
- `Dependencies`: Structured memory entries and follow-up check routine.
- `Alignment`: Strong
- `Status`: Backlog

### Context pins
- `Idea`: Add manual pinned context (`/pin`, `/pins`, `/unpin`) injected into future sessions.
- `Why it fits Minion`: Gives user direct control over must-remember context.
- `Expected impact`: Medium
- `Complexity`: S
- `Dependencies`: Pin storage and history/system prompt injection point.
- `Alignment`: Strong
- `Status`: Backlog

### Personal playbooks
- `Idea`: Keep repeatable workflows in `docs/playbooks/*.md` and let Minion consult them for recurring tasks.
- `Why it fits Minion`: Stays simple and file-based while improving consistency.
- `Expected impact`: Medium
- `Complexity`: S
- `Dependencies`: Convention for discovery/loading playbook files.
- `Alignment`: Strong
- `Status`: Backlog

### Mac health watchdog (anomaly alerts)
- `Idea`: Run periodic health checks and only notify when metrics cross configured thresholds.
- `Why it fits Minion`: Practical always-on server assistant capability.
- `Expected impact`: Medium
- `Complexity`: M
- `Dependencies`: Scheduler task, baseline thresholds, alert dedupe.
- `Alignment`: Strong
- `Status`: Backlog

### Telegram voice note transcription
- `Idea`: Support voice messages by downloading audio and transcribing before handing text to the normal loop.
- `Why it fits Minion`: Expands natural input mode for on-the-go usage.
- `Expected impact`: Medium
- `Complexity`: M
- `Dependencies`: Telegram voice handling + transcription provider/tool.
- `Alignment`: Moderate
- `Status`: Backlog

### Web research quality controls
- `Idea`: Require citations and explicit date stamps when returning externally sourced facts.
- `Why it fits Minion`: Raises answer quality for research tasks with minimal UX cost.
- `Expected impact`: Medium
- `Complexity`: S
- `Dependencies`: System prompt/tool-output policy updates.
- `Alignment`: Strong
- `Status`: Backlog

## Parking Lot / Rejected

Use this section for ideas that were considered but are no longer a fit. Keep a short note on why.

## When to Promote an Idea to docs/todo.md

Promote only when all of the following are true:

- Scope is specific and bounded.
- Success criteria are testable.
- Required schema/tool/prompt changes are identified.
- Risks and rollout strategy are clear enough to implement without further product decisions.
