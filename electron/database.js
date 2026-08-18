// Wrapper around better-sqlite3 for the Electron main process.
// Uses the SAME schema as python-workers/shared/library_db.py — both sides
// open the same library.db file and read/write through it.

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const Database = require('better-sqlite3')
const sqliteVec = require('sqlite-vec')

// Embedding dimensions for the vector index. Picked to match the Gemini
// `gemini-embedding-001` model with `outputDimensionality=768` (MRL-truncated).
// Changing this requires DROP + reindex of items_vec.
const EMBEDDING_DIM = 768

const LIB_ROOT = process.env.SC_DESKTOP_DIR
  || process.env.MEDIA_INBOX_DIR
  || path.join(os.homedir(), 'Library', 'Application Support', 'sc-desktop')
const DB_PATH = process.env.SC_DESKTOP_DB
  || process.env.MEDIA_INBOX_DB
  || path.join(LIB_ROOT, 'library.db')

try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }) } catch {}

// SQL must stay in sync with python-workers/shared/library_db.py SCHEMA_V1.
// When changing this — change both. (Will eventually move to migrations/*.sql.)
const SCHEMA = `
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
  -- Telegram-only: linked discussion group exists for this channel.
  -- NULL = unknown (legacy rows / not yet probed); 0/1 = checked.
  -- Drives the «Комментарии» checkbox enabled/disabled state in TG fetch form.
  has_discussion  INTEGER,
  -- Telegram-only: имя session-файла (без .session), через который этот чат
  -- последний раз фетчился/резолвился. NULL = legacy-строка, сессия неизвестна
  -- до следующего fetch/refresh. Детерминизм: чат принадлежит той сессии,
  -- которой его реально читали.
  tg_session      TEXT,
  -- 1 = чат трогали из РАЗНЫХ сессий (upsert увидел другое непустое имя).
  -- UI показывает amber-бейдж «выбери сессию»; ручной пин сбрасывает в 0.
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
  sender              TEXT,
  has_media           INTEGER NOT NULL DEFAULT 0,
  -- Forum-topic membership (Telegram supergroups only, NULL elsewhere).
  -- topic_id = top_msg_id of the topic root; 0/NULL means General topic
  -- or a non-forum chat — treated identically by the UI.
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
  file_path       TEXT,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source_id);

-- coverage: which date×type×depth slices we have for each source.
-- Multiple rows per source are merged at query time (UI picks max depth per slice).
CREATE TABLE IF NOT EXISTS source_coverage (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id    INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  job_id       INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  date_from    INTEGER,
  date_to      INTEGER,
  content_type TEXT NOT NULL,             -- text | voice | video | photo | document | audio | other
  depth        TEXT NOT NULL,             -- metadata | media | transcribed
  items_count  INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_coverage_source ON source_coverage(source_id);

-- Telegram channel comments (lives in linked discussion group, not the channel
-- itself). Separate from items because comments are messages of a different
-- chat and would collide on (source_id, external_id) UNIQUE if mixed in.
-- post_external_id ties comment to its channel post; parent_comment_id is the
-- comment-id this one replies to (NULL = top-level reply to the post).
CREATE TABLE IF NOT EXISTS post_comments (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id           INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  post_external_id    TEXT NOT NULL,           -- channel msg_id this comment belongs to
  comment_id          INTEGER NOT NULL,        -- discussion-chat msg_id
  parent_comment_id   INTEGER,                 -- NULL for top-level
  sender              TEXT,
  text                TEXT,
  date                INTEGER,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(source_id, post_external_id, comment_id)
);
CREATE INDEX IF NOT EXISTS idx_post_comments_post ON post_comments(source_id, post_external_id);

-- Telegram folders. A folder is a *grouping over existing telegram sources*,
-- not a separate items-store. The user names a Telegram folder ("📂 events"
-- in the TG client itself), we resolve it via GetDialogFiltersRequest and
-- materialise the chats as regular Telegram sources (is_explicit stays as
-- the user has it). The folder row stores the per-folder defaults that
-- TelegramScreen drives ("за неделю", "за месяц", checkbox set, …).
--
-- tg_filter_id   — Telegram's own filter id (DialogFilter.id, int). Used
--                  for silent re-resolve to detect membership drift.
-- title          — display name (matches TG client folder name with emoji
--                  if any, e.g. "😑events").
-- default_period_days — default fetch range; 7 means "last week".
-- default_types_json  — checkbox set saved as JSON array, e.g. ["text"].
CREATE TABLE IF NOT EXISTS folders (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_filter_id         INTEGER,
  title                TEXT NOT NULL,
  -- Сессия, в которой эта папка существует. DialogFilter-id нумеруется с 2
  -- ВНУТРИ каждого аккаунта — у двух сессий папки коллидируют на id=2,3,…
  -- Поэтому уникальность только в паре с сессией, и смешивать «все папки»
  -- разных сессий нельзя.
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
`

let _db = null
let _itemsVecAvailable = null

function itemsVecAvailable(db) {
  if (_itemsVecAvailable != null) return _itemsVecAvailable
  const row = db.prepare(`
    SELECT 1 AS ok FROM sqlite_master
    WHERE type = 'table' AND name = 'items_vec'
    LIMIT 1
  `).get()
  _itemsVecAvailable = !!row
  return _itemsVecAvailable
}

function getDb() {
  if (_db) return _db
  _db = new Database(DB_PATH, { fileMustExist: false })
  // Wait up to 30s for a competing writer (e.g. CLI `sc` running in another
  // shell on the same library.db) instead of throwing 'database is locked'.
  _db.pragma('busy_timeout = 30000')
  // Load sqlite-vec extension. Must come before the SCHEMA exec because the
  // virtual table CREATE references vec0 module. Pre-built dylib ships in
  // node_modules/sqlite-vec-darwin-arm64 — no compilation needed.
  //
  // In production the dylib is extracted to app.asar.unpacked, but
  // sqlite-vec's getLoadablePath() does `require.resolve(...)` which returns
  // the in-asar path. SQLite's loadExtension() can't open files from inside
  // a packed asar — needs a real fs path. Rewrite asar/ → asar.unpacked/
  // before handing the path to loadExtension. Same trick is used by other
  // electron apps with native dylibs (better-sqlite3 itself does similar).
  try {
    let loadablePath = sqliteVec.getLoadablePath()
    if (loadablePath.includes('app.asar' + path.sep) &&
        !loadablePath.includes('app.asar.unpacked')) {
      loadablePath = loadablePath.replace(
        'app.asar' + path.sep, 'app.asar.unpacked' + path.sep)
    }
    _db.loadExtension(loadablePath)
  } catch (err) {
    console.error('[DB] sqlite-vec load failed:', err.message)
  }
  _db.exec(SCHEMA)
  // Vector index. Separate exec because vec0 is conditional on the extension
  // loading successfully — a build without sqlite-vec should still work for
  // FTS-only search.
  try {
    _db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS items_vec USING vec0(
      item_id INTEGER PRIMARY KEY,
      embedding float[${EMBEDDING_DIM}]
    )`)
  } catch (err) {
    console.error('[DB] items_vec create failed:', err.message)
  }
  // research_jobs — история external-research (claude/perplexity/aistudio).
  // DESKTOP-ONLY: CLI про неё не знает, поэтому НЕ в основной SCHEMA (которая
  // sync'ается с library_db.py), а отдельным exec. Раньше история жила только
  // в RAM (AISTUDIO_JOBS + research-state Map) и терялась при рестарте — теперь
  // терминальные джобы persist'ятся сюда. jobId — наш id (aim_…/r…), PK.
  try {
    _db.exec(`CREATE TABLE IF NOT EXISTS research_jobs (
      job_id        TEXT PRIMARY KEY,
      kind          TEXT,              -- 'research' | 'aistudio'
      provider      TEXT,              -- 'claude' | 'perplexity' | 'aistudio'
      model_id      TEXT,
      mode          TEXT,              -- perplexity: 'search' | 'deep'
      status        TEXT,              -- done | error
      stage         TEXT,
      prompt        TEXT,
      response_text TEXT,
      url           TEXT,
      response_len  INTEGER,
      link_count    INTEGER,
      result_json   TEXT,
      error         TEXT,
      created_at    INTEGER,
      updated_at    INTEGER,
      done_at       INTEGER
    )`)
    _db.exec("CREATE INDEX IF NOT EXISTS idx_research_jobs_created ON research_jobs(created_at DESC)")
    _db.exec("ALTER TABLE research_jobs ADD COLUMN result_json TEXT")
  } catch (err) {
    if (!/duplicate column name/i.test(String(err?.message || ''))) {
      console.error('[DB] research_jobs create failed:', err.message)
    }
  }
  // Desktop-only UI preferences. Not part of the CLI-shared SCHEMA:
  // sc CLI does not need renderer layout state, but the value still belongs
  // in library.db so it survives app restarts with the rest of the desktop DB.
  try {
    _db.exec(`CREATE TABLE IF NOT EXISTS ui_preferences (
      key        TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`)
  } catch (err) {
    console.error('[DB] ui_preferences create failed:', err.message)
  }
  // Defensive: add columns if upgrading from earlier dev DB.
  try { _db.exec("ALTER TABLE items ADD COLUMN sender TEXT") } catch {}
  try { _db.exec("ALTER TABLE items ADD COLUMN has_media INTEGER NOT NULL DEFAULT 0") } catch {}
  try { _db.exec("ALTER TABLE items ADD COLUMN topic_id INTEGER") } catch {}
  try { _db.exec("ALTER TABLE items ADD COLUMN topic_title TEXT") } catch {}
  try { _db.exec("CREATE INDEX IF NOT EXISTS idx_items_topic ON items(source_id, topic_id)") } catch {}
  try { _db.exec("ALTER TABLE items ADD COLUMN parent_external_id TEXT") } catch {}
  try { _db.exec("ALTER TABLE items ADD COLUMN depth INTEGER") } catch {}
  try { _db.exec("CREATE INDEX IF NOT EXISTS idx_items_parent ON items(source_id, parent_external_id)") } catch {}
  // reply_resolved separates "checked, has no reply" (=1, parent_external_id NULL)
  // from "never checked yet" (=0, parent_external_id NULL). Without this the
  // backfill-job re-queues every NULL row forever. Set to 1 by both fresh fetches
  // (tg_fetch_json now writes it via bulkUpsertItems) and by the backfill subprocess.
  try { _db.exec("ALTER TABLE items ADD COLUMN reply_resolved INTEGER NOT NULL DEFAULT 0") } catch {}
  // Telegram reactions — JSON array [{e:'👍',n:8}, ...]. NULL = unchecked,
  // empty array `[]` = checked-and-no-reactions. Backfill loop uses
  // `reactions_resolved` (0/1) to tell those apart, mirroring the
  // parent_external_id / reply_resolved pair (see fact-database.md).
  try { _db.exec("ALTER TABLE items ADD COLUMN reactions TEXT") } catch {}
  try { _db.exec("ALTER TABLE items ADD COLUMN reactions_resolved INTEGER NOT NULL DEFAULT 0") } catch {}
  try { _db.exec("ALTER TABLE jobs  ADD COLUMN file_path TEXT") } catch {}
  try { _db.exec("ALTER TABLE sources ADD COLUMN has_discussion INTEGER") } catch {}
  try { _db.exec("ALTER TABLE sources ADD COLUMN tg_session TEXT") } catch {}
  try { _db.exec("ALTER TABLE sources ADD COLUMN tg_session_conflict INTEGER NOT NULL DEFAULT 0") } catch {}
  try { _db.exec("ALTER TABLE folders ADD COLUMN tg_session TEXT") } catch {}
  // folders: UNIQUE(tg_filter_id) → UNIQUE(tg_filter_id, tg_session). Старый
  // констрейнт не даёт держать filter_id=2 из двух разных аккаунтов (Telegram
  // нумерует DialogFilter с 2 ВНУТРИ каждого аккаунта). CREATE IF NOT EXISTS
  // существующую таблицу не перестроит — детектим старый автоиндекс и
  // пересобираем один раз. foreign_keys обязан быть OFF на время DROP: иначе
  // ON DELETE CASCADE из folder_sources сотрёт всю folder↔source привязку.
  try {
    const uniq = (_db.pragma("index_list('folders')") || []).filter(ix => ix.unique)
    const legacyUnique = uniq.some(ix => {
      const cols = _db.pragma(`index_info('${ix.name}')`) || []
      return cols.length === 1 && cols[0].name === 'tg_filter_id'
    })
    if (legacyUnique) {
      _db.pragma('foreign_keys = OFF')
      _db.exec(`
        BEGIN;
        CREATE TABLE folders_new (
          id                   INTEGER PRIMARY KEY AUTOINCREMENT,
          tg_filter_id         INTEGER,
          title                TEXT NOT NULL,
          tg_session           TEXT,
          default_period_days  INTEGER NOT NULL DEFAULT 7,
          default_types_json   TEXT,
          last_fetched_at      INTEGER,
          added_at             INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at           INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(tg_filter_id, tg_session)
        );
        INSERT INTO folders_new (id, tg_filter_id, title, tg_session,
                                 default_period_days, default_types_json,
                                 last_fetched_at, added_at, updated_at)
          SELECT id, tg_filter_id, title, tg_session,
                 default_period_days, default_types_json,
                 last_fetched_at, added_at, updated_at
            FROM folders;
        DROP TABLE folders;
        ALTER TABLE folders_new RENAME TO folders;
        COMMIT;
      `)
      _db.pragma('foreign_keys = ON')
      console.log('[DB] folders rebuilt: UNIQUE(tg_filter_id, tg_session)')
    }
  } catch (err) {
    try { _db.exec('ROLLBACK') } catch {}
    try { _db.pragma('foreign_keys = ON') } catch {}
    console.error('[DB] folders unique-rebuild failed:', err.message)
  }
  // items_fts: contentless (content='') БЕЗ contentless_delete=1 не умеет
  // DELETE — кидает 'cannot DELETE from contentless fts5 table'. На это
  // напарывались deleteSource (вся транзакция откатывается, чат с
  // проиндексированными caption'ами вообще не удалить) и FTS-refresh в
  // appendItemTranscript/markItemTranscribed (для item'а, чей caption уже
  // в индексе). Конфиг fts5 меняется только пересозданием таблицы —
  // детектим старый DDL и пересобираем один раз: caption из items,
  // transcript из файла transcript_path (так же, как markItemTranscribed).
  try {
    const ddl = _db.prepare(
      `SELECT sql FROM sqlite_master WHERE name='items_fts' AND type='table'`
    ).get()
    if (ddl && ddl.sql && !ddl.sql.includes('contentless_delete')) {
      console.log('[DB] items_fts rebuild: adding contentless_delete=1…')
      const t0 = Date.now()
      _db.exec(`
        DROP TABLE items_fts;
        CREATE VIRTUAL TABLE items_fts USING fts5(
          caption, transcript,
          content='', contentless_delete=1,
          tokenize='unicode61 remove_diacritics 2'
        );
      `)
      const rows = _db.prepare(`
        SELECT id, caption, transcript_path FROM items
         WHERE (caption IS NOT NULL AND length(trim(caption)) > 0)
            OR transcript_path IS NOT NULL
      `).all()
      const ins = _db.prepare(
        `INSERT INTO items_fts (rowid, caption, transcript) VALUES (?, ?, ?)`)
      const tx = _db.transaction((rs) => {
        for (const r of rs) {
          let transcript = ''
          if (r.transcript_path) {
            try { transcript = fs.readFileSync(r.transcript_path, 'utf8') } catch {}
          }
          const cap = r.caption || ''
          if (cap.trim() || transcript.trim()) ins.run(r.id, cap, transcript)
        }
      })
      tx(rows)
      console.log(`[DB] items_fts rebuilt: ${rows.length} rows in ${Date.now() - t0}ms`)
    }
  } catch (err) {
    console.error('[DB] items_fts contentless_delete rebuild failed:', err.message)
  }
  // is_explicit = 1 если source создан целенаправленным запросом юзера
  // (paste @channel, channel-fetch, batch-transcribe, telegram resolve и
  // т.п.). =0 для «случайных» (single-paste отдельного видео через
  // browser-extension). Sidebar группирует «случайные» в свёрнутый
  // блок «Прочее».
  try { _db.exec("ALTER TABLE sources ADD COLUMN is_explicit INTEGER NOT NULL DEFAULT 0") } catch {}
  // Backfill для уже существующих row'ов: до введения флага sources с
  // аватаркой создавались только через целенаправленный fetch (channel
  // metadata pull, telegram entity event с photo). Используем avatar_url
  // как proxy «осознанный запрос». Telegram-чаты без аватаров тоже
  // обычно создавались юзером через resolve, но для них критерий —
  // наличие display_name (fallthrough в _normalize_title), так что
  // OR-условие покрывает оба.
  try {
    // Аватарка качается только тогда, когда был фактический channel/entity
    // request (а не голый upsert source'а под item). >1 item значит юзер
    // фетчил список — single-paste кладёт ровно один item.
    _db.exec(`
      UPDATE sources
         SET is_explicit = 1
       WHERE is_explicit = 0
         AND (
           avatar_url IS NOT NULL
           OR (SELECT COUNT(*) FROM items WHERE items.source_id = sources.id) > 1
         )
    `)
  } catch {}
  // Demote chats that ended up is_explicit=1 only because of folder-driven
  // activity. Truth source for "user actually subscribed to this chat" — был
  // ли хоть один direct fetch (paste @handle, channel-fetch через config-form,
  // preview, batch). Direct = type LIKE 'tg_%' && parameters_json НЕ содержит
  // _folder_umbrella_id. Папочные umbrella/refresh job'ы помечены этим ключом
  // в params, поэтому их легко исключить.
  //
  // Зачем не проверять items: папочный fetch тоже наполняет items. Мы и хотим,
  // чтобы у юзера был доступ к транскриптам/постам через TelegramScreen, но
  // в Library sidebar (`is_explicit`-фильтрованный) такие каналы попадать не
  // должны — они не «осознанные подписки».
  //
  // Идемпотентно — no-op после того, как backfill выше прогнал правильную
  // классификацию. Любой будущий direct fetch перезапишет is_explicit=1
  // через MAX-семантику в upsertSource.
  try {
    _db.exec(`
      UPDATE sources
         SET is_explicit = 0
       WHERE platform = 'telegram'
         AND is_explicit = 1
         AND id IN (SELECT source_id FROM folder_sources)
         AND NOT EXISTS (
           SELECT 1 FROM jobs j
           WHERE j.source_id = sources.id
             AND j.type LIKE 'tg_%'
             AND (j.parameters_json IS NULL
                  OR json_extract(j.parameters_json, '$._folder_umbrella_id') IS NULL)
         )
    `)
  } catch {}
  console.log(`[DB] opened ${DB_PATH}`)
  return _db
}

function close() {
  if (_db) {
    _db.close()
    _db = null
  }
}

// ─── Sources ──────────────────────────────────────────────────────────

function cleanMetaPatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  for (const [key, val] of Object.entries(value)) {
    if (val == null) continue
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const nested = cleanMetaPatch(val)
      if (Object.keys(nested).length) out[key] = nested
    } else {
      out[key] = val
    }
  }
  return out
}

function mergeSourceMetaJson(existingJson, patch) {
  let base = {}
  try {
    base = existingJson ? JSON.parse(existingJson) : {}
    if (!base || typeof base !== 'object' || Array.isArray(base)) base = {}
  } catch {
    base = {}
  }
  const cleanPatch = cleanMetaPatch(patch)
  const merged = { ...base }
  for (const [key, val] of Object.entries(cleanPatch)) {
    if (val && typeof val === 'object' && !Array.isArray(val)
      && merged[key] && typeof merged[key] === 'object' && !Array.isArray(merged[key])) {
      merged[key] = { ...merged[key], ...val }
    } else {
      merged[key] = val
    }
  }
  return Object.keys(merged).length ? JSON.stringify(merged) : null
}

function upsertSource({ platform, handle, display_name, external_id, avatar_url, meta, mark_synced, is_explicit, tg_session }) {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const requestedHandle = String(handle || '').replace(/^@+/, '').trim()
  // An entity event is a live Telegram answer.  Its username is therefore
  // authoritative over the alias used to start the request: aliases can be
  // renamed while external_id stays stable.  Keep the old/requested handle
  // only as a lookup fallback for legacy rows without an external_id.
  const telegramUsername = platform === 'telegram' && typeof meta?.username === 'string'
    ? meta.username.replace(/^@+/, '').trim()
    : ''
  const cleanHandle = telegramUsername || requestedHandle

  // is_explicit семантика: ставится в 1 callerом ИМЕННО при целенаправленном
  // запросе по каналу (paste @channel, channel-fetch, batch-pick, telegram
  // resolve). Bridge /yt-add для single-paste из расширения НЕ ставит,
  // оставляет дефолтный 0. Если уже было 1 — никогда не понижаем (юзер
  // когда-то спарсил канал явно, потом single-paste отдельного видео не
  // должен его «разжаловать»). Поэтому MAX над excluded и текущим.
  const explicitFlag = is_explicit ? 1 : 0
  // tg_session: имя активной сессии на момент операции. NULL (не-TG платформы,
  // legacy-вызовы) ничего не перезаписывает. Непустое значение:
  //   - row.tg_session NULL  → просто записываем (первая привязка);
  //   - совпадает           → no-op;
  //   - отличается          → чат реально читали из ДРУГОГО аккаунта:
  //     переписываем на свежую сессию + поднимаем tg_session_conflict=1,
  //     чтобы UI попросил юзера выбрать каноническую. Conflict-флаг сам не
  //     гаснет — сбрасывается явным пином (setSourceSession).
  const sess = (typeof tg_session === 'string' && tg_session.trim()) ? tg_session.trim() : null

  // Telegram: identity чата = external_id (tg chat id), а не форма handle.
  // Один и тот же чат приходит как '@username' (folder resolve, paste),
  // голый '<id>' (resolve-title), '-100<id>' (t.me/c ссылки) и в другом
  // регистре username'а — UNIQUE(platform, handle) сквозь это не видит,
  // на живой БД скопилось 9 пар дублей. Прежде чем INSERT'ить, ищем
  // существующую строку по chat id / альтернативным handle-формам и
  // обновляем её теми же правилами, что ON CONFLICT-ветка ниже.
  if (platform === 'telegram') {
    let extId = (external_id != null && String(external_id).trim())
      ? String(external_id).trim() : null
    // Числовой handle сам кодирует chat id: '-100<id>' (channel/supergroup),
    // '-<id>' (legacy group), '<id>'. Если external_id не передали — выводим
    // кандидата из handle, чтобы lookup по identity всё равно сработал
    // (та же конвенция, что в findTelegramSourceByTarget).
    if (!extId && /^-?\d+$/.test(cleanHandle)) {
      extId = cleanHandle.startsWith('-100') ? cleanHandle.slice(4)
        : cleanHandle.startsWith('-') ? cleanHandle.slice(1)
        : cleanHandle
    }
    let row = null
    if (extId) {
      row = db.prepare(
        `SELECT id, handle, meta_json FROM sources
          WHERE platform='telegram' AND external_id=? LIMIT 1`).get(extId)
    }
    if (!row) {
      row = db.prepare(
        `SELECT id, handle, meta_json FROM sources
          WHERE platform='telegram' AND handle=? COLLATE NOCASE LIMIT 1`).get(cleanHandle)
    }
    if (!row && requestedHandle && requestedHandle !== cleanHandle) {
      row = db.prepare(
        `SELECT id, handle, meta_json FROM sources
          WHERE platform='telegram' AND handle=? COLLATE NOCASE LIMIT 1`).get(requestedHandle)
    }
    if (!row && /^-?\d+$/.test(cleanHandle)) {
      const alt = cleanHandle.startsWith('-100')
        ? cleanHandle.slice(4) : ('-100' + cleanHandle)
      row = db.prepare(
        `SELECT id, handle, meta_json FROM sources
          WHERE platform='telegram' AND handle=? LIMIT 1`).get(alt)
    }
    if (row) {
      const meta_json = mergeSourceMetaJson(row.meta_json, meta)
      db.prepare(`
        UPDATE sources SET
          display_name   = COALESCE(?, display_name),
          external_id    = COALESCE(?, external_id),
          avatar_url     = COALESCE(?, avatar_url),
          meta_json      = COALESCE(?, meta_json),
          last_synced_at = CASE WHEN ? = 1 THEN ? ELSE last_synced_at END,
          is_explicit    = MAX(is_explicit, ?),
          tg_session_conflict = CASE
            WHEN ? IS NOT NULL AND tg_session IS NOT NULL AND tg_session != ?
            THEN 1 ELSE tg_session_conflict END,
          tg_session     = COALESCE(?, tg_session)
        WHERE id = ?
      `).run(
        display_name || null, extId, avatar_url || null, meta_json,
        mark_synced ? 1 : 0, now, explicitFlag,
        sess, sess, sess, row.id,
      )
      // Канонизация handle: username читабельнее численной формы, а username
      // из свежего entity-event'а авторитетнее старого username. Поэтому
      // обновляем не только число → имя, но и old_name → new_name при том же
      // external_id. Число поверх читаемого имени по-прежнему не пишем.
      const numericish = (h) => /^-?\d+$/.test(String(h || ''))
      const shouldRefreshUsername = !!telegramUsername && row.handle !== cleanHandle
      if (!numericish(cleanHandle) && (numericish(row.handle) || shouldRefreshUsername)) {
        const clash = db.prepare(
          `SELECT id FROM sources
            WHERE platform='telegram' AND handle=? COLLATE NOCASE AND id != ?`
        ).get(cleanHandle, row.id)
        if (!clash) {
          db.prepare(`UPDATE sources SET handle=? WHERE id=?`).run(cleanHandle, row.id)
        }
      }
      return row.id
    }
  }

  const existingByHandle = db.prepare(
    `SELECT id, meta_json FROM sources WHERE platform = ? AND handle = ? LIMIT 1`
  ).get(platform, cleanHandle)
  const meta_json = mergeSourceMetaJson(existingByHandle?.meta_json || null, meta)

  db.prepare(`
    INSERT INTO sources (platform, handle, display_name, external_id, avatar_url, meta_json, last_synced_at, is_explicit, tg_session)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, handle) DO UPDATE SET
      display_name   = COALESCE(excluded.display_name, sources.display_name),
      external_id    = COALESCE(excluded.external_id,  sources.external_id),
      avatar_url     = COALESCE(excluded.avatar_url,   sources.avatar_url),
      meta_json      = COALESCE(excluded.meta_json,    sources.meta_json),
      last_synced_at = CASE WHEN ? = 1 THEN ? ELSE sources.last_synced_at END,
      is_explicit    = MAX(sources.is_explicit, excluded.is_explicit),
      tg_session_conflict = CASE
        WHEN excluded.tg_session IS NOT NULL
         AND sources.tg_session IS NOT NULL
         AND sources.tg_session != excluded.tg_session
        THEN 1 ELSE sources.tg_session_conflict END,
      tg_session     = COALESCE(excluded.tg_session, sources.tg_session)
  `).run(
    platform, cleanHandle, display_name || null, external_id || null,
    avatar_url || null, meta_json,
    mark_synced ? now : null, explicitFlag, sess,
    mark_synced ? 1 : 0, now,
  )

  const row = db.prepare(`SELECT id FROM sources WHERE platform = ? AND handle = ?`).get(platform, cleanHandle)
  return row.id
}

// Ручной пин чата к сессии (из SourceDetail-бейджа). Явный выбор юзера
// гасит conflict-флаг — теперь привязка каноническая, пока следующий fetch
// из другой сессии снова его не поднимет.
function setSourceSession(sourceId, sessionName) {
  const db = getDb()
  const sess = (typeof sessionName === 'string' && sessionName.trim()) ? sessionName.trim() : null
  db.prepare(`UPDATE sources SET tg_session = ?, tg_session_conflict = 0 WHERE id = ?`)
    .run(sess, sourceId)
}

function listSources(platform = null) {
  const db = getDb()
  const hasVec = itemsVecAvailable(db)
  const indexedExpr = hasVec ? `COALESCE(iv.semantic_indexed_count, 0)` : `0`
  const itemStatsJoin = `
    LEFT JOIN (
      SELECT source_id,
             COUNT(*) AS items_count,
             SUM(CASE WHEN type='boosty_post'  THEN 1 ELSE 0 END) AS boosty_posts_n,
             SUM(CASE WHEN type='boosty_video' THEN 1 ELSE 0 END) AS boosty_videos_n,
             SUM(CASE WHEN type='boosty_video' AND transcribe_status='done' THEN 1 ELSE 0 END) AS boosty_transcribed_n,
             SUM(CASE WHEN caption IS NOT NULL AND length(trim(caption)) > 0 THEN 1 ELSE 0 END) AS semantic_indexable_count,
             MAX(published_at) AS last_item_at,
             SUM(CASE WHEN type='text'     THEN 1 ELSE 0 END) AS text_n,
             SUM(CASE WHEN type='voice'    THEN 1 ELSE 0 END) AS voice_n,
             SUM(CASE WHEN type='video'    THEN 1 ELSE 0 END) AS video_n,
             SUM(CASE WHEN type='photo'    THEN 1 ELSE 0 END) AS photo_n,
             SUM(CASE WHEN type='audio'    THEN 1 ELSE 0 END) AS audio_n,
             SUM(CASE WHEN type='document' THEN 1 ELSE 0 END) AS document_n
        FROM items
       GROUP BY source_id
    ) ia ON ia.source_id = s.id
  `
  const indexedJoin = hasVec ? `
    LEFT JOIN (
      SELECT i.source_id, COUNT(*) AS semantic_indexed_count
        FROM items_vec v
        JOIN items i ON i.id = v.item_id
       GROUP BY i.source_id
    ) iv ON iv.source_id = s.id
  ` : ''
  const sql = `
    SELECT s.*,
      CASE WHEN s.platform='boosty'
        THEN COALESCE(ia.boosty_posts_n, 0)
        ELSE COALESCE(ia.items_count, 0)
      END AS items_count,
      COALESCE(ia.boosty_posts_n, 0) AS boosty_posts_count,
      COALESCE(ia.boosty_videos_n, 0) AS boosty_videos_count,
      COALESCE(ia.boosty_transcribed_n, 0) AS boosty_transcribed_count,
      COALESCE(ia.semantic_indexable_count, 0) AS semantic_indexable_count,
      ${indexedExpr} AS semantic_indexed_count,
      ia.last_item_at AS last_item_at,
      COALESCE(ia.text_n, 0) AS text_n,
      COALESCE(ia.voice_n, 0) AS voice_n,
      COALESCE(ia.video_n, 0) AS video_n,
      COALESCE(ia.photo_n, 0) AS photo_n,
      COALESCE(ia.audio_n, 0) AS audio_n,
      COALESCE(ia.document_n, 0) AS document_n
    FROM sources s
    ${itemStatsJoin}
    ${indexedJoin}
    ${platform ? 'WHERE s.platform = ?' : ''}
    ORDER BY s.platform, COALESCE(s.last_synced_at, 0) DESC
  `
  return platform ? db.prepare(sql).all(platform) : db.prepare(sql).all()
}

/**
 * Per-source notes — stored as `meta_json.notes` (single string).  Avoids
 * schema migration: meta_json is already there and shared with the CLI.
 */
function getSourceNotes(sourceId) {
  const db = getDb()
  const row = db.prepare(`SELECT meta_json FROM sources WHERE id = ?`).get(sourceId)
  if (!row) return ''
  try {
    const meta = JSON.parse(row.meta_json || '{}')
    return typeof meta.notes === 'string' ? meta.notes : ''
  } catch {
    return ''
  }
}

function setSourceNotes(sourceId, notes) {
  const db = getDb()
  const row = db.prepare(`SELECT meta_json FROM sources WHERE id = ?`).get(sourceId)
  if (!row) return { ok: false, error: 'source not found' }
  let meta = {}
  try { meta = row.meta_json ? JSON.parse(row.meta_json) : {} } catch {}
  meta.notes = String(notes || '')
  db.prepare(`UPDATE sources SET meta_json = ? WHERE id = ?`).run(JSON.stringify(meta), sourceId)
  return { ok: true }
}

/**
 * Persistent per-source access state.  This lives in meta_json so it stays
 * attached to the Telegram source even when repeated auto failures are no
 * longer written to History.  Read-modify-write is mandatory: tg_auto,
 * username, notes and other platform metadata must survive unchanged.
 */
function setTelegramSourceUnavailable(sourceId, { code, message, checked_at } = {}) {
  const db = getDb()
  const id = Number(sourceId)
  if (!Number.isFinite(id) || id <= 0) return { ok: false, error: 'source_id required' }
  const row = db.prepare(
    `SELECT platform, meta_json FROM sources WHERE id = ?`
  ).get(id)
  if (!row || row.platform !== 'telegram') return { ok: false, error: 'telegram source not found' }

  let meta = {}
  try { meta = row.meta_json ? JSON.parse(row.meta_json) : {} } catch {}
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) meta = {}
  const previous = meta.tg_health && typeof meta.tg_health === 'object'
    ? meta.tg_health
    : {}
  const checkedAt = Number(checked_at) || Math.floor(Date.now() / 1000)
  meta.tg_health = {
    status: 'unavailable',
    code: code || 'telegram_source_unavailable',
    message: String(message || 'Telegram больше не отдаёт этот чат выбранному аккаунту.'),
    first_failed_at: Number(previous.first_failed_at) || checkedAt,
    checked_at: checkedAt,
  }
  db.prepare(`UPDATE sources SET meta_json = ? WHERE id = ?`)
    .run(JSON.stringify(meta), id)
  return { ok: true, changed: previous.status !== 'unavailable' }
}

function clearTelegramSourceHealth(sourceId) {
  const db = getDb()
  const id = Number(sourceId)
  if (!Number.isFinite(id) || id <= 0) return { ok: false, error: 'source_id required' }
  const row = db.prepare(
    `SELECT platform, meta_json FROM sources WHERE id = ?`
  ).get(id)
  if (!row || row.platform !== 'telegram') return { ok: false, error: 'telegram source not found' }

  let meta = {}
  try { meta = row.meta_json ? JSON.parse(row.meta_json) : {} } catch {}
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) meta = {}
  if (!meta.tg_health) return { ok: true, changed: false }
  delete meta.tg_health
  const metaJson = Object.keys(meta).length ? JSON.stringify(meta) : null
  db.prepare(`UPDATE sources SET meta_json = ? WHERE id = ?`).run(metaJson, id)
  return { ok: true, changed: true }
}

function setTelegramAutoForSources(sourceIds, patch = {}) {
  const db = getDb()
  const ids = Array.isArray(sourceIds)
    ? sourceIds.map(Number).filter(Number.isFinite)
    : []
  if (!ids.length) return { ok: false, error: 'source_ids required' }

  const validTypes = new Set(['text', 'voice', 'video', 'photo', 'docs', 'comments'])
  const cleanTypes = Array.isArray(patch.types)
    ? patch.types.map(String).filter(t => validTypes.has(t))
    : null
  const cleanEngine = ['assemblyai', 'gemini'].includes(patch.engine)
    ? patch.engine
    : null

  const rows = db.prepare(`
    SELECT id, meta_json FROM sources
     WHERE platform = 'telegram'
       AND id IN (${ids.map(() => '?').join(',')})
  `).all(...ids)
  const upd = db.prepare(`UPDATE sources SET meta_json = ? WHERE id = ?`)
  const tx = db.transaction((rs) => {
    for (const row of rs) {
      let meta = {}
      try { meta = row.meta_json ? JSON.parse(row.meta_json) : {} } catch {}
      const prev = (meta.tg_auto && typeof meta.tg_auto === 'object') ? meta.tg_auto : {}
      const next = { ...prev }
      if (typeof patch.pull === 'boolean') next.pull = patch.pull
      if (typeof patch.index === 'boolean') next.index = patch.index
      if (next.index) next.pull = true
      if (cleanTypes) next.types = cleanTypes
      if (cleanEngine) next.engine = cleanEngine
      if (!next.pull) next.index = false
      if (!next.pull && !next.index) {
        delete meta.tg_auto
      } else {
        meta.tg_auto = next
      }
      upd.run(JSON.stringify(meta), row.id)
    }
  })
  tx(rows)
  return { ok: true, updated: rows.length }
}

function listTelegramAutoSources() {
  const db = getDb()
  const rows = db.prepare(`
    SELECT id, handle, display_name, external_id, tg_session, meta_json
      FROM sources
     WHERE platform = 'telegram'
       AND handle IS NOT NULL
     ORDER BY COALESCE(last_synced_at, 0) ASC, id ASC
  `).all()
  return rows
    .map((row) => {
      let meta = {}
      try { meta = row.meta_json ? JSON.parse(row.meta_json) : {} } catch {}
      const raw = (meta.tg_auto && typeof meta.tg_auto === 'object') ? meta.tg_auto : {}
      const health = (meta.tg_health && typeof meta.tg_health === 'object')
        ? meta.tg_health
        : null
      return {
        ...row,
        tg_health: health,
        tg_auto: {
          pull: !!raw.pull || !!raw.index,
          index: !!raw.index,
          types: Array.isArray(raw.types) ? raw.types.map(String).filter(Boolean) : [],
          engine: raw.engine || 'assemblyai',
        },
      }
    })
    .filter(row => row.tg_auto.pull || row.tg_auto.index)
}

function semanticIndexCountsForSources(sourceIds) {
  const db = getDb()
  const ids = Array.isArray(sourceIds)
    ? sourceIds.map(Number).filter(Number.isFinite)
    : []
  if (!ids.length) return new Map()
  const placeholders = ids.map(() => '?').join(',')
  const hasVec = itemsVecAvailable(db)
  const indexedJoin = hasVec ? `
    LEFT JOIN (
      SELECT i.source_id, COUNT(*) AS semantic_indexed_count
        FROM items_vec v
        JOIN items i ON i.id = v.item_id
       GROUP BY i.source_id
    ) iv ON iv.source_id = s.id
  ` : ''
  const indexedExpr = hasVec ? 'COALESCE(iv.semantic_indexed_count, 0)' : '0'
  const rows = db.prepare(`
    SELECT s.id,
      (SELECT COUNT(*)
         FROM items i
        WHERE i.source_id = s.id
          AND i.caption IS NOT NULL
          AND length(trim(i.caption)) > 0) AS semantic_indexable_count,
      ${indexedExpr} AS semantic_indexed_count
    FROM sources s
    ${indexedJoin}
    WHERE s.id IN (${placeholders})
  `).all(...ids)
  return new Map(rows.map(r => [Number(r.id), {
    semantic_indexable_count: Number(r.semantic_indexable_count) || 0,
    semantic_indexed_count: Number(r.semantic_indexed_count) || 0,
  }]))
}

function getSource(id) {
  const db = getDb()
  // Mirror listSources()'s shape — include items_count + last_item_at so the
  // SourceDetail page can show "Последнее видео / сообщение" without an
  // extra round-trip.
  return db.prepare(`
    SELECT s.*,
      CASE WHEN s.platform='boosty'
        THEN (SELECT COUNT(*) FROM items i WHERE i.source_id = s.id AND i.type='boosty_post')
        ELSE (SELECT COUNT(*) FROM items i WHERE i.source_id = s.id)
      END AS items_count,
      (SELECT COUNT(*) FROM items i WHERE i.source_id = s.id AND i.type='boosty_post') AS boosty_posts_count,
      (SELECT COUNT(*) FROM items i WHERE i.source_id = s.id AND i.type='boosty_video') AS boosty_videos_count,
      (SELECT COUNT(*) FROM items i WHERE i.source_id = s.id AND i.type='boosty_video' AND i.transcribe_status='done') AS boosty_transcribed_count,
      (SELECT MAX(published_at) FROM items i WHERE i.source_id = s.id) AS last_item_at
    FROM sources s WHERE s.id = ?
  `).get(id)
}

/**
 * UPSERT a YouTube channel by channel_id (UCxxxx) — canonical primary key.
 * Several URL forms (/@handle, /c/x, /channel/UCxx, /user/x) all map to the
 * same channel; keying on `external_id = channel_id` avoids duplicates.
 * Falls back to handle-based unique if channel_id is missing (rare).
 *
 * Always merges `meta` into the existing meta_json instead of replacing —
 * preserves any keys that came from earlier writes.
 */
function upsertYoutubeChannel({ channel_id, handle, display_name, avatar_url, meta, is_explicit }) {
  return _upsertWebChannel('youtube', { channel_id, handle, display_name, avatar_url, meta, is_explicit })
}

function upsertTiktokChannel({ channel_id, handle, display_name, avatar_url, meta, is_explicit }) {
  return _upsertWebChannel('tiktok', { channel_id, handle, display_name, avatar_url, meta, is_explicit })
}

function upsertBoostyChannel({ author_id, handle, display_name, avatar_url, meta, is_explicit, mark_synced = true }) {
  return _upsertWebChannel('boosty', {
    channel_id: author_id,
    handle,
    display_name,
    avatar_url,
    meta,
    is_explicit,
    mark_synced,
  })
}

function _upsertWebChannel(platform, { channel_id, handle, display_name, avatar_url, meta, is_explicit, mark_synced = true }) {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const cleanHandle = String(handle || '').replace(/^@+/, '').trim() || channel_id

  // Find existing source by external_id first (channel_id is stable). If
  // absent, by (platform, handle) — covers legacy rows from before we
  // captured channel_id.
  const byExt = channel_id
    ? db.prepare(`SELECT * FROM sources WHERE platform=? AND external_id=?`).get(platform, channel_id)
    : null
  const byHandle = !byExt
    ? db.prepare(`SELECT * FROM sources WHERE platform=? AND handle=?`).get(platform, cleanHandle)
    : null
  const existing = byExt || byHandle || null

  let mergedMeta = meta || {}
  if (existing && existing.meta_json) {
    try { mergedMeta = { ...JSON.parse(existing.meta_json), ...(meta || {}) } } catch {}
  }
  const meta_json = Object.keys(mergedMeta).length ? JSON.stringify(mergedMeta) : null
  const explicitFlag = is_explicit ? 1 : 0

  if (existing) {
    // is_explicit «защёлкивается» в 1: single-paste из browser-extension
    // не должен «разжаловать» канал, который юзер раньше явно фетчил.
    db.prepare(`
      UPDATE sources
         SET handle         = COALESCE(?, handle),
             display_name   = COALESCE(?, display_name),
             external_id    = COALESCE(?, external_id),
             avatar_url     = COALESCE(?, avatar_url),
             meta_json      = COALESCE(?, meta_json),
             last_synced_at = CASE WHEN ? = 1 THEN ? ELSE last_synced_at END,
             is_explicit    = MAX(is_explicit, ?)
       WHERE id = ?
    `).run(
      cleanHandle, display_name || null, channel_id || null,
      avatar_url || null, meta_json, mark_synced ? 1 : 0, now, explicitFlag, existing.id,
    )
    return existing.id
  }

  db.prepare(`
    INSERT INTO sources (platform, handle, display_name, external_id, avatar_url, meta_json, last_synced_at, is_explicit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(platform, cleanHandle, display_name || null, channel_id || null, avatar_url || null, meta_json, mark_synced ? now : null, explicitFlag)
  return db.prepare('SELECT last_insert_rowid() AS id').get().id
}

// ─── Items ────────────────────────────────────────────────────────────

function upsertItem({
  source_id, external_id, type, url, title, caption,
  published_at, duration_seconds, views, likes, comments,
  media_path, thumbnail_path,
  sender, has_media, raw_meta, topic_id, topic_title,
  parent_external_id, depth, reply_resolved,
  reactions, reactions_resolved,
}) {
  const db = getDb()
  const raw_meta_json = raw_meta ? JSON.stringify(raw_meta) : null
  // reply_resolved is sticky-up: callers that authoritatively know reply
  // state (Telethon) pass `1`, callers that don't (Reddit, IG, YT) leave it
  // undefined and we coerce to 0 on insert. On UPDATE we use MAX so a once-
  // resolved row never reverts to 0 from a subsequent metadata-only upsert.
  const replyResolvedVal = reply_resolved ? 1 : 0
  // Same pattern for reactions: TG fetch always knows (None / list of
  // ReactionCount), Reddit/IG/YT never set it.
  const reactionsResolvedVal = reactions_resolved ? 1 : 0
  // reactions is either a JSON string (already serialised by caller) or
  // an array (we serialise here). null/undefined = leave existing alone.
  let reactionsJson = null
  if (reactions != null) {
    reactionsJson = typeof reactions === 'string' ? reactions : JSON.stringify(reactions)
  }
  db.prepare(`
    INSERT INTO items (
      source_id, external_id, type, url, title, caption, published_at,
      duration_seconds, views, likes, comments, media_path, thumbnail_path,
      sender, has_media, raw_meta_json,
      topic_id, topic_title, parent_external_id, depth, reply_resolved,
      reactions, reactions_resolved
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id, external_id) DO UPDATE SET
      type             = COALESCE(excluded.type,             items.type),
      url              = COALESCE(excluded.url,              items.url),
      title            = COALESCE(excluded.title,            items.title),
      caption          = CASE
                           -- Preserve any AI-appended block on UPSERT. Without
                           -- this, a re-fetch that skips media-processing (because
                           -- transcribe_status='done') would still rewrite caption
                           -- with raw msg.text, dropping the «[голосовое — расшифровка
                           -- · X] …» block appendItemTranscript wrote earlier.
                           -- Fresh first-time inserts have items.caption = NULL so
                           -- the COALESCE branch runs unchanged.
                           WHEN items.caption IS NOT NULL
                                AND (items.caption LIKE '%[голосовое — расшифровка%'
                                  OR items.caption LIKE '%[фото — описание%'
                                  OR items.caption LIKE '%[документ — извлечение%')
                             THEN items.caption
                           ELSE COALESCE(excluded.caption, items.caption)
                         END,
      published_at     = COALESCE(excluded.published_at,     items.published_at),
      duration_seconds = COALESCE(excluded.duration_seconds, items.duration_seconds),
      views            = COALESCE(excluded.views,            items.views),
      likes            = COALESCE(excluded.likes,            items.likes),
      comments         = COALESCE(excluded.comments,         items.comments),
      media_path       = COALESCE(excluded.media_path,       items.media_path),
      thumbnail_path   = COALESCE(excluded.thumbnail_path,   items.thumbnail_path),
      sender           = COALESCE(excluded.sender,           items.sender),
      has_media        = COALESCE(excluded.has_media,        items.has_media),
      raw_meta_json    = COALESCE(excluded.raw_meta_json,    items.raw_meta_json),
      topic_id         = COALESCE(excluded.topic_id,         items.topic_id),
      topic_title      = COALESCE(excluded.topic_title,      items.topic_title),
      parent_external_id = COALESCE(excluded.parent_external_id, items.parent_external_id),
      depth            = COALESCE(excluded.depth,            items.depth),
      reply_resolved   = MAX(items.reply_resolved, excluded.reply_resolved),
      reactions        = COALESCE(excluded.reactions,        items.reactions),
      reactions_resolved = MAX(items.reactions_resolved, excluded.reactions_resolved),
      updated_at       = unixepoch()
  `).run(
    source_id, external_id, type, url || null, title || null, caption || null,
    published_at || null, duration_seconds || null,
    views || null, likes || null, comments || null,
    media_path || null, thumbnail_path || null,
    sender || null, has_media ? 1 : 0, raw_meta_json,
    topic_id != null ? topic_id : null,
    topic_title || null,
    parent_external_id || null,
    depth != null ? depth : null,
    replyResolvedVal,
    reactionsJson,
    reactionsResolvedVal,
  )
  return db.prepare(`SELECT id FROM items WHERE source_id = ? AND external_id = ?`)
           .get(source_id, external_id).id
}

function bulkUpsertItems(rows) {
  const db = getDb()
  const tx = db.transaction((rows) => {
    for (const r of rows) {
      const id = upsertItem(r)
      // Mirror caption into FTS so search works without a separate transcribe step.
      if (r.caption && r.caption.trim()) {
        try { indexItemForFts(id, r.caption, '') } catch {}
      }
    }
  })
  tx(rows)
}

function parseObjectJson(value) {
  try {
    const parsed = value ? JSON.parse(value) : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Persist the Boosty hierarchy without flattening a multi-video post:
 * one boosty_post parent plus one boosty_video child per actual player.
 *
 * Access is deliberately sticky. If a post was readable before and a later
 * catalog response hides it, the row becomes `lost` rather than looking like
 * a post we never had access to. Local audio/transcripts remain untouched by
 * metadata refreshes because upsertItem only fills those paths when supplied.
 */
function upsertBoostyCatalog({ source_id, posts, thumbnail_paths = {} }) {
  if (!source_id || !Array.isArray(posts)) return { posts: 0, videos: 0 }
  const db = getDb()
  const existingRows = db.prepare(`
    SELECT * FROM items
     WHERE source_id = ? AND type IN ('boosty_post', 'boosty_video')
  `).all(source_id)
  const existing = new Map(existingRows.map(row => [String(row.external_id), row]))
  const childrenByParent = new Map()
  for (const row of existingRows) {
    if (row.type !== 'boosty_video' || !row.parent_external_id) continue
    const key = String(row.parent_external_id)
    if (!childrenByParent.has(key)) childrenByParent.set(key, [])
    childrenByParent.get(key).push(row)
  }

  const rows = []
  const accessUpdates = []
  let videoCount = 0
  for (const post of posts) {
    if (!post || !post.post_id) continue
    const parentId = String(post.external_id || `post:${post.post_id}`)
    const oldParent = existing.get(parentId)
    const oldParentMeta = parseObjectJson(oldParent?.raw_meta_json)
    const everAccessible = oldParentMeta.ever_accessible === true || post.has_access === true
    const accessState = post.has_access === true
      ? 'accessible'
      : everAccessible ? 'lost' : 'locked'
    const parentMeta = {
      ...oldParentMeta,
      platform: 'boosty',
      entity_kind: 'post',
      post_id: String(post.post_id),
      canonical_url: post.canonical_url || null,
      has_access: post.has_access === true,
      ever_accessible: everAccessible,
      access_state: accessState,
      subscription_level: post.subscription_level || null,
      price: post.price ?? null,
      currency_prices: post.currency_prices || {},
      video_count: Number(post.video_count || 0),
      tags: Array.isArray(post.tags) ? post.tags : [],
      content_counters: post.content_counters || {},
      is_deleted: !!post.is_deleted,
      is_blocked: !!post.is_blocked,
      is_published: post.is_published !== false,
      is_waiting_video: !!post.is_waiting_video,
      is_pinned: !!post.is_pinned,
      updated_at_remote: post.updated_at || null,
    }
    const parentThumbnail = thumbnail_paths[parentId]
      || (oldParent?.thumbnail_path && !/^https?:\/\//i.test(oldParent.thumbnail_path) ? oldParent.thumbnail_path : null)
      || post.thumbnail_url
      || oldParent?.thumbnail_path
      || null
    rows.push({
      source_id,
      external_id: parentId,
      type: 'boosty_post',
      url: post.canonical_url || null,
      title: post.title || 'Пост Boosty',
      caption: post.text || null,
      published_at: post.publish_time || post.created_at || null,
      duration_seconds: null,
      views: null,
      likes: post.likes ?? null,
      comments: post.comments ?? null,
      thumbnail_path: parentThumbnail,
      sender: null,
      has_media: Number(post.video_count || 0) > 0,
      raw_meta: parentMeta,
      parent_external_id: null,
      depth: 0,
    })

    const currentVideoIds = new Set()
    const videos = Array.isArray(post.videos) ? post.videos : []
    for (const [index, video] of videos.entries()) {
      if (!video?.video_id) continue
      const videoId = String(video.video_id)
      currentVideoIds.add(videoId)
      videoCount += 1
      const oldVideo = existing.get(videoId)
      const oldVideoMeta = parseObjectJson(oldVideo?.raw_meta_json)
      const childEverAccessible = oldVideoMeta.ever_accessible === true || post.has_access === true
      const childTitle = video.title && video.title !== 'Видео Boosty'
        ? video.title
        : videos.length > 1 ? `${post.title || 'Видео Boosty'} · ${index + 1}` : (post.title || 'Видео Boosty')
      const videoThumbnail = thumbnail_paths[videoId]
        || (oldVideo?.thumbnail_path && !/^https?:\/\//i.test(oldVideo.thumbnail_path) ? oldVideo.thumbnail_path : null)
        || video.thumbnail_url
        || parentThumbnail
        || oldVideo?.thumbnail_path
        || null
      rows.push({
        source_id,
        external_id: videoId,
        type: 'boosty_video',
        url: video.canonical_url || post.canonical_url || null,
        title: childTitle,
        caption: null,
        published_at: post.publish_time || post.created_at || null,
        duration_seconds: video.duration_sec || null,
        views: video.views ?? null,
        likes: null,
        comments: null,
        thumbnail_path: videoThumbnail,
        sender: null,
        has_media: true,
        parent_external_id: parentId,
        depth: 1,
        raw_meta: {
          ...oldVideoMeta,
          platform: 'boosty',
          entity_kind: 'video',
          post_id: String(post.post_id),
          post_external_id: parentId,
          position: Number(video.position || index + 1),
          video_kind: video.kind || 'video',
          external_url: video.external_url || null,
          canonical_url: video.canonical_url || post.canonical_url || null,
          has_access: post.has_access === true,
          ever_accessible: childEverAccessible,
          access_state: post.has_access === true
            ? 'accessible'
            : childEverAccessible ? 'lost' : 'locked',
          subscription_level: post.subscription_level || null,
        },
      })
    }

    // Locked API payloads omit the actual players. Keep known child rows and
    // only update their access state, otherwise a refresh would silently
    // turn previously downloaded media into apparently available videos.
    for (const child of childrenByParent.get(parentId) || []) {
      if (currentVideoIds.has(String(child.external_id))) continue
      const childMeta = parseObjectJson(child.raw_meta_json)
      const childEverAccessible = childMeta.ever_accessible === true || post.has_access === true
      accessUpdates.push({
        id: child.id,
        raw_meta_json: JSON.stringify({
          ...childMeta,
          has_access: post.has_access === true,
          ever_accessible: childEverAccessible,
          access_state: post.has_access === true
            ? 'accessible'
            : childEverAccessible ? 'lost' : 'locked',
          subscription_level: post.subscription_level || null,
        }),
      })
    }
  }

  const tx = db.transaction(() => {
    for (const row of rows) upsertItem(row)
    const updateAccess = db.prepare(`
      UPDATE items SET raw_meta_json = ?, updated_at = unixepoch() WHERE id = ?
    `)
    for (const patch of accessUpdates) updateAccess.run(patch.raw_meta_json, patch.id)
  })
  tx()
  return { posts: rows.filter(row => row.type === 'boosty_post').length, videos: videoCount }
}

function setItemThumbnailPath(source_id, external_id, thumbnail_path) {
  if (!source_id || !external_id || !thumbnail_path) return false
  const result = getDb().prepare(`
    UPDATE items
       SET thumbnail_path = ?, updated_at = unixepoch()
     WHERE source_id = ? AND external_id = ?
  `).run(thumbnail_path, source_id, String(external_id))
  return result.changes > 0
}

function patchSourceMeta(source_id, patch, { mark_synced = false } = {}) {
  const db = getDb()
  const row = db.prepare(`SELECT meta_json FROM sources WHERE id = ?`).get(source_id)
  if (!row) return false
  const metaJson = mergeSourceMetaJson(row.meta_json, patch)
  db.prepare(`
    UPDATE sources
       SET meta_json = ?,
           last_synced_at = CASE WHEN ? = 1 THEN unixepoch() ELSE last_synced_at END
     WHERE id = ?
  `).run(metaJson, mark_synced ? 1 : 0, source_id)
  return true
}

function listBoostyItems(source_id) {
  if (!source_id) return []
  return getDb().prepare(`
    SELECT * FROM items
     WHERE source_id = ? AND type IN ('boosty_post', 'boosty_video')
     ORDER BY published_at DESC,
              CASE WHEN type='boosty_post' THEN 0 ELSE 1 END,
              COALESCE(depth, 0), id
  `).all(source_id)
}

function listBoostyVideos(source_id, video_ids = null) {
  if (!source_id) return []
  const db = getDb()
  if (Array.isArray(video_ids) && video_ids.length) {
    const placeholders = video_ids.map(() => '?').join(',')
    return db.prepare(`
      SELECT * FROM items
       WHERE source_id = ? AND type='boosty_video'
         AND external_id IN (${placeholders})
    `).all(source_id, ...video_ids.map(String))
  }
  return db.prepare(`
    SELECT * FROM items WHERE source_id = ? AND type='boosty_video'
  `).all(source_id)
}

function markItemDownloaded({ source_id, external_id, media_path }) {
  const info = getDb().prepare(`
    UPDATE items
       SET media_path = ?, download_status = 'done', download_error = NULL,
           updated_at = unixepoch()
     WHERE source_id = ? AND external_id = ?
  `).run(media_path || null, source_id, String(external_id))
  return info.changes > 0
}

function markItemDownloadError({ source_id, external_id, error }) {
  const info = getDb().prepare(`
    UPDATE items
       SET download_status = 'error', download_error = ?, updated_at = unixepoch()
     WHERE source_id = ? AND external_id = ?
  `).run(String(error || 'Не удалось скачать аудио'), source_id, String(external_id))
  return info.changes > 0
}

function markItemTranscribeError({ source_id, external_id, error }) {
  const info = getDb().prepare(`
    UPDATE items
       SET transcribe_status = 'error', transcribe_error = ?, updated_at = unixepoch()
     WHERE source_id = ? AND external_id = ?
  `).run(String(error || 'Не удалось расшифровать аудио'), source_id, String(external_id))
  return info.changes > 0
}

function clearItemMediaPaths(source_id, external_ids, status = 'evicted') {
  if (!source_id || !Array.isArray(external_ids) || !external_ids.length) return 0
  const db = getDb()
  const placeholders = external_ids.map(() => '?').join(',')
  const info = db.prepare(`
    UPDATE items
       SET media_path = NULL, download_status = ?, download_error = NULL,
           updated_at = unixepoch()
     WHERE source_id = ? AND type='boosty_video'
       AND external_id IN (${placeholders})
  `).run(status, source_id, ...external_ids.map(String))
  return info.changes
}

// Telegram comments — bulk insert into post_comments (UPSERT on
// (source_id, post_external_id, comment_id) so re-running «Дотянуть» is safe).
function bulkInsertComments(source_id, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0
  const db = getDb()
  const stmt = db.prepare(`
    INSERT INTO post_comments
      (source_id, post_external_id, comment_id, parent_comment_id, sender, text, date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id, post_external_id, comment_id) DO UPDATE SET
      parent_comment_id = COALESCE(excluded.parent_comment_id, post_comments.parent_comment_id),
      sender            = COALESCE(excluded.sender,            post_comments.sender),
      text              = COALESCE(excluded.text,              post_comments.text),
      date              = COALESCE(excluded.date,              post_comments.date)
  `)
  const tx = db.transaction((rows) => {
    let n = 0
    for (const r of rows) {
      stmt.run(
        source_id,
        String(r.post_external_id),
        Number(r.comment_id),
        r.parent_comment_id != null ? Number(r.parent_comment_id) : null,
        r.sender || null,
        r.text || null,
        r.date != null ? Number(r.date) : null,
      )
      n += 1
    }
    return n
  })
  return tx(rows)
}

// Used by «type_breakdown chip» in SourceDetail — total count of comments
// stored for this channel across all posts.
function countCommentsBySource(source_id) {
  const db = getDb()
  const row = db.prepare(`SELECT COUNT(*) AS n FROM post_comments WHERE source_id = ?`)
                .get(source_id)
  return row?.n || 0
}

// Used by CopySavedPanel «с комментариями» — fetch threads for a given list
// of post msg_ids in one shot, ordered by (post, comment_id) so the assembler
// can stream them per-post without further sorts.
function listCommentsForPosts(source_id, postExternalIds) {
  const db = getDb()
  if (!Array.isArray(postExternalIds) || postExternalIds.length === 0) return []
  const placeholders = postExternalIds.map(() => '?').join(',')
  return db.prepare(`
    SELECT post_external_id, comment_id, parent_comment_id, sender, text, date
    FROM post_comments
    WHERE source_id = ? AND post_external_id IN (${placeholders})
    ORDER BY post_external_id ASC, comment_id ASC
  `).all(source_id, ...postExternalIds.map(String))
}

// Posts (channel msg_ids) for which we already have at least one stored
// comment — used by «Дотянуть комментарии» to know which posts to skip.
function listPostsWithComments(source_id) {
  const db = getDb()
  return db.prepare(`
    SELECT DISTINCT post_external_id FROM post_comments WHERE source_id = ?
  `).all(source_id).map(r => r.post_external_id)
}

// Set has_discussion flag on a source. NULL until probed; 0/1 once known.
function setSourceHasDiscussion(source_id, value) {
  const db = getDb()
  const v = value == null ? null : (value ? 1 : 0)
  db.prepare(`UPDATE sources SET has_discussion = ? WHERE id = ?`).run(v, source_id)
}

function listItems({ source_id, limit = 200, offset = 0, order = 'published_at DESC',
                     type = null, types = null, topic_id = null }) {
  const db = getDb()
  const safeOrder = ['published_at DESC', 'published_at ASC', 'created_at DESC'].includes(order)
    ? order : 'published_at DESC'
  const params = [source_id]
  let where = 'source_id = ?'
  // `types` is the multi-select form (preferred); `type` kept for legacy
  // single-string callers. If both given, `types` wins.
  const typeList = Array.isArray(types) && types.length ? types : (type ? [type] : null)
  if (typeList) {
    where += ` AND type IN (${typeList.map(() => '?').join(',')})`
    params.push(...typeList)
  }
  if (topic_id != null) {
    where += ' AND topic_id = ?'
    params.push(topic_id)
  }
  params.push(limit, offset)
  return db.prepare(`SELECT * FROM items WHERE ${where} ORDER BY ${safeOrder} LIMIT ? OFFSET ?`)
           .all(...params)
}

/**
 * Topic chips for forum supergroups: returns [{id, title, count}] sorted
 * by count desc. NULL/0 topic_id (non-forum messages, or General before
 * Telegram populated it) is excluded — UI shows them as "Все сообщения"
 * by virtue of no chip being active. Chats without forum topics simply
 * return [].
 */
function listSourceTopics(source_id) {
  const db = getDb()
  const rows = db.prepare(`
    SELECT topic_id AS id,
           MAX(topic_title) AS title,
           COUNT(*) AS count
      FROM items
     WHERE source_id = ? AND topic_id IS NOT NULL
     GROUP BY topic_id
     ORDER BY count DESC
  `).all(source_id)
  return rows
}

/**
 * Batch lookup of items by their external_id (video_id, message_id, …).
 * Returns the full row for each match; missing ids are simply absent from
 * the result. Used to cache-check before launching a batch transcription.
 */
function getItemsByExternalIds(source_id, ids) {
  if (!source_id || !Array.isArray(ids) || ids.length === 0) return []
  const db = getDb()
  const placeholders = ids.map(() => '?').join(',')
  return db.prepare(
    `SELECT * FROM items WHERE source_id = ? AND external_id IN (${placeholders})`
  ).all(source_id, ...ids)
}

/**
 * Returns external_ids of items in this source whose AI processing is already
 * done, grouped by Python's process_media() kind. Used by tg_fetch_json to
 * skip re-running AAI/Gemini on media that was processed in a previous fetch.
 *
 *   { voice: ['<msg_id>', ...],   // voice + audio + video (all routed through
 *                                 //   the voice path on Python's side)
 *     photo: [...],               // images already described by Gemini Vision
 *     pdf:   [...] }              // PDFs already extracted by Gemini
 *
 * Set membership in Python is O(1) — much cheaper than per-msg SELECT.
 *
 * Why we trust transcribe_status='done' as the universal flag: appendItemTranscript
 * (the close-handler replay) sets that exact status for ALL three kinds after a
 * successful AI result, regardless of voice/photo/pdf. See database.js::appendItemTranscript.
 */
/**
 * Find a Telegram source row by whatever the user pasted into the form:
 *   • bare handle           — `bari_s_patrikovv` → handle exact match
 *   • @-prefixed handle     — `@bari_s_patrikovv` → strip @ then exact match
 *   • numeric chat_id       — `-1001769090887`     → handle exact match
 *                                                    (we store numeric ids as handles
 *                                                    when the chat has no @username)
 *   • t.me URL              — falls through, no match (URL fetches don't reuse a source row)
 *
 * Returns the source row or null. Used by the skip-processed wiring in
 * startTelegramFetch to know which source's items table to consult.
 */
function findTelegramSourceByTarget(target) {
  if (!target) return null
  const db = getDb()
  const handle = String(target).trim().replace(/^@/, '')
  if (!handle) return null
  // Direct handle match — covers @username, bare username, numeric chat_id
  // exactly as the user pasted it. Most common case.
  let row = db.prepare(
    `SELECT * FROM sources WHERE platform='telegram' AND handle=? LIMIT 1`
  ).get(handle)
  if (row) return row
  // Numeric handle (channel/supergroup chat_id): the same chat can land in
  // sources with EITHER format depending on how it was first added — paste
  // of t.me/c/<id>/... uses the `-100<id>` convention, while resolve-title
  // and most paste-flows store just `<id>`. Try the alternate form so the
  // skip-processed lookup finds the right row regardless.
  if (/^-?\d+$/.test(handle)) {
    if (handle.startsWith('-100')) {
      row = db.prepare(
        `SELECT * FROM sources WHERE platform='telegram' AND handle=? LIMIT 1`
      ).get(handle.slice(4))
    } else {
      row = db.prepare(
        `SELECT * FROM sources WHERE platform='telegram' AND handle=? LIMIT 1`
      ).get('-100' + handle)
    }
    if (row) return row
    // Last resort: try matching by external_id, which job-runner writes as
    // String(entity.id) without the `-100` prefix on every entity event.
    const ext = handle.replace(/^-100/, '')
    row = db.prepare(
      `SELECT * FROM sources WHERE platform='telegram' AND external_id=? LIMIT 1`
    ).get(ext)
  }
  return row || null
}

function listProcessedExternalIdsByKind(source_id) {
  const out = { voice: {}, photo: {}, pdf: {} }
  if (!source_id) return out
  const db = getDb()
  const rows = db.prepare(`
    SELECT external_id, type, transcribe_engine
      FROM items
     WHERE source_id = ?
       AND transcribe_status = 'done'
       AND external_id IS NOT NULL
  `).all(source_id)
  for (const r of rows) {
    const eng = r.transcribe_engine || ''
    if (r.type === 'voice' || r.type === 'audio' || r.type === 'video') {
      out.voice[String(r.external_id)] = eng
    } else if (r.type === 'photo') {
      out.photo[String(r.external_id)] = eng
    } else if (r.type === 'document') {
      out.pdf[String(r.external_id)] = eng
    }
  }
  return out
}

/**
 * Mark an item as transcribed and index the transcript content into FTS.
 * Reads the file (small, < 200 KB typical) and stores it in items_fts.
 */
function markItemTranscribed({ source_id, external_id, transcript_path, engine, cost_usd }) {
  const db = getDb()
  const row = db.prepare(`SELECT id FROM items WHERE source_id = ? AND external_id = ?`)
                .get(source_id, external_id)
  if (!row) return null
  db.prepare(`
    UPDATE items
       SET transcript_path     = ?,
           transcribe_status   = 'done',
           transcribe_engine   = ?,
           transcribe_cost_usd = COALESCE(?, transcribe_cost_usd),
           updated_at          = unixepoch()
     WHERE id = ?
  `).run(transcript_path, engine || null, cost_usd || null, row.id)

  // Mirror transcript content into FTS (best-effort; missing file is fine).
  try {
    if (transcript_path && fs.existsSync(transcript_path)) {
      const text = fs.readFileSync(transcript_path, 'utf8')
      // existing caption stays — index transcript alongside it
      const cap = db.prepare(`SELECT caption FROM items WHERE id = ?`).get(row.id)?.caption || ''
      indexItemForFts(row.id, cap, text)
    }
  } catch (err) {
    console.error('[DB] markItemTranscribed FTS update failed', err)
  }
  return row.id
}

/**
 * Append a transcribed/described text block to an item's caption + mirror
 * into FTS. Used for inline TG fetches that ran voice transcription, photo
 * Vision describe, or PDF extract on a per-item basis. Idempotent — calling
 * twice produces only one block (we look for the heading in the existing
 * caption first).
 *
 * `kind` is one of 'voice' | 'photo' | 'pdf', used to format the heading
 * shown in the caption ("[голосовое — расшифровка · ENGINE]" etc.).
 */
function appendItemTranscript({ source_id, external_id, text, engine, kind }) {
  if (!text || !String(text).trim()) return null
  const db = getDb()
  const row = db.prepare(
    `SELECT id, caption FROM items WHERE source_id = ? AND external_id = ?`
  ).get(source_id, external_id)
  if (!row) return null

  const HEADINGS = {
    voice: `[голосовое — расшифровка · ${engine || 'gemini'}]`,
    photo: `[фото — описание · ${engine || 'gemini'}]`,
    pdf:   `[документ — извлечение · ${engine || 'gemini'}]`,
  }
  const heading = HEADINGS[kind] || `[медиа · ${engine || 'gemini'}]`

  // Idempotency: skip the caption append if the same heading is already
  // there (re-fetches with the same engine). We DO still bump the status
  // and engine — those are cheap UPDATEs and may have been reset by the
  // caller (e.g. tests or manual SQL).
  const existing = row.caption || ''
  if (existing.includes(heading)) {
    db.prepare(`
      UPDATE items
         SET transcribe_status = 'done',
             transcribe_engine = COALESCE(?, transcribe_engine),
             updated_at        = unixepoch()
       WHERE id = ?
    `).run(engine || null, row.id)
    return row.id
  }

  const block = `${heading}\n${String(text).trim()}`
  const next = existing.trim() ? `${existing.trim()}\n\n${block}` : block

  db.prepare(`
    UPDATE items
       SET caption           = ?,
           transcribe_status = 'done',
           transcribe_engine = COALESCE(?, transcribe_engine),
           updated_at        = unixepoch()
     WHERE id = ?
  `).run(next, engine || null, row.id)

  // Refresh FTS row so search hits the new text. items_fts is a contentless
  // table (rowid = items.id), so a delete+insert is cheap.
  try {
    db.prepare(`DELETE FROM items_fts WHERE rowid = ?`).run(row.id)
    indexItemForFts(row.id, next, '')
  } catch (err) {
    console.error('[DB] appendItemTranscript FTS refresh failed', err)
  }
  return row.id
}


function itemTypeBreakdown(source_id, topic_id = null) {
  const db = getDb()
  const params = [source_id]
  let where = 'source_id = ?'
  if (topic_id != null) { where += ' AND topic_id = ?'; params.push(topic_id) }
  // `processed` = items whose AI pipeline finished (transcribe_status='done').
  // For inline TG fetches that path stores text directly into caption + sets
  // status='done'; legacy YouTube/IG batch flows set transcript_path too.
  // UI reads this to skip the "files not loaded" warning when the file was
  // downloaded, processed, and removed (we don't keep media_path on tmp).
  return db.prepare(`
    SELECT type,
           COUNT(*) AS count,
           SUM(CASE WHEN media_path IS NOT NULL THEN 1 ELSE 0 END) AS with_media,
           SUM(CASE WHEN transcript_path IS NOT NULL THEN 1 ELSE 0 END) AS transcribed,
           SUM(CASE WHEN transcribe_status = 'done' THEN 1 ELSE 0 END) AS processed,
           SUM(CASE WHEN caption IS NOT NULL AND length(trim(caption)) > 0
                       THEN 1 ELSE 0 END) AS with_caption
    FROM items WHERE ${where} GROUP BY type ORDER BY count DESC
  `).all(...params)
}

function telegramMediaEstimate(scope = {}) {
  const db = getDb()
  const sourceId = Number(scope.source_id)
  if (!sourceId) {
    return { ok: false, error: 'source_id required', total: 0, by_type: {} }
  }

  const conds = ['source_id = ?']
  const params = [sourceId]

  const topicIds = Array.isArray(scope.topic_ids)
    ? scope.topic_ids.map(Number).filter(Number.isFinite)
    : []
  if (topicIds.length) {
    conds.push(`topic_id IN (${topicIds.map(() => '?').join(',')})`)
    params.push(...topicIds)
  } else if (scope.topic_id != null) {
    conds.push('topic_id = ?')
    params.push(Number(scope.topic_id))
  }

  if ((scope.mode === 'from_date' || scope.mode === 'date_range') && scope.date_from) {
    conds.push('published_at >= ?')
    params.push(Number(scope.date_from))
  }
  if (scope.mode === 'date_range' && scope.date_to) {
    conds.push('published_at <= ?')
    params.push(Number(scope.date_to))
  }

  const where = conds.join(' AND ')
  let sliceSql = `SELECT * FROM items WHERE ${where}`
  const sliceParams = [...params]
  if (scope.mode === 'last_n' && Number(scope.limit) > 0) {
    sliceSql += ` ORDER BY COALESCE(published_at, 0) DESC, CAST(external_id AS INTEGER) DESC LIMIT ?`
    sliceParams.push(Number(scope.limit))
  }

  const total = db.prepare(`
    SELECT COUNT(*) AS count,
           MIN(published_at) AS date_min,
           MAX(published_at) AS date_max
      FROM (${sliceSql})
  `).get(...sliceParams)

  const rows = db.prepare(`
    SELECT type,
           COUNT(*) AS count,
           SUM(CASE WHEN has_media = 1 THEN 1 ELSE 0 END) AS has_media,
           SUM(CASE WHEN media_path IS NOT NULL THEN 1 ELSE 0 END) AS downloaded,
           SUM(CASE WHEN transcribe_status = 'done' THEN 1 ELSE 0 END) AS processed,
           SUM(CASE WHEN transcript_path IS NOT NULL THEN 1 ELSE 0 END) AS transcribed,
           SUM(CASE WHEN caption IS NOT NULL AND length(trim(caption)) > 0 THEN 1 ELSE 0 END) AS with_caption,
           SUM(COALESCE(duration_seconds, 0)) AS duration_seconds,
           SUM(CASE WHEN duration_seconds IS NOT NULL THEN 1 ELSE 0 END) AS duration_known,
           SUM(CASE
                 WHEN type IN ('voice','video','audio') AND duration_seconds IS NULL THEN 1
                 ELSE 0
               END) AS duration_missing
      FROM (${sliceSql})
     GROUP BY type
     ORDER BY count DESC
  `).all(...sliceParams)

  const byType = {}
  for (const row of rows) {
    byType[row.type] = {
      count: Number(row.count || 0),
      has_media: Number(row.has_media || 0),
      downloaded: Number(row.downloaded || 0),
      processed: Number(row.processed || 0),
      transcribed: Number(row.transcribed || 0),
      with_caption: Number(row.with_caption || 0),
      duration_seconds: Number(row.duration_seconds || 0),
      duration_known: Number(row.duration_known || 0),
      duration_missing: Number(row.duration_missing || 0),
    }
  }

  return {
    ok: true,
    source_id: sourceId,
    scope: {
      mode: scope.mode || 'all',
      limit: Number(scope.limit || 0),
      date_from: scope.date_from || null,
      date_to: scope.date_to || null,
      topic_ids: topicIds,
      basis: 'saved_items',
    },
    total: Number(total?.count || 0),
    date_min: total?.date_min || null,
    date_max: total?.date_max || null,
    by_type: byType,
  }
}

function socialSourceOverview(source_id) {
  const db = getDb()
  const source = db.prepare(`
    SELECT id, platform, meta_json
      FROM sources
     WHERE id = ?
  `).get(source_id)
  if (!source || !['reddit', 'twitter'].includes(source.platform)) return null

  const totals = db.prepare(`
    SELECT COUNT(*) AS total_items,
           SUM(CASE WHEN type = 'comment' THEN 1 ELSE 0 END) AS comment_items,
           SUM(CASE WHEN type != 'comment' THEN 1 ELSE 0 END) AS post_items,
           SUM(CASE WHEN parent_external_id IS NOT NULL THEN 1 ELSE 0 END) AS linked_reply_items,
           MAX(COALESCE(depth, 0)) AS max_depth,
           COUNT(DISTINCT CASE WHEN sender IS NOT NULL AND trim(sender) != '' THEN sender END) AS authors,
           SUM(CASE WHEN title IS NOT NULL AND trim(title) != '' THEN 1 ELSE 0 END) AS with_title,
           SUM(CASE WHEN caption IS NOT NULL AND trim(caption) != '' THEN 1 ELSE 0 END) AS with_caption,
           SUM(CASE WHEN url IS NOT NULL AND trim(url) != '' THEN 1 ELSE 0 END) AS with_url,
           SUM(CASE WHEN has_media = 1 THEN 1 ELSE 0 END) AS media_items,
           SUM(CASE WHEN media_path IS NOT NULL THEN 1 ELSE 0 END) AS media_downloaded,
           SUM(CASE WHEN thumbnail_path IS NOT NULL THEN 1 ELSE 0 END) AS thumbnails,
           SUM(CASE WHEN likes IS NOT NULL THEN 1 ELSE 0 END) AS with_likes,
           SUM(CASE WHEN comments IS NOT NULL THEN 1 ELSE 0 END) AS with_comment_counter,
           SUM(CASE WHEN views IS NOT NULL THEN 1 ELSE 0 END) AS with_views,
           SUM(COALESCE(likes, 0)) AS likes_sum,
           SUM(COALESCE(comments, 0)) AS comment_counter_sum,
           SUM(COALESCE(views, 0)) AS views_sum,
           MIN(published_at) AS min_at,
           MAX(published_at) AS max_at,
           SUM(COALESCE(octet_length(title), 0)) AS title_bytes,
           SUM(COALESCE(octet_length(caption), 0)) AS caption_bytes,
           SUM(COALESCE(octet_length(url), 0)) AS url_bytes,
           SUM(COALESCE(octet_length(raw_meta_json), 0)) AS raw_meta_bytes
      FROM items
     WHERE source_id = ?
  `).get(source_id) || {}

  const rows = db.prepare(`
    SELECT url, caption, raw_meta_json
      FROM items
     WHERE source_id = ?
  `).all(source_id)

  const sourceUrls = new Set()
  const externalLinks = new Set()
  const mediaUrls = new Set()

  for (const row of rows) {
    addSourceUrl(row.url, sourceUrls)
    collectTextUrls(row.caption, externalLinks, mediaUrls)
    if (!row.raw_meta_json) continue
    try {
      collectStructuredUrls(JSON.parse(row.raw_meta_json), externalLinks, mediaUrls)
    } catch {}
  }

  let meta = {}
  try { meta = source.meta_json ? JSON.parse(source.meta_json) : {} } catch {}
  const bytes = {
    title: Number(totals.title_bytes || 0),
    caption: Number(totals.caption_bytes || 0),
    url: Number(totals.url_bytes || 0),
    raw_meta: Number(totals.raw_meta_bytes || 0),
  }
  bytes.db_payload = bytes.title + bytes.caption + bytes.url + bytes.raw_meta

  return {
    kind: meta.kind || null,
    query: meta.query || meta.search_query || null,
    subreddit: meta.subreddit || null,
    url: meta.url || meta.thread_url || null,
    backend: meta.backend || (source.platform === 'twitter' ? 'browser' : null),
    counters: normalizeNumbers(totals),
    bytes,
    links: {
      source_urls: sourceUrls.size,
      external_urls: externalLinks.size,
      media_urls: mediaUrls.size,
    },
    type_breakdown: itemTypeBreakdown(source_id),
  }
}

function normalizeNumbers(row) {
  const out = {}
  for (const [k, v] of Object.entries(row || {})) {
    out[k] = Number(v || 0)
  }
  return out
}

function collectTextUrls(text, externalLinks, mediaUrls) {
  if (!text) return
  const re = /https?:\/\/[^\s<>"')\]}]+/gi
  let m
  while ((m = re.exec(String(text)))) {
    addUrl(m[0], externalLinks, mediaUrls)
  }
}

function collectStructuredUrls(value, externalLinks, mediaUrls, depth = 0) {
  if (value == null || depth > 5) return
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) addUrl(value, externalLinks, mediaUrls)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStructuredUrls(item, externalLinks, mediaUrls, depth + 1)
    return
  }
  if (typeof value !== 'object') return
  for (const v of Object.values(value)) collectStructuredUrls(v, externalLinks, mediaUrls, depth + 1)
}

function addSourceUrl(raw, sourceUrls) {
  if (!raw) return
  let url = String(raw).trim()
  if (!url || !/^https?:\/\//i.test(url)) return
  sourceUrls.add(url.replace(/[),.;\]]+$/g, ''))
}

function addUrl(raw, externalLinks, mediaUrls) {
  if (!raw) return
  let url = String(raw).trim()
  if (!url || !/^https?:\/\//i.test(url)) return
  url = url.replace(/[),.;\]]+$/g, '')
  if (isMediaUrl(url)) mediaUrls.add(url)
  else externalLinks.add(url)
}

function isMediaUrl(raw) {
  try {
    const u = new URL(raw)
    const host = u.hostname.replace(/^www\./, '').toLowerCase()
    if (host.endsWith('twimg.com')) return true
    if (host === 'i.redd.it' || host === 'v.redd.it') return true
    if (host.endsWith('redditmedia.com') || host.endsWith('redd.it')) return true
    return /\.(jpg|jpeg|png|webp|gif|mp4|mov|m4v)(?:$|[?#])/i.test(u.pathname)
  } catch {
    return /\.(jpg|jpeg|png|webp|gif|mp4|mov|m4v)(?:$|[?#])/i.test(String(raw))
  }
}

// Aggregate min/max published_at across saved items. Used by SourceDetail
// to show "Период · 12.03.24 — 26.04.26" instead of just the latest item
// (more useful for understanding what slice of history we already have).
function itemsDateRange(source_id) {
  const db = getDb()
  const row = db.prepare(`
    SELECT MIN(published_at) AS min_at, MAX(published_at) AS max_at
    FROM items
    WHERE source_id = ? AND published_at IS NOT NULL
  `).get(source_id)
  return { min_at: row?.min_at || null, max_at: row?.max_at || null }
}

// limit=500: SendersBlock рисует поверх результата живой «Поиск по
// отправителям» — с прежним top-10 поиск молча не находил никого вне топа
// (групповой чат на 50+ участников). 500 покрывает любой реальный групповой
// чат; одна GROUP BY по индексированному source_id — копейки.
function senderBreakdown(source_id, limit = 500) {
  const db = getDb()
  return db.prepare(`
    SELECT COALESCE(sender, '(unknown)') AS sender, COUNT(*) AS count
    FROM items WHERE source_id = ? GROUP BY sender ORDER BY count DESC LIMIT ?
  `).all(source_id, limit)
}

// ─── Jobs ─────────────────────────────────────────────────────────────

function recordJob(j) {
  const db = getDb()
  const params = j.params ? JSON.stringify(j.params) : null
  db.prepare(`
    INSERT INTO jobs (type, source_id, status, items_total, items_done, items_failed,
                      cost_usd, parameters_json, error, started_at, finished_at, file_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    j.type, j.source_id || null, j.status,
    j.items_total || null, j.items_done || 0, j.items_failed || 0,
    j.cost_usd || 0,
    params, j.error || null,
    j.started_at || null, j.finished_at || null,
    j.file_path || null,
  )
  return db.prepare('SELECT last_insert_rowid() AS id').get().id
}

/**
 * UPDATE a previously inserted jobs row (typically created with status=
 * 'running' on entity-resolve, then finalised on close). Only updates fields
 * that are actually provided — call sites pass `status`, `error`, etc, and
 * timestamps that flip when the job ends.
 */
function updateJob(id, patch) {
  if (!id || !patch) return
  const db = getDb()
  const fields = []
  const values = []
  const map = {
    status: 'status', items_total: 'items_total', items_done: 'items_done',
    items_failed: 'items_failed', cost_usd: 'cost_usd', error: 'error',
    finished_at: 'finished_at', started_at: 'started_at', file_path: 'file_path',
  }
  for (const k of Object.keys(map)) {
    if (k in patch) {
      fields.push(`${map[k]} = ?`)
      values.push(patch[k] == null ? null : patch[k])
    }
  }
  if (patch.params !== undefined) {
    fields.push('parameters_json = ?')
    values.push(patch.params ? JSON.stringify(patch.params) : null)
  }
  if (!fields.length) return
  values.push(id)
  db.prepare(`UPDATE jobs SET ${fields.join(', ')} WHERE id = ?`).run(...values)
}

// Reset zombie 'running' rows left behind by a hard-killed app. Called once
// on startup — any job in DB with status='running' and no live process will
// resume nowhere, so flip it to 'interrupted' which JobDetail surfaces with
// a "Продолжить" button.
/**
 * Find a row in `running` state for (type, source_id), if any. Used as a
 * defensive guard before opening a fresh job-row, in case the startup
 * zombie-cleanup didn't catch it (race with first user click, or type
 * not in the cleanup list).
 */
function findRunningJobForSource(type, source_id) {
  if (!type || !source_id) return null
  const db = getDb()
  return db.prepare(`
    SELECT id, type, source_id, status, started_at
      FROM jobs
     WHERE type = ? AND source_id = ? AND status = 'running'
     ORDER BY started_at DESC
     LIMIT 1
  `).get(type, source_id) || null
}


function markStuckRunningAsInterrupted({ types = null } = {}) {
  const db = getDb()
  const sql = types && types.length
    ? `UPDATE jobs SET status='interrupted'
        WHERE status='running'
          AND type IN (${types.map(() => '?').join(',')})`
    : `UPDATE jobs SET status='interrupted' WHERE status='running'`
  const r = types && types.length ? db.prepare(sql).run(...types) : db.prepare(sql).run()
  return r.changes
}

function listJobsForSource(source_id, limit = 20) {
  const db = getDb()
  return db.prepare(`SELECT * FROM jobs WHERE source_id = ? ORDER BY started_at DESC LIMIT ?`)
           .all(source_id, limit)
}

/**
 * Latest successful Telegram pre-analysis for a source.
 *
 * tg_preview already persists its aggregate in jobs.parameters_json._summary.
 * SourceDetail used to ignore that durable result and therefore rendered an
 * empty distribution until the first real fetch wrote item rows.  Keep the
 * analysis as a separate projection: it describes what Telegram reported,
 * not what is already stored in `items`.
 *
 * A handful of old/partial rows can be `done` without a usable summary, so
 * inspect a small tail and return the newest valid one instead of letting a
 * malformed row hide the preceding successful analysis.
 */
function latestTelegramAnalysisForSource(source_id) {
  const db = getDb()
  const rows = db.prepare(`
    SELECT id, parameters_json, started_at, finished_at, created_at
      FROM jobs
     WHERE source_id = ?
       AND type = 'tg_preview'
       AND status = 'done'
     ORDER BY COALESCE(finished_at, started_at, created_at, 0) DESC, id DESC
     LIMIT 20
  `).all(source_id)

  for (const row of rows) {
    let params
    try { params = JSON.parse(row.parameters_json || '{}') } catch { continue }
    const summary = params?._summary
    const rawCounts = summary?.type_counts
    if (!rawCounts || typeof rawCounts !== 'object' || Array.isArray(rawCounts)) continue

    const typeCounts = {}
    for (const [type, value] of Object.entries(rawCounts)) {
      const count = Number(value)
      if (!type || !Number.isFinite(count) || count <= 0) continue
      typeCounts[type] = Math.floor(count)
    }
    const countedTotal = Object.values(typeCounts).reduce((sum, count) => sum + count, 0)
    const summaryTotal = Number(summary.items_total)

    return {
      job_id: Number(row.id),
      analyzed_at: Number(row.finished_at || row.started_at || row.created_at) || null,
      items_total: Number.isFinite(summaryTotal) && summaryTotal >= 0
        ? Math.floor(summaryTotal)
        : countedTotal,
      type_counts: typeCounts,
      date_min: summary.date_min || null,
      date_max: summary.date_max || null,
      scope: {
        mode: params.mode || null,
        limit: Number(params.limit || 0),
        date: params.date || null,
        date_to: params.date_to || null,
        since_message_id: Number(params.sinceMessageId || 0),
      },
    }
  }

  return null
}

// jobs without a source (e.g. one-off YouTube transcripts). Optional type filter.
function listSourcelessJobs({ type = null, limit = 100 } = {}) {
  const db = getDb()
  const sql = type
    ? `SELECT * FROM jobs WHERE source_id IS NULL AND type = ? ORDER BY started_at DESC LIMIT ?`
    : `SELECT * FROM jobs WHERE source_id IS NULL ORDER BY started_at DESC LIMIT ?`
  return type ? db.prepare(sql).all(type, limit) : db.prepare(sql).all(limit)
}

// Cache lookup for one-off YouTube transcripts. Matches by video_id stored
// inside parameters_json (JSON-LIKE substring is fine since IDs are 11 chars
// and have no JSON-special characters). Returns most recent done job whose
// file still exists, or null.
function findDoneYoutubeJob(videoId) {
  return _findDoneTranscribeJob('yt_transcribe', videoId)
}

function findDoneTiktokJob(videoId) {
  return _findDoneTranscribeJob('tk_transcribe', videoId)
}

function _findDoneTranscribeJob(jobType, videoId) {
  if (!videoId) return null
  const db = getDb()
  const rows = db.prepare(`
    SELECT * FROM jobs
    WHERE type = ?
      AND status = 'done'
      AND file_path IS NOT NULL
      AND parameters_json LIKE ?
    ORDER BY finished_at DESC
    LIMIT 5
  `).all(jobType, `%"video_id":"${videoId}"%`)
  return rows[0] || null
}

// Cross-source transcript lookup — used by paste-flow and search-picker so
// the user doesn't re-transcribe a video that's already saved under any
// channel (or via a sourceless single-video job).
//
// Two sources of truth feed it:
//   1. items.transcript_path — every channel-batch save populates this.
//   2. jobs (sourceless yt_transcribe / tk_transcribe) — single-video pastes
//      that never created an items row.
//
// Items wins when both exist (channel context = better metadata; the file
// itself is the same — `transcripts/youtube/<videoId>__*.txt`).
function findYoutubeTranscriptForVideo(videoId) {
  return _findTranscriptForVideo('youtube', 'yt_transcribe', videoId)
}

function findTiktokTranscriptForVideo(videoId) {
  return _findTranscriptForVideo('tiktok', 'tk_transcribe', videoId)
}

function _findTranscriptForVideo(platform, jobType, videoId) {
  if (!videoId) return null
  const db = getDb()
  // Items table — JOIN sources to know which channel it belongs to.
  const itemRow = db.prepare(`
    SELECT i.*, s.handle AS source_handle, s.display_name AS source_title
    FROM items i
    JOIN sources s ON s.id = i.source_id
    WHERE s.platform = ? AND i.external_id = ? AND i.transcript_path IS NOT NULL
    ORDER BY i.id DESC LIMIT 1
  `).get(platform, videoId)
  if (itemRow) {
    return {
      origin:          'items',
      file_path:       itemRow.transcript_path,
      finished_at:     null,
      source_id:       itemRow.source_id,
      source_handle:   itemRow.source_handle,
      source_title:    itemRow.source_title,
      title:           itemRow.title,
      duration_seconds: itemRow.duration_seconds,
    }
  }
  // Sourceless single-video jobs. Return the full DB row plus an `origin`
  // marker — callers (lookupYoutubeCache) read parameters_json / cost_usd
  // off the row directly.
  const jobRow = _findDoneTranscribeJob(jobType, videoId)
  if (jobRow) {
    return Object.assign({}, jobRow, {
      origin: 'jobs',
      source_id: null,
    })
  }
  return null
}

// Cache lookup for YouTube comments. Cache key = (video_id, sort, limit,
// with_replies) — different parameter sets produce different files (see
// yt_comments_ndjson.py file naming). Returns most recent done job whose
// file still exists, or null.
//
// The match is parameter-exact: changing limit from 200 to 500 means a
// fresh fetch, never a stale 200-comment file rebranded as 500.
function findYoutubeCommentsForVideo({ videoId, sort, limit, includeReplies }) {
  if (!videoId) return null
  const fs = require('fs')
  const db = getDb()
  // Comments live as their own job type. parameters_json is a JSON string,
  // so we LIKE-match on the four canonical fields. Numbers serialise without
  // quotes, booleans as `true|false`, strings quoted.
  const sortLike    = `%"sort":"${sort}"%`
  const limitLike   = `%"limit":${Number(limit)}%`
  const repliesLike = `%"include_replies":${includeReplies ? 'true' : 'false'}%`
  const videoLike   = `%"video_id":"${videoId}"%`
  const rows = db.prepare(`
    SELECT * FROM jobs
    WHERE type = 'yt_comments'
      AND status = 'done'
      AND file_path IS NOT NULL
      AND parameters_json LIKE ?
      AND parameters_json LIKE ?
      AND parameters_json LIKE ?
      AND parameters_json LIKE ?
    ORDER BY finished_at DESC
    LIMIT 5
  `).all(videoLike, sortLike, limitLike, repliesLike)
  for (const r of rows) {
    if (r.file_path && fs.existsSync(r.file_path)) return r
  }
  return null
}

// Bulk lookup for the picker's "💬✓" markers — for each video_id, return
// the most recent done yt_comments job (regardless of sort/limit/replies
// — any cached file counts as "we have something for this video"). Returns
// Map<videoId, {file_path, finished_at, sort, limit, include_replies, count_total}>.
function findYoutubeCommentsByVideoIds(videoIds) {
  const out = new Map()
  if (!Array.isArray(videoIds) || videoIds.length === 0) return out
  const fs = require('fs')
  const db = getDb()
  // We can't IN-clause LIKE patterns, so do per-id lookups. Volume is small
  // — picker rarely shows >200 videos, queries on indexed jobs table.
  for (const vid of videoIds) {
    if (!vid) continue
    const rows = db.prepare(`
      SELECT * FROM jobs
      WHERE type = 'yt_comments'
        AND status = 'done'
        AND file_path IS NOT NULL
        AND parameters_json LIKE ?
      ORDER BY finished_at DESC
      LIMIT 5
    `).all(`%"video_id":"${vid}"%`)
    for (const r of rows) {
      if (r.file_path && fs.existsSync(r.file_path)) {
        let p = null
        try { p = r.parameters_json ? JSON.parse(r.parameters_json) : null } catch {}
        out.set(vid, {
          file_path:       r.file_path,
          finished_at:     r.finished_at,
          sort:            p?.sort || null,
          limit:           p?.limit ?? null,
          include_replies: !!p?.include_replies,
          count_total:     p?.count_total ?? null,
        })
        break
      }
    }
  }
  return out
}

// Bulk version for search-pickers showing ✓ on already-transcribed rows.
// Returns Map<external_id, {origin, file_path, source_id?}>.
function findYoutubeTranscriptsByVideoIds(videoIds) {
  return _findTranscriptsBulk('youtube', 'yt_transcribe', videoIds)
}

function findTiktokTranscriptsByVideoIds(videoIds) {
  return _findTranscriptsBulk('tiktok', 'tk_transcribe', videoIds)
}

function _findTranscriptsBulk(platform, jobType, videoIds) {
  const out = new Map()
  if (!Array.isArray(videoIds) || videoIds.length === 0) return out
  const db = getDb()
  const placeholders = videoIds.map(() => '?').join(',')
  const itemRows = db.prepare(`
    SELECT i.external_id, i.transcript_path, i.title, i.duration_seconds, i.source_id, s.handle AS source_handle
    FROM items i JOIN sources s ON s.id = i.source_id
    WHERE s.platform = ?
      AND i.transcript_path IS NOT NULL
      AND i.external_id IN (${placeholders})
  `).all(platform, ...videoIds)
  for (const r of itemRows) {
    if (out.has(r.external_id)) continue
    out.set(r.external_id, {
      origin:          'items',
      file_path:       r.transcript_path,
      source_id:       r.source_id,
      source_handle:   r.source_handle,
      title:           r.title,
      duration_seconds: r.duration_seconds,
    })
  }
  // Cover the rest from sourceless jobs (one IN-clause works because we
  // build per-id LIKE substrings — fallback to per-id queries; volume is
  // small, picker rarely shows >100 videos).
  const remaining = videoIds.filter(v => !out.has(v))
  for (const vid of remaining) {
    const r = _findDoneTranscribeJob(jobType, vid)
    if (r) {
      out.set(vid, { origin: 'jobs', file_path: r.file_path, source_id: null })
    }
  }
  return out
}

// ─── Deletes ──────────────────────────────────────────────────────────

function deleteSource(source_id) {
  const db = getDb()
  // FK with ON DELETE CASCADE removes items / coverage; jobs only set null,
  // so wipe their history rows for this source explicitly.
  const tx = db.transaction((id) => {
    db.prepare('DELETE FROM jobs WHERE source_id = ?').run(id)
    db.prepare('DELETE FROM source_coverage WHERE source_id = ?').run(id)
    // FTS: remove all FTS rows whose item belonged to this source.
    db.prepare(`DELETE FROM items_fts WHERE rowid IN (SELECT id FROM items WHERE source_id = ?)`).run(id)
    db.prepare('DELETE FROM items WHERE source_id = ?').run(id)
    db.prepare('DELETE FROM sources WHERE id = ?').run(id)
  })
  tx(source_id)
}

function deleteJob(job_id) {
  const db = getDb()
  db.prepare('DELETE FROM jobs WHERE id = ?').run(job_id)
}

function clearJobsForSource(source_id) {
  const db = getDb()
  db.prepare('DELETE FROM jobs WHERE source_id = ?').run(source_id)
}

function deleteItem(item_id) {
  const db = getDb()
  db.prepare('DELETE FROM items_fts WHERE rowid = ?').run(item_id)
  db.prepare('DELETE FROM items WHERE id = ?').run(item_id)
}

/**
 * IDs of Telegram items in a source that haven't had reply_to resolved yet.
 * Drives the reply-graph backfill subprocess. Excludes the post itself
 * (parent_external_id IS NULL after backfill is the legitimate "no reply"
 * state), so we use a sentinel column we set after a backfill run — a
 * dedicated `reply_resolved INTEGER NOT NULL DEFAULT 0` would be cleaner
 * but adds a schema migration; for now we treat NULL as "unknown" and only
 * the user-facing UI knows to re-run after fetch.
 *
 * Returns rows ordered by external_id (numeric msg_id) ascending so the
 * subprocess walks the chat in chronological order.
 */
function listItemsMissingParent(source_id, limit = 5000) {
  const db = getDb()
  // Pick rows where EITHER the reply-graph OR the reactions still need
  // resolving. The backfill subprocess fills both in one Telethon RPC, so
  // a single OR-filter avoids running the script twice.
  return db.prepare(`
    SELECT id, external_id
      FROM items
     WHERE source_id = ?
       AND (reply_resolved = 0 OR reactions_resolved = 0)
     ORDER BY CAST(external_id AS INTEGER) ASC
     LIMIT ?
  `).all(source_id, Math.max(1, Math.min(limit, 50000)))
}

/**
 * Apply reply-graph results from the backfill subprocess. NULL writes
 * are kept (we want to durably record "checked, no parent") even though
 * upsertItem treats NULL as no-op via COALESCE — this is a different code
 * path on purpose.
 */
function bulkUpdateParentExternalId(source_id, rows) {
  if (!rows || !rows.length) return 0
  const db = getDb()
  // reply_resolved = 1 always — the row was *checked*, even if the answer
  // is "no parent". Without this the backfill loop never terminates on
  // chats where most messages aren't replies.
  // The same statement also writes reactions when present in the row.
  // r.reactions semantics:
  //   undefined  → backfill didn't include reactions in this batch (legacy).
  //                Don't touch the column or reactions_resolved.
  //   null       → checked, but no concrete reaction list came back. Mark
  //                resolved=1 with reactions=NULL; repeated real logs showed
  //                keeping this at 0 creates an endless backfill loop.
  //   []         → checked, no reactions. Persist `[]` JSON + resolved=1.
  //   [...]      → populated list. Persist + resolved=1.
  const stmtReply = db.prepare(`
    UPDATE items SET parent_external_id = ?, reply_resolved = 1,
                     updated_at = unixepoch()
     WHERE source_id = ? AND external_id = ?
  `)
  const stmtReplyAndReact = db.prepare(`
    UPDATE items SET parent_external_id = ?, reply_resolved = 1,
                     reactions = ?, reactions_resolved = ?,
                     updated_at = unixepoch()
     WHERE source_id = ? AND external_id = ?
  `)
  const tx = db.transaction((rs) => {
    let n = 0
    for (const r of rs) {
      const hasReactionsField = Object.prototype.hasOwnProperty.call(r, 'reactions')
      if (!hasReactionsField) {
        const res = stmtReply.run(r.parent_external_id || null,
                                  source_id, String(r.external_id))
        n += res.changes
        continue
      }
      let json = null
      let resolved = 1
      if (r.reactions != null) {
        json = typeof r.reactions === 'string'
          ? r.reactions
          : JSON.stringify(r.reactions)
      }
      const res = stmtReplyAndReact.run(
        r.parent_external_id || null,
        json, resolved,
        source_id, String(r.external_id),
      )
      n += res.changes
    }
    return n
  })
  return tx(rows)
}

function maxExternalId(source_id) {
  // Telegram message_ids are monotonic ints — used as `min_id` for incremental sync.
  const db = getDb()
  const row = db.prepare(`
    SELECT MAX(CAST(external_id AS INTEGER)) AS max_id
    FROM items WHERE source_id = ?
  `).get(source_id)
  return row?.max_id || null
}

// ─── Coverage ─────────────────────────────────────────────────────────

function recordCoverage({ source_id, job_id, date_from, date_to, content_type, depth, items_count }) {
  const db = getDb()
  db.prepare(`
    INSERT INTO source_coverage
      (source_id, job_id, date_from, date_to, content_type, depth, items_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(source_id, job_id || null, date_from || null, date_to || null, content_type, depth, items_count || 0)
}

function listCoverage(source_id) {
  const db = getDb()
  return db.prepare(`
    SELECT c.*,
           j.parameters_json AS job_parameters_json,
           j.status AS job_status,
           j.started_at AS job_started_at,
           j.finished_at AS job_finished_at
      FROM source_coverage c
      LEFT JOIN jobs j ON j.id = c.job_id
     WHERE c.source_id = ?
     ORDER BY c.date_from
  `)
           .all(source_id)
}

// ─── FTS ──────────────────────────────────────────────────────────────

function indexItemForFts(itemId, caption, transcript) {
  const db = getDb()
  db.prepare('DELETE FROM items_fts WHERE rowid = ?').run(itemId)
  if ((caption && caption.trim()) || (transcript && transcript.trim())) {
    db.prepare('INSERT INTO items_fts (rowid, caption, transcript) VALUES (?, ?, ?)')
      .run(itemId, caption || '', transcript || '')
  }
}

function searchItems(source_id, query, limit = 50) {
  const db = getDb()
  const sql = `
    SELECT i.* FROM items_fts fts
    JOIN items i ON i.id = fts.rowid
    WHERE items_fts MATCH ? ${source_id ? 'AND i.source_id = ?' : ''}
    LIMIT ?
  `
  return source_id
    ? db.prepare(sql).all(query, source_id, limit)
    : db.prepare(sql).all(query, limit)
}

// ─── Vector index (semantic search) ───────────────────────────────────

/**
 * Bulk-insert vectors. `rows` is [{ item_id, embedding: Float32Array }, ...].
 * UPSERT semantics: existing vectors for the same item_id are replaced.
 *
 * sqlite-vec stores embeddings as raw float32 little-endian buffers.
 * We pass each Float32Array as a Node Buffer view of its underlying ArrayBuffer.
 */
function bulkUpsertVectors(rows) {
  if (!rows || !rows.length) return 0
  const db = getDb()
  // DELETE first because vec0 doesn't support REPLACE/UPSERT inline.
  // vec0 is strict about PK types: it rejects JS number values and demands
  // BigInt. We coerce here, callers don't need to know.
  const del = db.prepare('DELETE FROM items_vec WHERE item_id = ?')
  const ins = db.prepare('INSERT INTO items_vec(item_id, embedding) VALUES (?, ?)')
  const tx = db.transaction((rows) => {
    for (const r of rows) {
      const id = BigInt(r.item_id)
      del.run(id)
      ins.run(id, Buffer.from(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength))
    }
  })
  tx(rows)
  return rows.length
}

/**
 * Count of vectors stored for a source. Used by the IndexButton to decide
 * between "Проиндексировать" / "Переиндексировать" labels and to show the
 * "indexed N / total" status.
 */
function vectorCountForSource(source_id) {
  const db = getDb()
  const row = db.prepare(`
    SELECT COUNT(*) AS cnt FROM items_vec
    WHERE item_id IN (SELECT id FROM items WHERE source_id = ?)
  `).get(source_id)
  return row?.cnt || 0
}

/**
 * Per-source disk-weight breakdown, in BYTES, decomposed by payload kind —
 * NOT by message type. Storage axis ≠ type axis: a photo's caption is text
 * that lives in the DB, the photo file lives on disk, so the same row can
 * contribute to two buckets. We answer "what's eating my disk" honestly:
 *
 *   text        — SUM(octet_length(caption)). Real UTF-8 bytes of every
 *                 caption regardless of message type (a captioned photo's
 *                 words count here, mirroring the copy/index «Текст» model).
 *   index       — vectors live in items_vec as raw float32: one vector is
 *                 EMBEDDING_DIM × 4 bytes. vec0 is a virtual table (no
 *                 queryable page count per row), so we COMPUTE the logical
 *                 size: count × dim × 4. This is the data weight, the bulk of
 *                 what bloats library.db on a fully-indexed channel.
 *   media_files / transcript_files — paths only; the caller stat()s them off
 *                 the main thread (you can't sum file sizes inside SQL). We
 *                 return the path lists so one DB round-trip feeds both the
 *                 count and the on-disk measurement.
 *
 * Returns { text_bytes, index_vectors, index_bytes, media_paths[],
 *           transcript_paths[] }.
 */
function storageBreakdownForSource(source_id) {
  const db = getDb()
  const t = db.prepare(`
    SELECT COALESCE(SUM(octet_length(caption)), 0) AS text_bytes
      FROM items WHERE source_id = ?
  `).get(source_id)
  const vectors = vectorCountForSource(source_id)
  const media = db.prepare(`
    SELECT media_path FROM items
     WHERE source_id = ? AND media_path IS NOT NULL
  `).all(source_id).map(r => r.media_path)
  const transcripts = db.prepare(`
    SELECT transcript_path FROM items
     WHERE source_id = ? AND transcript_path IS NOT NULL
  `).all(source_id).map(r => r.transcript_path)
  const thumbnails = db.prepare(`
    SELECT DISTINCT thumbnail_path FROM items
     WHERE source_id = ? AND thumbnail_path IS NOT NULL
  `).all(source_id).map(r => r.thumbnail_path)
  return {
    text_bytes:    t?.text_bytes || 0,
    index_vectors: vectors,
    index_bytes:   vectors * EMBEDDING_DIM * 4,   // float32 = 4 bytes/dim
    media_paths:       media,
    transcript_paths:  transcripts,
    thumbnail_paths:   thumbnails,
  }
}

/**
 * Return item_ids that already have a vector — used by the indexer to skip
 * messages that are up to date in incremental runs.
 */
function indexedItemIds(source_id, item_ids) {
  if (!item_ids?.length) return new Set()
  const db = getDb()
  const placeholders = item_ids.map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT v.item_id FROM items_vec v WHERE v.item_id IN (${placeholders})`
  ).all(...item_ids)
  return new Set(rows.map(r => r.item_id))
}

/**
 * Pure vector search: returns up to `limit` items ranked by cosine similarity
 * to the query embedding, descending.
 *
 *   query_embedding — Float32Array of the same dimensionality as items_vec
 *   source_id       — restrict to one source (required for chat-search)
 *   limit           — final number of items to return
 *
 * `query` parameter is accepted for forward-compat (the IPC layer passes it)
 * but ignored — FTS branch was removed deliberately. If you need exact-word
 * search, that's what the dedicated FTS button does.
 *
 * sqlite-vec returns Euclidean distance by default. Since both stored and
 * query vectors are L2-normalised by the embedder, cos = 1 - d²/2 ∈ [-1, 1].
 */
function hybridSearch({ query_embedding, source_id, limit = 10 }) {
  const db = getDb()
  const qbuf = Buffer.from(query_embedding.buffer, query_embedding.byteOffset, query_embedding.byteLength)
  const rows = db.prepare(`
    SELECT i.*, v.distance AS _dist
      FROM (
        SELECT item_id, distance FROM items_vec
         WHERE embedding MATCH ? AND k = ?
      ) v
      JOIN items i ON i.id = v.item_id
     WHERE i.source_id = ?
     ORDER BY v.distance
     LIMIT ?
  `).all(qbuf, Math.max(limit, 100), source_id, limit)
  return rows.map(r => {
    const cos = 1 - (r._dist * r._dist) / 2
    const { _dist, ...rest } = r
    return { ...rest, _cos: cos, _score: cos, _branches: ['vec'] }
  })
}

// ─── Assembly (Copy-saved) ────────────────────────────────────────────
//
// "Скопировать сохранённое" picks a slice of saved items and concatenates
// them into a single text blob (or .txt file). The slice is described by
// `scope`:
//
//   {
//     source_id: number,
//     types:     string[]            // ['text','voice','video','photo','document']
//                                   //   default: ['text']
//     topic_id:  number | null       // null = all topics
//     mode:      'all' | 'last_n' | 'from_date' | 'date_range',
//     limit:     number              // for last_n
//     date_from: number (unix sec)   // for from_date / date_range
//     date_to:   number (unix sec)   // for date_range
//   }
//
// Inclusion rules:
//   text                          → must have non-empty caption
//   voice / video / audio         → must have transcript_path (text body lives in file)
//   photo / document              → must have non-empty caption
//   other                         → never included
//
// All filters compose ANDed. Result is sorted ASC by published_at so the
// output reads chat-style.

function _buildAssemblyWhere(scope) {
  const types = (Array.isArray(scope?.types) && scope.types.length)
    ? scope.types : ['text']
  // scope.source_ids[] (multi, folder mode) OR scope.source_id (single).
  // Both shapes share the same WHERE machinery so estimate/fetch/transcript
  // paths don't diverge on a folder-vs-source axis.
  const sourceIds = (Array.isArray(scope?.source_ids) && scope.source_ids.length)
    ? scope.source_ids.map(Number)
    : (scope?.source_id != null ? [Number(scope.source_id)] : [])
  if (sourceIds.length === 0) {
    // No sources = no rows; produces an empty SQL that won't match anything.
    return { where: '1 = 0', params: [] }
  }
  const conds = []
  const params = []
  if (sourceIds.length === 1) {
    conds.push('source_id = ?')
    params.push(sourceIds[0])
  } else {
    conds.push(`source_id IN (${sourceIds.map(() => '?').join(',')})`)
    params.push(...sourceIds)
  }

  // Eligibility is SELECTION-DRIVEN, not a rigid `type IN (types)` gate.
  //
  // The old code gated on `type IN (selected types)` first, then applied a
  // fixed payload CASE. That silently dropped the single biggest class of text
  // in caption-heavy channels: a *photo with a caption* is stored as
  // type='photo', so selecting only «Текст» (type='text') threw away every
  // captioned photo. On one real channel that was 481 of 632 text-bearing
  // posts (76%) — copy stopped at the last caption-less text post (25.12.25)
  // while the channel had text through today. To the user, a "photo with a
  // 1879-char caption" IS a text post; the attachment is incidental. Same
  // trap hit polls (type='poll' never in `types`, so they never copied at all
  // despite the documented «Текст = текст + опросы + реакции» model).
  //
  // New rule — must mirror assemble.js::_bodyFor EXACTLY, or the estimate
  // (which counts eligible rows) and the copy (which keeps only rows _bodyFor
  // renders) disagree on the slice. _bodyFor's split is by transcript vs
  // caption, NOT by the message type the user ticked:
  //   • voice/video/audio  → body = transcript file (caption ignored)
  //   • everything else     → body = caption (+reactions tail)
  // So eligibility splits the same way:
  //   • «Текст» selected → ANY NON-transcript row with a caption, whatever its
  //     message type. A photo / document / poll with a caption carries the
  //     user's words in `caption`; to them it IS a text post (the attachment
  //     is incidental). "Give me everything I wrote." This is the fix — the
  //     old `type IN ('text')` gate dropped exactly these.
  //   • a caption-media type (photo/document/poll) selected → that type's
  //     captioned rows. A subset of «Текст», but meaningful when «Текст» is
  //     OFF (e.g. only photo captions).
  //   • voice/video/audio selected → rows whose transcript file exists.
  // OR over single-table conditions, so each row matches at most once — no
  // double counting when «Текст» and «Фото» overlap.
  //
  // (A captioned video with no transcript still isn't covered — its caption is
  // unreachable because _bodyFor renders video from the transcript only. That's
  // a pre-existing, separate limitation, not this bug; keeping estimate==copy
  // honest matters more than smuggling it in here.)
  const sel = new Set(types)
  const CAPTION_OK = `caption IS NOT NULL AND length(trim(caption)) > 0`
  const AV_TYPES = ['voice', 'video', 'audio']
  const elig = []
  if (sel.has('text')) {
    elig.push(`(type NOT IN ('voice','video','audio') AND ${CAPTION_OK})`)
  }
  const captionMedia = ['photo', 'document', 'poll'].filter(t => sel.has(t))
  if (captionMedia.length) {
    elig.push(`(type IN (${captionMedia.map(() => '?').join(',')}) AND ${CAPTION_OK})`)
    params.push(...captionMedia)
  }
  const transcriptMedia = AV_TYPES.filter(t => sel.has(t))
  if (transcriptMedia.length) {
    elig.push(`(type IN (${transcriptMedia.map(() => '?').join(',')}) AND transcript_path IS NOT NULL)`)
    params.push(...transcriptMedia)
  }
  if (elig.length === 0) {
    // Nothing selected can produce a body — match no rows.
    return { where: '1 = 0', params: [] }
  }
  conds.push(`(${elig.join(' OR ')})`)

  if (scope.topic_id != null) {
    conds.push('topic_id = ?')
    params.push(scope.topic_id)
  }

  if (scope.mode === 'from_date' && scope.date_from) {
    conds.push('published_at >= ?')
    params.push(scope.date_from)
  } else if (scope.mode === 'date_range') {
    if (scope.date_from) { conds.push('published_at >= ?'); params.push(scope.date_from) }
    if (scope.date_to)   { conds.push('published_at <= ?'); params.push(scope.date_to) }
  }

  return { where: conds.join(' AND '), params }
}

function assemblyEstimate(scope) {
  const db = getDb()
  const { where, params } = _buildAssemblyWhere(scope)
  // last_n constrains AFTER the type/text filter — otherwise "Последние 500 с
  // только voice+транскриптом" может вернуть 3 строки потому что 497 из 500
  // исходных были text-only без caption. Здесь limit применяется к уже
  // сужённому набору — то что юзер видит в estimate то и копируется.
  //
  // octet_length() — UTF-8 size in bytes (not chars). Critical: Cyrillic
  // doubles in UTF-8, so showing char-count as bytes was off by 2× for
  // Russian chats.
  if (scope.mode === 'last_n' && scope.limit > 0) {
    // direction='oldest' → take the N earliest; default 'newest' → freshest.
    // Mirrors assemblyFetch so estimate and copy never disagree on the slice.
    const order = scope.direction === 'oldest' ? 'ASC' : 'DESC'
    const row = db.prepare(`
      SELECT COUNT(*) AS n,
             SUM(COALESCE(octet_length(caption), 0)) AS caption_bytes,
             MIN(published_at) AS dmin,
             MAX(published_at) AS dmax
        FROM (
          SELECT * FROM items
           WHERE ${where}
           ORDER BY published_at ${order} LIMIT ?
        )
    `).get(...params, scope.limit)
    return { count: row.n || 0, caption_bytes: row.caption_bytes || 0,
             date_min: row.dmin, date_max: row.dmax }
  }
  const row = db.prepare(`
    SELECT COUNT(*) AS n,
           SUM(COALESCE(octet_length(caption), 0)) AS caption_bytes,
           MIN(published_at) AS dmin,
           MAX(published_at) AS dmax
      FROM items WHERE ${where}
  `).get(...params)
  return { count: row.n || 0, caption_bytes: row.caption_bytes || 0,
           date_min: row.dmin, date_max: row.dmax }
}

/**
 * Same scope as assemblyEstimate, but returns transcript_path strings only
 * for rows that have one (i.e. voice/video/audio after the standard filter).
 * Used by the IPC handler to stat() each file and add real bytes to the
 * estimate — you can't sum file sizes from inside SQL.
 */
function assemblyTranscriptPaths(scope) {
  const db = getDb()
  const { where, params } = _buildAssemblyWhere(scope)
  if (scope.mode === 'last_n' && scope.limit > 0) {
    // Mirror assemblyFetch direction so the byte estimate matches the slice
    // we'll actually copy (different ends of the chat = different files).
    const order = scope.direction === 'oldest' ? 'ASC' : 'DESC'
    return db.prepare(`
      SELECT transcript_path FROM (
        SELECT * FROM items WHERE ${where}
         ORDER BY published_at ${order} LIMIT ?
      ) WHERE transcript_path IS NOT NULL
    `).all(...params, scope.limit)
  }
  return db.prepare(`
    SELECT transcript_path FROM items
     WHERE ${where} AND transcript_path IS NOT NULL
  `).all(...params)
}

function assemblyFetch(scope) {
  const db = getDb()
  const { where, params } = _buildAssemblyWhere(scope)
  // Multi-source (folder mode) groups items by chat first, then chronologically
  // inside each chat — so combined.txt reads "<chat A timeline>" → "<chat B
  // timeline>" instead of one interleaved stream that's pointless to re-read.
  // Single-source mode keeps the legacy chat-style ASC order.
  const isMulti = Array.isArray(scope?.source_ids) && scope.source_ids.length > 1
  if (scope.mode === 'last_n' && scope.limit > 0) {
    // direction='oldest' → take the N earliest; default 'newest' (legacy) →
    // N freshest. After picking the slice we always re-sort ASC so the
    // assembled blob still reads top-to-bottom in chronological order.
    const oldestFirst = scope.direction === 'oldest'
    const order = oldestFirst ? 'ASC' : 'DESC'
    const rows = db.prepare(`
      SELECT * FROM items
       WHERE ${where}
       ORDER BY published_at ${order} LIMIT ?
    `).all(...params, scope.limit)
    if (isMulti) {
      rows.sort((a, b) => {
        if (a.source_id !== b.source_id) return a.source_id - b.source_id
        return (a.published_at || 0) - (b.published_at || 0)
      })
    } else {
      rows.sort((a, b) => (a.published_at || 0) - (b.published_at || 0))
    }
    return rows
  }
  if (isMulti) {
    return db.prepare(`
      SELECT * FROM items WHERE ${where}
       ORDER BY source_id ASC, published_at ASC
    `).all(...params)
  }
  return db.prepare(`
    SELECT * FROM items WHERE ${where}
     ORDER BY published_at ASC
  `).all(...params)
}

// ─── Folders (Telegram) ────────────────────────────────────────────────
//
// A folder = pointer into existing sources, never a content store of its
// own. We never INSERT items with a folder_id; assemble.js takes a list of
// source_ids that the folder resolves to. Same items table, same fetch jobs.

function listFolders(tg_session = null) {
  const db = getDb()
  // С фильтром по сессии: папки этой сессии + legacy-строки без привязки
  // (tg_session IS NULL — дозаполнятся при следующем refresh). Без аргумента —
  // прежнее поведение (все папки), для мест, которым сессия не важна.
  if (tg_session) {
    return db.prepare(`
      SELECT f.*,
        (SELECT COUNT(*) FROM folder_sources fs WHERE fs.folder_id = f.id) AS sources_count
      FROM folders f
      WHERE f.tg_session = ? OR f.tg_session IS NULL
      ORDER BY f.added_at DESC
    `).all(tg_session)
  }
  return db.prepare(`
    SELECT f.*,
      (SELECT COUNT(*) FROM folder_sources fs WHERE fs.folder_id = f.id) AS sources_count
    FROM folders f
    ORDER BY f.added_at DESC
  `).all()
}

function getFolder(id) {
  const db = getDb()
  return db.prepare(`
    SELECT f.*,
      (SELECT COUNT(*) FROM folder_sources fs WHERE fs.folder_id = f.id) AS sources_count
    FROM folders f WHERE f.id = ?
  `).get(id)
}

function findFolderByTgId(tg_filter_id, tg_session = null) {
  if (tg_filter_id == null) return null
  const db = getDb()
  if (tg_session) {
    return db.prepare(
      `SELECT * FROM folders WHERE tg_filter_id = ? AND (tg_session = ? OR tg_session IS NULL)`
    ).get(tg_filter_id, tg_session) || null
  }
  return db.prepare(`SELECT * FROM folders WHERE tg_filter_id = ?`).get(tg_filter_id) || null
}

function upsertFolder({ tg_filter_id, title, default_period_days, default_types_json, tg_session }) {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const periodDays = Number.isFinite(default_period_days) ? default_period_days : 7
  const typesJson = default_types_json
    || JSON.stringify(['text'])
  const sess = (typeof tg_session === 'string' && tg_session.trim()) ? tg_session.trim() : null
  if (tg_filter_id != null) {
    // Матчим в рамках сессии. Legacy-строка (tg_session IS NULL) с тем же
    // filter_id — это та же папка, спарсенная до ввода привязки: усыновляем
    // её, проставляя сессию, вместо создания дубля.
    const existing = sess
      ? db.prepare(`SELECT id FROM folders WHERE tg_filter_id = ? AND (tg_session = ? OR tg_session IS NULL)`)
          .get(tg_filter_id, sess)
      : db.prepare(`SELECT id FROM folders WHERE tg_filter_id = ?`).get(tg_filter_id)
    if (existing) {
      db.prepare(`
        UPDATE folders
           SET title = ?, updated_at = ?,
               tg_session = COALESCE(?, tg_session)
         WHERE id = ?
      `).run(title || `folder-${tg_filter_id}`, now, sess, existing.id)
      return existing.id
    }
  }
  db.prepare(`
    INSERT INTO folders (tg_filter_id, title, tg_session, default_period_days, default_types_json, added_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(tg_filter_id || null, title || 'Без названия', sess, periodDays, typesJson, now, now)
  return db.prepare('SELECT last_insert_rowid() AS id').get().id
}

function updateFolderParams(id, patch) {
  if (!id || !patch) return
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const fields = ['updated_at = ?']
  const values = [now]
  if (patch.title !== undefined) {
    fields.push('title = ?')
    values.push(String(patch.title || ''))
  }
  if (patch.default_period_days !== undefined) {
    fields.push('default_period_days = ?')
    values.push(Number(patch.default_period_days) || 7)
  }
  if (patch.default_types_json !== undefined) {
    fields.push('default_types_json = ?')
    values.push(typeof patch.default_types_json === 'string'
      ? patch.default_types_json
      : JSON.stringify(patch.default_types_json || ['text']))
  }
  if (patch.last_fetched_at !== undefined) {
    fields.push('last_fetched_at = ?')
    values.push(patch.last_fetched_at == null ? null : Number(patch.last_fetched_at))
  }
  values.push(id)
  db.prepare(`UPDATE folders SET ${fields.join(', ')} WHERE id = ?`).run(...values)
}

// Replace folder ↔ source mapping atomically. `sourceIds` is the canonical
// new set; rows not in it are removed, rows new to it are inserted. Idempotent.
function setFolderSources(folder_id, sourceIds) {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const tx = db.transaction((ids) => {
    db.prepare(`DELETE FROM folder_sources WHERE folder_id = ?`).run(folder_id)
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO folder_sources (folder_id, source_id, added_at)
      VALUES (?, ?, ?)
    `)
    for (const sid of ids) {
      if (!Number.isFinite(Number(sid))) continue
      stmt.run(folder_id, Number(sid), now)
    }
  })
  tx(sourceIds || [])
}

// All sources tied to a folder, in insertion order. Joined with the same
// shape that listSources() returns so TelegramScreen can render rows
// without a second round-trip.
//
// Per-type breakdown comes baked in (text_n / voice_n / video_n / photo_n /
// document_n) so the row can show "Текст 10 · 🎤 2 · 🎬 5" without a second
// IPC per source. SQL uses one JOIN with conditional SUMs — indexed by
// idx_items_type so cost is one index seek per source.
function listFolderSources(folder_id) {
  const db = getDb()
  const hasVec = itemsVecAvailable(db)
  const indexedExpr = hasVec ? `COALESCE(iv.semantic_indexed_count, 0)` : `0`
  const itemStatsJoin = `
    LEFT JOIN (
      SELECT source_id,
             COUNT(*) AS items_count,
             SUM(CASE WHEN caption IS NOT NULL AND length(trim(caption)) > 0 THEN 1 ELSE 0 END) AS semantic_indexable_count,
             MAX(published_at) AS last_item_at,
             SUM(CASE WHEN type='text'     THEN 1 ELSE 0 END) AS text_n,
             SUM(CASE WHEN type='voice'    THEN 1 ELSE 0 END) AS voice_n,
             SUM(CASE WHEN type='video'    THEN 1 ELSE 0 END) AS video_n,
             SUM(CASE WHEN type='photo'    THEN 1 ELSE 0 END) AS photo_n,
             SUM(CASE WHEN type='audio'    THEN 1 ELSE 0 END) AS audio_n,
             SUM(CASE WHEN type='document' THEN 1 ELSE 0 END) AS document_n
        FROM items
       GROUP BY source_id
    ) ia ON ia.source_id = s.id
  `
  const indexedJoin = hasVec ? `
    LEFT JOIN (
      SELECT i.source_id, COUNT(*) AS semantic_indexed_count
        FROM items_vec v
        JOIN items i ON i.id = v.item_id
       GROUP BY i.source_id
    ) iv ON iv.source_id = s.id
  ` : ''
  return db.prepare(`
    SELECT s.*,
      COALESCE(ia.items_count, 0) AS items_count,
      COALESCE(ia.semantic_indexable_count, 0) AS semantic_indexable_count,
      ${indexedExpr} AS semantic_indexed_count,
      ia.last_item_at AS last_item_at,
      COALESCE(ia.text_n, 0) AS text_n,
      COALESCE(ia.voice_n, 0) AS voice_n,
      COALESCE(ia.video_n, 0) AS video_n,
      COALESCE(ia.photo_n, 0) AS photo_n,
      COALESCE(ia.audio_n, 0) AS audio_n,
      COALESCE(ia.document_n, 0) AS document_n,
      fs.added_at AS folder_added_at
    FROM folder_sources fs
    JOIN sources s ON s.id = fs.source_id
    ${itemStatsJoin}
    ${indexedJoin}
    WHERE fs.folder_id = ?
    -- Свежий пост вверху, пустые/неспарсенные чаты в конец (last_item_at = NULL).
    -- Telethon-порядок (fs.added_at) — стабильный fallback при равенстве, чтобы
    -- список не «прыгал» между перерендерами при одинаковых датах.
    ORDER BY last_item_at IS NULL, last_item_at DESC, fs.added_at ASC, s.id ASC
  `).all(folder_id)
}

function deleteFolder(id) {
  const db = getDb()
  // ON DELETE CASCADE on folder_sources clears the join rows. Sources
  // themselves stay — they may also be reachable from Library directly.
  db.prepare(`DELETE FROM folders WHERE id = ?`).run(id)
}

// ─── research_jobs (история external-research) ────────────────────────
// Persist терминального джоба (done/error) в БД, чтобы история переживала
// рестарт. Идемпотентно по job_id (UPSERT).
function upsertResearchJob(j) {
  if (!j || !j.jobId) return
  const db = getDb()
  db.prepare(`
    INSERT INTO research_jobs
      (job_id, kind, provider, model_id, mode, status, stage, prompt,
       response_text, url, response_len, link_count, result_json, error,
       created_at, updated_at, done_at)
    VALUES
      (@job_id, @kind, @provider, @model_id, @mode, @status, @stage, @prompt,
       @response_text, @url, @response_len, @link_count, @result_json, @error,
       @created_at, @updated_at, @done_at)
    ON CONFLICT(job_id) DO UPDATE SET
      status=excluded.status, stage=excluded.stage,
      response_text=COALESCE(excluded.response_text, research_jobs.response_text),
      url=COALESCE(excluded.url, research_jobs.url),
      response_len=excluded.response_len, link_count=excluded.link_count,
      result_json=COALESCE(excluded.result_json, research_jobs.result_json),
      error=excluded.error, updated_at=excluded.updated_at, done_at=excluded.done_at
  `).run({
    job_id: j.jobId,
    kind: j.kind || null,
    provider: j.provider || null,
    model_id: j.modelId || null,
    mode: j.mode || null,
    status: j.status || null,
    stage: j.stage || null,
    prompt: j.prompt || j.fullPrompt || null,
    response_text: j.responseText || null,
    url: j.url || null,
    response_len: j.responseTextLen ?? (j.responseText ? j.responseText.length : null),
    link_count: j.linkCount ?? null,
    result_json: researchResultJson(j),
    error: j.error || null,
    created_at: j.createdAt || null,
    updated_at: j.updatedAt || Date.now(),
    done_at: j.doneAt || null,
  })
}

// Последние N джобов из БД (хронология, свежие сверху).
function listResearchJobs(limit = 100) {
  const db = getDb()
  const rows = db.prepare(`
    SELECT job_id AS jobId, kind, provider, model_id AS modelId, mode,
           status, stage, prompt AS fullPrompt, response_text AS responseText,
           url, response_len AS responseTextLen, link_count AS linkCount,
           result_json AS resultJson, error, created_at AS createdAt,
           updated_at AS updatedAt, done_at AS doneAt
    FROM research_jobs
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit)
  return rows.map(normalizeResearchHistoryRow)
}

function researchResultJson(j) {
  if (!j?.result || typeof j.result !== 'object') return null
  try { return JSON.stringify(j.result) } catch { return null }
}

function parseResearchResult(raw) {
  if (!raw) return null
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

function normalizeResearchHistoryRow(row) {
  const result = parseResearchResult(row.resultJson)
  const { resultJson, ...base } = row
  const responseText = row.responseText || (typeof result?.text === 'string' ? result.text : '')
  const legacy = splitLegacyResearchResponse(responseText)
  const resultSources = normalizeResearchSources(result)
  const sources = resultSources.length > 0 ? resultSources : legacy.sources
  const resultSourcesMeta = result?.sources_meta && typeof result.sources_meta === 'object'
    ? result.sources_meta
    : null
  const sourceActivity = normalizeResearchSourceActivity(result, resultSourcesMeta)
  const sourcesMeta = resultSourcesMeta || legacy.sourcesMeta
  if (sourcesMeta && sourceActivity.length && !Array.isArray(sourcesMeta.activity_items)) {
    sourcesMeta.activity_items = sourceActivity
  }
  const answerText = normalizeResearchAnswerText(result, responseText, legacy.answerText)
  const reasoningText = normalizeResearchReasoningText(result, sourcesMeta)
  const images = normalizeResearchImages(result?.images, 'output')
  const inputImages = normalizeResearchImages(result?.input_images, 'input')
  return {
    ...base,
    responseText: responseText || null,
    responseHead: responseText ? responseText.slice(0, 600) : null,
    responseTextLen: row.responseTextLen ?? (responseText ? responseText.length : null),
    answerText: answerText || null,
    answerHead: answerText ? answerText.slice(0, 600) : null,
    reasoningText: reasoningText || null,
    images,
    inputImages,
    imageCount: images.length,
    sources,
    sourcesMeta,
    sourceActivity,
    linkCount: sources.length || row.linkCount,
    textKind: result?.text_kind || null,
    isResearch: result?.is_research,
  }
}

function normalizeResearchSourceActivity(result, sourcesMeta) {
  const arr = Array.isArray(sourcesMeta?.activity_items)
    ? sourcesMeta.activity_items
    : Array.isArray(result?.source_activity)
      ? result.source_activity
      : []
  return arr
    .map((item) => {
      const title = typeof item?.title === 'string' ? item.title.trim() : ''
      const text = typeof item?.text === 'string' ? item.text.trim() : ''
      const command = typeof item?.command === 'string' ? item.command.trim() : ''
      const links = Array.isArray(item?.links)
        ? item.links.map((link) => ({
          url: typeof link?.url === 'string' ? link.url : '',
          title: typeof link?.title === 'string' ? link.title : '',
        })).filter((link) => link.url)
        : []
      if (!title && !text && !command && links.length === 0) return null
      return { title, text, command, links }
    })
    .filter(Boolean)
}

function normalizeResearchSources(result) {
  const arr = Array.isArray(result?.sources)
    ? result.sources
    : Array.isArray(result?.links)
      ? result.links
      : []
  return arr
    .map((s) => ({
      url: typeof s?.url === 'string' ? s.url : (typeof s?.href === 'string' ? s.href : ''),
      title: typeof s?.title === 'string' ? s.title : '',
    }))
    .filter((s) => s.url)
}

function normalizeResearchAnswerText(result, fallbackText = '', legacyAnswerText = '') {
  if (typeof result?.answer_text === 'string' && result.answer_text.trim()) return result.answer_text
  if (typeof result?.answerText === 'string' && result.answerText.trim()) return result.answerText
  if (legacyAnswerText) return legacyAnswerText
  return stripResearchSourcesBlock(fallbackText)
}

function normalizeResearchReasoningText(result, sourcesMeta) {
  const direct = typeof result?.reasoning_text === 'string'
    ? result.reasoning_text
    : typeof result?.thinking_text === 'string'
      ? result.thinking_text
      : typeof sourcesMeta?.thinking_text === 'string'
        ? sourcesMeta.thinking_text
        : ''
  return direct.trim()
}

function normalizeResearchImages(raw, role) {
  const arr = Array.isArray(raw) ? raw : []
  return arr
    .map((it, i) => {
      const filePath = typeof it?.file_path === 'string' ? it.file_path
        : typeof it?.filePath === 'string' ? it.filePath
          : typeof it?.path === 'string' ? it.path
            : ''
      const name = typeof it?.name === 'string' && it.name
        ? it.name
        : (filePath ? path.basename(filePath) : `image-${i + 1}`)
      const assetUrl = assetUrlForResearchFile(filePath)
      return {
        role,
        index: Number.isFinite(it?.index) ? it.index : i,
        name,
        filePath: filePath || null,
        assetUrl,
        contentType: it?.content_type || it?.contentType || it?.mime || null,
        bytes: Number.isFinite(it?.bytes) ? it.bytes : (Number.isFinite(it?.size) ? it.size : null),
        width: Number.isFinite(it?.width) ? it.width : null,
        height: Number.isFinite(it?.height) ? it.height : null,
      }
    })
    .filter((img) => img.assetUrl || img.filePath)
}

function assetUrlForResearchFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return ''
  const abs = path.resolve(filePath)
  const rel = path.relative(LIB_ROOT, abs)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return ''
  return `sc-asset://${rel.split(path.sep).join('/')}`
}

function stripResearchSourcesBlock(text) {
  if (!text) return ''
  return String(text).split(/\n{2,}---\n(?:Источники|Sources)\s*\(\d+\):\n/i)[0].trim()
}

function splitLegacyResearchResponse(text) {
  const raw = typeof text === 'string' ? text : ''
  const match = raw.match(/\n{2,}---\n(?:Источники|Sources)\s*\(\d+\):\n/i)
  if (!match || match.index == null) return { answerText: '', sources: [], sourcesMeta: null }

  const answerText = raw.slice(0, match.index).trim()
  const tail = raw.slice(match.index + match[0].length)
  const sources = []
  let activity = null

  for (const line of tail.split(/\n+/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const activityMatch = trimmed.match(/^(?:Активность|Activity):\s*(.{1,60})/i)
    if (activityMatch) {
      activity = cleanResearchActivity(activityMatch[1])
      continue
    }
    const sourceMatch = trimmed.match(/^\d+\.\s+(.+?)\s+[—-]\s+(https?:\/\/\S+)/i)
    if (!sourceMatch) continue
    sources.push({
      title: sourceMatch[1].trim(),
      url: sourceMatch[2].replace(/[),.;]+$/g, ''),
    })
  }

  return {
    answerText,
    sources,
    sourcesMeta: activity ? { activity } : null,
  }
}

function cleanResearchActivity(value) {
  const s = typeof value === 'string' ? value.trim() : ''
  if (!s) return ''
  const time = s.match(/^((?:\d+\s*(?:h|hr|hrs|m|min|mins|s|sec|secs|ч|час|часа|часов|м|мин|сек|с)\s*){1,4})/i)
  return (time ? time[1] : s).trim()
}

function deleteResearchJob(jobId) {
  getDb().prepare(`DELETE FROM research_jobs WHERE job_id = ?`).run(jobId)
}

function validUiPreferenceKey(key) {
  return typeof key === 'string' &&
    key.length > 0 &&
    key.length <= 120 &&
    /^[a-zA-Z0-9._:-]+$/.test(key)
}

function getUiPreference(key) {
  if (!validUiPreferenceKey(key)) return null
  const row = getDb().prepare(`SELECT value_json FROM ui_preferences WHERE key = ?`).get(key)
  if (!row) return null
  try { return JSON.parse(row.value_json) } catch { return null }
}

function setUiPreference(key, value) {
  if (!validUiPreferenceKey(key)) return { ok: false, error: 'invalid_key' }
  getDb().prepare(`
    INSERT INTO ui_preferences (key, value_json, updated_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value))
  return { ok: true }
}

module.exports = {
  upsertResearchJob, listResearchJobs, deleteResearchJob,
  getUiPreference, setUiPreference,
  getDb, close,
  // sources
  upsertSource, setSourceSession, upsertYoutubeChannel, upsertTiktokChannel, upsertBoostyChannel,
  listSources, getSource, deleteSource, patchSourceMeta,
  getSourceNotes, setSourceNotes,
  setTelegramAutoForSources, listTelegramAutoSources,
  setTelegramSourceUnavailable, clearTelegramSourceHealth,
  semanticIndexCountsForSources,
  // items
  upsertItem, bulkUpsertItems, upsertBoostyCatalog, setItemThumbnailPath, listBoostyItems, listBoostyVideos,
  markItemDownloaded, markItemDownloadError, markItemTranscribeError, clearItemMediaPaths,
  listItems, listSourceTopics,
  itemTypeBreakdown, telegramMediaEstimate, socialSourceOverview, senderBreakdown,
  itemsDateRange,
  assemblyEstimate, assemblyTranscriptPaths, assemblyFetch,
  deleteItem, maxExternalId, getItemsByExternalIds, markItemTranscribed,
  appendItemTranscript, listProcessedExternalIdsByKind, findTelegramSourceByTarget,
  listItemsMissingParent, bulkUpdateParentExternalId,
  // tg comments
  bulkInsertComments, countCommentsBySource,
  listCommentsForPosts, listPostsWithComments, setSourceHasDiscussion,
  // jobs
  recordJob, updateJob, listJobsForSource, latestTelegramAnalysisForSource, listSourcelessJobs,
  markStuckRunningAsInterrupted, findRunningJobForSource,
  findDoneYoutubeJob, findDoneTiktokJob,
  findYoutubeTranscriptForVideo, findTiktokTranscriptForVideo,
  findYoutubeTranscriptsByVideoIds, findTiktokTranscriptsByVideoIds,
  findYoutubeCommentsForVideo, findYoutubeCommentsByVideoIds,
  deleteJob, clearJobsForSource,
  // coverage
  recordCoverage, listCoverage,
  // fts
  indexItemForFts, searchItems,
  // vectors
  bulkUpsertVectors, vectorCountForSource, indexedItemIds, hybridSearch,
  storageBreakdownForSource, EMBEDDING_DIM,
  // folders
  listFolders, getFolder, findFolderByTgId, upsertFolder, updateFolderParams,
  setFolderSources, listFolderSources, deleteFolder,
  // paths (so other modules don't recompute)
  LIB_ROOT, DB_PATH,
}
