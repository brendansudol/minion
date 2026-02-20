# Minion

A personal AI assistant that lives in a Telegram chat, running 24/7 on a Mac Mini. Uses the Anthropic Messages API with tool use to run an agentic loop. It can execute shell commands, read/write files, search the web, remember things, run scheduled tasks, and shell out to `claude -p` for heavy-lift coding/research tasks.

## Architecture

```
Telegram Bot API (polling)
        │
        ▼
┌─────────────────────┐
│   minion.ts          │
│                      │
│  ┌────────────────┐  │
│  │ Agent Loop     │  │  ← Anthropic Messages API with tool_use
│  │ (while loop)   │  │
│  └───────┬────────┘  │
│          │           │
│  ┌───────▼────────┐  │
│  │ Tool Executor  │  │  ← bash, read_file, write_file, memory_read,
│  └────────────────┘  │    memory_update, claude_code, schedule_task,
│                      │    think_hard, twitter, web_search*, web_fetch*
│                      │    (* = server-side, handled by Anthropic)
│                      │
│  ┌────────────────┐  │
│  │ SQLite Store   │  │  ← conversations, scheduled tasks
│  └────────────────┘  │
│                      │
│  ┌────────────────┐  │
│  │ Scheduler      │  │  ← setInterval, checks cron table every 60s
│  └────────────────┘  │
└──────────────────────┘
```

## Quick Start

```bash
# Install dependencies
npm install

# Set environment variables
export ANTHROPIC_API_KEY="sk-ant-..."
export TELEGRAM_BOT_TOKEN="..."
export TELEGRAM_USER_ID="..."

# Run
npm start
```

### Creating a Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token — that's your `TELEGRAM_BOT_TOKEN`
4. To find your user ID, message [@userinfobot](https://t.me/userinfobot) — that's your `TELEGRAM_USER_ID`

## File Structure

```
minion/
├── minion.ts            # Everything lives here (under 1k lines)
├── config.ts            # Env vars + constants
├── package.json
├── tsconfig.json
├── .gitignore
├── prompts/
│   ├── SYSTEM_PROMPT.md # Editable system prompt (agent personality)
│   └── MEMORY.md        # Persistent memory the agent reads/writes
├── data/
│   └── minion.db        # SQLite database (auto-created)
├── workspace/           # Working directory for agent file operations
└── logs/                # stdout/stderr when running via launchd
```

## Tools

The agent has 10 tools available (8 client-side + 2 server-side):

| Tool | Description |
|------|-------------|
| `bash` | Execute shell commands on macOS (30s default timeout) |
| `read_file` | Read file contents (relative to workspace or absolute) |
| `write_file` | Write/create files with auto-created directories |
| `memory_read` | Read the persistent MEMORY.md |
| `memory_update` | Append to or rewrite MEMORY.md |
| `claude_code` | Delegate to Claude Code CLI for complex multi-step tasks (5 min timeout) |
| `schedule_task` | Create, list, or remove cron-scheduled tasks |
| `think_hard` | Send a question to Opus with extended thinking for hard reasoning |
| `twitter` | Read tweets, view user timelines, or search recent X/Twitter posts |
| `web_search` | Search the web (server-side, handled by Anthropic) |
| `web_fetch` | Fetch and read a URL (server-side, handled by Anthropic) |

### claude_code

The killer feature. Shells out to `claude -p "..." --output-format stream-json`, giving the agent access to Claude Code's full toolset — file editing, bash, web search, MCP servers, etc. Use this for complex multi-step coding, debugging, or research tasks.

### think_hard

Calls Opus with extended thinking (10K budget tokens) for genuinely difficult reasoning. Expensive — the agent should only reach for this when it recognizes it needs deeper analysis.

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/clear` | Reset conversation history |
| `/tasks` | List all scheduled tasks |
| `/memory` | Show current MEMORY.md contents |
| `/status` | Show uptime, message count, pending tasks, current model |
| `/model opus` | Switch to Opus for this session |
| `/model sonnet` | Switch back to Sonnet |

Anything else you send is treated as a regular message and goes through the agent loop.

## How the Agent Loop Works

1. Load conversation history from SQLite (last 50 messages within 4-hour window)
2. Append the new user message
3. Call the Anthropic Messages API with the system prompt, tools, and messages
4. If the model returns `end_turn` — extract text and reply
5. If the model returns `pause_turn` — server-side tool still running; pass response back and continue the loop
6. If the model returns `tool_use` — execute each tool call, append results, and loop back to step 3
7. Safety cap at 25 iterations per message

API calls retry with exponential backoff (3 attempts, longer delays for rate limits).

## Conversation History

All messages are persisted in SQLite. When loading history for an API call, the last 50 messages within a 4-hour window are fetched and cleaned to ensure proper user/assistant alternation (required by the Anthropic API). Use `/clear` to reset.

## Scheduler

A `setInterval` checks the `scheduled_tasks` table every 60 seconds. When a task is due:

1. Runs the task's prompt through the agent loop
2. Sends the response to the associated Telegram chat
3. Computes the next run time from the cron expression and updates the row

You can create scheduled tasks by asking the agent directly, e.g.:
> "Set up a daily briefing at 9am that checks my calendar and summarizes the weather"

Or the agent uses the `schedule_task` tool programmatically with standard 5-field cron expressions (`min hour dom mon dow`).

## System Prompt

The agent's personality and instructions are loaded from `SYSTEM_PROMPT.md`. Edit this file to change behavior without touching code. If the file is missing, a minimal default is used.

## Memory

`MEMORY.md` is a persistent file the agent reads and writes to remember context across conversations — facts about you, project details, preferences, machine setup, etc. The agent manages the structure itself.

## Configuration

All configuration is in `config.ts` via environment variables:

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from BotFather |
| `TELEGRAM_USER_ID` | Your Telegram user ID (only this user gets responses) |
| `X_BEARER_TOKEN` | X/Twitter API bearer token (optional, for twitter tool) |

Other constants in `config.ts`:

| Key | Default | Description |
|-----|---------|-------------|
| `MODEL` | `claude-sonnet-4-6` | Default model for daily use |
| `OPUS_MODEL` | `claude-opus-4-6` | Model for think_hard |
| `MAX_TOOL_ITERATIONS` | `25` | Safety cap on agent loop iterations |
| `WORKSPACE_DIR` | `./workspace` | Working directory for file operations |
| `MEMORY_FILE` | `./prompts/MEMORY.md` | Path to persistent memory |
| `DB_PATH` | `./data/minion.db` | SQLite database path |
| `SYSTEM_PROMPT_FILE` | `./prompts/SYSTEM_PROMPT.md` | System prompt file path |

## Running 24/7 with launchd

For persistent operation on a Mac Mini, create a launchd plist:

```bash
# Create the plist
cat > ~/Library/LaunchAgents/com.minion.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.minion</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/npx</string>
        <string>tsx</string>
        <string>minion.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/brendansudol/Documents/code/minion</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>ANTHROPIC_API_KEY</key>
        <string>YOUR_KEY_HERE</string>
        <key>TELEGRAM_BOT_TOKEN</key>
        <string>YOUR_TOKEN_HERE</string>
        <key>TELEGRAM_USER_ID</key>
        <string>YOUR_ID_HERE</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/brendansudol/Documents/code/minion/logs/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/brendansudol/Documents/code/minion/logs/stderr.log</string>
</dict>
</plist>
EOF

# Load it
launchctl load ~/Library/LaunchAgents/com.minion.plist

# Check status
launchctl list | grep minion

# Restart
launchctl kickstart -k gui/$(id -u)/com.minion

# View logs
tail -f ~/Documents/code/minion/logs/stdout.log
```

Update the `ProgramArguments` path if `npx` is installed elsewhere — run `which npx` to check.

## Safety

- Only responds to the configured `TELEGRAM_USER_ID`
- Blocks `rm -rf /` and `sudo` in bash commands
- Shell commands default to 30s timeout, claude_code to 5 min
- Agent loop capped at 25 iterations per message
- Tool outputs truncated to prevent context blowouts
- API calls retry with exponential backoff (rate limit aware)

## Dependencies

Only 5 runtime dependencies:

- `@anthropic-ai/sdk` — Anthropic Messages API
- `better-sqlite3` — SQLite for conversations + scheduled tasks
- `node-telegram-bot-api` — Telegram bot polling
- `cron-parser` — Cron expression parsing for the scheduler
- `dotenv` — Load environment variables from `.env`

No web frameworks, no ORMs, no abstractions.

## Development

```bash
# Run with file watching (auto-restart on changes)
npm run dev
```
