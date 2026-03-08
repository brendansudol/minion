import fs from 'fs';
import path from 'path';
import { format } from 'util';

const logsDir = path.join(path.dirname(new URL(import.meta.url).pathname), 'logs');
fs.mkdirSync(logsDir, { recursive: true });

const outStream = fs.createWriteStream(path.join(logsDir, 'stdout.log'), { flags: 'a' });
const errStream = fs.createWriteStream(path.join(logsDir, 'stderr.log'), { flags: 'a' });

const origLog = console.log.bind(console);
const origErr = console.error.bind(console);

function fmt(args: unknown[]): string {
  return format(...args);
}

console.log = (...args: unknown[]) => {
  const ts = `[${new Date().toISOString()}]`;
  origLog(ts, ...args);
  outStream.write(`${ts} ${fmt(args)}\n`);
};

console.error = (...args: unknown[]) => {
  const ts = `[${new Date().toISOString()}]`;
  origErr(ts, ...args);
  errStream.write(`${ts} ${fmt(args)}\n`);
};
