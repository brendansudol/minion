import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import Database from 'better-sqlite3';
import TelegramBot from 'node-telegram-bot-api';
import { CronExpressionParser } from 'cron-parser';
import { execSync, spawn, ChildProcess } from 'child_process';
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

// Database row types
interface CountRow { count: number }
interface HistoryRow { role: string; content: string }
interface TaskListRow {
  id: number;
  name: string;
  cron_expression: string;
  enabled: number;
  next_run: string | null;
}
interface ScheduledTaskRow extends TaskListRow {
  prompt: string;
  chat_id: string;
  last_run: string | null;
}

// Error helpers
interface ExecError extends Error {
  stdout?: string;
  stderr?: string;
  status?: number | null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Clients ───────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });
const bot = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN, { polling: true });

// ── Helpers ───────────────────────────────────────────────────────────

const workspaceDir = path.resolve(CONFIG.WORKSPACE_DIR);
fs.mkdirSync(workspaceDir, { recursive: true });

function loadSystemPrompt(): string {
  let prompt: string;
  try {
    prompt = fs.readFileSync(CONFIG.SYSTEM_PROMPT_FILE, 'utf-8');
  } catch {
    prompt = 'You are Minion, a personal AI assistant running on a Mac Mini. Be concise and helpful.';
  }

  try {
    const memory = fs.readFileSync(path.resolve(CONFIG.MEMORY_FILE), 'utf-8').trim();
    if (memory) {
      prompt += `\n\n---\n\n## Memory\n\nThe following is your persistent memory — durable facts, preferences, and guardrails. Refer to it as needed.\n\n${memory}`;
    }
  } catch {
    // No memory file yet — that's fine
  }

  return prompt;
}

function resolvePath(p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(workspaceDir, p);
}

async function downloadTelegramPhoto(fileId: string): Promise<{ base64: string; mime: Anthropic.Base64ImageSource['media_type']; ext: string }> {
  const fileLink = await bot.getFileLink(fileId);
  const resp = await fetch(fileLink);
  const buffer = Buffer.from(await resp.arrayBuffer());
  const ext = path.extname(new URL(fileLink).pathname).slice(1) || 'jpg';
  const mimeMap: Record<string, Anthropic.Base64ImageSource['media_type']> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
  const mime = mimeMap[ext] || 'image/jpeg';
  return { base64: buffer.toString('base64'), mime, ext };
}

function splitMessage(text: string, limit = 4_000): string[] {
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
const stmtLoadHistory = db.prepare<[string, number, number], HistoryRow>(
  `SELECT role, content FROM messages
   WHERE chat_id = ? AND timestamp > datetime('now', '-' || ? || ' minutes')
   ORDER BY timestamp DESC LIMIT ?`
);
const stmtClearHistory = db.prepare('DELETE FROM messages WHERE chat_id = ?');
const stmtMessageCount = db.prepare<[], CountRow>('SELECT COUNT(*) as count FROM messages');

function saveMessage(chatId: string, role: string, content: unknown): void {
  stmtInsertMsg.run(chatId, role, JSON.stringify(content));
}

function loadHistory(chatId: string): Anthropic.MessageParam[] {
  const rows = stmtLoadHistory.all(chatId, CONFIG.HISTORY_TTL_MINUTES, CONFIG.MAX_HISTORY_MESSAGES);
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
    if (Array.isArray(first.content) && first.content.some((b) => b.type === 'tool_result')) {
      cleaned.shift();
      continue;
    }
    break;
  }

  return cleaned;
}

// ── Tool Definitions ──────────────────────────────────────────────────

const TOOLS: Anthropic.Messages.ToolUnion[] = [
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
  {
    name: 'twitter',
    description: 'Read tweets, view user timelines, or search X/Twitter. Use read_tweet to fetch a specific tweet by URL or ID. Use user_timeline to get recent tweets from a user. Use search to find recent tweets.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['read_tweet', 'user_timeline', 'search'], description: 'Action to perform' },
        tweet_id: { type: 'string', description: 'Tweet ID or full URL (for read_tweet)' },
        username: { type: 'string', description: 'X/Twitter username without @ (for user_timeline)' },
        query: { type: 'string', description: 'Search query (for search)' },
        max_results: { type: 'number', description: 'Max results 10-100 (default 10, for search)' },
      },
      required: ['action'],
    },
  },
  // Server-side tools (executed by Anthropic, not client-side)
  { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
  { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 5 },
];

// ── Tool Execution ────────────────────────────────────────────────────

const BLOCKED_PATTERNS = [/rm\s+-rf\s+\/(?!\w)/, /sudo\s+/];

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
          return { stdout: stdout.slice(0, 50_000), stderr: '', exit_code: 0 };
        } catch (err) {
          const e = err as ExecError;
          return {
            stdout: (e.stdout || '').slice(0, 50_000),
            stderr: (e.stderr || e.message || '').slice(0, 10_000),
            exit_code: e.status ?? 1,
          };
        }
      }

      case 'read_file': {
        const { path: filePath } = input as { path: string };
        const resolved = resolvePath(filePath);
        const content = fs.readFileSync(resolved, 'utf-8');
        return { content: content.slice(0, 100_000) };
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

      case 'claude_code': {
        const { prompt, working_directory } = input as { prompt: string; working_directory?: string };
        const cwd = working_directory ? path.resolve(working_directory) : workspaceDir;
        const jobId = nextJobId++;

        bot.sendMessage(Number(chatId), `⏳ Running Claude Code job #${jobId}...`).catch(() => {});

        // Fire and forget — result will be posted when complete
        runClaudeCodeAsync(jobId, chatId, prompt, cwd).catch(err => console.error(`[job#${jobId}]`, err));

        return { job_started: true, job_id: jobId, note: 'Background job started; results posted when complete.' };
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
          max_tokens: 16_000,
          thinking: { type: 'enabled', budget_tokens: 10_000 },
          messages: [{ role: 'user', content: question }],
        });

        let reasoning = '';
        let answer = '';
        for (const block of resp.content) {
          if (block.type === 'thinking') reasoning = block.thinking;
          if (block.type === 'text') answer += block.text;
        }
        return { reasoning: reasoning.slice(0, 5_000), answer };
      }

      case 'twitter': {
        if (!CONFIG.X_BEARER_TOKEN) {
          return { error: 'X_BEARER_TOKEN not configured in .env' };
        }
        const { action, tweet_id, username, query, max_results = 10 } = input as {
          action: 'read_tweet' | 'user_timeline' | 'search';
          tweet_id?: string;
          username?: string;
          query?: string;
          max_results?: number;
        };

        const tweetFields = 'text,author_id,created_at,public_metrics';
        const expansions = 'author_id';
        const userFields = 'username,name';

        const xFetch = async (endpoint: string) => {
          const resp = await fetch(`https://api.x.com/2${endpoint}`, {
            headers: { Authorization: `Bearer ${CONFIG.X_BEARER_TOKEN}` },
          });
          if (!resp.ok) {
            const body = await resp.text();
            return { error: `X API ${resp.status}: ${body.slice(0, 1_000)}` };
          }
          return resp.json();
        };

        if (action === 'read_tweet') {
          if (!tweet_id) return { error: 'tweet_id is required for read_tweet' };
          const id = tweet_id.match(/status\/(\d+)/)?.[1] || tweet_id;
          const data = await xFetch(`/tweets/${id}?tweet.fields=${tweetFields}&expansions=${expansions}&user.fields=${userFields}`);
          return data;
        }

        if (action === 'user_timeline') {
          if (!username) return { error: 'username is required for user_timeline' };
          const userResp = await xFetch(`/users/by/username/${encodeURIComponent(username)}`);
          if (userResp.error) return userResp;
          const userId = userResp.data?.id;
          if (!userId) return { error: `User not found: ${username}` };
          const n = Math.min(Math.max(max_results, 5), 100);
          const params = new URLSearchParams({
            max_results: String(n),
            'tweet.fields': tweetFields,
            expansions,
            'user.fields': userFields,
          });
          const data = await xFetch(`/users/${userId}/tweets?${params}`);
          return data;
        }

        if (action === 'search') {
          if (!query) return { error: 'query is required for search' };
          const n = Math.min(Math.max(max_results, 10), 100);
          const params = new URLSearchParams({
            query,
            max_results: String(n),
            'tweet.fields': tweetFields,
            expansions,
            'user.fields': userFields,
          });
          const data = await xFetch(`/tweets/search/recent?${params}`);
          return data;
        }

        return { error: `Unknown twitter action: ${action}` };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err: unknown) {
    return { error: errMsg(err) };
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
          model: currentModel,
          max_tokens: 4_096,
          system: loadSystemPrompt(),
          tools: TOOLS,
          messages,
        })
      );
    } catch (err: unknown) {
      return `API error: ${errMsg(err)}`;
    }

    saveMessage(chatId, 'assistant', response.content);

    for (const block of response.content) {
      if (block.type === 'server_tool_use') {
        console.log(`[server_tool] ${block.name}(${JSON.stringify(block.input).slice(0, 200)})`);
      }
    }

    if (response.stop_reason === 'end_turn' || response.stop_reason === 'max_tokens') {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      return text || '(no response)';
    }

    if (response.stop_reason === 'pause_turn') {
      // API paused a long-running server tool turn; pass response back to continue
      messages.push({ role: 'assistant', content: response.content as Anthropic.ContentBlockParam[] });
      bot.sendChatAction(Number(chatId), 'typing').catch(() => {});
      continue;
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
            content: JSON.stringify(result).slice(0, 50_000),
          });
        }
      }

      messages.push({ role: 'assistant', content: response.content as Anthropic.ContentBlockParam[] });

      if (toolResults.length > 0) {
        messages.push({ role: 'user', content: toolResults });
        saveMessage(chatId, 'tool_results', toolResults);
      }

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
    } catch (err: unknown) {
      if (i === retries - 1) throw err;
      const isRateLimit = err instanceof Anthropic.RateLimitError;
      const delay = isRateLimit ? 5_000 * (i + 1) : 1_000 * (i + 1);
      console.log(`[retry] Attempt ${i + 1} failed: ${errMsg(err)}. Retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error('Unreachable');
}

// ── Session State ─────────────────────────────────────────────────────

const startTime = Date.now();
let currentModel: string = CONFIG.MODEL;

// ── Background Jobs & Chat Queue ──────────────────────────────────────

let nextJobId = 1;
const activeJobs = new Map<number, { chatId: string; excerpt: string; process: ChildProcess }>();
const chatQueues = new Map<string, Promise<void>>();

function enqueueChatTask(chatId: string, task: () => Promise<void>): void {
  const prior = chatQueues.get(chatId) || Promise.resolve();
  const chain = prior.then(task).catch(err => console.error('[queue]', err));
  chatQueues.set(chatId, chain);
  chain.then(() => { if (chatQueues.get(chatId) === chain) chatQueues.delete(chatId); });
}

async function sendChatMessage(chatId: string, text: string): Promise<void> {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    await bot.sendMessage(Number(chatId), chunk, { parse_mode: 'Markdown' }).catch(() =>
      bot.sendMessage(Number(chatId), chunk)
    );
  }
}

function parseStreamJsonLine(line: string, acc: { resultText: string }): void {
  try {
    const obj = JSON.parse(line);
    if (obj.type === 'result' && obj.result) {
      acc.resultText = obj.result;
    } else if (obj.type === 'assistant' && obj.message?.content) {
      for (const block of obj.message.content) {
        if (block.type === 'text') acc.resultText = block.text;
      }
    }
  } catch {}
}

async function runClaudeCodeAsync(jobId: number, chatId: string, prompt: string, cwd: string): Promise<void> {
  const excerpt = prompt.slice(0, 200);
  const child = spawn('claude', ['-p', prompt, '--verbose', '--output-format', 'stream-json'], {
    cwd,
    env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` },
  });

  activeJobs.set(jobId, { chatId, excerpt, process: child });

  let stdoutTail = '';
  let stderrTail = '';
  let remainder = '';
  let timedOut = false;
  const acc = { resultText: '' };

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 300_000);

  child.stdout.on('data', (chunk: Buffer) => {
    const str = chunk.toString();
    stdoutTail += str;
    if (stdoutTail.length > 50_000) stdoutTail = stdoutTail.slice(-50_000);
    remainder += str;
    const lines = remainder.split('\n');
    remainder = lines.pop()!;
    for (const line of lines) {
      if (line.trim()) parseStreamJsonLine(line, acc);
    }
  });

  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail += chunk.toString();
    if (stderrTail.length > 10_000) stderrTail = stderrTail.slice(-10_000);
  });

  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      let settled = false;
      child.on('close', (code) => { if (!settled) { settled = true; resolve(code); } });
      child.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
    });

    clearTimeout(timer);

    if (remainder.trim()) parseStreamJsonLine(remainder, acc);

    let message: string;
    if (timedOut) {
      message = `[Background job #${jobId} timed out | claude_code | request: ${excerpt}]\n\nJob killed after 5-minute timeout.`;
    } else if (exitCode !== 0 && !acc.resultText) {
      message = `[Background job #${jobId} failed | claude_code | request: ${excerpt}]\n\n${stderrTail || 'Unknown error (exit code ' + exitCode + ')'}`;
    } else {
      const result = acc.resultText || stdoutTail.slice(-5_000);
      message = `[Background job #${jobId} completed | claude_code | request: ${excerpt}]\n\n${result}`;
    }

    saveMessage(chatId, 'assistant', message);
    await sendChatMessage(chatId, message);
  } catch (err) {
    clearTimeout(timer);
    const message = `[Background job #${jobId} failed | claude_code | request: ${excerpt}]\n\n${errMsg(err)}`;
    saveMessage(chatId, 'assistant', message);
    await sendChatMessage(chatId, message);
  } finally {
    activeJobs.delete(jobId);
  }
}

// ── Telegram Commands & Messages ──────────────────────────────────────

bot.on('message', async (msg) => {
  if (String(msg.from?.id) !== CONFIG.ALLOWED_USER_ID) return;

  const chatId = String(msg.chat.id);

  // Handle photos
  if (msg.photo && msg.photo.length > 0) {
    const photo = msg.photo[msg.photo.length - 1]; // largest resolution
    const caption = msg.caption || "What's in this image?";

    enqueueChatTask(chatId, async () => {
      bot.sendChatAction(msg.chat.id, 'typing').catch(() => {});

      try {
        const { base64, mime, ext } = await downloadTelegramPhoto(photo.file_id);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${timestamp}-${photo.file_unique_id}.${ext}`;
        const imagesDir = path.join(workspaceDir, 'images');
        fs.mkdirSync(imagesDir, { recursive: true });
        fs.writeFileSync(path.join(imagesDir, filename), Buffer.from(base64, 'base64'));

        const contentBlocks: Anthropic.ContentBlockParam[] = [
          { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
          { type: 'text', text: caption },
        ];
        const saveAs = `[Image: workspace/images/${filename}] ${caption}`;

        const response = await runAgentLoop(chatId, contentBlocks, saveAs);
        await sendChatMessage(chatId, response);
      } catch (err: unknown) {
        console.error('[error] photo handling:', err);
        await bot.sendMessage(msg.chat.id, `❌ Error processing image: ${errMsg(err)}`);
      }
    });
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
    const tasks = db.prepare<[], TaskListRow>('SELECT id, name, cron_expression, enabled, next_run FROM scheduled_tasks').all();
    if (tasks.length === 0) {
      await bot.sendMessage(msg.chat.id, 'No scheduled tasks.');
      return;
    }
    const lines = tasks.map((t) => `${t.enabled ? '✅' : '❌'} #${t.id} ${t.name} — \`${t.cron_expression}\`\nNext: ${t.next_run || 'N/A'}`);
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
    const uptimeH = (uptimeMs / 3_600_000).toFixed(1);
    const msgCount = stmtMessageCount.get()?.count ?? 0;
    const taskCount = db.prepare<[], CountRow>('SELECT COUNT(*) as count FROM scheduled_tasks WHERE enabled = 1').get()?.count ?? 0;
    await bot.sendMessage(msg.chat.id,
      `Uptime: ${uptimeH}h\nMessages: ${msgCount}\nActive tasks: ${taskCount}\nModel: ${currentModel}`
    );
    return;
  }

  if (text.startsWith('/model ')) {
    const model = text.slice(7).trim().toLowerCase();
    if (model === 'opus') {
      currentModel = CONFIG.OPUS_MODEL;
      await bot.sendMessage(msg.chat.id, `Switched to Opus (${CONFIG.OPUS_MODEL})`);
    } else if (model === 'sonnet') {
      currentModel = CONFIG.MODEL;
      await bot.sendMessage(msg.chat.id, `Switched to Sonnet (${CONFIG.MODEL})`);
    } else {
      await bot.sendMessage(msg.chat.id, 'Usage: /model opus | /model sonnet');
    }
    return;
  }

  // Regular message — run agent loop
  enqueueChatTask(chatId, async () => {
    bot.sendChatAction(msg.chat.id, 'typing').catch(() => {});

    try {
      const response = await runAgentLoop(chatId, text);
      await sendChatMessage(chatId, response);
    } catch (err: unknown) {
      console.error('[error]', err);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${errMsg(err)}`);
    }
  });
});

// ── Scheduler ─────────────────────────────────────────────────────────

const schedulerInterval = setInterval(async () => {
  const now = new Date();
  const dueTasks = db.prepare<[string], ScheduledTaskRow>(
    'SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run <= ?'
  ).all(now.toISOString());

  for (const task of dueTasks) {
    // Claim-first: advance next_run before enqueueing to prevent duplicate runs
    const nextRun = getNextCronRun(task.cron_expression);
    db.prepare('UPDATE scheduled_tasks SET last_run = ?, next_run = ? WHERE id = ?')
      .run(now.toISOString(), nextRun.toISOString(), task.id);

    enqueueChatTask(task.chat_id, async () => {
      try {
        console.log(`[scheduler] Running task: ${task.name}`);
        const response = await runAgentLoop(task.chat_id, task.prompt);
        await sendChatMessage(task.chat_id, `📋 *${task.name}*\n\n${response}`);
      } catch (err: unknown) {
        console.error(`[scheduler] Task "${task.name}" failed:`, err);
        await bot.sendMessage(Number(task.chat_id), `❌ Scheduled task "${task.name}" failed: ${errMsg(err)}`).catch(() => {});
      }
    });
  }
}, 60_000);

// ── Graceful Shutdown ─────────────────────────────────────────────────

function shutdown(signal: string): void {
  console.log(`\n[shutdown] Received ${signal}, shutting down...`);
  for (const [jobId, job] of activeJobs) {
    console.log(`[shutdown] Killing background job #${jobId}`);
    job.process.kill();
  }
  activeJobs.clear();
  clearInterval(schedulerInterval);
  bot.stopPolling();
  db.close();
  console.log('[shutdown] Done.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── Startup ───────────────────────────────────────────────────────────

console.log('🤖 Minion is running');
console.log(`   Model: ${CONFIG.MODEL}`);
console.log(`   Workspace: ${workspaceDir}`);
console.log(`   DB: ${path.resolve(CONFIG.DB_PATH)}`);
