## Split Lanes MVP v2 for Minion: Per-Chat Turn Lock + Background `claude_code` Jobs

### Summary
Implement a two-lane runtime model in `minion.ts`:

1. **Conversation lane (serialized per chat):** all normal `runAgentLoop` turns execute FIFO per `chat_id`.
2. **Job lane (out-of-band):** long-running `claude_code` tool requests become background jobs and return immediately with a job ID; completion is posted as a separate Telegram message.

This MVP keeps the codebase lightweight, removes event-loop blocking from `execSync`, and fixes concurrency hazards between user turns and scheduler turns for the same chat.

### Scope
- In scope:
  - Per-chat queue/lock for normal turns.
  - Async background job system for `claude_code` only.
  - SQLite jobs table + minimal status commands.
  - Event-driven queue trigger with low-frequency watchdog.
  - Out-of-band completion notifications with structured context header.
- Out of scope (defer):
  - Job cancellation.
  - Automatic retries.
  - Persistence/recovery of in-flight subprocesses across process restart.
  - Worker pool concurrency > 1.

---

## Data Model (SQLite)

### New table
Add to startup `db.exec(...)`:

```sql
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- 'claude_code'
  status TEXT NOT NULL,                -- 'queued' | 'running' | 'succeeded' | 'failed'
  input_json TEXT NOT NULL,            -- serialized tool input: prompt, working_directory
  request_excerpt TEXT NOT NULL,       -- short prompt excerpt used in completion header
  result_text TEXT,                    -- truncated final extracted text
  error_text TEXT,                     -- truncated error details
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  finished_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_chat_created ON jobs(chat_id, created_at DESC);
```

### Truncation/storage policy
Enforce before DB write:
- `request_excerpt`: max 200 chars
- `result_text`: max 50_000 chars
- `error_text`: max 10_000 chars

### Type additions
Add row interfaces:
- `JobRow { id, chat_id, kind, status, input_json, request_excerpt, result_text, error_text, created_at, started_at, finished_at }`
- `JobListRow { id, status, kind, request_excerpt, created_at, finished_at }`

---

## Function Boundaries

### 1) Conversation lane serialization

#### New state
- `const chatQueues = new Map<string, Promise<void>>();`

#### New helper
- `function enqueueChatTask(chatId: string, task: () => Promise<void>): void`
  - Load prior promise for `chatId` (or resolved promise).
  - Chain `task` (`prior.then(task)` with local error handling).
  - Store chained promise back into map.
  - Cleanup map entry when this tail completes and no newer tail replaced it.

#### Integration points (required)
Wrap these calls via `enqueueChatTask(...)`:
- Photo flow in `bot.on('message')`.
- Regular text flow in `bot.on('message')`.
- Scheduler flow in interval loop.

Do not queue lightweight commands that do not invoke `runAgentLoop` (`/status`, `/tasks`, `/memory`, `/model`, `/clear`, `/jobs`, `/job`).

---

### 2) Background job lane (`claude_code`)

#### Replace blocking execution path
Current `executeTool(... case 'claude_code')` uses `execSync`. Replace with queueing behavior:

- `enqueueClaudeCodeJob(chatId, input): { job_id: number, status: 'queued' }`
  - Insert queued row into `jobs`.
  - Persist `request_excerpt` from prompt.
  - Trigger `processJobQueue()` immediately (fire-and-forget).
  - Return job metadata.

`executeTool('claude_code', ...)` returns:

```json
{
  "job_started": true,
  "job_id": 42,
  "status": "queued",
  "note": "Background Claude Code job started; results will be posted when complete."
}
```

This lets the model acknowledge and complete its turn without blocking.

---

### 3) Job worker

#### Trigger model
Use both:
1. **Primary trigger:** direct `processJobQueue()` call after enqueue.
2. **Fallback watchdog:** `setInterval(processJobQueue, 30000)`.

Reason: near-zero enqueue latency plus recovery from missed triggers or transient errors.

#### Worker state
- `let jobRunnerActive = false;`

#### `async function processJobQueue(): Promise<void>`
1. If `jobRunnerActive`, return.
2. Set `jobRunnerActive = true`.
3. In `try` block, loop:
   - Fetch oldest queued job.
   - If none, break.
   - Mark running (`started_at=now`).
   - Execute via `runClaudeCodeJob(job)`.
   - On success: mark succeeded + `result_text` + `finished_at`; notify Telegram.
   - On failure: mark failed + `error_text` + `finished_at`; notify Telegram.
4. In `finally`: set `jobRunnerActive = false`.

`finally` is mandatory so the worker cannot get stuck active on exceptions.

---

### 4) Async Claude runner + streaming parser

#### New functions
- `async function runClaudeCodeJob(job: JobRow): Promise<{ result: string }>`
- `function parseClaudeStreamLine(line: string, acc: ParseAccumulator): void`

#### Execution details
- Use `spawn('claude', ['-p', prompt, '--verbose', '--output-format', 'stream-json'], { cwd, env })`.
- Read stdout as stream; parse line-by-line.
- Keep bounded buffers only:
  - `stdout_tail` up to 200_000 chars for diagnostics.
  - `stderr_tail` up to 50_000 chars.
  - `result_text` max 50_000 chars final.
- 5-minute timeout (300_000 ms): kill process, fail job.
- Exit code non-zero: fail with truncated stderr/stdout summary.

Do not buffer unbounded full output in memory.

---

### 5) Telegram commands for jobs

Add to `bot.on('message')`:

1. `/jobs`
- Show latest 10 jobs for requesting `chat_id` only.
- Format: `#id status kind created_at finished_at request_excerpt`.

2. `/job <id>`
- Validate integer.
- Query by `id` and same `chat_id`.
- Return status and truncated `result_text` or `error_text`.

No `/cancel` in MVP.

---

## History Semantics for Out-of-Band Completion

### Decision for MVP
Use existing assistant role, but prepend structured header to completion/failure text:

- Success:
  - `[Background job #N completed | kind=claude_code | original request: <request_excerpt>]`
- Failure:
  - `[Background job #N failed | kind=claude_code | original request: <request_excerpt>]`

Then append job outcome body below header.

### Reason
Keeps loader/schema unchanged while preserving context when this message appears in later history without nearby original user prompt.

### Future note
If background-job volume grows, revisit a dedicated role/metadata path (e.g., `job_event`) for finer history control.

---

## Message and State Transitions

### A) Normal conversational turn (non-job)
1. Incoming message -> `enqueueChatTask(chatId, task)`.
2. Task starts when prior chat task completes.
3. `runAgentLoop` executes and may use normal inline tools.
4. End turn -> send response.

### B) `claude_code` tool request during a turn
1. Model emits `tool_use: claude_code`.
2. `executeTool` enqueues job row (`queued`) and returns `job_started` tool result.
3. Model acknowledges queued job and ends turn.
4. User immediately receives normal conversational reply indicating job queued.

### C) Background job lifecycle
1. `queued -> running` (worker picks oldest).
2. Process exits:
   - success: `running -> succeeded`
   - timeout/error: `running -> failed`
3. Bot sends out-of-band message with structured header + body.
4. Message is stored as assistant content for future history.

---

## Required Refactors

1. Extract Claude stream-json parsing logic into reusable streaming parser.
2. Replace `execSync` claude invocation with `spawn` and timeout handling.
3. Add jobs prepared statements:
- insert queued
- get oldest queued
- mark running
- mark succeeded
- mark failed
- list by chat
- get by id/chat
4. Add `enqueueChatTask` wrapper and route scheduler through it.
5. Keep `runAgentLoop` unchanged except for receiving queued job tool result behavior.

---

## Public Interfaces / Behavior Changes

1. Tool contract change:
- `claude_code` returns queued-job metadata instead of final result.

2. New Telegram commands:
- `/jobs`
- `/job <id>`

3. Runtime behavior:
- Long Claude work is asynchronous.
- Chat remains responsive.
- Scheduler and user turns are serialized per chat to prevent interleaving corruption.

---

## Acceptance Tests

### Functional
1. Send text A then B rapidly in same chat:
- Replies occur in order A then B.

2. Start long `claude_code` request:
- Immediate queued acknowledgment with job ID.
- `/jobs` shows queued/running then succeeded/failed.
- Out-of-band completion message arrives later.

3. Send normal message while job running:
- Message is processed promptly in conversation lane.

4. Scheduler fires during active user turn on same `chat_id`:
- No concurrent `runAgentLoop` overlap; execution serialized.

5. Model emits two `claude_code` calls in one turn:
- Two jobs are queued, both IDs returned in tool results, both eventually complete/fail independently.

6. `/job <id>` cannot access another chat's job.

7. Timeout path:
- Job exceeds 300s, gets failed status, failure notification sent.

### Safety/Regression
1. Existing `/clear`, `/tasks`, `/memory`, `/status`, `/model` behavior remains intact.
2. No event-loop freeze from `claude_code` path.
3. History alternation requirements remain valid for Anthropic API usage.
4. DB row sizes stay bounded by truncation policy.

---

## Effort Estimate (MVP v2)

- DB schema + statements + truncation guards: 0.5 day
- Per-chat queue integration (message + scheduler paths): 0.5 day
- Async Claude runner + streaming parse + timeout/error handling: 1 to 1.5 days
- Job commands `/jobs` + `/job`: 0.5 day
- Validation and edge-case testing: 0.5 day

**Total:** ~3 to 3.5 engineering days.

---

## Assumptions and Defaults

1. Single process deployment remains the operating model.
2. Worker concurrency is one global job at a time in MVP.
3. Job completion is out-of-band and includes structured contextual header.
4. No cancel/retry/restart recovery in MVP.
5. Existing history TTL/message-limit strategy remains unchanged.
