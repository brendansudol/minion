# Future Improvement: Session-Based Conversation History

## The Problem

Currently, every API call loads the last 50 messages from SQLite regardless of when they happened. After a couple months of usage (~1,200 conversations), this means sending ~50-60K tokens of irrelevant history on every message — costing ~$0.18/message in input tokens and confusing the model with stale context from weeks ago.

## The Idea

Replace "load last 50 messages" with session-based context management:

- **Session boundaries**: A session expires after 30 minutes of inactivity. New messages after that gap start a fresh session.
- **Session summarization**: When a session ends (detected lazily on next message), generate a 2-4 sentence summary via a cheap Sonnet call (max_tokens=300).
- **Lightweight context**: Each API call sends system prompt + MEMORY.md + previous session's summary + current session messages. Typically ~3-5K tokens instead of 50-60K.
- **Recall tool**: New tool that searches past session summaries by keyword (`LIKE '%query%'` over a `sessions` table). The agent uses this when the user references something from a past conversation.

## Schema

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at DATETIME,
  summary TEXT,
  is_active INTEGER DEFAULT 1
);

-- Add to existing messages table:
ALTER TABLE messages ADD COLUMN session_id INTEGER REFERENCES sessions(id);
```

## Key Design Decisions

- **Lazy summarization**: Summary is generated when the *next* message arrives and detects the 30-min gap, not via a timer. Avoids background processes.
- **Previous session summary injection**: Injected as a synthetic user/assistant exchange at the start of a new session to maintain proper message alternation.
- **No data migration**: Existing messages with `session_id = NULL` are simply invisible to the new system. Clean break.
- **Simple search**: `LIKE '%keyword%'` over session summaries is good enough for months. Embeddings can come later if needed.
- **Scheduled tasks share sessions**: They go through the same `getOrCreateSession` flow — joining an active session if within 30 min, or getting a fresh one.

## When to Implement

This becomes important once:
- You notice API costs climbing from context size
- The model starts referencing irrelevant old conversations
- You're sending 20+ messages/day consistently

Until then, the current "last 50 messages" approach works fine for light-to-moderate usage.
