import type Database from 'better-sqlite3';
import type { ServerConfig } from './config.js';

/** Shared per-app context handed to every route module. */
export interface AppCtx {
  db: Database;
  cfg: ServerConfig;
}
