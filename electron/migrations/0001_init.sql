-- Media Inbox schema v1
-- One DB shared by Electron app and CLI tools.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS sources (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  platform        TEXT NOT NULL,         -- instagram | telegram | youtube | tiktok
  handle          TEXT NOT NULL,         -- e.g. "aniginaaaa", "@channel", channel id
  display_name    TEXT,
  external_id     TEXT,                  -- platform-native id (user_id, channel_id)
  avatar_url      TEXT,
  meta_json       TEXT,                  -- followers, bio, etc. as JSON
  last_synced_at  INTEGER,               -- unix seconds
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(platform, handle)
);

CREATE TABLE IF NOT EXISTS items (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id           INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  external_id         TEXT NOT NULL,      -- shortcode / message_id / video_id
  type                TEXT NOT NULL,      -- reel | post | message | video | short
  url                 TEXT,
  title               TEXT,
  caption             TEXT,
  published_at        INTEGER,            -- unix seconds, UTC
  duration_seconds    REAL,
  views               INTEGER,
  likes               INTEGER,
  comments            INTEGER,

  -- media + transcript paths (relative to library root)
  media_path          TEXT,
  thumbnail_path      TEXT,
  transcript_path     TEXT,

  -- state
  download_status     TEXT NOT NULL DEFAULT 'none',    -- none | pending | done | error
  download_error      TEXT,
  transcribe_status   TEXT NOT NULL DEFAULT 'none',    -- none | pending | done | error
  transcribe_error    TEXT,
  transcribe_engine   TEXT,                            -- gemini | assemblyai | apify | apple_yang
  transcribe_cost_usd REAL,

  raw_meta_json       TEXT,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at          INTEGER NOT NULL DEFAULT (unixepoch()),

  UNIQUE(source_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_items_source     ON items(source_id);
CREATE INDEX IF NOT EXISTS idx_items_published  ON items(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_status     ON items(download_status, transcribe_status);

CREATE TABLE IF NOT EXISTS jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  type            TEXT NOT NULL,        -- sync_source | download_item | transcribe_item | bulk_transcribe
  source_id       INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'pending',     -- pending | running | done | error | cancelled | interrupted
  items_total     INTEGER,
  items_done      INTEGER NOT NULL DEFAULT 0,
  items_failed    INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL NOT NULL DEFAULT 0,
  parameters_json TEXT,
  error           TEXT,
  pid             INTEGER,
  started_at      INTEGER,
  finished_at     INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

-- Full-text search over transcripts + captions
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  title, caption, transcript,
  content='',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT OR IGNORE INTO schema_version (version) VALUES (1);
