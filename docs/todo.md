# Future Work

## Async tool execution
Switch `execSync` to async `execFile` in the `bash` and `claude_code` tools so the Node.js event loop isn't blocked during long-running commands. Currently, a 5-minute `claude_code` call freezes the entire process — no other messages can be handled.

Keep it simple: no queues or locks. Just unblock the event loop. Conversation history interleaving is a theoretical concern but unlikely to matter in practice for single-user usage.

## Better HTML handling in web_fetch
`web_fetch` currently returns raw HTML (tags, scripts, styles included). The model can parse through it, but it wastes tokens and long articles may get truncated at the 20KB limit before reaching the main content. Consider adding HTML-to-text conversion — either strip tags manually or use a readability library (e.g., `@mozilla/readability` + `linkedom`) to extract the article body.

## Dedicated calendar tool
Calendar integration currently lives in the system prompt (JXA examples via `osascript`). If this proves unreliable — e.g., the model struggles with date formatting, produces broken JXA, or the commands are too verbose for the context window — consider promoting to a dedicated tool using the same JXA patterns under the hood. A tool could handle argument validation, date parsing, and error handling more robustly.

## One-time scheduled tasks
Reminders like "remind me at 5pm" create cron jobs that technically match again a year later. Add a `one_shot` flag to `scheduled_tasks` that auto-disables the task after its first run.

## Typing indicator during long tool calls
`sendChatAction('typing')` is called between agent loop iterations, but since `execSync` blocks the event loop, the typing indicator expires during long-running tool calls (Telegram's typing status lasts ~5 seconds). Fixing async execution (item 1) would naturally solve this — a periodic `setInterval` could keep the indicator alive while awaiting the tool result.

---

# Done

## Clean model switching
Introduced a mutable `currentModel` session variable instead of mutating the `as const` CONFIG object via `as any`.

## Graceful shutdown
Added `SIGTERM`/`SIGINT` handlers that clear the scheduler interval, stop Telegram polling, and close the SQLite database.
