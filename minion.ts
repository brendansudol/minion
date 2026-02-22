import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import Database from 'better-sqlite3';
import TelegramBot from 'node-telegram-bot-api';
import { CronExpressionParser } from 'cron-parser';
import { execSync, spawn } from 'child_process';
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
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    input_json TEXT NOT NULL,
    request_excerpt TEXT NOT NULL,
    result_text TEXT,
    error_text TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    finished_at DATETIME
  );
  CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_tasks_next ON scheduled_tasks(next_run) WHERE enabled = 1;
  CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_jobs_chat_created ON jobs(chat_id, created_at DESC);
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
type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
interface JobRow {
  id: number;
  chat_id: string;
  kind: string;
  status: JobStatus;
  input_json: string;
  request_excerpt: string;
  result_text: string | null;
  error_text: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}
interface JobListRow {
  id: number;
  kind: string;
  status: JobStatus;
  request_excerpt: string;
  created_at: string;
  finished_at: string | null;
}
interface ClaudeToolInput {
  prompt: string;
  working_directory?: string;
}
interface ClaudeStreamAccumulator {
  resultText: string;
  stdoutTail: string;
  stderrTail: string;
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

const REQUEST_EXCERPT_MAX_CHARS = 200;
const JOB_RESULT_MAX_CHARS = 50_000;
const JOB_ERROR_MAX_CHARS = 10_000;
const CLAUDE_STDOUT_TAIL_MAX = 200_000;
const CLAUDE_STDERR_TAIL_MAX = 50_000;
const CLAUDE_TIMEOUT_MS = 300_000;

function truncateText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

function appendTail(existing: string, incoming: string, maxChars: number): string {
  const combined = existing + incoming;
  return combined.length <= maxChars ? combined : combined.slice(combined.length - maxChars);
}

function buildRequestExcerpt(prompt: string): string {
  return truncateText(prompt.replace(/\s+/g, ' ').trim(), REQUEST_EXCERPT_MAX_CHARS);
}

function parseClaudeStreamLine(line: string, acc: ClaudeStreamAccumulator): void {
  try {
    const obj = JSON.parse(line) as {
      type?: string;
      result?: string;
      message?: {
        content?: Array<{ type?: string; text?: string }>;
      };
    };

    if (obj.type === 'result' && typeof obj.result === 'string') {
      acc.resultText = obj.result;
      return;
    }

    if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
      for (const block of obj.message.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          acc.resultText = block.text;
        }
      }
    }
  } catch {
    // Ignore non-JSON lines from claude stream output.
  }
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
const stmtUpdateTaskRun = db.prepare('UPDATE scheduled_tasks SET last_run = ?, next_run = ? WHERE id = ?');

const stmtInsertJob = db.prepare(
  'INSERT INTO jobs (chat_id, kind, status, input_json, request_excerpt) VALUES (?, ?, ?, ?, ?)'
);
const stmtSelectNextQueuedJob = db.prepare<[], JobRow>(
  `SELECT id, chat_id, kind, status, input_json, request_excerpt, result_text, error_text, created_at, started_at, finished_at
   FROM jobs
   WHERE status = 'queued'
   ORDER BY id ASC
   LIMIT 1`
);
const stmtMarkJobRunning = db.prepare('UPDATE jobs SET status = ?, started_at = ?, finished_at = NULL, error_text = NULL WHERE id = ?');
const stmtMarkJobSucceeded = db.prepare('UPDATE jobs SET status = ?, result_text = ?, error_text = NULL, finished_at = ? WHERE id = ?');
const stmtMarkJobFailed = db.prepare('UPDATE jobs SET status = ?, error_text = ?, finished_at = ? WHERE id = ?');
const stmtListJobsByChat = db.prepare<[string], JobListRow>(
  `SELECT id, kind, status, request_excerpt, created_at, finished_at
   FROM jobs
   WHERE chat_id = ?
   ORDER BY id DESC
   LIMIT 10`
);
const stmtGetJobByIdAndChat = db.prepare<[number, string], JobRow>(
  `SELECT id, chat_id, kind, status, input_json, request_excerpt, result_text, error_text, created_at, started_at, finished_at
   FROM jobs
   WHERE id = ? AND chat_id = ?`
);

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

const chatQueues = new Map<string, Promise<void>>();

function enqueueChatTask(chatId: string, task: () => Promise<void>): void {
  const previous = chatQueues.get(chatId) ?? Promise.resolve();
  const next = previous
    .catch((err: unknown) => {
      console.error(`[chat_queue] Previous task failed for ${chatId}:`, err);
    })
    .then(task)
    .catch((err: unknown) => {
      console.error(`[chat_queue] Task failed for ${chatId}:`, err);
    });

  chatQueues.set(chatId, next);
  void next.finally(() => {
    if (chatQueues.get(chatId) === next) {
      chatQueues.delete(chatId);
    }
  });
}

function statusEmoji(status: JobStatus): string {
  switch (status) {
    case 'queued':
      return '🕒';
    case 'running':
      return '🏃';
    case 'succeeded':
      return '✅';
    case 'failed':
      return '❌';
    default:
      return '•';
  }
}

async function sendMessageChunks(chatId: string, text: string, parseMode: 'Markdown' | null = null): Promise<void> {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    if (parseMode) {
      try {
        await bot.sendMessage(Number(chatId), chunk, { parse_mode: parseMode });
      } catch {
        try {
          await bot.sendMessage(Number(chatId), chunk);
        } catch (err: unknown) {
          console.error(`[telegram] Failed to send message chunk to ${chatId}: ${errMsg(err)}`);
        }
      }
    } else {
      try {
        await bot.sendMessage(Number(chatId), chunk);
      } catch (err: unknown) {
        console.error(`[telegram] Failed to send message chunk to ${chatId}: ${errMsg(err)}`);
      }
    }
  }
}

async function runClaudeCodeProcess(input: ClaudeToolInput): Promise<string> {
  const cwd = input.working_directory ? path.resolve(input.working_directory) : workspaceDir;

  return new Promise<string>((resolve, reject) => {
    const acc: ClaudeStreamAccumulator = { resultText: '', stdoutTail: '', stderrTail: '' };
    let stdoutBuffer = '';
    let timedOut = false;
    let settled = false;

    const child = spawn('claude', ['-p', input.prompt, '--verbose', '--output-format', 'stream-json'], {
      cwd,
      env: {
        ...process.env,
        PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, CLAUDE_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      acc.stdoutTail = appendTail(acc.stdoutTail, text, CLAUDE_STDOUT_TAIL_MAX);
      stdoutBuffer += text;

      let newline = stdoutBuffer.indexOf('\n');
      while (newline !== -1) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line) parseClaudeStreamLine(line, acc);
        newline = stdoutBuffer.indexOf('\n');
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      acc.stderrTail = appendTail(acc.stderrTail, chunk.toString('utf-8'), CLAUDE_STDERR_TAIL_MAX);
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Claude Code spawn error: ${err.message}`));
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      const leftover = stdoutBuffer.trim();
      if (leftover) parseClaudeStreamLine(leftover, acc);

      if (timedOut) {
        reject(new Error('Claude Code timed out after 300 seconds.'));
        return;
      }

      if (code === 0) {
        const result = truncateText(acc.resultText || acc.stdoutTail.slice(-5_000) || '(no result)', JOB_RESULT_MAX_CHARS);
        resolve(result);
        return;
      }

      const errTail = truncateText(acc.stderrTail || acc.stdoutTail || `Process exited with code ${String(code)}`, 5_000);
      reject(new Error(`Claude Code exited with code ${String(code)}${signal ? ` (${signal})` : ''}: ${errTail}`));
    });
  });
}

let jobRunnerActive = false;

function enqueueClaudeCodeJob(chatId: string, input: ClaudeToolInput): { job_id: number; status: JobStatus } {
  const prompt = input.prompt?.trim();
  if (!prompt) throw new Error('claude_code prompt is required');

  const payload: ClaudeToolInput = { prompt };
  if (input.working_directory && input.working_directory.trim()) {
    payload.working_directory = input.working_directory.trim();
  }

  const requestExcerpt = buildRequestExcerpt(prompt);
  const info = stmtInsertJob.run(
    chatId,
    'claude_code',
    'queued',
    JSON.stringify(payload),
    requestExcerpt
  );
  const jobId = Number(info.lastInsertRowid);

  void processJobQueue();
  return { job_id: jobId, status: 'queued' };
}

async function processJobQueue(): Promise<void> {
  if (jobRunnerActive) return;
  jobRunnerActive = true;

  try {
    while (true) {
      const job = stmtSelectNextQueuedJob.get();
      if (!job) break;

      const startedAt = new Date().toISOString();
      stmtMarkJobRunning.run('running', startedAt, job.id);
      let notificationText = '';

      try {
        const parsed = JSON.parse(job.input_json) as ClaudeToolInput;
        if (!parsed?.prompt || typeof parsed.prompt !== 'string') {
          throw new Error('Job payload missing claude_code prompt');
        }

        const resultText = await runClaudeCodeProcess(parsed);
        const storedResult = truncateText(resultText, JOB_RESULT_MAX_CHARS);
        const finishedAt = new Date().toISOString();

        stmtMarkJobSucceeded.run('succeeded', storedResult, finishedAt, job.id);

        const header = `[Background job #${job.id} completed | kind=${job.kind} | original request: ${job.request_excerpt}]`;
        const completionBody = `${header}\n\n${storedResult}`;
        saveMessage(job.chat_id, 'assistant', completionBody);
        notificationText = `✅ Job #${job.id} completed\n\n${storedResult}`;
      } catch (err: unknown) {
        const errorText = truncateText(errMsg(err), JOB_ERROR_MAX_CHARS);
        const finishedAt = new Date().toISOString();
        stmtMarkJobFailed.run('failed', errorText, finishedAt, job.id);

        const header = `[Background job #${job.id} failed | kind=${job.kind} | original request: ${job.request_excerpt}]`;
        const failureBody = `${header}\n\n${errorText}`;
        saveMessage(job.chat_id, 'assistant', failureBody);
        notificationText = `❌ Job #${job.id} failed\n\n${errorText}`;
      }

      if (notificationText) {
        try {
          await sendMessageChunks(job.chat_id, notificationText);
        } catch (notifyErr: unknown) {
          console.error(`[job] Notification failed for #${job.id}: ${errMsg(notifyErr)}`);
        }
      }
    }
  } finally {
    jobRunnerActive = false;
  }
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
        const raw = input as Record<string, unknown>;
        const job = enqueueClaudeCodeJob(chatId, {
          prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
          working_directory: typeof raw.working_directory === 'string' ? raw.working_directory : undefined,
        });
        return {
          job_started: true,
          job_id: job.job_id,
          status: job.status,
          note: 'Background Claude Code job started; results will be posted when complete.',
        };
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

// ── Telegram Commands & Messages ──────────────────────────────────────

bot.on('message', async (msg) => {
  if (String(msg.from?.id) !== CONFIG.ALLOWED_USER_ID) return;

  const chatId = String(msg.chat.id);

  // Handle photos
  if (msg.photo && msg.photo.length > 0) {
    const photo = msg.photo[msg.photo.length - 1]; // largest resolution
    const caption = msg.caption || "What's in this image?";

    bot.sendChatAction(msg.chat.id, 'typing').catch(() => {});
    enqueueChatTask(chatId, async () => {
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
        await sendMessageChunks(chatId, response, 'Markdown');
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

  if (text === '/jobs') {
    const jobs = stmtListJobsByChat.all(chatId);
    if (jobs.length === 0) {
      await bot.sendMessage(msg.chat.id, 'No background jobs yet.');
      return;
    }

    const lines = jobs.map((job) =>
      `${statusEmoji(job.status)} #${job.id} ${job.kind} (${job.status})\nCreated: ${job.created_at}${job.finished_at ? `\nFinished: ${job.finished_at}` : ''}\nRequest: ${job.request_excerpt}`
    );
    await bot.sendMessage(msg.chat.id, lines.join('\n\n'));
    return;
  }

  if (text.startsWith('/job ')) {
    const idText = text.slice(5).trim();
    if (!/^\d+$/.test(idText)) {
      await bot.sendMessage(msg.chat.id, 'Usage: /job <id>');
      return;
    }

    const job = stmtGetJobByIdAndChat.get(Number(idText), chatId);
    if (!job) {
      await bot.sendMessage(msg.chat.id, `No job #${idText} found for this chat.`);
      return;
    }

    let details = '';
    if (job.status === 'succeeded') {
      details = job.result_text || '(No result stored)';
    } else if (job.status === 'failed') {
      details = job.error_text || '(No error details stored)';
    } else {
      details = 'Job is still in progress.';
    }

    const message = [
      `${statusEmoji(job.status)} #${job.id} ${job.kind} (${job.status})`,
      `Created: ${job.created_at}`,
      `Started: ${job.started_at || 'N/A'}`,
      `Finished: ${job.finished_at || 'N/A'}`,
      `Original request: ${job.request_excerpt}`,
      details,
    ].join('\n\n');

    await sendMessageChunks(chatId, message);
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
  bot.sendChatAction(msg.chat.id, 'typing').catch(() => {});

  enqueueChatTask(chatId, async () => {
    try {
      const response = await runAgentLoop(chatId, text);
      await sendMessageChunks(chatId, response, 'Markdown');
    } catch (err: unknown) {
      console.error('[error]', err);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${errMsg(err)}`);
    }
  });
});

// ── Scheduler ─────────────────────────────────────────────────────────

const schedulerInterval = setInterval(() => {
  const nowIso = new Date().toISOString();
  const dueTasks = db.prepare<[string], ScheduledTaskRow>(
    'SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run <= ?'
  ).all(nowIso);

  for (const task of dueTasks) {
    const nextRun = getNextCronRun(task.cron_expression);
    stmtUpdateTaskRun.run(nowIso, nextRun.toISOString(), task.id);

    enqueueChatTask(task.chat_id, async () => {
      try {
        console.log(`[scheduler] Running task: ${task.name}`);
        const response = await runAgentLoop(task.chat_id, task.prompt);
        await sendMessageChunks(task.chat_id, `📋 *${task.name}*\n\n${response}`, 'Markdown');
      } catch (err: unknown) {
        console.error(`[scheduler] Task "${task.name}" failed:`, err);
        await bot.sendMessage(Number(task.chat_id), `❌ Scheduled task "${task.name}" failed: ${errMsg(err)}`).catch(() => {});
      }
    });
  }
}, 60_000);

const jobWatchdogInterval = setInterval(() => {
  void processJobQueue();
}, 30_000);

// ── Graceful Shutdown ─────────────────────────────────────────────────

function shutdown(signal: string): void {
  console.log(`\n[shutdown] Received ${signal}, shutting down...`);
  clearInterval(schedulerInterval);
  clearInterval(jobWatchdogInterval);
  bot.stopPolling();
  db.close();
  console.log('[shutdown] Done.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── Startup ───────────────────────────────────────────────────────────

void processJobQueue();
console.log('🤖 Minion is running');
console.log(`   Model: ${CONFIG.MODEL}`);
console.log(`   Workspace: ${workspaceDir}`);
console.log(`   DB: ${path.resolve(CONFIG.DB_PATH)}`);
