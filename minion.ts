import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import Database from 'better-sqlite3';
import TelegramBot from 'node-telegram-bot-api';
import { CronExpressionParser } from 'cron-parser';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { CONFIG } from './config.js';

// ── Database ──────────────────────────────────────────────────────────

fs.mkdirSync(path.dirname(CONFIG.DB_PATH), { recursive: true });
const db = new Database(CONFIG.DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    cron_expression TEXT NOT NULL,
    prompt TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    last_run DATETIME,
    next_run DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_tasks_next ON scheduled_tasks(next_run) WHERE enabled = 1;
`);

// ── Clients ───────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });
const bot = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN, { polling: true });

// ── Helpers ───────────────────────────────────────────────────────────

const workspaceDir = path.resolve(CONFIG.WORKSPACE_DIR);
fs.mkdirSync(workspaceDir, { recursive: true });

function loadSystemPrompt(): string {
  try {
    return fs.readFileSync(CONFIG.SYSTEM_PROMPT_FILE, 'utf-8');
  } catch {
    return 'You are Minion, a personal AI assistant running on a Mac Mini. Be concise and helpful.';
  }
}

function resolvePath(p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(workspaceDir, p);
}

async function downloadTelegramPhoto(fileId: string): Promise<{ base64: string; mime: string; ext: string }> {
  const fileLink = await bot.getFileLink(fileId);
  const resp = await fetch(fileLink);
  const buffer = Buffer.from(await resp.arrayBuffer());
  const ext = path.extname(new URL(fileLink).pathname).slice(1) || 'jpg';
  const mimeMap: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
  const mime = mimeMap[ext] || 'image/jpeg';
  return { base64: buffer.toString('base64'), mime, ext };
}

function splitMessage(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt === -1 || splitAt < limit / 2) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}

// ── History ───────────────────────────────────────────────────────────

const stmtInsertMsg = db.prepare(
  'INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)'
);
const stmtLoadHistory = db.prepare(
  'SELECT role, content FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?'
);
const stmtClearHistory = db.prepare('DELETE FROM messages WHERE chat_id = ?');
const stmtMessageCount = db.prepare('SELECT COUNT(*) as count FROM messages');

function saveMessage(chatId: string, role: string, content: unknown): void {
  stmtInsertMsg.run(chatId, role, JSON.stringify(content));
}

function loadHistory(chatId: string, maxMessages = 50): Anthropic.MessageParam[] {
  const rows = stmtLoadHistory.all(chatId, maxMessages) as { role: string; content: string }[];
  rows.reverse();

  const messages: Anthropic.MessageParam[] = [];
  for (const row of rows) {
    const content = JSON.parse(row.content);
    if (row.role === 'user' || row.role === 'assistant') {
      messages.push({ role: row.role, content });
    } else if (row.role === 'tool_results') {
      messages.push({ role: 'user', content });
    }
  }

  // Ensure messages alternate properly and start with 'user'
  const cleaned: Anthropic.MessageParam[] = [];
  for (const msg of messages) {
    const last = cleaned[cleaned.length - 1];
    if (last && last.role === msg.role) {
      // Merge consecutive same-role messages
      if (typeof last.content === 'string' && typeof msg.content === 'string') {
        last.content = last.content + '\n' + msg.content;
      } else {
        const lastArr = Array.isArray(last.content) ? last.content : [{ type: 'text' as const, text: last.content as string }];
        const msgArr = Array.isArray(msg.content) ? msg.content : [{ type: 'text' as const, text: msg.content as string }];
        last.content = [...lastArr, ...msgArr] as Anthropic.ContentBlockParam[];
      }
    } else {
      cleaned.push({ ...msg });
    }
  }

  // Must start with user, and first user message must not have orphaned tool_results
  while (cleaned.length > 0) {
    const first = cleaned[0];
    if (first.role !== 'user') {
      cleaned.shift();
      continue;
    }
    if (Array.isArray(first.content) && first.content.some((b: any) => b.type === 'tool_result')) {
      cleaned.shift();
      continue;
    }
    break;
  }

  return cleaned;
}

// ── Tool Definitions ──────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'bash',
    description: 'Execute a shell command on macOS. Returns stdout, stderr, and exit code. Use for quick system commands, brew, open, osascript, etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        timeout_seconds: { type: 'number', description: 'Timeout in seconds (default 30)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file. Path is relative to workspace or absolute.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path to read' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file (create or overwrite). Auto-creates directories.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path to write' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'memory_read',
    description: 'Read the persistent MEMORY.md file containing important context about Brendan and ongoing projects.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'memory_update',
    description: 'Update the persistent MEMORY.md file. Use "append" to add new info, "rewrite" to replace the entire file.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['append', 'rewrite'], description: 'append or rewrite' },
        content: { type: 'string', description: 'Content to append or full replacement content' },
      },
      required: ['action', 'content'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch a URL and return its text content. Useful for checking websites, APIs, documentation.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
      },
      required: ['url'],
    },
  },
  {
    name: 'claude_code',
    description: 'Delegate complex multi-step coding, debugging, or research tasks to Claude Code CLI. This gives access to full file editing, bash, web search, and MCP tools. Use for tasks that need multiple steps or deep context.',
    input_schema: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string', description: 'The task description for Claude Code' },
        working_directory: { type: 'string', description: 'Working directory (default: workspace)' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'schedule_task',
    description: 'Create, list, or remove scheduled tasks that run on a cron schedule.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'remove'], description: 'Action to perform' },
        name: { type: 'string', description: 'Task name (for create)' },
        cron: { type: 'string', description: 'Cron expression, e.g. "0 9 * * *" (for create)' },
        prompt: { type: 'string', description: 'Prompt to run when task fires (for create)' },
        task_id: { type: 'number', description: 'Task ID (for remove)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'think_hard',
    description: 'Use Opus with extended thinking for genuinely difficult reasoning tasks. Expensive — use sparingly.',
    input_schema: {
      type: 'object' as const,
      properties: {
        question: { type: 'string', description: 'The question requiring deep reasoning' },
      },
      required: ['question'],
    },
  },
];

// ── Tool Execution ────────────────────────────────────────────────────

const BLOCKED_PATTERNS = [/rm\s+-rf\s+\/(?!\w)/, /sudo\s+/];
const SAFE_COMMANDS = ['date', 'whoami', 'brew', 'system_profiler', 'sw_vers', 'uptime', 'df', 'which', 'echo', 'cat', 'ls', 'pwd', 'hostname', 'ifconfig', 'networksetup', 'pmset', 'sysctl', 'uname', 'open', 'osascript', 'pbcopy', 'pbpaste', 'defaults', 'top', 'ps'];

async function executeTool(name: string, input: Record<string, unknown>, chatId: string): Promise<unknown> {
  try {
    switch (name) {
      case 'bash': {
        const { command, timeout_seconds = 30 } = input as { command: string; timeout_seconds?: number };
        for (const pattern of BLOCKED_PATTERNS) {
          if (pattern.test(command)) {
            return { stdout: '', stderr: `Blocked: command matches safety pattern ${pattern}`, exit_code: 1 };
          }
        }
        try {
          const stdout = execSync(command, {
            cwd: workspaceDir,
            timeout: timeout_seconds * 1000,
            maxBuffer: 1024 * 1024,
            encoding: 'utf-8',
            env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` },
          });
          return { stdout: stdout.slice(0, 50000), stderr: '', exit_code: 0 };
        } catch (err: any) {
          return {
            stdout: (err.stdout || '').slice(0, 50000),
            stderr: (err.stderr || err.message || '').slice(0, 10000),
            exit_code: err.status ?? 1,
          };
        }
      }

      case 'read_file': {
        const { path: filePath } = input as { path: string };
        const resolved = resolvePath(filePath);
        const content = fs.readFileSync(resolved, 'utf-8');
        return { content: content.slice(0, 100000) };
      }

      case 'write_file': {
        const { path: filePath, content } = input as { path: string; content: string };
        const resolved = resolvePath(filePath);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, content, 'utf-8');
        return { success: true, path: resolved };
      }

      case 'memory_read': {
        const memPath = path.resolve(CONFIG.MEMORY_FILE);
        try {
          return { content: fs.readFileSync(memPath, 'utf-8') };
        } catch {
          return { content: '(MEMORY.md does not exist yet)' };
        }
      }

      case 'memory_update': {
        const { action, content } = input as { action: 'append' | 'rewrite'; content: string };
        const memPath = path.resolve(CONFIG.MEMORY_FILE);
        if (action === 'append') {
          fs.appendFileSync(memPath, '\n' + content, 'utf-8');
        } else {
          fs.writeFileSync(memPath, content, 'utf-8');
        }
        return { success: true };
      }

      case 'web_fetch': {
        const { url } = input as { url: string };
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
          const resp = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'Minion/1.0' },
          });
          const text = await resp.text();
          return { content: text.slice(0, 20000), status: resp.status };
        } finally {
          clearTimeout(timeout);
        }
      }

      case 'claude_code': {
        const { prompt, working_directory } = input as { prompt: string; working_directory?: string };
        const cwd = working_directory ? path.resolve(working_directory) : workspaceDir;
        try {
          const escaped = prompt.replace(/'/g, "'\\''");
          const output = execSync(`claude -p '${escaped}' --verbose --output-format stream-json`, {
            cwd,
            timeout: 300_000,
            maxBuffer: 10 * 1024 * 1024,
            encoding: 'utf-8',
            env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` },
          });
          // Parse stream-json: each line is a JSON object, extract result text from the last "result" message
          const lines = output.trim().split('\n');
          let resultText = '';
          for (const line of lines) {
            try {
              const obj = JSON.parse(line);
              if (obj.type === 'result' && obj.result) {
                resultText = obj.result;
              } else if (obj.type === 'assistant' && obj.message?.content) {
                // Accumulate assistant text blocks
                for (const block of obj.message.content) {
                  if (block.type === 'text') {
                    resultText = block.text;
                  }
                }
              }
            } catch {
              // Skip unparseable lines
            }
          }
          return { result: resultText || output.slice(-5000) };
        } catch (err: any) {
          return { result: `Claude Code error: ${(err.stderr || err.message || '').slice(0, 5000)}` };
        }
      }

      case 'schedule_task': {
        const { action, name: taskName, cron, prompt, task_id } = input as {
          action: 'create' | 'list' | 'remove';
          name?: string;
          cron?: string;
          prompt?: string;
          task_id?: number;
        };

        if (action === 'list') {
          const tasks = db.prepare('SELECT id, name, cron_expression, prompt, enabled, last_run, next_run FROM scheduled_tasks').all();
          return { tasks };
        }

        if (action === 'remove') {
          db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(task_id);
          return { success: true, removed: task_id };
        }

        if (action === 'create') {
          if (!taskName || !cron || !prompt) {
            return { error: 'name, cron, and prompt are required for create' };
          }
          const nextRun = getNextCronRun(cron);
          db.prepare(
            'INSERT INTO scheduled_tasks (name, cron_expression, prompt, chat_id, next_run) VALUES (?, ?, ?, ?, ?)'
          ).run(taskName, cron, prompt, chatId, nextRun.toISOString());
          return { success: true, name: taskName, cron, next_run: nextRun.toISOString() };
        }

        return { error: `Unknown action: ${action}` };
      }

      case 'think_hard': {
        const { question } = input as { question: string };
        const resp = await anthropic.messages.create({
          model: CONFIG.OPUS_MODEL,
          max_tokens: 16000,
          thinking: { type: 'enabled', budget_tokens: 10000 },
          messages: [{ role: 'user', content: question }],
        });

        let reasoning = '';
        let answer = '';
        for (const block of resp.content) {
          if (block.type === 'thinking') reasoning = block.thinking;
          if (block.type === 'text') answer += block.text;
        }
        return { reasoning: reasoning.slice(0, 5000), answer };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err: any) {
    return { error: err.message || String(err) };
  }
}

// ── Cron Helpers ──────────────────────────────────────────────────────

function getNextCronRun(cronExpr: string): Date {
  const expr = CronExpressionParser.parse(cronExpr);
  return expr.next().toDate();
}

// ── Agent Loop ────────────────────────────────────────────────────────

async function runAgentLoop(chatId: string, userMessage: string | Anthropic.ContentBlockParam[], saveAs?: string): Promise<string> {
  const history = loadHistory(chatId);

  const messages: Anthropic.MessageParam[] = [
    ...history,
    { role: 'user', content: userMessage },
  ];

  saveMessage(chatId, 'user', saveAs ?? userMessage);

  let iterations = 0;
  while (iterations < CONFIG.MAX_TOOL_ITERATIONS) {
    iterations++;

    let response: Anthropic.Message;
    try {
      response = await callWithRetry(() =>
        anthropic.messages.create({
          model: CONFIG.MODEL,
          max_tokens: 4096,
          system: loadSystemPrompt(),
          tools: TOOLS,
          messages,
        })
      );
    } catch (err: any) {
      return `API error: ${err.message}`;
    }

    saveMessage(chatId, 'assistant', response.content);

    if (response.stop_reason === 'end_turn' || response.stop_reason === 'max_tokens') {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      return text || '(no response)';
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type === 'tool_use') {
          console.log(`[tool] ${block.name}(${JSON.stringify(block.input).slice(0, 200)})`);
          const result = await executeTool(block.name, block.input as Record<string, unknown>, chatId);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result).slice(0, 50000),
          });
        }
      }

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });

      saveMessage(chatId, 'tool_results', toolResults);

      // Keep sending typing indicator during tool loops
      bot.sendChatAction(Number(chatId), 'typing').catch(() => {});
    }
  }

  return '⚠️ Hit max iterations. Task may be incomplete.';
}

// ── Retry Helper ──────────────────────────────────────────────────────

async function callWithRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (i === retries - 1) throw err;
      const isRateLimit = err.status === 429;
      const delay = isRateLimit ? 5000 * (i + 1) : 1000 * (i + 1);
      console.log(`[retry] Attempt ${i + 1} failed: ${err.message}. Retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error('Unreachable');
}

// ── Session State ─────────────────────────────────────────────────────

const startTime = Date.now();

// ── Telegram Commands & Messages ──────────────────────────────────────

bot.on('message', async (msg) => {
  if (String(msg.from?.id) !== CONFIG.ALLOWED_USER_ID) return;

  const chatId = String(msg.chat.id);

  // Handle photos
  if (msg.photo && msg.photo.length > 0) {
    const photo = msg.photo[msg.photo.length - 1]; // largest resolution
    const caption = msg.caption || "What's in this image?";

    bot.sendChatAction(msg.chat.id, 'typing').catch(() => {});

    try {
      const { base64, mime, ext } = await downloadTelegramPhoto(photo.file_id);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `${timestamp}-${photo.file_unique_id}.${ext}`;
      const imagesDir = path.join(workspaceDir, 'images');
      fs.mkdirSync(imagesDir, { recursive: true });
      fs.writeFileSync(path.join(imagesDir, filename), Buffer.from(base64, 'base64'));

      const contentBlocks: Anthropic.ContentBlockParam[] = [
        { type: 'image', source: { type: 'base64', media_type: mime as 'image/jpeg', data: base64 } },
        { type: 'text', text: caption },
      ];
      const saveAs = `[Image: workspace/images/${filename}] ${caption}`;

      const response = await runAgentLoop(chatId, contentBlocks, saveAs);
      const chunks = splitMessage(response);
      for (const chunk of chunks) {
        await bot.sendMessage(msg.chat.id, chunk, { parse_mode: 'Markdown' }).catch(() =>
          bot.sendMessage(msg.chat.id, chunk)
        );
      }
    } catch (err: any) {
      console.error('[error] photo handling:', err);
      await bot.sendMessage(msg.chat.id, `❌ Error processing image: ${err.message}`);
    }
    return;
  }

  const text = msg.text;
  if (!text) return;

  // Handle commands
  if (text === '/clear') {
    stmtClearHistory.run(chatId);
    await bot.sendMessage(msg.chat.id, 'Conversation cleared.');
    return;
  }

  if (text === '/tasks') {
    const tasks = db.prepare('SELECT id, name, cron_expression, enabled, next_run FROM scheduled_tasks').all() as any[];
    if (tasks.length === 0) {
      await bot.sendMessage(msg.chat.id, 'No scheduled tasks.');
      return;
    }
    const lines = tasks.map((t: any) => `${t.enabled ? '✅' : '❌'} #${t.id} ${t.name} — \`${t.cron_expression}\`\nNext: ${t.next_run || 'N/A'}`);
    await bot.sendMessage(msg.chat.id, lines.join('\n\n'), { parse_mode: 'Markdown' });
    return;
  }

  if (text === '/memory') {
    try {
      const content = fs.readFileSync(path.resolve(CONFIG.MEMORY_FILE), 'utf-8');
      const chunks = splitMessage(content);
      for (const chunk of chunks) {
        await bot.sendMessage(msg.chat.id, chunk);
      }
    } catch {
      await bot.sendMessage(msg.chat.id, 'No memory file found.');
    }
    return;
  }

  if (text === '/status') {
    const uptimeMs = Date.now() - startTime;
    const uptimeH = (uptimeMs / 3600000).toFixed(1);
    const msgCount = (stmtMessageCount.get() as any).count;
    const taskCount = (db.prepare('SELECT COUNT(*) as count FROM scheduled_tasks WHERE enabled = 1').get() as any).count;
    await bot.sendMessage(msg.chat.id,
      `Uptime: ${uptimeH}h\nMessages: ${msgCount}\nActive tasks: ${taskCount}\nModel: ${CONFIG.MODEL}`
    );
    return;
  }

  if (text.startsWith('/model ')) {
    const model = text.slice(7).trim().toLowerCase();
    if (model === 'opus') {
      (CONFIG as any).MODEL = CONFIG.OPUS_MODEL;
      await bot.sendMessage(msg.chat.id, `Switched to Opus (${CONFIG.OPUS_MODEL})`);
    } else if (model === 'sonnet') {
      (CONFIG as any).MODEL = 'claude-sonnet-4-5-20250929';
      await bot.sendMessage(msg.chat.id, `Switched to Sonnet`);
    } else {
      await bot.sendMessage(msg.chat.id, 'Usage: /model opus | /model sonnet');
    }
    return;
  }

  // Regular message — run agent loop
  bot.sendChatAction(msg.chat.id, 'typing').catch(() => {});

  try {
    const response = await runAgentLoop(chatId, text);
    const chunks = splitMessage(response);
    for (const chunk of chunks) {
      await bot.sendMessage(msg.chat.id, chunk, { parse_mode: 'Markdown' }).catch(() =>
        // Fallback: send without markdown if parsing fails
        bot.sendMessage(msg.chat.id, chunk)
      );
    }
  } catch (err: any) {
    console.error('[error]', err);
    await bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
  }
});

// ── Scheduler ─────────────────────────────────────────────────────────

setInterval(async () => {
  const now = new Date();
  const dueTasks = db.prepare(
    'SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run <= ?'
  ).all(now.toISOString()) as any[];

  for (const task of dueTasks) {
    try {
      console.log(`[scheduler] Running task: ${task.name}`);
      const response = await runAgentLoop(task.chat_id, task.prompt);
      const chunks = splitMessage(`📋 *${task.name}*\n\n${response}`);
      for (const chunk of chunks) {
        await bot.sendMessage(Number(task.chat_id), chunk, { parse_mode: 'Markdown' }).catch(() =>
          bot.sendMessage(Number(task.chat_id), chunk)
        );
      }
    } catch (err: any) {
      console.error(`[scheduler] Task "${task.name}" failed:`, err);
      await bot.sendMessage(Number(task.chat_id), `❌ Scheduled task "${task.name}" failed: ${err.message}`).catch(() => {});
    }

    // Update next_run
    const nextRun = getNextCronRun(task.cron_expression);
    db.prepare('UPDATE scheduled_tasks SET last_run = ?, next_run = ? WHERE id = ?')
      .run(now.toISOString(), nextRun.toISOString(), task.id);
  }
}, 60_000);

// ── Startup ───────────────────────────────────────────────────────────

console.log('🤖 Minion is running');
console.log(`   Model: ${CONFIG.MODEL}`);
console.log(`   Workspace: ${workspaceDir}`);
console.log(`   DB: ${path.resolve(CONFIG.DB_PATH)}`);
