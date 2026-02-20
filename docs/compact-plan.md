# Future Improvement: /compact Command for Conversation Summarization

## The Problem

Long conversations eat up the context window. Even with the 4-hour TTL on history, an active session can accumulate enough messages to bloat the context and increase API costs.

## The Idea

A `/compact` command that summarizes the current conversation into a short blurb (2-4 sentences) and stores it so it gets prepended to future context. Non-destructive — uses a compaction boundary timestamp so `loadHistory` only loads messages after the last compaction. No messages are deleted from the DB.

## Key Design Decisions

- **Non-destructive**: Messages stay in the DB. A `compact_after:{chatId}` timestamp in the `state` table controls what `loadHistory` loads — only messages after the boundary.
- **Summary injection**: Stored as `summary:{chatId}` in the `state` table, injected as a synthetic user/assistant pair at the start of history to maintain proper message alternation.
- **Cheap summarization**: Uses Sonnet with max_tokens=300. Transcript is capped at 8K chars and each message at 500 chars.
- **Chained compactions**: On repeated `/compact`, the new summary covers only post-boundary messages, but the previous summary was in context when those messages were created, so context chains naturally.
- **Reuses existing schema**: The `state` table already exists — no migrations needed.

## Implementation

### 1. Add state prepared statements (`minion.ts`, after `stmtMessageCount`)

```typescript
const stmtGetState = db.prepare('SELECT value FROM state WHERE key = ?');
const stmtSetState = db.prepare(
  `INSERT INTO state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
);
const stmtDeleteState = db.prepare('DELETE FROM state WHERE key = ?');
```

### 2. Update `stmtLoadHistory` query

Add a compact boundary filter:

```typescript
const stmtLoadHistory = db.prepare(
  `SELECT role, content FROM messages
   WHERE chat_id = ? AND timestamp > datetime('now', '-' || ? || ' minutes')
   AND timestamp > COALESCE(?, '1970-01-01')
   ORDER BY timestamp DESC LIMIT ?`
);
```

### 3. Update `loadHistory`

Look up the compact boundary and pass it to the query. Prepend stored summary as synthetic messages:

```typescript
function loadHistory(chatId: string): Anthropic.MessageParam[] {
  const compactRow = stmtGetState.get(`compact_after:${chatId}`) as { value: string } | undefined;
  const compactAfter = compactRow?.value ?? null;
  const rows = stmtLoadHistory.all(chatId, CONFIG.HISTORY_TTL_MINUTES, compactAfter, CONFIG.MAX_HISTORY_MESSAGES) as { role: string; content: string }[];
  rows.reverse();

  const messages: Anthropic.MessageParam[] = [];

  const summaryRow = stmtGetState.get(`summary:${chatId}`) as { value: string } | undefined;
  if (summaryRow) {
    messages.push({ role: 'user', content: `[Previous conversation summary: ${summaryRow.value}]` });
    messages.push({ role: 'assistant', content: 'Got it, I have context from our previous conversation. How can I help?' });
  }

  // ... rest of existing row-parsing and cleaning logic unchanged
```

### 4. Add `/compact` command handler (after `/status` handler)

```typescript
if (text === '/compact') {
  const history = loadHistory(chatId);
  if (history.length === 0) {
    await bot.sendMessage(msg.chat.id, 'Nothing to compact.');
    return;
  }

  const transcript = history.map(m => {
    const t = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ')
        : JSON.stringify(m.content);
    return `${m.role}: ${t.slice(0, 500)}`;
  }).join('\n');

  bot.sendChatAction(msg.chat.id, 'typing').catch(() => {});
  try {
    const resp = await anthropic.messages.create({
      model: CONFIG.MODEL,
      max_tokens: 300,
      system: 'Summarize this conversation in 2-4 sentences. Focus on what was discussed, decided, or accomplished. Be specific.',
      messages: [{ role: 'user', content: transcript.slice(0, 8000) }],
    });
    const summary = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join(' ');

    stmtSetState.run(`summary:${chatId}`, summary);
    stmtSetState.run(`compact_after:${chatId}`, new Date().toISOString());

    await bot.sendMessage(msg.chat.id, `Compacted. Summary:\n\n${summary}`);
  } catch (err: any) {
    await bot.sendMessage(msg.chat.id, `Failed to compact: ${err.message}`);
  }
  return;
}
```

### 5. Update `/clear` to also remove state entries

```typescript
if (text === '/clear') {
  stmtClearHistory.run(chatId);
  stmtDeleteState.run(`summary:${chatId}`);
  stmtDeleteState.run(`compact_after:${chatId}`);
  await bot.sendMessage(msg.chat.id, 'Conversation cleared.');
  return;
}
```

## Verification

1. `npm run dev` — boots without errors
2. Send a few messages, then `/compact` — verify summary is returned
3. Send a new message — verify the summary is prepended (agent should reference prior context)
4. `/compact` again — verify it only summarizes post-compaction messages
5. `/compact` with no history — verify "Nothing to compact"
6. `/clear` — verify messages and all state entries are wiped

## When to Implement

This becomes useful once you find yourself in long sessions where the context feels bloated or the model starts losing track of earlier conversation points.
