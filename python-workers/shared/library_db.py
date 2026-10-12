"""Shared SQLite library used by sc CLI and the SC Desktop Electron app.

The DB lives at ~/Library/Application Support/sc-desktop/library.db (macOS default).
Override with $SC_DESKTOP_DB (or legacy $MEDIA_INBOX_DB).

This module is import-safe: it does not run migrations on import. Call
`open_db()` to lazily create + migrate the file on first access.
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path

PLATFORMS = ("instagram", "telegram", "youtube", "tiktok", "reddit", "boosty")

DEFAULT_DB_PATH = (
    Path.home() / "Library" / "Application Support" / "sc-desktop" / "library.db"
)


def _db_path() -> Path:
    override = os.environ.get("SC_DESKTOP_DB") or os.environ.get("MEDIA_INBOX_DB")
    if override:
        return Path(override)
    root = os.environ.get("SC_DESKTOP_DIR") or os.environ.get("MEDIA_INBOX_DIR")
    return Path(root) / "library.db" if root else DEFAULT_DB_PATH


SCHEMA_V1 = """
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS sources (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  platform        TEXT NOT NULL,
  handle          TEXT NOT NULL,
  display_name    TEXT,
  external_id     TEXT,
  avatar_url      TEXT,
  meta_json       TEXT,
  has_discussion  INTEGER,
  -- Telegram-only: session name (no .session ext) this chat was last
  -- fetched/resolved through. Written by the Electron side; CLI only needs
  -- the column to exist so both writers share one schema.
  tg_session      TEXT,
  -- 1 = chat was touched from different sessions; desktop UI asks the user
  -- to pin one. CLI never sets this.
  tg_session_conflict INTEGER NOT NULL DEFAULT 0,
  last_synced_at  INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(platform, handle)
);

CREATE TABLE IF NOT EXISTS items (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id           INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  external_id         TEXT NOT NULL,
  type                TEXT NOT NULL,
  url                 TEXT,
  title               TEXT,
  caption             TEXT,
  published_at        INTEGER,
  duration_seconds    REAL,
  views               INTEGER,
  likes               INTEGER,
  comments            INTEGER,
  media_path          TEXT,
  video_path          TEXT,
  thumbnail_path      TEXT,
  transcript_path     TEXT,
  download_status     TEXT NOT NULL DEFAULT 'none',
  download_error      TEXT,
  transcribe_status   TEXT NOT NULL DEFAULT 'none',
  transcribe_error    TEXT,
  transcribe_engine   TEXT,
  transcribe_cost_usd REAL,
  raw_meta_json       TEXT,
  sender              TEXT,
  has_media           INTEGER NOT NULL DEFAULT 0,
  topic_id            INTEGER,
  topic_title         TEXT,
  -- Reddit-only: comment tree. parent_external_id == NULL for the post itself
  -- and top-level comments; depth = 0 for post, 1+ for nested comments.
  parent_external_id  TEXT,
  depth               INTEGER,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(source_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_items_source     ON items(source_id);
CREATE INDEX IF NOT EXISTS idx_items_published  ON items(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_source_published ON items(source_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_source_published_id ON items(source_id, published_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_items_source_caption_present ON items(source_id)
  WHERE caption IS NOT NULL AND length(trim(caption)) > 0;
CREATE INDEX IF NOT EXISTS idx_items_status     ON items(download_status, transcribe_status);
CREATE INDEX IF NOT EXISTS idx_items_type       ON items(source_id, type);

CREATE TABLE IF NOT EXISTS semantic_chunks (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id              INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  source_id            INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  chunk_index          INTEGER NOT NULL,
  start_char           INTEGER NOT NULL,
  end_char             INTEGER NOT NULL,
  start_seconds        REAL,
  end_seconds          REAL,
  position_approximate INTEGER NOT NULL DEFAULT 1,
  text                 TEXT NOT NULL,
  document_hash        TEXT NOT NULL,
  indexed_at           INTEGER,
  created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(item_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_semantic_chunks_source ON semantic_chunks(source_id, item_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_semantic_chunks_document ON semantic_chunks(item_id, document_hash);

-- Boosty saved-text publication. Partial embeddings are resumable but never
-- searchable; active vectors live in the same semantic_chunks/vec corpus.
CREATE TABLE IF NOT EXISTS boosty_rag_generations (
  generation_id TEXT PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  document_hash TEXT NOT NULL,
  index_version TEXT NOT NULL,
  fragments_total INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('staging', 'active', 'obsolete')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  published_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_boosty_rag_item ON boosty_rag_generations(item_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_boosty_rag_active ON boosty_rag_generations(item_id) WHERE status = 'active';
CREATE TABLE IF NOT EXISTS boosty_rag_staging (
  generation_id TEXT NOT NULL REFERENCES boosty_rag_generations(generation_id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  chunk_json TEXT NOT NULL,
  embedding BLOB,
  PRIMARY KEY(generation_id, chunk_index)
);

-- Telegram-only RAG publication ledger. Staging embeddings never enter vec0.
CREATE TABLE IF NOT EXISTS telegram_rag_source_state (
  source_id        INTEGER PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  content_revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS telegram_rag_item_state (
  item_id               INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  local_revision        INTEGER NOT NULL DEFAULT 1,
  stale                 INTEGER NOT NULL DEFAULT 0,
  migrated              INTEGER NOT NULL DEFAULT 0,
  active_generation_id  TEXT,
  desired_generation_id TEXT
);
CREATE TABLE IF NOT EXISTS telegram_rag_generations (
  generation_id      TEXT PRIMARY KEY,
  item_id            INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  source_id          INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  input_hash         TEXT NOT NULL,
  index_version      TEXT NOT NULL,
  target_revision    INTEGER NOT NULL,
  target_content_hash TEXT NOT NULL,
  source_revision    INTEGER NOT NULL,
  context_refs_json  TEXT NOT NULL,
  status             TEXT NOT NULL CHECK(status IN ('staging', 'active', 'obsolete')),
  fragments_total    INTEGER NOT NULL,
  created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  published_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_telegram_rag_generations_item
  ON telegram_rag_generations(item_id, status);
CREATE TABLE IF NOT EXISTS telegram_rag_generation_chunks (
  generation_id TEXT NOT NULL REFERENCES telegram_rag_generations(generation_id) ON DELETE CASCADE,
  chunk_index   INTEGER NOT NULL,
  chunk_json    TEXT NOT NULL,
  embedding     BLOB,
  PRIMARY KEY(generation_id, chunk_index)
);
CREATE TABLE IF NOT EXISTS telegram_rag_dependencies (
  generation_id TEXT NOT NULL REFERENCES telegram_rag_generations(generation_id) ON DELETE CASCADE,
  source_id     INTEGER NOT NULL,
  external_id   TEXT NOT NULL,
  item_id       INTEGER,
  local_revision INTEGER,
  content_hash  TEXT,
  role          TEXT NOT NULL,
  PRIMARY KEY(generation_id, source_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_telegram_rag_dependencies_external
  ON telegram_rag_dependencies(source_id, external_id);

CREATE TABLE IF NOT EXISTS jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  type            TEXT NOT NULL,
  source_id       INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
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
CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source_id);
CREATE INDEX IF NOT EXISTS idx_jobs_source_started ON jobs(source_id, started_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS source_coverage (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id    INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  job_id       INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  date_from    INTEGER,
  date_to      INTEGER,
  content_type TEXT NOT NULL,
  depth        TEXT NOT NULL,
  items_count  INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_coverage_source ON source_coverage(source_id);

-- Telegram channel comments (lives in linked discussion group, not the channel
-- itself). Keep these mirrored 1:1 with electron/database.js — both sides UPSERT.
CREATE TABLE IF NOT EXISTS post_comments (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id           INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  post_external_id    TEXT NOT NULL,
  comment_id          INTEGER NOT NULL,
  parent_comment_id   INTEGER,
  sender              TEXT,
  text                TEXT,
  date                INTEGER,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(source_id, post_external_id, comment_id)
);
CREATE INDEX IF NOT EXISTS idx_post_comments_post ON post_comments(source_id, post_external_id);

-- Telegram folders (mirror of electron/database.js). The Electron app owns
-- folder CRUD; the CLI does not currently read or write these tables, but
-- both sides must declare the same schema so that opening library.db never
-- triggers an "no such table" surprise.
CREATE TABLE IF NOT EXISTS folders (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_filter_id         INTEGER,
  title                TEXT NOT NULL,
  -- Session this folder belongs to. DialogFilter ids start at 2 inside EACH
  -- account, so uniqueness only holds per (filter_id, session) pair.
  tg_session           TEXT,
  default_period_days  INTEGER NOT NULL DEFAULT 7,
  default_types_json   TEXT,
  last_fetched_at      INTEGER,
  added_at             INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at           INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(tg_filter_id, tg_session)
);

CREATE TABLE IF NOT EXISTS folder_sources (
  folder_id  INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  source_id  INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  added_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (folder_id, source_id)
);

CREATE INDEX IF NOT EXISTS idx_folder_sources_source ON folder_sources(source_id);

-- Shared with Electron. Python workers do not currently use these tables,
-- but both runtimes open the same library.db and must declare one schema.
CREATE TABLE IF NOT EXISTS translation_cache (
  cache_key     TEXT PRIMARY KEY,
  operation     TEXT NOT NULL CHECK(operation IN ('translate', 'dictionary')),
  source_lang   TEXT NOT NULL,
  target_lang   TEXT NOT NULL,
  source_text   TEXT NOT NULL,
  response_json TEXT NOT NULL,
  provider      TEXT NOT NULL DEFAULT 'azure',
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_translation_cache_lookup
  ON translation_cache(operation, source_lang, target_lang);

CREATE TABLE IF NOT EXISTS learning_entries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL CHECK(kind IN ('word', 'phrase')),
  state           TEXT NOT NULL DEFAULT 'saved'
                    CHECK(state IN ('saved', 'known', 'ignored')),
  source_lang     TEXT NOT NULL,
  target_lang     TEXT NOT NULL,
  source_text     TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  translation     TEXT,
  metadata_json   TEXT,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(kind, source_lang, target_lang, normalized_text)
);
CREATE INDEX IF NOT EXISTS idx_learning_entries_state
  ON learning_entries(state, updated_at DESC);

CREATE TABLE IF NOT EXISTS learning_examples (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id            INTEGER NOT NULL REFERENCES learning_entries(id) ON DELETE CASCADE,
  video_id            TEXT NOT NULL DEFAULT '',
  video_url           TEXT,
  video_title         TEXT,
  cue_start_ms        INTEGER NOT NULL DEFAULT -1,
  cue_end_ms          INTEGER,
  source_text         TEXT NOT NULL,
  translated_text     TEXT,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(entry_id, video_id, cue_start_ms, source_text)
);
CREATE INDEX IF NOT EXISTS idx_learning_examples_entry
  ON learning_examples(entry_id, cue_start_ms);

CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  caption, transcript,
  content='', contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2'
);


CREATE TABLE IF NOT EXISTS research_jobs (
  job_id TEXT PRIMARY KEY, kind TEXT, provider TEXT, model_id TEXT, mode TEXT,
  status TEXT, stage TEXT, prompt TEXT, response_text TEXT, url TEXT,
  response_len INTEGER, link_count INTEGER, result_json TEXT,
  request_fingerprint TEXT, request_metadata_json TEXT, error TEXT,
  created_at INTEGER, updated_at INTEGER, done_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_research_jobs_created ON research_jobs(created_at DESC);

CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT OR IGNORE INTO schema_version (version) VALUES (1);
"""


TELEGRAM_RAG_TRIGGERS = """
-- Triggers cover BOTH SQLite writers; they deliberately never touch vec0.
CREATE TRIGGER IF NOT EXISTS telegram_rag_item_insert AFTER INSERT ON items
WHEN EXISTS (SELECT 1 FROM sources WHERE id = NEW.source_id AND platform = 'telegram')
BEGIN
  INSERT INTO telegram_rag_source_state(source_id) SELECT NEW.source_id
    WHERE NOT EXISTS (SELECT 1 FROM telegram_rag_source_state WHERE source_id = NEW.source_id);
  UPDATE telegram_rag_source_state SET content_revision = content_revision + 1 WHERE source_id = NEW.source_id;
  INSERT INTO telegram_rag_item_state(item_id) SELECT NEW.id
    WHERE NOT EXISTS (SELECT 1 FROM telegram_rag_item_state WHERE item_id = NEW.id);

  UPDATE telegram_rag_item_state SET stale = 1
   WHERE item_id IN (
     SELECT g.item_id FROM telegram_rag_dependencies d
     JOIN telegram_rag_generations g ON g.generation_id = d.generation_id
     WHERE d.source_id = NEW.source_id AND d.external_id = NEW.external_id
       AND g.status IN ('staging', 'active')
   );
  UPDATE telegram_rag_item_state SET stale = 1
   WHERE (active_generation_id IS NOT NULL OR desired_generation_id IS NOT NULL)
     AND item_id IN (
       SELECT i.id FROM items i WHERE i.source_id = NEW.source_id
         AND i.id != NEW.id
         AND COALESCE(i.topic_id, 0) = COALESCE(NEW.topic_id, 0)
         AND i.published_at BETWEEN NEW.published_at AND NEW.published_at + 86400
         AND (i.published_at > NEW.published_at
           OR (i.published_at = NEW.published_at
             AND CAST(i.external_id AS INTEGER) > CAST(NEW.external_id AS INTEGER)))
     );

END;
CREATE TRIGGER IF NOT EXISTS telegram_rag_item_update AFTER UPDATE ON items
WHEN EXISTS (SELECT 1 FROM sources WHERE id = NEW.source_id AND platform = 'telegram')
 AND (OLD.caption IS NOT NEW.caption
  OR OLD.sender IS NOT NEW.sender
  OR OLD.type IS NOT NEW.type
  OR OLD.published_at IS NOT NEW.published_at
  OR OLD.topic_id IS NOT NEW.topic_id
  OR OLD.topic_title IS NOT NEW.topic_title
  OR OLD.parent_external_id IS NOT NEW.parent_external_id
  OR OLD.source_id IS NOT NEW.source_id
  OR OLD.external_id IS NOT NEW.external_id
  OR (CASE WHEN json_valid(OLD.raw_meta_json) THEN json_extract(OLD.raw_meta_json, '$.forward') END)
     IS NOT (CASE WHEN json_valid(NEW.raw_meta_json) THEN json_extract(NEW.raw_meta_json, '$.forward') END)
  OR (CASE WHEN json_valid(OLD.raw_meta_json) THEN json_extract(OLD.raw_meta_json, '$.telegram_reply') END)
     IS NOT (CASE WHEN json_valid(NEW.raw_meta_json) THEN json_extract(NEW.raw_meta_json, '$.telegram_reply') END)
  OR (CASE WHEN json_valid(OLD.raw_meta_json) THEN json_type(OLD.raw_meta_json, '$.telegram_reply') END)
     IS NOT (CASE WHEN json_valid(NEW.raw_meta_json) THEN json_type(NEW.raw_meta_json, '$.telegram_reply') END)
  OR (CASE WHEN json_valid(OLD.raw_meta_json) THEN json_extract(OLD.raw_meta_json, '$.external_reply') END)
     IS NOT (CASE WHEN json_valid(NEW.raw_meta_json) THEN json_extract(NEW.raw_meta_json, '$.external_reply') END)
  OR (CASE WHEN json_valid(OLD.raw_meta_json) THEN json_type(OLD.raw_meta_json, '$.external_reply') END)
     IS NOT (CASE WHEN json_valid(NEW.raw_meta_json) THEN json_type(NEW.raw_meta_json, '$.external_reply') END))
BEGIN
  INSERT INTO telegram_rag_source_state(source_id) SELECT NEW.source_id
    WHERE NOT EXISTS (SELECT 1 FROM telegram_rag_source_state WHERE source_id = NEW.source_id);
  UPDATE telegram_rag_source_state SET content_revision = content_revision + 1
    WHERE source_id IN (NEW.source_id, OLD.source_id);
  INSERT INTO telegram_rag_item_state(item_id) SELECT NEW.id
    WHERE NOT EXISTS (SELECT 1 FROM telegram_rag_item_state WHERE item_id = NEW.id);
  UPDATE telegram_rag_item_state SET local_revision = local_revision + 1, stale = 1 WHERE item_id = NEW.id;

  UPDATE telegram_rag_item_state SET stale = 1
   WHERE item_id IN (
     SELECT g.item_id FROM telegram_rag_dependencies d
     JOIN telegram_rag_generations g ON g.generation_id = d.generation_id
     WHERE d.source_id = NEW.source_id AND d.external_id = NEW.external_id
       AND g.status IN ('staging', 'active')
   );
  UPDATE telegram_rag_item_state SET stale = 1
   WHERE (active_generation_id IS NOT NULL OR desired_generation_id IS NOT NULL)
     AND item_id IN (
       SELECT i.id FROM items i WHERE i.source_id = NEW.source_id
         AND i.id != NEW.id
         AND COALESCE(i.topic_id, 0) = COALESCE(NEW.topic_id, 0)
         AND i.published_at BETWEEN NEW.published_at AND NEW.published_at + 86400
         AND (i.published_at > NEW.published_at
           OR (i.published_at = NEW.published_at
             AND CAST(i.external_id AS INTEGER) > CAST(NEW.external_id AS INTEGER)))
     );

  UPDATE telegram_rag_item_state SET stale = 1
   WHERE item_id IN (
     SELECT g.item_id FROM telegram_rag_dependencies d
     JOIN telegram_rag_generations g ON g.generation_id = d.generation_id
     WHERE d.source_id = OLD.source_id AND d.external_id = OLD.external_id
       AND g.status IN ('staging', 'active')
   );
  UPDATE telegram_rag_item_state SET stale = 1
   WHERE (active_generation_id IS NOT NULL OR desired_generation_id IS NOT NULL)
     AND item_id IN (
       SELECT i.id FROM items i WHERE i.source_id = OLD.source_id
         AND i.id != OLD.id
         AND COALESCE(i.topic_id, 0) = COALESCE(OLD.topic_id, 0)
         AND i.published_at BETWEEN OLD.published_at AND OLD.published_at + 86400
         AND (i.published_at > OLD.published_at
           OR (i.published_at = OLD.published_at
             AND CAST(i.external_id AS INTEGER) > CAST(OLD.external_id AS INTEGER)))
     );

END;
CREATE TRIGGER IF NOT EXISTS telegram_rag_item_delete AFTER DELETE ON items
WHEN EXISTS (SELECT 1 FROM sources WHERE id = OLD.source_id AND platform = 'telegram')
BEGIN
  INSERT INTO telegram_rag_source_state(source_id) SELECT OLD.source_id
    WHERE NOT EXISTS (SELECT 1 FROM telegram_rag_source_state WHERE source_id = OLD.source_id);
  UPDATE telegram_rag_source_state SET content_revision = content_revision + 1 WHERE source_id = OLD.source_id;

  UPDATE telegram_rag_item_state SET stale = 1
   WHERE item_id IN (
     SELECT g.item_id FROM telegram_rag_dependencies d
     JOIN telegram_rag_generations g ON g.generation_id = d.generation_id
     WHERE d.source_id = OLD.source_id AND d.external_id = OLD.external_id
       AND g.status IN ('staging', 'active')
   );
  UPDATE telegram_rag_item_state SET stale = 1
   WHERE (active_generation_id IS NOT NULL OR desired_generation_id IS NOT NULL)
     AND item_id IN (
       SELECT i.id FROM items i WHERE i.source_id = OLD.source_id
         AND i.id != OLD.id
         AND COALESCE(i.topic_id, 0) = COALESCE(OLD.topic_id, 0)
         AND i.published_at BETWEEN OLD.published_at AND OLD.published_at + 86400
         AND (i.published_at > OLD.published_at
           OR (i.published_at = OLD.published_at
             AND CAST(i.external_id AS INTEGER) > CAST(OLD.external_id AS INTEGER)))
     );

END;
"""


def open_db() -> sqlite3.Connection:
    """Open or create the library DB. Idempotent."""
    path = _db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=10, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA_V1)
    # Defensive column adds for DBs created before these landed in SCHEMA_V1
    # (CREATE IF NOT EXISTS never alters an existing table). Mirrors the
    # equivalent try/ALTER block in electron/database.js — both writers must
    # agree on the full column set.
    for ddl in (
        "ALTER TABLE research_jobs ADD COLUMN result_json TEXT",
        "ALTER TABLE research_jobs ADD COLUMN request_fingerprint TEXT",
        "ALTER TABLE research_jobs ADD COLUMN request_metadata_json TEXT",
        "ALTER TABLE sources ADD COLUMN tg_session TEXT",
        "ALTER TABLE sources ADD COLUMN tg_session_conflict INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE folders ADD COLUMN tg_session TEXT",
        "ALTER TABLE items ADD COLUMN video_path TEXT",
        "ALTER TABLE items ADD COLUMN has_media INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE items ADD COLUMN sender TEXT",
        "ALTER TABLE items ADD COLUMN topic_id INTEGER",
        "ALTER TABLE items ADD COLUMN topic_title TEXT",
        "ALTER TABLE items ADD COLUMN parent_external_id TEXT",
    ):
        try:
            conn.execute(ddl)
        except sqlite3.OperationalError:
            pass  # column already exists
    # Keep installed bodies current atomically, including DBs opened by an
    # earlier worker. No trigger touches sqlite-vec, unavailable in Python.
    conn.executescript(
        "BEGIN IMMEDIATE;"
        "DROP TRIGGER IF EXISTS telegram_rag_item_insert;"
        "DROP TRIGGER IF EXISTS telegram_rag_item_update;"
        "DROP TRIGGER IF EXISTS telegram_rag_item_delete;"
        + TELEGRAM_RAG_TRIGGERS + "COMMIT;"
    )
    return conn


def upsert_source(
    conn: sqlite3.Connection,
    *,
    platform: str,
    handle: str,
    display_name: str | None = None,
    external_id: str | None = None,
    avatar_url: str | None = None,
    meta: dict | None = None,
    mark_synced: bool = False,
) -> int:
    if platform not in PLATFORMS:
        raise ValueError(f"Unknown platform: {platform!r}")
    handle = handle.lstrip("@").strip()
    now = int(time.time())
    meta_json = json.dumps(meta, ensure_ascii=False) if meta else None
    conn.execute(
        """
        INSERT INTO sources (platform, handle, display_name, external_id, avatar_url, meta_json, last_synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(platform, handle) DO UPDATE SET
          display_name   = COALESCE(excluded.display_name, sources.display_name),
          external_id    = COALESCE(excluded.external_id,  sources.external_id),
          avatar_url     = COALESCE(excluded.avatar_url,   sources.avatar_url),
          meta_json      = COALESCE(excluded.meta_json,    sources.meta_json),
          last_synced_at = CASE WHEN ? = 1 THEN ? ELSE sources.last_synced_at END
        """,
        (platform, handle, display_name, external_id, avatar_url, meta_json,
         now if mark_synced else None,
         1 if mark_synced else 0, now),
    )
    row = conn.execute(
        "SELECT id FROM sources WHERE platform = ? AND handle = ?",
        (platform, handle),
    ).fetchone()
    return row["id"]


def upsert_item(
    conn: sqlite3.Connection,
    *,
    source_id: int,
    external_id: str,
    type: str,
    url: str | None = None,
    title: str | None = None,
    caption: str | None = None,
    published_at: int | None = None,
    duration_seconds: float | None = None,
    views: int | None = None,
    likes: int | None = None,
    comments: int | None = None,
    raw_meta: dict | None = None,
) -> int:
    raw = json.dumps(raw_meta, ensure_ascii=False) if raw_meta else None
    conn.execute(
        """
        INSERT INTO items (
          source_id, external_id, type, url, title, caption, published_at,
          duration_seconds, views, likes, comments, raw_meta_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, external_id) DO UPDATE SET
          url              = COALESCE(excluded.url,              items.url),
          title            = COALESCE(excluded.title,            items.title),
          caption          = COALESCE(excluded.caption,          items.caption),
          published_at     = COALESCE(excluded.published_at,     items.published_at),
          duration_seconds = COALESCE(excluded.duration_seconds, items.duration_seconds),
          views            = COALESCE(excluded.views,            items.views),
          likes            = COALESCE(excluded.likes,            items.likes),
          comments         = COALESCE(excluded.comments,         items.comments),
          raw_meta_json    = COALESCE(excluded.raw_meta_json,    items.raw_meta_json),
          updated_at       = unixepoch()
        """,
        (source_id, external_id, type, url, title, caption, published_at,
         duration_seconds, views, likes, comments, raw),
    )
    row = conn.execute(
        "SELECT id FROM items WHERE source_id = ? AND external_id = ?",
        (source_id, external_id),
    ).fetchone()
    return row["id"]


def set_item_transcript(
    conn: sqlite3.Connection,
    item_id: int,
    *,
    transcript_path: str | None = None,
    transcript_text: str | None = None,
    engine: str | None = None,
    cost_usd: float | None = None,
    error: str | None = None,
):
    status = "error" if error else ("done" if (transcript_path or transcript_text) else "pending")
    conn.execute(
        """
        UPDATE items SET
          transcript_path     = COALESCE(?, transcript_path),
          transcribe_status   = ?,
          transcribe_error    = ?,
          transcribe_engine   = COALESCE(?, transcribe_engine),
          transcribe_cost_usd = COALESCE(transcribe_cost_usd, 0) + COALESCE(?, 0),
          updated_at          = unixepoch()
        WHERE id = ?
        """,
        (transcript_path, status, error, engine, cost_usd, item_id),
    )
    if transcript_text is not None:
        # Mirror into FTS. Columns = (caption, transcript) — то же, что в
        # electron/database.js::indexItemForFts; раньше тут была лишняя
        # title-колонка, которой нет в реальной таблице (создаёт её Electron),
        # и INSERT падал 'table items_fts has no column named title'.
        # DELETE безопасен: contentless_delete=1 (rebuild на Electron-стороне).
        conn.execute("DELETE FROM items_fts WHERE rowid = ?", (item_id,))
        row = conn.execute(
            "SELECT caption FROM items WHERE id = ?", (item_id,)
        ).fetchone()
        conn.execute(
            "INSERT INTO items_fts (rowid, caption, transcript) VALUES (?, ?, ?)",
            (item_id, (row["caption"] if row else None) or "", transcript_text),
        )


def list_sources(conn: sqlite3.Connection, platform: str | None = None) -> list[sqlite3.Row]:
    if platform:
        return list(conn.execute(
            """
            SELECT s.*, COUNT(i.id) AS item_count
            FROM sources s LEFT JOIN items i ON i.source_id = s.id
            WHERE s.platform = ?
            GROUP BY s.id ORDER BY s.last_synced_at DESC NULLS LAST
            """,
            (platform,),
        ))
    return list(conn.execute(
        """
        SELECT s.*, COUNT(i.id) AS item_count
        FROM sources s LEFT JOIN items i ON i.source_id = s.id
        GROUP BY s.id ORDER BY s.platform, s.last_synced_at DESC NULLS LAST
        """,
    ))


def list_items(
    conn: sqlite3.Connection,
    *,
    source_id: int,
    limit: int = 1000,
    order: str = "published_at DESC",
) -> list[sqlite3.Row]:
    safe_order = order if order in ("published_at DESC", "published_at ASC", "views DESC", "likes DESC") else "published_at DESC"
    return list(conn.execute(
        f"SELECT * FROM items WHERE source_id = ? ORDER BY {safe_order} LIMIT ?",
        (source_id, limit),
    ))


def processed_external_ids_by_kind(
    conn: sqlite3.Connection,
    source_id: int,
) -> dict[str, dict[str, str]]:
    """Return already processed Telegram media IDs grouped by pipeline kind.

    This query intentionally runs in the Python fetch subprocess. Building and
    serialising the same potentially huge map in Electron main made the Parse
    click stall before the subprocess was even spawned.
    """
    result: dict[str, dict[str, str]] = {"voice": {}, "photo": {}, "pdf": {}}
    rows = conn.execute(
        """
        SELECT external_id, type, transcribe_engine
          FROM items
         WHERE source_id = ?
           AND transcribe_status = 'done'
           AND external_id IS NOT NULL
        """,
        (int(source_id),),
    )
    for row in rows:
        engine = str(row["transcribe_engine"] or "")
        external_id = str(row["external_id"])
        if row["type"] in ("voice", "audio", "video"):
            result["voice"][external_id] = engine
        elif row["type"] == "photo":
            result["photo"][external_id] = engine
        elif row["type"] == "document":
            result["pdf"][external_id] = engine
    return result


def pending_reply_external_ids(
    conn: sqlite3.Connection,
    source_id: int,
    limit: int = 5000,
) -> list[int]:
    """IDs whose reply edge or reactions still need an authoritative read."""
    bounded = max(1, min(int(limit or 5000), 50000))
    rows = conn.execute(
        """
        SELECT external_id
          FROM items
         WHERE source_id = ?
           AND (reply_resolved = 0 OR reactions_resolved = 0)
         ORDER BY CAST(external_id AS INTEGER) ASC
         LIMIT ?
        """,
        (int(source_id), bounded),
    )
    result = []
    for row in rows:
        try:
            result.append(int(row["external_id"]))
        except (TypeError, ValueError):
            pass
    return result


def missing_comment_post_ids(
    conn: sqlite3.Connection,
    source_id: int,
) -> list[int]:
    """Post IDs without any stored discussion rows, newest first."""
    rows = conn.execute(
        """
        SELECT i.external_id
          FROM items i
         WHERE i.source_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM post_comments pc
              WHERE pc.source_id = i.source_id
                AND pc.post_external_id = i.external_id
           )
         ORDER BY i.published_at DESC, i.id DESC
        """,
        (int(source_id),),
    )
    result = []
    for row in rows:
        try:
            result.append(int(row["external_id"]))
        except (TypeError, ValueError):
            pass
    return result
