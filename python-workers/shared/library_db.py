"""Shared SQLite library used by sc CLI and the SC Desktop Electron app.

The DB lives at ~/Library/Application Support/sc-desktop/library.db (macOS default).
Override with $SC_DESKTOP_DB (or legacy $MEDIA_INBOX_DB).

This module is import-safe: it does not run migrations on import. Call
`open_db()` to lazily create + migrate the file on first access.
"""
import json
import os
import sqlite3
import time
from pathlib import Path

PLATFORMS = ("instagram", "telegram", "youtube", "tiktok", "reddit")

DEFAULT_DB_PATH = (
    Path.home() / "Library" / "Application Support" / "sc-desktop" / "library.db"
)


def _db_path() -> Path:
    override = os.environ.get("SC_DESKTOP_DB") or os.environ.get("MEDIA_INBOX_DB")
    return Path(override) if override else DEFAULT_DB_PATH


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
  thumbnail_path      TEXT,
  transcript_path     TEXT,
  download_status     TEXT NOT NULL DEFAULT 'none',
  download_error      TEXT,
  transcribe_status   TEXT NOT NULL DEFAULT 'none',
  transcribe_error    TEXT,
  transcribe_engine   TEXT,
  transcribe_cost_usd REAL,
  raw_meta_json       TEXT,
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
CREATE INDEX IF NOT EXISTS idx_items_source_caption_present ON items(source_id)
  WHERE caption IS NOT NULL AND length(trim(caption)) > 0;
CREATE INDEX IF NOT EXISTS idx_items_status     ON items(download_status, transcribe_status);
CREATE INDEX IF NOT EXISTS idx_items_type       ON items(source_id, type);

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

CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  caption, transcript,
  content='', contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT OR IGNORE INTO schema_version (version) VALUES (1);
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
        "ALTER TABLE sources ADD COLUMN tg_session TEXT",
        "ALTER TABLE sources ADD COLUMN tg_session_conflict INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE folders ADD COLUMN tg_session TEXT",
    ):
        try:
            conn.execute(ddl)
        except sqlite3.OperationalError:
            pass  # column already exists
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
