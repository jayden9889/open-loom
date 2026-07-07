/**
 * Minimal file + console logger for the main process.
 * Log file: <userData>/logs/main.log (rotated by size, keeps one previous).
 */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 2 * 1024 * 1024;
let logFile: string | null = null;

function ensureLogFile(): string | null {
  if (logFile) return logFile;
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'main.log');
    return logFile;
  } catch {
    return null;
  }
}

function write(level: string, msg: string): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  console.log(`[openloom] ${line}`);
  const file = ensureLogFile();
  if (!file) return;
  try {
    const stat = fs.existsSync(file) ? fs.statSync(file) : null;
    if (stat && stat.size > MAX_BYTES) {
      fs.renameSync(file, file + '.1');
    }
    fs.appendFileSync(file, line + '\n');
  } catch {
    // Logging must never crash the app.
  }
}

export const log = {
  info: (msg: string) => write('info', msg),
  warn: (msg: string) => write('warn', msg),
  error: (msg: string) => write('error', msg),
};

export function logFilePath(): string | null {
  return ensureLogFile();
}
