# Minion: Minimal Personal AI Assistant for Mac Mini

## What This Is

A single-file personal AI assistant that lives in a Telegram chat, running 24/7 on my Mac Mini (Apple Silicon). It uses the raw Anthropic Messages API with tool use to run an agentic loop. It can execute shell commands, read/write files, search the web, remember things about me, run scheduled tasks, and — critically — shell out to `claude -p` for heavy-lift coding/research tasks that benefit from Claude Code's full toolset.

**Runs on:** Mac Mini (Apple Silicon, macOS). Always-on, headless. The Mac Mini is my home server — it's always powered on and connected.

**Design philosophy:** Fewer than 500 lines of core code. No frameworks, no abstractions, no plugin system. One process, one file, one config. If I want to change behavior, I edit the code directly.

## Architecture

```
Telegram Bot API (polling)
        │
        ▼
┌─────────────────────┐
│   minion.ts        │
│                     │
│  ┌───────────────┐  │
│  │ Agent Loop    │  │  ← Anthropic Messages API with tool_use
│  │ (while loop)  │  │
│  └───────┬───────┘  │
│          │          │
│  ┌───────▼───────┐  │
│  │ Tool Executor │  │  ← bash, read_file, write_file, memory, web_fetch, claude_code, schedule
│  └───────────────┘  │
│                     │
│  ┌───────────────┐  │
│  │ SQLite Store  │  │  ← conversations, scheduled tasks
│  └───────────────┘  │
│                     │
│  ┌───────────────┐  │
│  │ Scheduler     │  │  ← setInterval, checks cron table every 60s
│  └───────────────┘  │
└─────────────────────┘
```

## Tech Stack

- **Runtime:** Node.js with TypeScript (tsx for direct execution, no build step)
- **LLM:** Anthropic Messages API via `@anthropic-ai/sdk`
- **Chat:** Telegram Bot API via `node-telegram-bot-api`
- **Storage:** `better-sqlite3` for conversations + scheduled tasks
- **HTTP:** Built-in `fetch` for web requests
- **Scheduler:** Simple `setInterval` polling a SQLite cron table

No other dependencies. No Express, no frameworks, no ORMs.

## File Structure

```
minion/
├── minion.ts          # Everything lives here
├── config.ts            # Env vars + constants (tiny file)
├── package.json
├── tsconfig.json
├── MEMORY.md            # Persistent memory the agent reads/writes
├── data/
│   └── minion.db      # SQLite database (auto-created)
└── workspace/           # Working directory for agent file operations
```

## Config (config.ts)

```typescript
export const CONFIG = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN!,
  ALLOWED_USER_ID: process.env.TELEGRAM_USER_ID!,  // Only respond to me
  MODEL: 'claude-sonnet-4-5-20250929',              // Sonnet for daily use
  OPUS_MODEL: 'claude-opus-4-6-20250918',            // Opus for complex tasks
  MAX_TOOL_ITERATIONS: 25,                           // Safety cap on agent loop
  WORKSPACE_DIR: './workspace',
  MEMORY_FILE: './MEMORY.md',
  DB_PATH: './data/minion.db',
  SYSTEM_PROMPT_FILE: './SYSTEM_PROMPT.md',          // Optional external system prompt
} as const;
```

## System Prompt

The system prompt should be loaded from `SYSTEM_PROMPT.md` if it exists, otherwise use a sensible default. This lets me iterate on the prompt without touching code.

Default system prompt:

```markdown
You are Minion, Brendan's personal AI assistant. You run 24/7 on his Mac Mini (Apple Silicon, macOS) and communicate via Telegram.

## Who You Are
- You are direct, concise, and opinionated when asked
- You remember context across conversations via your memory file
- You have full access to the Mac Mini — shell, filesystem, homebrew, network, etc.
- You can delegate complex coding/research tasks to Claude Code via the claude_code tool

## How to Use Tools
- For quick commands, file reads, or simple tasks: use bash/read_file/write_file directly
- For complex multi-step coding, debugging, or research: use the claude_code tool which invokes Claude Code CLI with full context
- Always check your MEMORY.md at the start of conversations for relevant context
- Update MEMORY.md when you learn important new facts about Brendan or ongoing projects
- You're on macOS — use `brew`, `open`, `pbcopy`, `osascript`, etc. as needed

## Guidelines
- Keep Telegram messages concise. Use line breaks, not walls of text.
- If a task will take more than a few seconds, acknowledge receipt first, then do the work
- For scheduled tasks, confirm what you'll do and when
- If something fails, explain what happened and suggest a fix
- You can use Opus (via the think_hard tool) for genuinely difficult reasoning tasks
```

## Database Schema

```sql
-- Conversation history
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL,           -- 'user' | 'assistant' | 'tool_use' | 'tool_result'
  content TEXT NOT NULL,        -- JSON for complex content blocks
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Scheduled tasks
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  cron_expression TEXT NOT NULL,  -- Standard 5-field cron: min hour dom mon dow
  prompt TEXT NOT NULL,           -- What to tell the agent when the task fires
  chat_id TEXT NOT NULL,          -- Where to send the response
  enabled INTEGER DEFAULT 1,
  last_run DATETIME,
  next_run DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Simple key-value for misc state
CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_tasks_next ON scheduled_tasks(next_run) WHERE enabled = 1;
```

## Tools

Define these as the `tools` array in the Anthropic API call. Each tool needs a name, description, and input_schema (JSON Schema).

### 1. `bash`
Execute a shell command and return stdout/stderr.
- **Input:** `{ command: string, timeout_seconds?: number }`
- **Execution:** `child_process.execSync` with timeout (default 30s), cwd set to workspace
- **Returns:** `{ stdout: string, stderr: string, exit_code: number }`
- **Safety:** Block `rm -rf /`, `sudo`, and commands outside workspace unless explicitly about system info (like `date`, `whoami`, `brew list`, `system_profiler`, etc.)
- **Note:** This is macOS — `grep` is BSD grep, `sed` is BSD sed, `pbcopy`/`pbpaste` are available, `open` launches apps, `osascript` runs AppleScript, `brew` is the package manager

### 2. `read_file`
Read a file's contents.
- **Input:** `{ path: string }`
- **Execution:** `fs.readFileSync`, resolve path relative to workspace (or allow absolute for known safe paths like MEMORY.md)
- **Returns:** `{ content: string }` or error

### 3. `write_file`
Write content to a file (create or overwrite).
- **Input:** `{ path: string, content: string }`
- **Execution:** `fs.writeFileSync`, auto-create directories
- **Returns:** `{ success: true, path: string }`

### 4. `memory_read`
Read the current MEMORY.md file.
- **Input:** `{}`
- **Returns:** `{ content: string }`

### 5. `memory_update`
Append to or rewrite sections of MEMORY.md.
- **Input:** `{ action: 'append' | 'rewrite', content: string }`
- **Execution:** For 'append', add to end. For 'rewrite', replace entire file.
- **Returns:** `{ success: true }`

### 6. `web_fetch`
Fetch a URL and return the text content.
- **Input:** `{ url: string }`
- **Execution:** `fetch()` with a 15s timeout, extract text, truncate to 20,000 chars
- **Returns:** `{ content: string, status: number }`

### 7. `claude_code`
**This is the killer feature.** Shell out to Claude Code CLI for complex tasks.
- **Input:** `{ prompt: string, working_directory?: string }`
- **Execution:** `child_process.execSync('claude -p "..." --output-format stream-json', { cwd: working_directory || workspace })`
- **Parse the stream-json output to extract the final result text**
- **Timeout:** 300 seconds (5 min) for complex tasks
- **Returns:** `{ result: string }`
- **Note:** This inherits all of Claude Code's tools — file editing, bash, web search, MCP servers, etc. It's like having a senior engineer on call.

### 8. `schedule_task`
Create, list, or remove scheduled tasks.
- **Input:** `{ action: 'create' | 'list' | 'remove', name?: string, cron?: string, prompt?: string, task_id?: number }`
- **Execution:** CRUD on the scheduled_tasks table
- **Returns:** Confirmation or list of tasks

### 9. `think_hard`
For genuinely difficult reasoning — re-runs the current prompt through Opus with extended thinking.
- **Input:** `{ question: string }`
- **Execution:** Single Anthropic API call with `model: OPUS_MODEL` and `thinking: { type: 'enabled', budget_tokens: 10000 }`
- **Returns:** `{ reasoning: string, answer: string }`
- **Note:** Use sparingly — this is expensive. The agent should only use this when it recognizes it needs deeper reasoning.

## Core Agent Loop (pseudocode)

```typescript
async function runAgentLoop(chatId: string, userMessage: string): Promise<string> {
  // 1. Load conversation history from SQLite (last N messages, or token-budget based)
  const history = loadHistory(chatId, { maxMessages: 50 });

  // 2. Build messages array
  const messages = [
    ...history,
    { role: 'user', content: userMessage }
  ];

  // 3. Enter agent loop
  let iterations = 0;
  while (iterations < CONFIG.MAX_TOOL_ITERATIONS) {
    iterations++;

    // 4. Call Anthropic API
    const response = await anthropic.messages.create({
      model: CONFIG.MODEL,
      max_tokens: 4096,
      system: loadSystemPrompt(),
      tools: TOOLS,
      messages: messages,
    });

    // 5. Save assistant response to history
    saveMessage(chatId, 'assistant', response.content);

    // 6. Check stop reason
    if (response.stop_reason === 'end_turn') {
      // Extract text from content blocks
      const text = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
      return text;
    }

    if (response.stop_reason === 'tool_use') {
      // 7. Execute each tool call
      const toolResults = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          const result = await executeTool(block.name, block.input);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        }
      }

      // 8. Append assistant message + tool results to messages
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });

      // Save tool results to history
      saveMessage(chatId, 'tool_results', toolResults);
    }
  }

  return "⚠️ Hit max iterations. Task may be incomplete.";
}
```

## Telegram Integration

```typescript
// Polling-based (no webhooks, no public ports needed)
const bot = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN, { polling: true });

bot.on('message', async (msg) => {
  // Security: only respond to my user ID
  if (String(msg.from?.id) !== CONFIG.ALLOWED_USER_ID) return;

  const chatId = String(msg.chat.id);
  const text = msg.text;
  if (!text) return;

  // Send "typing" indicator
  bot.sendChatAction(chatId, 'typing');

  try {
    const response = await runAgentLoop(chatId, text);

    // Telegram has a 4096 char limit per message
    // Split long responses into chunks
    const chunks = splitMessage(response, 4000);
    for (const chunk of chunks) {
      await bot.sendMessage(msg.chat.id, chunk, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    await bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
  }
});
```

## Scheduler

```typescript
// Check for due tasks every 60 seconds
setInterval(async () => {
  const now = new Date();
  const dueTasks = db.prepare(`
    SELECT * FROM scheduled_tasks
    WHERE enabled = 1 AND next_run <= ?
  `).all(now.toISOString());

  for (const task of dueTasks) {
    try {
      const response = await runAgentLoop(task.chat_id, task.prompt);
      await bot.sendMessage(task.chat_id, `📋 **${task.name}**\n\n${response}`,
        { parse_mode: 'Markdown' });
    } catch (err) {
      await bot.sendMessage(task.chat_id, `❌ Scheduled task "${task.name}" failed: ${err.message}`);
    }

    // Update next_run based on cron expression
    const nextRun = getNextCronRun(task.cron_expression);
    db.prepare('UPDATE scheduled_tasks SET last_run = ?, next_run = ? WHERE id = ?')
      .run(now.toISOString(), nextRun.toISOString(), task.id);
  }
}, 60_000);
```

Use a small cron parser library (`cron-parser` npm package) for computing next run times. This is the ONE exception to the "no frameworks" rule because cron parsing is gnarly.

## Conversation History Management

- Store all messages in SQLite with timestamps
- When loading history for a new API call, load the last 50 messages by default
- If the conversation is getting long (rough token estimate > 80K), summarize older messages:
  - Take the oldest messages beyond the window
  - Summarize them into a single "Previously:" message
  - This keeps context while managing token costs
- Include a `/clear` Telegram command to reset conversation history for a chat

## MEMORY.md Format

The agent manages this file itself. Suggested initial structure:

```markdown
# Minion Memory

## About Brendan
- Works at Palantir in a leadership role managing software engineers
- Active cyclist, tracks on Strava
- Parent of young children

## Mac Mini Setup
- Apple Silicon Mac Mini, always-on, headless
- Minion runs here via launchd
- Claude Code CLI is installed and available
(agent fills in more as it discovers the environment — brew packages, node version, etc.)

## Active Projects
(agent fills this in as it learns)

## Preferences
(agent fills this in as it learns)

## Important Context
(agent fills this in as it learns)
```

## Commands

The agent should recognize these Telegram "commands" directly (parsed from message text, not Telegram bot commands):

- `/clear` — Reset conversation history for this chat
- `/tasks` — List all scheduled tasks
- `/memory` — Show current MEMORY.md contents
- `/status` — Show uptime, message count, pending tasks
- `/model opus` / `/model sonnet` — Switch default model for this session

## Running

```bash
# Install dependencies
npm install

# Set environment variables (add to ~/.zshrc or use a .env file)
export ANTHROPIC_API_KEY="sk-ant-..."
export TELEGRAM_BOT_TOKEN="..."
export TELEGRAM_USER_ID="..."

# Run directly
npx tsx minion.ts

# For persistent 24/7 operation on the Mac Mini, use a launchd plist:
```

### launchd (recommended for Mac Mini)

Create `~/Library/LaunchAgents/com.brendan.minion.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.brendan.minion</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/npx</string>
        <string>tsx</string>
        <string>minion.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/brendan/minion</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/brendan/minion/logs/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/brendan/minion/logs/stderr.log</string>
</dict>
</plist>
```

```bash
# Load it
launchctl load ~/Library/LaunchAgents/com.brendan.minion.plist

# Check status
launchctl list | grep minion

# Restart
launchctl kickstart -k gui/$(id -u)/com.brendan.minion

# View logs
tail -f ~/minion/logs/stdout.log
```

Note: Update the `ProgramArguments` path to wherever `npx` actually lives on your Mac Mini — run `which npx` to check. If using homebrew Node, it's likely `/opt/homebrew/bin/npx`.

## Error Handling

- **API errors:** Retry with exponential backoff (3 attempts max)
- **Tool errors:** Return the error message to the LLM so it can recover
- **Telegram errors:** Log and continue
- **Uncaught exceptions:** Log to file, restart via pm2
- **Rate limiting:** Respect Anthropic rate limits, queue messages if needed

## What NOT to Build

- No web UI. Telegram IS the UI.
- No plugin/skill system. Edit the code.
- No multi-user support. This is personal.
- No container isolation. I trust myself.
- No channel abstraction. It's Telegram.
- No config file format. It's environment variables.
- No authentication beyond Telegram user ID check.
- No MCP server integration (unless I add it later as a tool).

## Future Extensions (NOT part of MVP)

These are things I might want later but should NOT be built initially:
- Voice messages (Telegram voice → Whisper → text → agent → text → voice)
- Image understanding (forward images from Telegram, pass as base64 to API)
- Calendar integration
- Email integration
- Strava integration
- Proactive messages (agent notices something and messages me unprompted)
- Mac Mini system monitoring (disk space, uptime, running processes, network status)
- Home network awareness (devices on LAN, wake-on-LAN for other machines)
- AppleScript automations (control macOS apps, Shortcuts integration)

## Success Criteria

The MVP is done when I can:
1. Message my Telegram bot and get intelligent responses
2. Ask it to run shell commands and read/write files
3. Ask it to delegate complex tasks to Claude Code
4. Ask it to remember things and recall them later
5. Set up a scheduled daily briefing
6. Have it maintain conversation context across messages
