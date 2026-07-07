/**
 * SQLite persistence (better-sqlite3, WAL). Schema per SPEC section 4.
 * Row types are the exact shapes handed around the route modules.
 */
import Database from 'better-sqlite3';

export interface VideoRow {
  id: string;
  title: string;
  description: string | null;
  creator: string | null;
  created_at: string;
  duration_sec: number;
  width: number;
  height: number;
  size_bytes: number;
  status: 'processing' | 'ready';
  privacy: 'link' | 'password';
  password_hash: string | null;
  allow_comments: 0 | 1;
  allow_reactions: 0 | 1;
  allow_download: 0 | 1;
  cta_label: string | null;
  cta_url: string | null;
  chapters_json: string | null;
  transcript_vtt_path: string | null;
  files_dir: string;
}

export interface CommentRow {
  id: string;
  video_id: string;
  parent_id: string | null;
  author: string;
  text: string;
  at_sec: number | null;
  created_at: string;
}

export interface ReactionRow {
  video_id: string;
  emoji: string;
  session_id: string;
  created_at: string;
}

export interface ViewRow {
  id: string;
  video_id: string;
  session_id: string;
  viewer_name: string | null;
  started_at: string;
  last_beacon_at: string;
  max_position_sec: number;
  coverage_json: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS videos (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  description         TEXT,
  creator             TEXT,
  created_at          TEXT NOT NULL,
  duration_sec        REAL NOT NULL DEFAULT 0,
  width               INTEGER NOT NULL DEFAULT 0,
  height              INTEGER NOT NULL DEFAULT 0,
  size_bytes          INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'processing',
  privacy             TEXT NOT NULL DEFAULT 'link',
  password_hash       TEXT,
  allow_comments      INTEGER NOT NULL DEFAULT 1,
  allow_reactions     INTEGER NOT NULL DEFAULT 1,
  allow_download      INTEGER NOT NULL DEFAULT 1,
  cta_label           TEXT,
  cta_url             TEXT,
  chapters_json       TEXT,
  transcript_vtt_path TEXT,
  files_dir           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id         TEXT PRIMARY KEY,
  video_id   TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  parent_id  TEXT,
  author     TEXT NOT NULL,
  text       TEXT NOT NULL,
  at_sec     REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_video ON comments(video_id, created_at);

CREATE TABLE IF NOT EXISTS reactions (
  video_id   TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(video_id, emoji, session_id)
);
CREATE INDEX IF NOT EXISTS idx_reactions_video ON reactions(video_id);

CREATE TABLE IF NOT EXISTS views (
  id               TEXT PRIMARY KEY,
  video_id         TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  session_id       TEXT NOT NULL,
  viewer_name      TEXT,
  started_at       TEXT NOT NULL,
  last_beacon_at   TEXT NOT NULL,
  max_position_sec REAL NOT NULL DEFAULT 0,
  coverage_json    TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_views_video ON views(video_id, started_at);
`;

export function openDb(file: string): Database {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export function getVideo(db: Database, id: string): VideoRow | null {
  const row = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
  return (row as VideoRow | undefined) ?? null;
}
