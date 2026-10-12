#!/usr/bin/env node
// SC Desktop — one MCP entry point for semantic search over saved archives,
// live social/source tools and direct API integrations such as YouGile.
//
// Architecture: Claude Code spawns this script (via the wrapper that sets
// ELECTRON_RUN_AS_NODE=1, see ./run.sh). The script opens the same library.db
// as the Electron app — better-sqlite3 with WAL allows concurrent readers, so
// running side-by-side with the desktop is safe.
//
// Tools exposed:
//   list_telegram_chats           → enumerate sources we can search
//   telegram_semantic_search      → vector search inside one chat
//   telegram_neighbors            → fetch ±N messages around a hit by published_at,
//                                   so the assistant can reconstruct the thread
//                                   (the "Late Chunking" context isn't stored in
//                                   the DB — neighbors approximate it)
//   telegram_reply_thread         → reply-graph walk (ancestors + descendants)
//   telegram_get_by_external_id   → resolve a t.me URL fragment
//                                   (chat + message_id) to one item
//
// All paths are absolute. The server has no CLI args; configuration goes
// through env or shared ~/.config/sc/settings.json.

const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const { Server } = require('@modelcontextprotocol/sdk/server/index.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js')

// MCP speaks over stdout. Desktop job modules log with console.log, so route
// their diagnostics to stderr before importing/starting them.
console.log = (...args) => console.error(...args)
process.env.SC_DESKTOP_MCP = '1'

// Reuse the desktop-side modules verbatim — they already handle DB connection,
// vec extension loading, embedder API key resolution. Keeps semantic search
// behaviour identical between the in-app UI and Claude Code calls.
const projectRoot = path.resolve(__dirname, '..')
const db = require(path.join(projectRoot, 'electron', 'database.js'))
const { embedQuery } = require(path.join(projectRoot, 'electron', 'embedder.js'))
const {
  buildTwitterQuery,
  normaliseStatusUrl,
  parseStatusId: parseTwitterStatusIdFromUrl,
  scrapeTwitterSearch,
  scrapeTwitterThread,
} = require(path.join(projectRoot, 'mcp', 'twitter-browser.js'))
const { createTelegramLiveClient } = require('./telegram-live-client')
const { telegramArchiveMediaTools, callTelegramArchiveMediaTool } = require('./telegram-archive-media-tools')
const { createTelegramRagClient } = require('./telegram-rag-client')
const { telegramSendSavedMessageTool: savedMessageTool, normalizeSavedMessageInput } = require('./telegram-saved-message')
const { telegramTextTools, toolOperations: telegramTextOperations, callTelegramTextTool } = require('./telegram-text-tools')
const { telegramBotTools, botOperations, callTelegramBotTool } = require('./telegram-bot-tools')
const { telegramFolderTools, callTelegramFolderTool } = require('./telegram-folder-tools')
const { createTelegramRagReaders, serializeTelegramItem, readTelegramCaptionSpan, annotateSemanticContextRefs } = require('./telegram-rag-readers')
const { telegramRagTools, captionProperties: ragCaptionProperties, ragErrorResult } = require('./telegram-rag-tools')
const { boostyRagTools, boostyRagOperations, callBoostyRagTool } = require('./boosty-rag-tools')
const { boostyCatalogTools, boostyCatalogOperations, callBoostyCatalogTool } = require('./boosty-catalog-tools')
const { boostyWorkflowTools, boostyWorkflowOperations, callBoostyWorkflowTool } = require('./boosty-workflow-tools')
const { accountTools, inventoryResult: telegramAccountInventory, selectAccount: selectTelegramAccount, loginCommand: telegramLoginCommand } = require('./telegram-account-tools')
const { telegramForwardProvenance } = require('./telegram-forward-provenance')
const { searchTelegramRag, normalizeRagScope } = require('../electron/telegram-rag-search')
const { loadYougileToolBridge } = require('./yougile-tools')

let _jobRunner = null
let _indexJob = null
let _youtubeSubtitlesClient = null
let _telegramLiveClient = null
let _telegramRagClient = null
let yougileToolBridge = null
function jobRunner() {
  if (!_jobRunner) {
    _jobRunner = require(path.join(projectRoot, 'electron', 'job-runner.js'))
  }
  return _jobRunner
}
function indexJob() {
  if (!_indexJob) {
    _indexJob = require(path.join(projectRoot, 'electron', 'index-job.js'))
  }
  return _indexJob
}
function youtubeSubtitlesClient() {
  if (!_youtubeSubtitlesClient) {
    const { createYoutubeSubtitlesClient } = require('./youtube-subtitles-client')
    _youtubeSubtitlesClient = createYoutubeSubtitlesClient()
  }
  return _youtubeSubtitlesClient
}
function telegramLiveClient() {
  if (!_telegramLiveClient) _telegramLiveClient = createTelegramLiveClient()
  return _telegramLiveClient
}
function telegramRagClient() {
  if (!_telegramRagClient) _telegramRagClient = createTelegramRagClient()
  return _telegramRagClient
}

// ===== GT EDITOR INTEGRATION =====
// Same MCP, second data source: gt-editor's storage.db with search_notes /
// search_chunks / search_chunks_vec tables. We open a SECOND better-sqlite3
// handle here (read-mostly) — gt-editor/electron/database.js cannot be imported
// because it owns a module-level `db` singleton and pulls in Electron app paths.
// We load sqlite-vec into this handle ourselves; better-sqlite3 + vec0 from
// sc-desktop's node_modules are ABI-compatible with the gt-editor DB file.
const Database = require('better-sqlite3')
const sqliteVec = require('sqlite-vec')
const fs = require('node:fs')
const os = require('node:os')

const GT_DB_PATH = process.env.GT_EDITOR_DB
  || path.join(os.homedir(), 'Library', 'Application Support', 'gt-editor', 'storage.db')

const GT_FALLBACK_LINE_BACKGROUNDS = [
  { id: 'warn', name: 'Warning' },
  { id: 'danger', name: 'Danger' },
  { id: 'ok', name: 'Success' },
  { id: 'info', name: 'Info' },
  { id: 'muted', name: 'Muted' },
]

let gtDb = null
function getGtDb() {
  if (gtDb) return gtDb
  if (!fs.existsSync(GT_DB_PATH)) {
    throw new Error(`gt-editor DB not found at ${GT_DB_PATH}. Open gt-editor at least once to create it.`)
  }
  gtDb = new Database(GT_DB_PATH, { readonly: false })
  gtDb.pragma('journal_mode = WAL')
  gtDb.pragma('busy_timeout = 30000')
  try { sqliteVec.load(gtDb) } catch (e) {
    throw new Error('sqlite-vec failed to load on gt-editor DB: ' + e.message)
  }
  return gtDb
}

const TOOLS = [
  ...telegramBotTools,
  ...telegramFolderTools,
  ...telegramRagTools,
  ...accountTools,
  {
    name: 'list_telegram_chats',
    description:
      'List Telegram chats available for semantic search, with how many ' +
      'messages are indexed in each. Use this first to find a source_id, ' +
      'then call telegram_semantic_search.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'telegram_semantic_search',
    description:
      'Semantic RAG search scoped to ONE saved Telegram source before nearest-neighbor ranking. ' +
      'Searches full-text fragments for migrated messages and preserves legacy message vectors ' +
      'for the remaining corpus. Returns original-message identities, matched spans, provenance, ' +
      'coverage/freshness and explicit search_budget_exhausted. Dates/topics apply before top-k. ' +
      'Cosine is a ranking score, NOT a probability or proof of a statement. Use several distinct ' +
      'semantic angles, then telegram_context and telegram_message_read for chosen hits; do not ' +
      'treat repeated snippets or forwarded copies as independent evidence. Unindexed/stale ' +
      'corpus and a budget-truncated empty result are not proof a topic was never discussed.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        source_id: {
          type: 'integer',
          description:
            'Numeric chat id from list_telegram_chats. Required to scope the ' +
            'search.',
        },
        query: {
          type: 'string',
          description:
            'Free-form text. Sentences and paragraphs out-perform keywords; ' +
            'the embedder takes up to ~2000 tokens.',
        },
        limit: {
          type: 'integer',
          default: 10,
          minimum: 1,
          maximum: 100,
          description: 'Number of results. Default 10.',
        },
        min_cos: {
          type: 'number',
          default: 0.55,
          minimum: 0,
          maximum: 1,
          description:
            'Ranking threshold, not confidence. Inspect context; distributions differ for legacy vs fragment indexes.',
        },
        date_from: { oneOf: [{ type: 'string' }, { type: 'integer', minimum: 0 }], description: 'Inclusive lower publication bound: Unix seconds or ISO date/time. A plain YYYY-MM-DD means UTC midnight.' },
        date_to: { oneOf: [{ type: 'string' }, { type: 'integer', minimum: 0 }], description: 'Inclusive upper bound; plain YYYY-MM-DD includes the entire UTC day.' },
        topic_id: { type: 'integer', minimum: 0, description: 'Topic eligibility before ranking. Omit for every topic; 0 selects null/zero (unknown or non-topic) metadata. General is normally topic 1, not 0.' },
        caption_chars: { ...ragCaptionProperties.caption_chars, default: 1200 },
      },
      required: ['source_id', 'query'],
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_neighbors',
    description:
      'Fetch the messages immediately preceding and following an item by ' +
      'published_at within the same chat. Use this after a search hit to ' +
      'inspect chronological context. An adjacent message is not proof of belonging ' +
      'to the same conversation. Best for dense bursts where one topic ' +
      "is discussed back-to-back. For replies that span hours/days call " +
      'telegram_reply_thread instead — the two tools are complementary.',
    inputSchema: {
      type: 'object',
      properties: {
        item_id: { type: 'integer', description: 'Numeric item id.' },
        before:  { type: 'integer', default: 5, minimum: 0, maximum: 30 },
        after:   { type: 'integer', default: 5, minimum: 0, maximum: 30 },
        same_topic: { type: 'boolean', default: false },
        ...ragCaptionProperties,
      },
      required: ['item_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_get_by_external_id',
    description:
      'Resolve a Telegram message reference (from a t.me URL or a known ' +
      'message_id) to one item with full context — caption, reactions, ' +
      'parent_external_id, item_id. Use this when the user pastes a link like ' +
      't.me/c/1769090887/22875/45751 or simply names a message_id; the tool ' +
      'finds (source_id, external_id) and returns the matching item. After ' +
      'getting item_id you can call telegram_neighbors / telegram_reply_thread ' +
      'on it. Accepts the chat as: numeric source_id from list_telegram_chats, ' +
      'a public handle ("neuraldeepchat"), an internal id like "1769090887" ' +
      'or "-1001769090887", or the full t.me URL (in which case external_id ' +
      'is parsed from the URL and the explicit external_id arg is ignored).',
    inputSchema: {
      type: 'object',
      properties: {
        chat: {
          oneOf: [{ type: 'string' }, { type: 'integer' }],
          description:
            'Identifier of the chat. Accepted: numeric source_id (preferred ' +
            'if known); public handle without @; internal chat_id ("1769090887" ' +
            'or "-1001769090887"); a full t.me/c/<id>/... URL (URL also ' +
            'supplies external_id, then external_id arg is ignored).',
        },
        external_id: {
          type: 'integer',
          minimum: 1,
          description:
            'Telegram message_id inside the chat (last numeric segment of a ' +
            't.me URL). Required unless `chat` is a full t.me URL.',
        },
        ...ragCaptionProperties,
      },
      required: ['chat'],
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_reply_thread',
    description:
      'Walk the saved Telegram reply graph around an item, with checked same-peer ' +
      'edges separate from unverified legacy parent candidates. Known external-peer ' +
      'quotes never become local edges; topic anchors are not ordinary replies. ' +
      'Use when a hit ' +
      'sits in a reply chain that is spread across hours or days — ' +
      'telegram_neighbors would return unrelated messages by time. Returns ' +
      'empty arrays for items that neither reply to nor are replied to. ' +
      'Missing parents, bounded traversal and provenance quality are explicit; ' +
      'an empty local graph does not prove a conversation has no context. ' +
      'Read saved-caption processing flags before attributing text to the author.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        item_id:    { type: 'integer', description: 'Numeric item id (the search hit).' },
        max_depth:  {
          type: 'integer', default: 10, minimum: 1, maximum: 50,
          description:
            'Limit on chain length in either direction. Guards against ' +
            'pathological deep threads.',
        },
        max_descendants: {
          type: 'integer', default: 100, minimum: 1, maximum: 500,
          description:
            'Cap on how many descendant messages to return. Wide threads ' +
            'with hundreds of replies get truncated; ancestors are never capped.',
        },
        ...ragCaptionProperties,
      },
      required: ['item_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_list_sources',
    description:
      'List ALL Telegram sources known to SC Desktop, not only semantically ' +
      'indexed chats. Returns per-source counts, date range, comment count, ' +
      'vector coverage, session binding, discussion availability, and type ' +
      'breakdown. Use before deciding whether to fetch, index, or pull comments.',
    inputSchema: {
      type: 'object',
      properties: {
        indexed_only: {
          type: 'boolean',
          default: false,
          description:
            'When true, only return sources with at least one semantic vector. ' +
            'Default false returns fetched-but-not-indexed chats too.',
        },
        explicit_only: {
          type: 'boolean',
          default: false,
          description:
            'When true, hide sources materialised only by folder fetches.',
        },
        limit: { type: 'integer', default: 200, minimum: 1, maximum: 1000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_source_state',
    description:
      'Return detailed local state for one Telegram source: source row, saved ' +
      'message counts, semantic-index coverage, date range, max message id, ' +
      'stored comments, coverage rows, recent jobs, and type breakdown. Accepts ' +
      'source_id, handle/title/internal id, or t.me URL. Coverage history is explicitly ' +
      'paged; continue coverage_next_offset rather than assuming the first page is all syncs.',
    inputSchema: {
      type: 'object',
      properties: {
        source_id: { type: 'integer', description: 'Numeric SC Desktop source id.' },
        chat: {
          oneOf: [{ type: 'string' }, { type: 'integer' }],
          description:
            'Handle, title, internal id, source id, or t.me URL. Used when ' +
            'source_id is omitted.',
        },
        jobs_limit: { type: 'integer', default: 10, minimum: 0, maximum: 50 },
        coverage_offset: { type: 'integer', default: 0, minimum: 0 },
        coverage_limit: { type: 'integer', default: 200, minimum: 1, maximum: 1000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_list_folders',
    description:
      'List Telegram dialog folders already synced into SC Desktop. Folders are ' +
      'session-scoped pointers to normal Telegram sources, not separate message ' +
      'stores. Defaults to the active Telegram session; pass session/profile or ' +
      'all_sessions=true when investigating another account.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional case-insensitive substring filter on folder title.',
        },
        session: {
          type: 'string',
          description:
            'Optional Telegram session/account. Accepts a session file name or ' +
            'an account alias from telegram_list_sessions.',
        },
        profile: { type: 'string', description: 'Alias for session.' },
        all_sessions: {
          type: 'boolean',
          default: false,
          description:
            'When true, list folders from every session instead of active/session scope.',
        },
        include_sources: {
          type: 'boolean',
          default: false,
          description: 'Include a compact source list for each folder.',
        },
        source_limit: {
          type: 'integer',
          default: 50,
          minimum: 1,
          maximum: 500,
          description: 'Max sources per folder when include_sources=true.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_refresh_folders',
    description:
      'Start a Telegram DialogFilter refresh job for the active session or an ' +
      'explicit session/profile. This syncs the latest Telegram folders into ' +
      'SC Desktop so telegram_list_folders/telegram_folder_state can inspect them.',
    inputSchema: {
      type: 'object',
      properties: {
        session: {
          type: 'string',
          description:
            'Optional Telegram session/account. Accepts a session file name or ' +
            'an account alias from telegram_list_sessions.',
        },
        profile: { type: 'string', description: 'Alias for session.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_folder_state',
    description:
      'Return one Telegram folder and its member chats from local SC Desktop ' +
      'state. Resolve by folder_id, Telegram filter_id, or title substring. ' +
      'Use this to inspect a folder like "Social" before choosing chats to fetch, ' +
      'index, or search.',
    inputSchema: {
      type: 'object',
      properties: {
        folder_id: { type: 'integer', description: 'Numeric SC Desktop folders.id.' },
        filter_id: { type: 'integer', description: 'Telegram DialogFilter.id.' },
        title: { type: 'string', description: 'Folder title or substring.' },
        name: { type: 'string', description: 'Alias for title.' },
        session: {
          type: 'string',
          description:
            'Optional Telegram session/account. Accepts a session file name or ' +
            'an account alias from telegram_list_sessions.',
        },
        profile: { type: 'string', description: 'Alias for session.' },
        all_sessions: { type: 'boolean', default: false },
        source_limit: { type: 'integer', default: 200, minimum: 1, maximum: 1000 },
        source_offset: { type: 'integer', default: 0, minimum: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_search_chats',
    description:
      'Search local SC Desktop Telegram chats by title, handle, or username. ' +
      'Can be scoped to a session/profile or to one Telegram folder. This is ' +
      'local metadata search; use telegram_resolve_chat for a live Telegram ' +
      'dialog scan when the chat is not in library.db.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive title/handle/username substring.' },
        session: {
          type: 'string',
          description:
            'Optional Telegram session/account. Accepts a session file name or ' +
            'an account alias from telegram_list_sessions.',
        },
        profile: { type: 'string', description: 'Alias for session.' },
        all_sessions: { type: 'boolean', default: false },
        folder_id: { type: 'integer', description: 'Optional folder scope.' },
        folder: { type: 'string', description: 'Optional folder title/substring scope.' },
        indexed_only: {
          type: 'boolean',
          default: false,
          description: 'Only return chats with at least one semantic vector.',
        },
        explicit_only: {
          type: 'boolean',
          default: false,
          description: 'Hide folder-only/materialised sources.',
        },
        limit: { type: 'integer', default: 50, minimum: 1, maximum: 500 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_resolve_chat',
    description:
      'Ask the active Telegram session to resolve a pasted chat title/handle ' +
      'into concrete chat candidates. Use when a human gives a plain chat ' +
      'name that is not already in SC Desktop sources. This may scan Telegram ' +
      'dialogs and can take time on large accounts.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Chat title, @handle, numeric id, or pasted text.' },
        session: {
          type: 'string',
          description:
            'Optional Telegram session/account to use. Accepts a session file name ' +
            '(e.g. session_4531193) or account alias from telegram_list_sessions ' +
            '(username/phone, e.g. f9922). Use this when the user names a profile.',
        },
        profile: {
          type: 'string',
          description: 'Alias for session; useful for phrases like "profile f9922".',
        },
        fuzzy: {
          type: 'boolean',
          default: true,
          description:
            'When true, match dialogs whose normalized title contains the query. ' +
            'MCP defaults to true so partial names like "Геннадий" work.',
        },
        limit: {
          type: 'integer',
          default: 50,
          minimum: 1,
          maximum: 200,
          description: 'Max candidates to return during fuzzy dialog scan.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_search_public_chats',
    description:
      'Search Telegram globally for public groups, supergroups, and channels by ' +
      'name or username through the selected user session. This is read-only and ' +
      'does not join anything. Returns public candidates and whether the account is ' +
      'already a member. The request is visible and cancellable in SC Desktop Requests.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 200 },
        limit: { type: 'integer', default: 20, minimum: 1, maximum: 50 },
        session: { type: 'string', description: 'Telegram session name or account alias.' },
        profile: { type: 'string', description: 'Alias for session.' },
        wait_ms: { type: 'integer', default: 30000, minimum: 0, maximum: 30000 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_join_chat',
    description:
      'Join one Telegram public group/channel by @username or t.me link, or use a ' +
      'private invite link (t.me/+... or t.me/joinchat/...). This changes the live ' +
      'Telegram account and therefore requires confirm=true. Already-member is a ' +
      'successful idempotent result. A successful membership is registered as an ' +
      'explicit SC Desktop source ready for telegram_fetch/telegram_index. FloodWait ' +
      'errors include retry_after_seconds. The operation is visible in SC Desktop ' +
      'Requests and cancellable until the membership RPC has been sent; after that ' +
      'SC Desktop waits for Telegram\'s authoritative result instead of claiming rollback.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', minLength: 1, maxLength: 2000, description: '@username, t.me public link, t.me/+... or t.me/joinchat/... invite.' },
        session: { type: 'string', description: 'Telegram session name or account alias.' },
        profile: { type: 'string', description: 'Alias for session.' },
        confirm: { type: 'boolean', const: true, description: 'Must be true: joining is a visible action by the user account.' },
        wait_ms: { type: 'integer', default: 30000, minimum: 0, maximum: 30000 },
      },
      required: ['target', 'confirm'],
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_leave_chat',
    description:
      'Leave one Telegram group/channel by @username, public t.me link, or invite ' +
      'link. This changes the live Telegram account and may remove access to private ' +
      'history, so confirm=true is mandatory. Already-left is an idempotent success. ' +
      'Local SC Desktop messages/source data are preserved. FloodWait errors include ' +
      'retry_after_seconds. The operation is visible in Requests and cancellable until ' +
      'the membership RPC has been sent; an in-flight external mutation is allowed to ' +
      'finish so the result cannot be misreported as rolled back.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', minLength: 1, maxLength: 2000, description: '@username, t.me public link, or invite link.' },
        session: { type: 'string', description: 'Telegram session name or account alias.' },
        profile: { type: 'string', description: 'Alias for session.' },
        confirm: { type: 'boolean', const: true, description: 'Must be true: leaving is a visible and potentially access-removing action.' },
        wait_ms: { type: 'integer', default: 30000, minimum: 0, maximum: 30000 },
      },
      required: ['target', 'confirm'],
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_live_search',
    description:
      'Search one Telegram chat directly on Telegram servers without fetching ' +
      'or indexing the whole chat. Returns matching message text/metadata and ' +
      'a pagination offset. This is lexical Telegram search, not semantic RAG. ' +
      'Forward provenance and attachment name/type/size are included when present. ' +
      'The request runs as a visible, cancellable SC Desktop job; no media bytes ' +
      'or messages are saved locally. Use telegram_live_context on selected hits; ' +
      'if a selected hit is voice/audio/video, use telegram_live_transcribe to read it.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { oneOf: [{ type: 'string' }, { type: 'integer' }], description: 'Source id, title, handle, internal id, or t.me URL.' },
        query: { type: 'string', minLength: 1, maxLength: 4000 },
        session: { type: 'string', description: 'Telegram session name or account alias.' },
        profile: { type: 'string', description: 'Alias for session.' },
        limit: { type: 'integer', default: 20, minimum: 1, maximum: 100 },
        offset_id: { type: 'integer', default: 0, minimum: 0, description: 'Pagination cursor returned as next_offset_id.' },
        date_from: { type: 'string', description: 'Optional lower date bound (ISO, YYYY-MM-DD, or DD.MM.YYYY).' },
        date_to: { type: 'string', description: 'Optional inclusive upper date bound.' },
        sender: { oneOf: [{ type: 'string' }, { type: 'integer' }], description: 'Optional sender handle/id.' },
        topic_id: { type: 'integer', minimum: 1, description: 'Optional forum top_msg_id.' },
        media_filter: {
          type: 'string',
          enum: ['all', 'photos', 'videos', 'photo_video', 'documents', 'voice', 'audio', 'music', 'links', 'polls', 'gifs'],
          default: 'all',
        },
        caption_chars: { type: 'integer', default: 1200, minimum: 100, maximum: 8000 },
        wait_ms: { type: 'integer', default: 15000, minimum: 0, maximum: 30000 },
      },
      required: ['chat', 'query'],
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_live_search_batch',
    description:
      'Run a bounded batch of lexical Telegram server searches across one or ' +
      'more chats, without downloading the chats. Intended for an AI agent\'s ' +
      'wide-search wave: provide several literal/synonym queries, then inspect ' +
      'deduplicated candidates and expand only strong hits with ' +
      'telegram_live_context. SC Desktop limits Telegram concurrency (default 3), ' +
      'shows one umbrella job in Requests, and provides Cancel. Selected voice/audio/' +
      'video hits can be read with telegram_live_transcribe.',
    inputSchema: {
      type: 'object',
      properties: {
        chats: {
          type: 'array', minItems: 1, maxItems: 12,
          items: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        },
        queries: { type: 'array', minItems: 1, maxItems: 60, items: { type: 'string', minLength: 1, maxLength: 4000 } },
        session: { type: 'string', description: 'Telegram session name or account alias.' },
        profile: { type: 'string', description: 'Alias for session.' },
        limit_per_query: { type: 'integer', default: 20, minimum: 1, maximum: 100 },
        max_candidates: { type: 'integer', default: 250, minimum: 1, maximum: 500 },
        concurrency: { type: 'integer', default: 3, minimum: 1, maximum: 5 },
        date_from: { type: 'string' },
        date_to: { type: 'string' },
        sender: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        topic_id: { type: 'integer', minimum: 1 },
        media_filter: {
          type: 'string',
          enum: ['all', 'photos', 'videos', 'photo_video', 'documents', 'voice', 'audio', 'music', 'links', 'polls', 'gifs'],
          default: 'all',
        },
        caption_chars: { type: 'integer', default: 1200, minimum: 100, maximum: 8000 },
        wait_ms: { type: 'integer', default: 20000, minimum: 0, maximum: 30000 },
      },
      required: ['chats', 'queries'],
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_live_context',
    description:
      'Read live context around one Telegram message without saving it: the ' +
      'reply ancestor chain, reply descendants, and chronological messages ' +
      'before/after are fetched together and deduplicated. Accepts a t.me URL ' +
      'or chat + message_id. Use this for every live hit you cite or analyse; ' +
      'reply links alone miss ordinary follow-up messages. Forward and attachment ' +
      'metadata are returned without downloading the attachment bytes. For a selected ' +
      'voice/audio/video message, call telegram_live_transcribe with its URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full t.me message URL.' },
        chat: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        message_id: { type: 'integer', minimum: 1 },
        session: { type: 'string' },
        profile: { type: 'string' },
        before: { type: 'integer', default: 15, minimum: 0, maximum: 100 },
        after: { type: 'integer', default: 15, minimum: 0, maximum: 100 },
        max_depth: { type: 'integer', default: 20, minimum: 0, maximum: 50 },
        max_replies: { type: 'integer', default: 100, minimum: 0, maximum: 500 },
        caption_chars: { type: 'integer', default: 8000, minimum: 100, maximum: 8000 },
        wait_ms: { type: 'integer', default: 20000, minimum: 0, maximum: 30000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_live_range',
    description:
      'Read an inclusive Telegram message-id range without saving the chat or ' +
      'downloading media; attachment name/type/size and forward origin are still ' +
      'returned. Pass two t.me URLs from the same chat, or chat + ' +
      'from_id + to_id. Missing/deleted ids are reported explicitly. This is ' +
      'the deterministic tool for requests like “read messages 5299 through 5318”. ' +
      'Use telegram_live_transcribe for any selected voice/audio/video row.',
    inputSchema: {
      type: 'object',
      properties: {
        from_url: { type: 'string' },
        to_url: { type: 'string' },
        chat: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        from_id: { type: 'integer', minimum: 1 },
        to_id: { type: 'integer', minimum: 1 },
        session: { type: 'string' },
        profile: { type: 'string' },
        max_messages: { type: 'integer', default: 1000, minimum: 1, maximum: 5000 },
        caption_chars: { type: 'integer', default: 8000, minimum: 100, maximum: 8000 },
        wait_ms: { type: 'integer', default: 20000, minimum: 0, maximum: 30000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_live_attachment',
    description:
      'Download and read exactly one attachment from one Telegram message without ' +
      'fetching or materialising the chat. Accepts a t.me message URL or chat + ' +
      'message_id. The operation runs in SC Desktop as a visible cancellable job. ' +
      'Returns a local cached file and metadata; supported images are additionally ' +
      'returned as real MCP image content, text/code and text PDFs as text content. ' +
      'Voice/audio/video are returned as the original file; use ' +
      'telegram_live_transcribe when the user wants their spoken contents. ' +
      'Unsupported binary formats return the original file plus an explicit limitation. ' +
      'If a large download is still running, call this tool again with job_id.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Existing desktop:<id> from an earlier attachment call; resumes result delivery without starting another download.' },
        url: { type: 'string', description: 'Full t.me message URL.' },
        chat: { oneOf: [{ type: 'string' }, { type: 'integer' }], description: 'Chat title, handle, source id, or Telegram internal id.' },
        message_id: { type: 'integer', minimum: 1 },
        session: { type: 'string', description: 'Telegram session name or account alias.' },
        profile: { type: 'string', description: 'Alias for session.' },
        max_bytes: { type: 'integer', default: 104857600, minimum: 1, maximum: 2147483648, description: 'Explicit safety cap for this one download; raise it when a known larger file is intended.' },
        max_text_chars: { type: 'integer', default: 200000, minimum: 1, maximum: 1000000 },
        caption_chars: { type: 'integer', default: 8000, minimum: 100, maximum: 8000 },
        wait_ms: { type: 'integer', default: 30000, minimum: 0, maximum: 30000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_live_transcribe',
    description:
      'Transcribe exactly one selected Telegram voice, audio, video note, or video ' +
      'without fetching or saving the surrounding chat. Use this when the user asks ' +
      'to read, listen to, understand, or transcribe a Telegram voice/media message. ' +
      'Soniox stt-async-v5 is the default and currently supported engine. SC Desktop ' +
      'shows one visible cancellable job, downloads only that attachment into its ' +
      'bounded cache, and returns transcript text plus links to the transcript and ' +
      'original media. If the job is still running, call again with job_id.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Existing desktop:<id> from an earlier transcription call; resumes result delivery without starting another job.' },
        url: { type: 'string', description: 'Full t.me URL of the voice/audio/video message.' },
        chat: { oneOf: [{ type: 'string' }, { type: 'integer' }], description: 'Chat title, handle, source id, or Telegram internal id.' },
        message_id: { type: 'integer', minimum: 1 },
        session: { type: 'string', description: 'Telegram session name or account alias.' },
        profile: { type: 'string', description: 'Alias for session.' },
        engine: { type: 'string', enum: ['soniox'], default: 'soniox' },
        language_hints: {
          type: 'array',
          minItems: 1,
          maxItems: 5,
          default: ['ru', 'en'],
          items: { type: 'string', minLength: 2, maxLength: 16 },
          description: 'Expected spoken languages; hints improve recognition but do not forbid other languages.',
        },
        context: { type: 'string', maxLength: 8000, description: 'Optional topic, names, or domain terms that should guide recognition.' },
        max_bytes: { type: 'integer', default: 104857600, minimum: 1, maximum: 2147483648, description: 'Safety cap for downloading this one selected media file.' },
        max_text_chars: { type: 'integer', default: 200000, minimum: 1, maximum: 1000000, description: 'Maximum transcript characters returned inline; the full text remains in transcript_path.' },
        caption_chars: { type: 'integer', default: 8000, minimum: 100, maximum: 8000 },
        wait_ms: { type: 'integer', default: 30000, minimum: 0, maximum: 30000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_live_save',
    description:
      'Explicitly materialise selected live Telegram message ids into the SC ' +
      'Desktop library. Live search/context/range are ephemeral by default; ' +
      'call this only when the user asks to save chosen messages. Starts one ' +
      'visible cancellable tg_fetch job and never fetches surrounding history.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        message_ids: { type: 'array', minItems: 1, maxItems: 5000, items: { type: 'integer', minimum: 1 } },
        session: { type: 'string' },
        profile: { type: 'string' },
        process_voice: { type: 'boolean', default: false },
        process_photo: { type: 'boolean', default: false },
        process_docs: { type: 'boolean', default: false, description: 'Read text/code attachments locally or extract PDFs with Gemini.' },
        process_polls: { type: 'boolean', default: true },
        transcribe_engine: { type: 'string', enum: ['assemblyai', 'gemini'] },
        transcribe_lang: { type: 'string', default: 'ru' },
        wait_ms: { type: 'integer', default: 0, minimum: 0, maximum: 30000 },
      },
      required: ['chat', 'message_ids'],
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_preview_fetch',
    description:
      'Start a Telegram pre-analysis job for a target/range. It walks the same ' +
      'range as fetch but does not save items; use it to estimate message counts ' +
      'and type distribution before launching a real fetch. Returns immediately ' +
      'with job id; poll telegram_job_status for the preview_summary.',
    inputSchema: {
      type: 'object',
      properties: {
        source_id: { type: 'integer', description: 'Known SC Desktop source id; target is derived from it.' },
        chat: {
          oneOf: [{ type: 'string' }, { type: 'integer' }],
          description: 'Known handle/title/internal id/t.me URL; target is derived when target is omitted.',
        },
        target: { type: 'string', description: '@handle, title-resolved id, internal id, or t.me URL.' },
        session: {
          type: 'string',
          description:
            'Optional Telegram session/account to use. Accepts a session name or an ' +
            'account alias from telegram_list_sessions (username/phone, e.g. f9922).',
        },
        profile: { type: 'string', description: 'Alias for session.' },
        mode: {
          type: 'string',
          enum: ['last_n', 'all', 'from_date', 'date_range', 'sync_new', 'single'],
          default: 'last_n',
        },
        limit: { type: 'integer', default: 500, minimum: 1, maximum: 100000 },
        date: { type: 'string', description: 'Lower bound for from_date/date_range, e.g. 01.02.2026.' },
        date_to: { type: 'string', description: 'Optional upper bound, same format as date.' },
        url: { type: 'string', description: 'Specific Telegram message URL for single mode.' },
        sinceMessageId: { type: 'integer', minimum: 1, description: 'For sync_new: fetch ids greater than this.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_fetch',
    description:
      'Start a real Telegram fetch through the same SC Desktop job-runner as ' +
      'the app UI. Saves messages into library.db, can pull comments, process ' +
      'voice/audio/video, describe photos, extract PDFs, save polls/reactions, ' +
      'and record coverage. Returns immediately with job id; poll ' +
      'telegram_job_status and run telegram_index after persisted completion. ' +
      'For a bounded speech pass use mode id_list + message_ids. voice_types and ' +
      'voice_max_duration_sec are checked before any download/STT. full_history ' +
      'requires mode all without limit/date/since/topic narrowing. With request_id, ' +
      'recover an unknown acknowledgement through fetch:<request_id>, never a new key.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        source_id: { type: 'integer', description: 'Known SC Desktop source id; target is derived from it.' },
        chat: {
          oneOf: [{ type: 'string' }, { type: 'integer' }],
          description: 'Known handle/title/internal id/t.me URL; target is derived when target is omitted.',
        },
        target: { type: 'string', description: '@handle, title-resolved id, internal id, or t.me URL.' },
        session: {
          type: 'string',
          description:
            'Optional Telegram session/account to use. Accepts a session name or an ' +
            'account alias from telegram_list_sessions (username/phone, e.g. f9922).',
        },
        profile: { type: 'string', description: 'Alias for session.' },
        mode: {
          type: 'string',
          enum: ['last_n', 'all', 'from_date', 'date_range', 'sync_new', 'single', 'media_only', 'id_list'],
          default: 'last_n',
        },
        limit: { type: 'integer', default: 500, minimum: 1, maximum: 100000 },
        date: { type: 'string', description: 'Lower bound for from_date/date_range, e.g. 01.02.2026.' },
        date_to: { type: 'string', description: 'Optional upper bound, same format as date.' },
        url: { type: 'string', description: 'Specific Telegram message URL for single mode.' },
        sinceMessageId: { type: 'integer', minimum: 1, description: 'For sync_new: fetch ids greater than this.' },
        types: {
          type: 'array',
          description:
            'Content/depth request. Accepted values: text, voice, audio, video, ' +
            'photo, docs, document, pdf, polls, comments, stickers. The fetcher ' +
            'always stores metadata for all Telegram message types in range; ' +
            'these values enable expensive AI/comment passes.',
          items: { type: 'string' },
        },
        process_voice: { type: 'boolean', description: 'Transcribe voice/audio/video.' },
        process_photo: { type: 'boolean', description: 'Describe photos with Gemini Vision.' },
        process_docs: { type: 'boolean', description: 'Read text/code files locally and extract PDFs with Gemini.' },
        download_profile_photo: { type: 'boolean', description: 'Optional avatar download. Set false for strictly metadata/allowed-speech-only collection; omit to keep legacy avatars.' },
        process_polls: { type: 'boolean', description: 'Render poll/quiz body into caption. Default true.' },
        include_comments: { type: 'boolean', description: 'Fetch linked discussion comments for posts.' },
        comments_limit: { type: 'integer', default: 0, minimum: 0, description: 'Max comments per post; 0 = all.' },
        topic_ids: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Forum topic top_msg_ids. Omit for all topics.',
        },
        transcribe_engine: { type: 'string', enum: ['assemblyai', 'gemini', 'soniox'], default: 'assemblyai' },
        transcribe_lang: { type: 'string', default: 'ru' },
        redo_processed: { type: 'boolean', default: false, description: 'Re-run AI media processing even if done.' },
        request_id: { type: 'string', description: 'Optional durable idempotency key. Same payload reuses original fetch:<key>; changed payload under that key is rejected.' },
        expected_account_id: { type: 'integer', minimum: 1, description: 'Optional exact Telegram account fence before history/download; does not switch the global session.' },
        expected_peer_id: { type: 'integer', description: 'Optional exact signed Telegram peer fence before history/download, e.g. -1002369738868 for itgrind.' },
        full_history: { type: 'boolean', default: false, description: 'Full snapshot: mode all, no limit/date/since/topic filter. Reports EOF/head/oldest/gaps; not a remote-delete audit.' },
        voice_types: { type: 'array', minItems: 1, items: { type: 'string', enum: ['voice', 'audio', 'video'] }, description: 'Speech allowlist before download/STT; omit to preserve all three types.' },
        voice_max_duration_sec: { type: 'number', exclusiveMinimum: 0, description: 'Inclusive duration cap before download; unknown/invalid duration is skipped.' },
        media_cache_dir: { type: 'string', description: 'Absolute job-local download directory; unmounted/unwritable/low-space cache fails, no silent fallback.' },
        media_min_free_bytes: { type: 'integer', minimum: 1048576 },
        reuse_transcripts: { type: 'boolean', default: false, description: 'Reuse any complete transcript, also for selected-message passes; do not repeat paid work.' },
        message_ids: { type: 'array', minItems: 1, maxItems: 5000, items: { type: 'integer', minimum: 1 }, description: 'Exact Telegram IDs for a bounded persisted speech pass.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_comments_catchup',
    description:
      'Fetch only comments for already-saved channel posts. If post_ids are ' +
      'omitted, the tool selects newest local posts without stored comments ' +
      'up to limit_posts. This skips the main message fetch loop and only walks ' +
      'linked discussion threads.',
    inputSchema: {
      type: 'object',
      properties: {
        source_id: { type: 'integer', description: 'Numeric SC Desktop source id.' },
        chat: {
          oneOf: [{ type: 'string' }, { type: 'integer' }],
          description: 'Handle/title/internal id/t.me URL when source_id is omitted.',
        },
        target: { type: 'string', description: 'Explicit target override for Telethon.' },
        post_ids: {
          type: 'array',
          items: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
          description: 'Channel post message ids to pull comments for.',
        },
        limit_posts: { type: 'integer', default: 200, minimum: 1, maximum: 5000 },
        comments_limit: { type: 'integer', default: 0, minimum: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_index',
    description:
      'Start/resume full-caption fragment indexing for one saved Telegram source in the ' +
      'running SC Desktop app. One visible cancellable Requests job; a message becomes ready ' +
      'only after every current fragment is published atomically. Old vectors remain for ' +
      'unmigrated messages. Returns immediately, including preparation; poll index/job status. ' +
      'item_ids are LOCAL item_id values, never Telegram message_id. No hidden MCP worker fallback.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        source_id: { type: 'integer', description: 'Numeric SC Desktop source id.' },
        chat: {
          oneOf: [{ type: 'string' }, { type: 'integer' }],
          description: 'Handle/title/internal id/t.me URL when source_id is omitted.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 200000, description: 'Newest local indexable messages to consider. Omit for all.' },
        item_ids: { type: 'array', minItems: 1, maxItems: 5000, items: { type: 'integer', minimum: 1 }, description: 'Optional exact local item_id subset within this source, for local-only targeted migration/guard repair. Does not start source-wide network metadata backfill.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_index_status',
    description:
      'Return current Telegram index coverage by saved source: ready-current messages, ' +
      'legacy-unverified, stale, partial and pending, with fragment progress separate. ' +
      'An accepted index job is not ready coverage; inspect its exact index-<id> status.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        source_id: { type: 'integer' },
        chat: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_list_jobs',
    description:
      'List recent Telegram jobs from SC Desktop jobs table, plus live MCP jobs ' +
      'known to this server process. Filter by source_id/chat when investigating ' +
      'a specific channel. active_only reads every nonterminal durable row without a recent-history limit. ' +
      'all_types with active_only is a read-only application drain check; live MCP rows are not the main app inventory.',
    inputSchema: {
      type: 'object',
      properties: {
        source_id: { type: 'integer' },
        chat: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        limit: { type: 'integer', default: 30, minimum: 1, maximum: 200 },
        active_only: { type: 'boolean', default: false },
        all_types: { type: 'boolean', default: false, description: 'Only with active_only: include other application job types for safe restart preflight; does not fetch their data.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_job_status',
    description:
      'Get one job snapshot/detail by in-memory id or DB id. For index status ' +
      'by source, pass source_id/chat. Use after telegram_fetch, ' +
      'telegram_preview_fetch, telegram_comments_catchup, telegram_index, or ' +
      'a telegram_live_* / telegram_join_chat / telegram_leave_chat tool. ' +
      'desktop:<id> jobs are read from the running app ' +
      'and include the ephemeral live result while the app remains open.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
        source_id: { type: 'integer' },
        chat: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_cancel_job',
    description:
      'Cancel a running Telegram fetch/preview/comments/index/membership job by ' +
      'in-memory id or DB id. For desktop:<id> returned by live/join/leave tools this routes ' +
      'to the running SC Desktop app, so the same cancellation is reflected in Requests.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
      },
      required: ['job_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_get_comments',
    description:
      'Read stored Telegram discussion comments from post_comments. Pass ' +
      'post_external_id for one channel post, or omit it to get recent comments ' +
      'for the source.',
    inputSchema: {
      type: 'object',
      properties: {
        source_id: { type: 'integer' },
        chat: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        post_external_id: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
        limit: { type: 'integer', default: 200, minimum: 1, maximum: 2000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_list_sessions',
    description:
      'Bounded fresh Telegram inventory: account IDs, assigned labels, masked phones. ' +
      'authorized:null/unknown means network/DNS/deadline, NOT absence. ' +
      'Use telegram_account_login_command for ONE user-run local hidden-input login; ' +
      'never ask for phone/code/2FA in AI. After ready use telegram_resolve_account ' +
      'and an explicit session per call. Global active is unchanged.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  savedMessageTool,
  ...telegramTextTools,
  ...boostyRagTools,
  ...boostyCatalogTools,
  ...boostyWorkflowTools,

  // ========== YOUTUBE SEARCH + SUBTITLES ==========
  {
    name: 'youtube_list_channels',
    description:
      'List YouTube channels saved in SC Desktop with catalog, transcript, and RAG-index coverage. ' +
      'Use this first to resolve a source_id before channel-specific semantic research.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional channel title, handle, or channel-id substring.' },
        indexed_only: { type: 'boolean', default: false },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'youtube_channel_index',
    description:
      'Start or resume a chunk-level RAG index for saved transcripts in one YouTube channel. ' +
      'The operation embeds bounded transcript passages, not whole videos. Poll ' +
      'youtube_channel_index_status or telegram_job_status with the returned job_id.',
    inputSchema: {
      type: 'object',
      properties: {
        source_id: { type: 'integer', minimum: 1 },
        channel: { type: 'string', description: 'Channel title, @handle, channel id, or URL when source_id is unknown.' },
        limit: { type: 'integer', minimum: 1, maximum: 20000, description: 'Newest transcribed videos to index. Omit for all.' },
      },
      anyOf: [{ required: ['source_id'] }, { required: ['channel'] }],
      additionalProperties: false,
    },
  },
  {
    name: 'youtube_channel_index_status',
    description:
      'Return RAG coverage for a saved YouTube channel: indexed transcript fragments, total ' +
      'fragments, and indexed/available videos.',
    inputSchema: {
      type: 'object',
      properties: {
        source_id: { type: 'integer', minimum: 1 },
        channel: { type: 'string' },
      },
      anyOf: [{ required: ['source_id'] }, { required: ['channel'] }],
      additionalProperties: false,
    },
  },
  {
    name: 'youtube_channel_semantic_search',
    description:
      'Semantic RAG search inside one indexed YouTube channel. Returns matching transcript ' +
      'passages with video URL, title, score, and exact or approximate position. For a selected ' +
      'hit call youtube_channel_context before making detailed claims or reconstructing a scheme.',
    inputSchema: {
      type: 'object',
      properties: {
        source_id: { type: 'integer', minimum: 1 },
        channel: { type: 'string' },
        query: { type: 'string', maxLength: 10000 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        min_cos: { type: 'number', minimum: -1, maximum: 1, default: 0.5 },
      },
      required: ['query'],
      anyOf: [{ required: ['source_id'] }, { required: ['channel'] }],
      additionalProperties: false,
    },
  },
  {
    name: 'youtube_channel_context',
    description:
      'Read neighboring transcript passages around a YouTube semantic-search hit. Pass item_id ' +
      'and chunk_index from youtube_channel_semantic_search; this is the evidence-expansion step ' +
      'before asking another model to explain a mechanism, workflow, or scheme.',
    inputSchema: {
      type: 'object',
      properties: {
        item_id: { type: 'integer', minimum: 1 },
        chunk_index: { type: 'integer', minimum: 0 },
        before: { type: 'integer', minimum: 0, maximum: 10, default: 2 },
        after: { type: 'integer', minimum: 0, maximum: 10, default: 2 },
      },
      required: ['item_id', 'chunk_index'],
      additionalProperties: false,
    },
  },
  {
    name: 'youtube_search',
    description:
      'Search YouTube through the running SC Desktop app using the same yt-dlp ranked-search ' +
      'flow as the in-app picker. A plain query returns YouTube relevance order. A full ' +
      'youtube.com/results URL preserves its native sp filters and sort. Results are ephemeral ' +
      'and are not written to the Library; pass selected URLs to youtube_get_subtitles.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          maxLength: 4096,
          description:
            'Plain search text, or a YouTube results URL containing search_query and optional sp filters.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          default: 20,
          description: 'Number of ranked results to return in this window.',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          maximum: 1000,
          default: 0,
          description: 'Start offset within the ranked result window.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'youtube_get_subtitles',
    description:
      'Get direct or automatic subtitles for one YouTube video through the running SC Desktop app. ' +
      'This starts the existing authenticated POST import, waits briefly, and returns transcript text ' +
      'when ready. It never starts paid AI transcription automatically. If status is running, call ' +
      'youtube_subtitles_status with the returned import id. Reuse client_request_id when retrying the same request.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'A YouTube watch, youtu.be, Shorts, Live, or embed video URL.',
        },
        client_request_id: {
          type: 'string',
          maxLength: 128,
          description: 'Optional stable idempotency id. Preserve and reuse it when retrying the call.',
        },
        wait_ms: {
          type: 'integer',
          minimum: 0,
          maximum: 45000,
          default: 25000,
          description: 'How long to wait for subtitles before returning a running status.',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          default: 0,
          description: 'Character offset for long transcript pagination.',
        },
        max_chars: {
          type: 'integer',
          minimum: 1,
          maximum: 200000,
          default: 50000,
          description: 'Maximum transcript characters returned by this call.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'youtube_subtitles_status',
    description:
      'Check a YouTube subtitle request started by youtube_get_subtitles. Waits briefly and returns ' +
      'the transcript when ready. If subtitles_not_found is returned, direct subtitles are unavailable ' +
      'and paid AI transcription has deliberately not been started.',
    inputSchema: {
      type: 'object',
      properties: {
        import_id: { type: 'string', description: 'Import UUID returned by youtube_get_subtitles.' },
        wait_ms: { type: 'integer', minimum: 0, maximum: 45000, default: 25000 },
        offset: { type: 'integer', minimum: 0, default: 0 },
        max_chars: { type: 'integer', minimum: 1, maximum: 200000, default: 50000 },
      },
      required: ['import_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'youtube_subtitles_cancel',
    description: 'Cancel an active YouTube subtitle request started through SC Desktop.',
    inputSchema: {
      type: 'object',
      properties: {
        import_id: { type: 'string', description: 'Import UUID returned by youtube_get_subtitles.' },
      },
      required: ['import_id'],
      additionalProperties: false,
    },
  },

  // ========== REDDIT ==========
  {
    name: 'reddit_search',
    description:
      'Start a Reddit post search through SC Desktop. Default backend is ' +
      'api: direct reddit.com/search.json with logged-in browser cookies, ' +
      'free and usually sub-second. Use backend=auto only when paid Apify ' +
      'fallback is explicitly acceptable. Saves a reddit/search source and ' +
      'post items into library.db.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Reddit search query.' },
        subreddit: {
          type: 'string',
          description: 'Optional subreddit name, with or without r/ prefix.',
        },
        limit: { type: 'integer', default: 25, minimum: 1, maximum: 250 },
        sort: {
          type: 'string',
          enum: ['relevance', 'top', 'new', 'hot', 'comments'],
          default: 'relevance',
        },
        time: {
          type: 'string',
          enum: ['all', 'year', 'month', 'week', 'day', 'hour'],
          default: 'year',
        },
        backend: {
          type: 'string',
          enum: ['api', 'auto', 'apify'],
          default: 'api',
          description:
            'api = free cookies only; auto = api then paid Apify fallback; apify = paid actor.',
        },
        wait_ms: {
          type: 'integer',
          default: 5000,
          minimum: 0,
          maximum: 30000,
          description:
            'How long to wait for completion before returning. Reddit api usually finishes in 1-3s.',
        },
        return_items: {
          type: 'boolean',
          default: true,
          description: 'When the job finishes during wait_ms, include saved post rows.',
        },
        download_media: {
          type: 'boolean',
          default: false,
          description:
            'Download post images after fetch completes. Default false; use reddit_media_fetch later when text suggests visual context matters.',
        },
        media_limit: {
          type: 'integer',
          default: 50,
          minimum: 1,
          maximum: 500,
          description: 'Max images to download when download_media=true.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'reddit_thread_fetch',
    description:
      'Fetch one Reddit post URL plus its comment tree through SC Desktop. ' +
      'Default backend=api is direct reddit.com/<post>.json with logged-in ' +
      'browser cookies, free. Saves a reddit/thread source with the post ' +
      '(type=text, depth=0) and comments (type=comment, depth>=1).',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full reddit.com post URL.' },
        max_comments: {
          type: 'integer',
          default: 200,
          minimum: 1,
          maximum: 5000,
          description: 'Max comments to save from the JSON tree.',
        },
        backend: {
          type: 'string',
          enum: ['api', 'auto', 'apify'],
          default: 'api',
          description:
            'api = free cookies only; auto = api then paid Apify fallback; apify = paid actor.',
        },
        wait_ms: { type: 'integer', default: 5000, minimum: 0, maximum: 30000 },
        return_items: {
          type: 'boolean',
          default: true,
          description: 'When finished during wait_ms, include saved post/comment rows.',
        },
        download_media: {
          type: 'boolean',
          default: false,
          description:
            'Download post images after fetch completes. Default false; use reddit_media_fetch later when visual context matters.',
        },
        media_limit: {
          type: 'integer',
          default: 50,
          minimum: 1,
          maximum: 500,
          description: 'Max images to download when download_media=true.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'reddit_list_sources',
    description:
      'List saved Reddit sources from SC Desktop. kind=search returns keyword ' +
      'search sources (posts only); kind=thread returns fetched post/comment ' +
      'trees. Use source_id with reddit_source_items or reddit_thread_tree.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['all', 'search', 'thread'],
          default: 'all',
        },
        limit: { type: 'integer', default: 100, minimum: 1, maximum: 1000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'reddit_source_state',
    description:
      'Return detailed state for one saved Reddit source: source metadata, ' +
      'post/comment counts, date range, type breakdown, recent rd_* jobs. ' +
      'Resolve by source_id, handle (q-.../t-...), post URL, or post id.',
    inputSchema: {
      type: 'object',
      properties: {
        source_id: { type: 'integer' },
        handle: { type: 'string', description: 'Reddit source handle q-... or t-...' },
        url: { type: 'string', description: 'Reddit post URL for thread sources.' },
        post_id: { type: 'string', description: 'Reddit t3 id without t3_ prefix.' },
        jobs_limit: { type: 'integer', default: 10, minimum: 0, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'reddit_source_items',
    description:
      'Read saved Reddit items for a source. For search sources this returns ' +
      'post rows. For thread sources this returns a flat post/comment list ' +
      'with parent_external_id and depth, so callers can reconstruct the tree.',
    inputSchema: {
      type: 'object',
      properties: {
        source_id: { type: 'integer' },
        handle: { type: 'string' },
        url: { type: 'string' },
        post_id: { type: 'string' },
        type: {
          type: 'string',
          enum: ['all', 'post', 'comment'],
          default: 'all',
        },
        order: {
          type: 'string',
          enum: ['tree', 'new', 'old', 'score'],
          default: 'tree',
        },
        limit: { type: 'integer', default: 200, minimum: 1, maximum: 2000 },
        offset: { type: 'integer', default: 0, minimum: 0 },
        caption_chars: { type: 'integer', default: 1200, minimum: 0, maximum: 8000 },
        include_raw_meta: { type: 'boolean', default: false },
        include_media: {
          type: 'boolean',
          default: false,
          description: 'Include saved media URLs/local paths in each row.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'reddit_thread_tree',
    description:
      'Return a nested tree for one saved Reddit thread source. Use after ' +
      'reddit_thread_fetch or for any source whose meta kind is thread. ' +
      'The output is truncated by max_nodes to protect context.',
    inputSchema: {
      type: 'object',
      properties: {
        source_id: { type: 'integer' },
        handle: { type: 'string' },
        url: { type: 'string' },
        post_id: { type: 'string' },
        max_nodes: { type: 'integer', default: 500, minimum: 1, maximum: 3000 },
        caption_chars: { type: 'integer', default: 1200, minimum: 0, maximum: 8000 },
        include_media: {
          type: 'boolean',
          default: false,
          description: 'Include saved media URLs/local paths in tree nodes.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'reddit_media_fetch',
    description:
      'Download saved Reddit post images into LIB_ROOT/reddit-media/<post-id>/ and ' +
      'update item media_path/thumbnail_path. Search/thread fetches save image URLs ' +
      'but do not download binaries by default; call this when the discussion relies ' +
      'on screenshots, memes, charts, or image-only context.',
    inputSchema: {
      type: 'object',
      properties: {
        source_id: { type: 'integer' },
        handle: { type: 'string' },
        url: { type: 'string' },
        post_id: { type: 'string' },
        item_external_id: {
          type: 'string',
          description: 'Optional exact item external_id, e.g. post:abc123.',
        },
        limit: { type: 'integer', default: 50, minimum: 1, maximum: 500 },
        include_items: { type: 'boolean', default: true },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'reddit_job_status',
    description:
      'Get a Reddit job snapshot by live/DB job_id, or source state by source ' +
      'reference. Use after reddit_search or reddit_thread_fetch.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
        source_id: { type: 'integer' },
        handle: { type: 'string' },
        url: { type: 'string' },
        post_id: { type: 'string' },
      },
      additionalProperties: false,
    },
  },

  // ========== X / TWITTER ==========
  {
    name: 'twitter_search',
    description:
      'Search X/Twitter through the real logged-in browser session, scroll the ' +
      'search feed, save posts into library.db, and return compact text rows. ' +
      'Uses X query operators (from:, to:, since:, until:, min_faves:, ' +
      'filter:replies, filter:media). Images are not downloaded by default: ' +
      'rows expose has_media/media_count, then call twitter_media_fetch when ' +
      'visual context is needed.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Raw X search query, e.g. "AI orchestration".' },
        exact_phrase: { type: 'string', description: 'Optional exact phrase; wrapped in quotes.' },
        any_words: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: 'Optional OR group: ["agent", "orchestration"].',
        },
        exclude_words: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: 'Words to exclude; each becomes -word.',
        },
        from_user: { type: 'string', description: 'Only posts from @user.' },
        to_user: { type: 'string', description: 'Only replies to @user.' },
        mention_user: { type: 'string', description: 'Posts mentioning @user.' },
        since: { type: 'string', description: 'YYYY-MM-DD lower date bound.' },
        until: { type: 'string', description: 'YYYY-MM-DD upper date bound.' },
        lang: { type: 'string', description: 'Language operator, e.g. en, ru.' },
        min_likes: { type: 'integer', default: 0 },
        min_replies: { type: 'integer', default: 0 },
        min_retweets: { type: 'integer', default: 0 },
        only_replies: { type: 'boolean', default: false },
        exclude_replies: { type: 'boolean', default: false },
        only_links: { type: 'boolean', default: false },
        only_media: { type: 'boolean', default: false },
        only_images: { type: 'boolean', default: false },
        only_videos: { type: 'boolean', default: false },
        tab: { type: 'string', enum: ['latest', 'top', 'media'], default: 'latest' },
        limit: { type: 'integer', default: 50, minimum: 1, maximum: 500 },
        scroll_steps: { type: 'integer', minimum: 1, maximum: 250 },
        settle_ms: { type: 'integer', default: 250, minimum: 80, maximum: 2000 },
        download_media: {
          type: 'boolean',
          default: false,
          description: 'Download images now into LIB_ROOT/twitter-media. Default false.',
        },
        media_limit: { type: 'integer', default: 80, minimum: 1, maximum: 1000 },
        close_tab: { type: 'boolean', default: true },
        return_items: { type: 'boolean', default: true },
        caption_chars: { type: 'integer', default: 1200, minimum: 0, maximum: 8000 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'twitter_thread_fetch',
    description:
      'Fetch one X/Twitter status page through the real browser, scroll replies, ' +
      'and save a best-effort discussion tree. reply_depth=1 reads the post page; ' +
      'reply_depth=2/3 also opens reply pages to discover replies-to-replies. ' +
      'Images are recorded as URLs and can be downloaded with twitter_media_fetch.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'x.com/twitter.com/<user>/status/<id> URL.' },
        max_items: { type: 'integer', default: 200, minimum: 1, maximum: 2000 },
        reply_depth: { type: 'integer', default: 1, minimum: 1, maximum: 3 },
        branch_limit: {
          type: 'integer',
          default: 25,
          minimum: 1,
          maximum: 100,
          description: 'How many visible replies to recursively open per depth.',
        },
        scroll_steps: { type: 'integer', minimum: 1, maximum: 220 },
        settle_ms: { type: 'integer', default: 300, minimum: 100, maximum: 2500 },
        download_media: { type: 'boolean', default: false },
        media_limit: { type: 'integer', default: 80, minimum: 1, maximum: 1000 },
        close_tab: { type: 'boolean', default: true },
        return_items: { type: 'boolean', default: true },
        caption_chars: { type: 'integer', default: 1200, minimum: 0, maximum: 8000 },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'twitter_list_sources',
    description:
      'List saved X/Twitter sources. kind=search are search feeds, kind=thread ' +
      'are fetched post/reply discussions.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['all', 'search', 'thread'], default: 'all' },
        limit: { type: 'integer', default: 100, minimum: 1, maximum: 1000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'twitter_source_state',
    description:
      'Return saved X/Twitter source metadata and counts. Resolve by source_id, ' +
      'handle, status URL, or status_id.',
    inputSchema: {
      type: 'object',
      properties: {
        source_id: { type: 'integer' },
        handle: { type: 'string' },
        url: { type: 'string' },
        status_id: { type: 'string' },
        jobs_limit: { type: 'integer', default: 10, minimum: 0, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'twitter_source_items',
    description:
      'Read saved X/Twitter rows. Default output is text-only with has_media and ' +
      'media_count; pass include_media=true for local image paths/asset URLs if already downloaded.',
    inputSchema: {
      type: 'object',
      properties: {
        source_id: { type: 'integer' },
        handle: { type: 'string' },
        url: { type: 'string' },
        status_id: { type: 'string' },
        type: { type: 'string', enum: ['all', 'post', 'comment'], default: 'all' },
        order: { type: 'string', enum: ['tree', 'new', 'old', 'likes', 'replies'], default: 'tree' },
        limit: { type: 'integer', default: 200, minimum: 1, maximum: 2000 },
        offset: { type: 'integer', default: 0, minimum: 0 },
        caption_chars: { type: 'integer', default: 1200, minimum: 0, maximum: 8000 },
        include_media: { type: 'boolean', default: false },
        include_raw_meta: { type: 'boolean', default: false },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'twitter_thread_tree',
    description:
      'Return a nested best-effort tree for one saved X/Twitter thread source. ' +
      'X DOM does not expose every hidden/ranked reply; tree reflects what was fetched.',
    inputSchema: {
      type: 'object',
      properties: {
        source_id: { type: 'integer' },
        handle: { type: 'string' },
        url: { type: 'string' },
        status_id: { type: 'string' },
        max_nodes: { type: 'integer', default: 500, minimum: 1, maximum: 3000 },
        caption_chars: { type: 'integer', default: 1200, minimum: 0, maximum: 8000 },
        include_media: { type: 'boolean', default: false },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'twitter_media_fetch',
    description:
      'Download images for saved X/Twitter items on demand into ' +
      'LIB_ROOT/twitter-media/<tweet-id>/. Use when text says the post relies on ' +
      'a screenshot/image/chart. Does not run by default in search/thread tools.',
    inputSchema: {
      type: 'object',
      properties: {
        source_id: { type: 'integer' },
        handle: { type: 'string' },
        url: { type: 'string' },
        status_id: { type: 'string' },
        item_status_id: { type: 'string', description: 'Specific tweet/status id inside the source.' },
        limit: { type: 'integer', default: 50, minimum: 1, maximum: 500 },
        include_items: { type: 'boolean', default: true },
      },
      additionalProperties: false,
    },
  },

  // ========== GT EDITOR (markdown notes) ==========
  {
    name: 'gt_list_indexed_folders',
    description:
      'List directories that have been indexed by gt-editor for semantic ' +
      'search. Returns root path, file count, chunk count, and last-indexed ' +
      'timestamp for each. Use this to discover what corpora are available ' +
      'before calling gt_search with a scoping root.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'gt_search',
    description:
      'Vector search across indexed markdown notes. Returns top-N paragraph ' +
      'chunks ranked by Gemini-embedding cosine similarity, grouped by file. ' +
      'Each chunk carries chunk_id, note_id, path, line_start/end, snippet ' +
      'text, and cosine score. Notes use paragraph-level chunks (\\n\\n split) ' +
      'with filename + date as context. Cosine bands for these embeddings: ' +
      '>= 0.75 very strong, 0.65-0.75 strong, 0.55-0.65 medium, < 0.55 noise. ' +
      'Note pruning is at min_cos=0.40 by default to surface borderline hits.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Free-form natural-language query. Paragraphs out-perform keywords.',
        },
        root: {
          type: 'string',
          description:
            'Optional absolute path to scope search to one indexed folder. ' +
            'Omit to search across ALL indexed folders.',
        },
        limit: {
          type: 'integer', default: 20, minimum: 1, maximum: 100,
          description: 'Max chunks to return after cos filter. Default 20.',
        },
        min_cos: {
          type: 'number', default: 0.40, minimum: 0, maximum: 1,
          description:
            'Drop chunks below this cosine. Raise to 0.55+ to keep only ' +
            'confident hits. Default 0.40 (broad recall).',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'gt_note_chunks',
    description:
      'Return ALL paragraph-chunks of one note, in original document order. ' +
      'Use after a gt_search hit to read the surrounding paragraphs in the ' +
      'same file. Cheaper than gt_note_content for big files. Identify the ' +
      'note by either note_id (from gt_search) or absolute path.',
    inputSchema: {
      type: 'object',
      properties: {
        note_id: { type: 'integer', description: 'Numeric note_id from gt_search result.' },
        path: { type: 'string', description: 'Absolute file path. Used if note_id is omitted.' },
        offset: { type: 'integer', default: 0, minimum: 0, description: 'Pagination offset.' },
        limit:  { type: 'integer', default: 200, minimum: 1, maximum: 1000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gt_note_content',
    description:
      'Return the FULL raw markdown content of one note (read from disk). ' +
      'Use when you need the verbatim file — frontmatter, formatting, all ' +
      'paragraphs. Heavier than gt_note_chunks; prefer chunks when chunks ' +
      'are enough.',
    inputSchema: {
      type: 'object',
      properties: {
        note_id: { type: 'integer' },
        path: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gt_neighbors',
    description:
      'Fetch chunks at ±N positions around a given chunk inside the same ' +
      'note, ordered by paragraph index. This is the file-local analog of ' +
      'telegram_neighbors — gives you adjacent paragraphs to reconstruct ' +
      'context around a search hit. Use before=2..5 / after=2..5 usually.',
    inputSchema: {
      type: 'object',
      properties: {
        chunk_id: { type: 'integer', description: 'chunk_id from gt_search result.' },
        before:   { type: 'integer', default: 3, minimum: 0, maximum: 30 },
        after:    { type: 'integer', default: 3, minimum: 0, maximum: 30 },
      },
      required: ['chunk_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'gt_list_background_palette',
    description:
      'List GT Editor background colors. These are editor metadata, not ' +
      'markdown text. Use returned ids with gt_set_line_backgrounds or ' +
      'gt_set_text_backgrounds; do not try to run this as a shell command.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'gt_get_line_backgrounds',
    description:
      'Read saved GT Editor background metadata for one file. Returns ' +
      'backgrounds as { lineNumber: backgroundId } plus ranges for exact text ' +
      'backgrounds. Does not read or edit markdown text.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'gt_set_line_backgrounds',
    description:
      'Set or clear GT Editor per-line backgrounds for specific lines/ranges. ' +
      'Use bg_id from gt_list_background_palette; use empty string, "clear", ' +
      '"none", or null to clear. Writes GT Editor metadata, not markdown text, ' +
      'then notifies open GT Editor windows to refresh.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path.' },
        bg_id: {
          type: 'string',
          description: 'Background id from gt_list_background_palette, or empty string/clear/none to clear.',
        },
        lines: {
          type: 'array',
          description: 'Individual 1-based line numbers to change.',
          items: { type: 'integer', minimum: 1 },
        },
        ranges: {
          type: 'array',
          description: '1-based inclusive line ranges to change.',
          items: {
            type: 'object',
            properties: {
              from: { type: 'integer', minimum: 1, description: 'First line, inclusive.' },
              to: { type: 'integer', minimum: 1, description: 'Last line, inclusive. Defaults to from.' },
            },
            required: ['from'],
            additionalProperties: false,
          },
        },
        line: { type: 'integer', minimum: 1, description: 'Convenience single line.' },
        from: { type: 'integer', minimum: 1, description: 'Convenience range start.' },
        to: { type: 'integer', minimum: 1, description: 'Convenience range end.' },
      },
      required: ['path', 'bg_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'gt_set_text_backgrounds',
    description:
      'Set or clear GT Editor background metadata for exact text ranges. ' +
      'Use bg_id from gt_list_background_palette; use empty string, "clear", ' +
      '"none", or null to clear. Lines are 1-based; ch offsets are 0-based ' +
      'character offsets from the start of that line. Writes GT Editor metadata, ' +
      'not markdown text, then notifies open GT Editor windows to refresh.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path.' },
        bg_id: {
          type: 'string',
          description: 'Background id from gt_list_background_palette, or empty string/clear/none to clear.',
        },
        ranges: {
          type: 'array',
          description:
            'Half-open text ranges. Preferred shape: {from_line, from_ch, to_line, to_ch}. ' +
            'Also accepts {from:{line,ch}, to:{line,ch}}.',
          items: {
            type: 'object',
            properties: {
              from_line: { type: 'integer', minimum: 1 },
              from_ch: { type: 'integer', minimum: 0 },
              to_line: { type: 'integer', minimum: 1 },
              to_ch: { type: 'integer', minimum: 0 },
              fromLine: { type: 'integer', minimum: 1 },
              fromCh: { type: 'integer', minimum: 0 },
              toLine: { type: 'integer', minimum: 1 },
              toCh: { type: 'integer', minimum: 0 },
              from_col: { type: 'integer', minimum: 1, description: '1-based display column; converted to ch=col-1.' },
              to_col: { type: 'integer', minimum: 1, description: '1-based display column; converted to ch=col-1.' },
              from: {
                type: 'object',
                properties: {
                  line: { type: 'integer', minimum: 1 },
                  ch: { type: 'integer', minimum: 0 },
                  col: { type: 'integer', minimum: 1 },
                },
                additionalProperties: false,
              },
              to: {
                type: 'object',
                properties: {
                  line: { type: 'integer', minimum: 1 },
                  ch: { type: 'integer', minimum: 0 },
                  col: { type: 'integer', minimum: 1 },
                },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
        },
        from_line: { type: 'integer', minimum: 1, description: 'Convenience single range start line.' },
        from_ch: { type: 'integer', minimum: 0, description: 'Convenience single range start ch.' },
        to_line: { type: 'integer', minimum: 1, description: 'Convenience single range end line.' },
        to_ch: { type: 'integer', minimum: 0, description: 'Convenience single range end ch.' },
      },
      required: ['path', 'bg_id'],
      additionalProperties: false,
    },
  },
]

const server = new Server(
  { name: 'sc-desktop', version: '0.2.0' },
  { capabilities: { tools: {} } },
)

TOOLS.push(...telegramArchiveMediaTools)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params
  try {
    if (telegramArchiveMediaTools.some(tool => tool.name === name)) return await callTelegramArchiveMediaTool(name, args)
    if (botOperations[name]) return await callTelegramBotTool(name, args, telegramLiveClient())
    if (telegramFolderTools.some(tool => tool.name === name)) return await callTelegramFolderTool(name, args, telegramLiveClient())
    if (boostyRagOperations[name]) return await callBoostyRagTool(name, args)
    if (boostyCatalogOperations[name]) return await callBoostyCatalogTool(name, args)
    if (boostyWorkflowOperations[name]) return await callBoostyWorkflowTool(name, args)
    if (yougileToolBridge?.has(name)) {
      return await yougileToolBridge.call(name, args)
    }
    if (name === 'list_telegram_chats') {
      return { content: [{ type: 'text', text: JSON.stringify(listChats(), null, 2) }] }
    }
    if (name === 'telegram_semantic_search') {
      if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('query is required')
      const out = await searchChat(args)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'telegram_message_read' || name === 'telegram_context') {
      try {
        const readers = createTelegramRagReaders(db.getDb())
        const out = name === 'telegram_message_read' ? readers.readItem(args) : readers.context(args)
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
      } catch (error) { return ragErrorResult(error) }
    }
    if (name === 'telegram_neighbors') {
      const { item_id, before = 5, after = 5 } = args
      if (!item_id) throw new Error('item_id is required')
      return {
        content: [{ type: 'text', text: JSON.stringify(createTelegramRagReaders(db.getDb()).neighbors(args), null, 2) }],
      }
    }
    if (name === 'telegram_reply_thread') {
      const { item_id, max_depth = 10, max_descendants = 100 } = args
      if (!item_id) throw new Error('item_id is required')
      return {
        content: [{ type: 'text', text: JSON.stringify(createTelegramRagReaders(db.getDb()).replyThread(args), null, 2) }],
      }
    }
    if (name === 'telegram_get_by_external_id') {
      const { chat, external_id } = args
      if (chat == null || chat === '') throw new Error('chat is required')
      return {
        content: [{ type: 'text', text: JSON.stringify(getByExternalId(chat, external_id, args), null, 2) }],
      }
    }
    if (name === 'telegram_list_sources') {
      const { indexed_only = false, explicit_only = false, limit = 200 } = args
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(listTelegramSources({ indexed_only, explicit_only, limit }), null, 2),
        }],
      }
    }
    if (name === 'telegram_source_state') {
      const source = resolveSourceOrThrow(args)
      const { jobs_limit = 10 } = args
      return {
        content: [{ type: 'text', text: JSON.stringify(sourceState(source.id, jobs_limit, args), null, 2) }],
      }
    }
    if (name === 'telegram_list_folders') {
      const out = await listTelegramFoldersTool(args)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'telegram_refresh_folders') {
      const out = await telegramRefreshFoldersTool(args)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'telegram_folder_state') {
      const out = await telegramFolderStateTool(args)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'telegram_search_chats') {
      const out = await telegramSearchChatsTool(args)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'telegram_resolve_chat') {
      const { text } = args
      if (!text || !String(text).trim()) throw new Error('text is required')
      const session = await resolveTelegramSessionName(args)
      const out = await resolveTelegramChat(text, {
        session,
        fuzzy: args.fuzzy !== false,
        limit: coercePositiveInt(args.limit, 50),
      })
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'telegram_search_public_chats') {
      const request = await buildTelegramPublicSearchRequest(args)
      const out = await telegramLiveClient().start(request, args.wait_ms ?? 30000)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'telegram_join_chat' || name === 'telegram_leave_chat') {
      if (args.confirm !== true) throw new Error(`${name} requires confirm=true`)
      const operation = name === 'telegram_join_chat' ? 'join' : 'leave'
      const request = await buildTelegramMembershipRequest(args, operation)
      const out = await telegramLiveClient().start(request, args.wait_ms ?? 30000)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'telegram_live_search') {
      const request = await buildTelegramLiveSearchRequest(args)
      const out = await telegramLiveClient().start(request, args.wait_ms ?? 15000)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'telegram_live_search_batch') {
      const request = await buildTelegramLiveSearchRequest(args, { batch: true })
      const out = await telegramLiveClient().start(request, args.wait_ms ?? 20000)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'telegram_live_context') {
      const request = await buildTelegramLiveContextRequest(args)
      const out = await telegramLiveClient().start(request, args.wait_ms ?? 20000)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'telegram_live_range') {
      const request = await buildTelegramLiveRangeRequest(args)
      const out = await telegramLiveClient().start(request, args.wait_ms ?? 20000)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'telegram_live_attachment') {
      const out = args.job_id
        ? await telegramLiveClient().status(args.job_id, args.wait_ms ?? 30000)
        : await telegramLiveClient().start(
            await buildTelegramLiveAttachmentRequest(args),
            args.wait_ms ?? 30000,
          )
      return telegramLiveAttachmentToolResult(out)
    }
    if (name === 'telegram_live_transcribe') {
      const out = args.job_id
        ? await telegramLiveClient().status(args.job_id, args.wait_ms ?? 30000)
        : await telegramLiveClient().start(
            await buildTelegramLiveTranscriptionRequest(args),
            args.wait_ms ?? 30000,
          )
      return telegramLiveTranscriptionToolResult(out)
    }
    if (name === 'telegram_live_save') {
      const resolved = liveChatTarget(args.chat)
      const session = await liveSessionForArgs(args, [resolved])
      const out = await telegramLiveClient().save({
        chat: resolved.target,
        message_ids: args.message_ids,
        session,
        process_voice: args.process_voice === true,
        process_photo: args.process_photo === true,
        process_docs: args.process_docs === true,
        process_polls: args.process_polls !== false,
        transcribe_engine: args.transcribe_engine,
        transcribe_lang: args.transcribe_lang,
      }, args.wait_ms || 0)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'telegram_preview_fetch') {
      const params = await buildTelegramJobParams(args, { preview: true })
      const id = jobRunner().startTelegramPreview(params)
      return { content: [{ type: 'text', text: JSON.stringify(jobStartResult(id), null, 2) }] }
    }
    if (name === 'telegram_fetch') {
      const params = await buildTelegramJobParams(args)
      const out = await telegramRagClient().startFetch(params)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'telegram_comments_catchup') {
      const out = startCommentsCatchup(args)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'telegram_index') {
      const source = resolveSourceOrThrow(args)
      if (args.limit != null && (typeof args.limit !== 'number' || !Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 200000)) {
        throw Object.assign(new Error('Explicit index limit must be an integer from 1 to 200000; omit it for full index'), { code: 'INVALID_INDEX_LIMIT' })
      }
      const limit = coercePositiveInt(args.limit, null)
      const out = await telegramRagClient().startIndex({ source_id: source.id, limit, item_ids: args.item_ids })
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'telegram_index_status') {
      const source = resolveSourceOrThrow(args)
      const out = { source: sourceRef(source), ...(await telegramRagClient().indexStatus({ source_id: source.id })) }
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'telegram_list_jobs') {
      const out = listTelegramJobs(args)
      try {
        const indices = await telegramRagClient().listIndices({ source_id: out.source?.source_id })
        out.live.push(...indices.jobs)
      } catch (error) {
        out.application_index_status = { available: false, error: error.message }
      }
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'telegram_job_status') {
      const out = typeof args.job_id === 'string' && args.job_id.startsWith('desktop:')
        ? await telegramLiveClient().status(args.job_id, 0)
        : typeof args.job_id === 'string' && args.job_id.startsWith('fetch:')
          ? await telegramRagClient().fetchStatus({ request_id: args.job_id.slice(6) })
        : typeof args.job_id === 'string' && args.job_id.startsWith('index-')
          ? await telegramRagClient().indexStatus({ id: args.job_id, source_id: args.source_id })
          : args.job_id == null && (args.source_id != null || args.chat != null)
            ? await telegramRagClient().indexStatus({ source_id: resolveSourceOrThrow(args).id })
          : telegramJobStatus(args)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'telegram_cancel_job') {
      const { job_id } = args
      if (job_id == null || job_id === '') throw new Error('job_id is required')
      if (typeof job_id === 'string' && job_id.startsWith('desktop:')) {
        const out = await telegramLiveClient().cancel(job_id)
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
      }
      if (typeof job_id === 'string' && job_id.startsWith('index-')) {
        const out = await telegramRagClient().cancelIndex({ job_id })
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
      }
      if (typeof job_id === 'string' && job_id.startsWith('fetch:')) {
        const out = await telegramRagClient().cancelFetch({ request_id: job_id.slice(6) })
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
      }
      const ok = jobRunner().cancelJob(job_id)
      return { content: [{ type: 'text', text: JSON.stringify({ ok, job_id }, null, 2) }] }
    }
    if (name === 'telegram_get_comments') {
      const source = resolveSourceOrThrow(args)
      const out = getStoredTelegramComments({
        source,
        post_external_id: args.post_external_id,
        limit: coercePositiveInt(args.limit, 200),
      })
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'telegram_list_sessions') {
      const out = await listTelegramSessions()
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'telegram_account_login_command') {
      return { content: [{ type: 'text', text: JSON.stringify(telegramLoginCommand(args), null, 2) }] }
    }
    if (name === 'telegram_resolve_account') {
      const out = selectTelegramAccount(await listTelegramSessions(), args)
      if (['missing', 'unauthorized'].includes(out.state)) out.login = telegramLoginCommand({ label: args.name, expected_account_id: args.account_id || out.account_id || undefined })
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'telegram_send_saved_message') {
      const out = await telegramSendSavedMessageTool(args)
      return { ...(out.ok === false ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (Object.hasOwn(telegramTextOperations, name)) {
      return await callTelegramTextTool(name, args, request => jobRunner().runTelegramTextCommand(request))
    }

    // ===== YouTube channel RAG + search + subtitle tools =====
    if (name === 'youtube_list_channels') {
      const out = listYoutubeChannelsTool(args)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'youtube_channel_index') {
      const out = await youtubeChannelIndexTool(args)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'youtube_channel_index_status') {
      const out = await youtubeChannelIndexStatusTool(args)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'youtube_channel_semantic_search') {
      const out = await youtubeChannelSemanticSearchTool(args)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'youtube_channel_context') {
      const out = youtubeChannelContextTool(args)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'youtube_search') {
      const out = await youtubeSubtitlesClient().search(args)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'youtube_get_subtitles') {
      const out = await youtubeSubtitlesClient().start(args)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'youtube_subtitles_status') {
      const out = await youtubeSubtitlesClient().status(args)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'youtube_subtitles_cancel') {
      const out = await youtubeSubtitlesClient().cancel(args)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }

    // ===== Reddit tools =====
    if (name === 'reddit_search') {
      const out = await startRedditSearchTool(args)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'reddit_thread_fetch') {
      const out = await startRedditThreadTool(args)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'reddit_list_sources') {
      const out = listRedditSources({
        kind: args.kind || 'all',
        limit: coercePositiveInt(args.limit, 100),
      })
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'reddit_source_state') {
      const source = resolveRedditSourceOrThrow(args)
      const out = redditSourceState(source.id, coercePositiveInt(args.jobs_limit, 10))
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'reddit_source_items') {
      const source = resolveRedditSourceOrThrow(args)
      const out = redditSourceItems(source, args)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'reddit_thread_tree') {
      const source = resolveRedditSourceOrThrow(args)
      const out = redditThreadTree(source, args)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'reddit_media_fetch') {
      const out = await redditMediaFetch(args)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'reddit_job_status') {
      const out = redditJobStatus(args)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }

    // ===== X/Twitter tools =====
    if (name === 'twitter_search') {
      const out = await startTwitterSearchTool(args)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'twitter_thread_fetch') {
      const out = await startTwitterThreadTool(args)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'twitter_list_sources') {
      const out = listTwitterSources({
        kind: args.kind || 'all',
        limit: coercePositiveInt(args.limit, 100),
      })
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'twitter_source_state') {
      const source = resolveTwitterSourceOrThrow(args)
      const out = twitterSourceState(source.id, coercePositiveInt(args.jobs_limit, 10))
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'twitter_source_items') {
      const source = resolveTwitterSourceOrThrow(args)
      const out = twitterSourceItems(source, args)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'twitter_thread_tree') {
      const source = resolveTwitterSourceOrThrow(args)
      const out = twitterThreadTree(source, args)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'twitter_media_fetch') {
      const out = await twitterMediaFetch(args)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }

    // ===== gt-editor tools =====
    if (name === 'gt_list_indexed_folders') {
      return { content: [{ type: 'text', text: JSON.stringify(gtListFolders(), null, 2) }] }
    }
    if (name === 'gt_search') {
      const { query, root = null, limit = 20, min_cos = 0.40 } = args
      if (!query || !query.trim()) throw new Error('query is required')
      const out = await gtSearch({ query, root, limit, min_cos })
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'gt_note_chunks') {
      const { note_id, path: filePath, offset = 0, limit = 200 } = args
      return { content: [{ type: 'text', text: JSON.stringify(gtNoteChunks({ note_id, path: filePath, offset, limit }), null, 2) }] }
    }
    if (name === 'gt_note_content') {
      const { note_id, path: filePath } = args
      return { content: [{ type: 'text', text: JSON.stringify(gtNoteContent({ note_id, path: filePath }), null, 2) }] }
    }
    if (name === 'gt_neighbors') {
      const { chunk_id, before = 3, after = 3 } = args
      if (!chunk_id) throw new Error('chunk_id is required')
      return { content: [{ type: 'text', text: JSON.stringify(gtNeighbors(chunk_id, before, after), null, 2) }] }
    }
    if (name === 'gt_list_background_palette') {
      return { content: [{ type: 'text', text: JSON.stringify(gtListBackgroundPalette(), null, 2) }] }
    }
    if (name === 'gt_get_line_backgrounds') {
      const { path: filePath } = args
      if (!filePath || typeof filePath !== 'string') throw new Error('path is required')
      return { content: [{ type: 'text', text: JSON.stringify(gtGetLineBackgrounds(filePath), null, 2) }] }
    }
    if (name === 'gt_set_line_backgrounds') {
      const out = gtSetLineBackgrounds(args)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    if (name === 'gt_set_text_backgrounds') {
      const out = gtSetTextBackgrounds(args)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }

    throw new Error(`unknown tool: ${name}`)
  } catch (err) {
    if (name.startsWith('telegram_') && err?.code) return ragErrorResult(err)
    return {
      isError: true,
      content: [{ type: 'text', text: `Error: ${err && err.message || err}` }],
    }
  }
})

function listChats() {
  const rows = db.listSources('telegram')
  return rows.filter(r => r.semantic_indexed_count > 0)
    .sort((a, b) => b.semantic_indexed_count - a.semantic_indexed_count).map(r => ({
    source_id: r.id,
    handle: r.handle,
    title: r.display_name || r.handle,
    indexed: r.semantic_indexed_count,
    indexed_current: r.semantic_current_count,
    indexed_legacy_unverified: r.semantic_legacy_count,
    stale: r.semantic_stale_count,
    total: r.items_count,
    indexable: r.semantic_indexable_count,
  }))
}

function youtubeUrlAt(rawUrl, seconds) {
  const value = String(rawUrl || '')
  const offset = Math.max(0, Math.round(Number(seconds) || 0))
  if (!value || !offset) return value || null
  try {
    const url = new URL(value)
    url.searchParams.set('t', `${offset}s`)
    return url.toString()
  } catch {
    return value
  }
}

function youtubeSourceSummary(row) {
  const meta = parseMaybeJson(row.meta_json, {}) || {}
  const saved = Number(row.items_total || 0)
  const total = meta.catalog_total == null ? null : Number(meta.catalog_total)
  const complete = meta.catalog_complete === true
  const transcripts = Number(row.transcribed_videos || 0)
  const fragmentsTotal = Number(row.fragments_total || 0)
  const fragmentsIndexed = Number(row.fragments_indexed || 0)
  const videosIndexed = Number(row.videos_indexed || 0)
  const indexComplete = fragmentsTotal > 0 && fragmentsIndexed >= fragmentsTotal
  const transcriptCoverageComplete = complete && saved > 0 && transcripts >= saved
  return {
    source_id: Number(row.id),
    handle: row.handle,
    title: row.display_name || row.handle,
    channel_id: row.external_id || null,
    catalog: {
      saved,
      total,
      complete,
      remaining: total == null ? null : Math.max(0, total - saved),
      updated_at: meta.catalog_updated_at || row.last_synced_at || null,
    },
    transcripts: {
      videos: transcripts,
      missing: Math.max(0, saved - transcripts),
      channel_coverage_complete: transcriptCoverageComplete,
    },
    rag: {
      fragments_indexed: fragmentsIndexed,
      fragments_total: fragmentsTotal,
      videos_indexed: videosIndexed,
      index_complete_for_transcripts: indexComplete,
      channel_coverage_complete: transcriptCoverageComplete && indexComplete,
    },
  }
}

function youtubeSourceRows() {
  return require('./youtube-source-inventory').youtubeSourceRows(db.getDb())
}

function resolveYoutubeSourceTool(args = {}) {
  const sourceId = Number(args.source_id)
  const rows = youtubeSourceRows()
  if (Number.isSafeInteger(sourceId) && sourceId > 0) {
    const row = rows.find(candidate => Number(candidate.id) === sourceId)
    if (!row) throw new Error(`YouTube source #${sourceId} not found`)
    return row
  }
  const query = normaliseText(args.channel).replace(/^@/, '')
  if (!query) throw new Error('source_id or channel is required')
  const exact = rows.filter(row => [row.handle, row.display_name, row.external_id]
    .some(value => normaliseText(value).replace(/^@/, '') === query))
  const matches = exact.length ? exact : rows.filter(row => [row.handle, row.display_name, row.external_id]
    .some(value => normaliseText(value).replace(/^@/, '').includes(query)))
  if (!matches.length) throw new Error(`YouTube channel not found in Library: ${args.channel}`)
  if (matches.length > 1) {
    const candidates = matches.slice(0, 10).map(row => ({
      source_id: row.id,
      handle: row.handle,
      title: row.display_name || row.handle,
    }))
    throw new Error(`YouTube channel is ambiguous; pass source_id. Candidates: ${JSON.stringify(candidates)}`)
  }
  return matches[0]
}

function listYoutubeChannelsTool(args = {}) {
  const query = normaliseText(args.query).replace(/^@/, '')
  const limit = Math.min(500, coercePositiveInt(args.limit, 100))
  const rows = youtubeSourceRows()
    .filter(row => !query || [row.handle, row.display_name, row.external_id]
      .some(value => normaliseText(value).replace(/^@/, '').includes(query)))
    .filter(row => args.indexed_only !== true || Number(row.fragments_indexed || 0) > 0)
  const channels = rows.slice(0, limit).map(youtubeSourceSummary)
  return {
    returned: channels.length,
    total_matching: rows.length,
    complete: channels.length === rows.length,
    filters: { query: args.query || null, indexed_only: args.indexed_only === true },
    channels,
  }
}

async function youtubeChannelIndexTool(args = {}) {
  const source = resolveYoutubeSourceTool(args)
  const result = await indexJob().start({
    sourceId: source.id,
    limit: args.limit || null,
    origin: 'mcp',
    mode: 'youtube',
  })
  if (result && typeof result === 'object' && result.noop) {
    return {
      ok: true,
      noop: true,
      reason: result.reason,
      source: youtubeSourceSummary(source),
      index: await indexJob().statusForSource(source.id, 'youtube'),
    }
  }
  return {
    ok: true,
    job_id: result,
    source: youtubeSourceSummary(source),
    next: 'Poll youtube_channel_index_status for coverage or telegram_job_status with this job_id.',
  }
}

async function youtubeChannelIndexStatusTool(args = {}) {
  const source = resolveYoutubeSourceTool(args)
  return {
    source: youtubeSourceSummary(source),
    index: await indexJob().statusForSource(source.id, 'youtube'),
  }
}

async function youtubeChannelSemanticSearchTool(args = {}) {
  const source = resolveYoutubeSourceTool(args)
  const query = String(args.query || '').trim()
  if (!query) throw new Error('query is required')
  const limit = Math.min(100, coercePositiveInt(args.limit, 20))
  const minCos = Number.isFinite(Number(args.min_cos)) ? Number(args.min_cos) : 0.5
  const embedding = await embedQuery(query)
  const rows = db.semanticChunkSearch({
    query_embedding: embedding,
    source_id: source.id,
    limit: Math.min(200, limit * 2),
  })
  const results = rows
    .filter(row => Number(row._cos || 0) >= minCos)
    .slice(0, limit)
    .map(row => ({
      chunk_id: Number(row.id),
      item_id: Number(row.item_id),
      chunk_index: Number(row.chunk_index),
      score: Number(Number(row._cos || 0).toFixed(3)),
      video_id: row.external_id,
      title: row.title,
      url: row.url,
      url_at_position: youtubeUrlAt(row.url, row.start_seconds),
      position: {
        start_seconds: row.start_seconds,
        end_seconds: row.end_seconds,
        approximate: !!row.position_approximate,
      },
      text: row.text,
    }))
  const status = db.semanticChunkIndexStatus(source.id)
  const sourceSummary = youtubeSourceSummary(source)
  const indexComplete = status.total > 0 && status.done >= status.total
  const channelCoverageComplete = sourceSummary.transcripts.channel_coverage_complete && indexComplete
  return {
    source: sourceSummary,
    query,
    threshold: minCos,
    returned: results.length,
    index: status,
    index_complete_for_transcripts: indexComplete,
    channel_coverage_complete: channelCoverageComplete,
    results,
    next: results.length
      ? 'Call youtube_channel_context with item_id and chunk_index for the hits used in the answer.'
      : 'Lower min_cos, broaden the query, or run youtube_channel_index if index coverage is incomplete.',
  }
}

function youtubeChannelContextTool(args = {}) {
  const rows = db.semanticChunkContext({
    item_id: args.item_id,
    chunk_index: args.chunk_index,
    before: Math.min(10, Math.max(0, Number(args.before ?? 2))),
    after: Math.min(10, Math.max(0, Number(args.after ?? 2))),
  })
  if (!rows.length) return { error: 'chunk_not_found', results: [] }
  const first = rows[0]
  return {
    video: {
      item_id: Number(first.item_id),
      video_id: first.external_id,
      title: first.title,
      channel: first.source_title || first.source_handle,
      url: first.url,
    },
    center_chunk_index: Number(args.chunk_index),
    returned: rows.length,
    results: rows.map(row => ({
      chunk_id: Number(row.id),
      chunk_index: Number(row.chunk_index),
      url_at_position: youtubeUrlAt(row.url, row.start_seconds),
      start_seconds: row.start_seconds,
      end_seconds: row.end_seconds,
      position_approximate: !!row.position_approximate,
      text: row.text,
    })),
  }
}

function coercePositiveInt(value, fallback) {
  if (value == null || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function parseMaybeJson(raw, fallback = null) {
  if (raw == null || raw === '') return fallback
  if (typeof raw !== 'string') return raw
  try { return JSON.parse(raw) } catch { return fallback }
}

function normaliseText(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .trim()
    .toLowerCase()
}

function sourceRef(source) {
  if (!source) return null
  return {
    source_id: source.id,
    handle: source.handle,
    title: source.display_name || source.handle,
    external_id: source.external_id || null,
  }
}

function resolveSourceOrThrow(args = {}) {
  const handle = db.getDb()
  let row = null
  if (args.source_id != null && args.source_id !== '') {
    row = handle.prepare(`
      SELECT * FROM sources WHERE platform = 'telegram' AND id = ?
    `).get(Number(args.source_id))
  }
  if (!row) {
    const chat = args.chat != null ? args.chat : args.target
    if (chat != null && chat !== '') {
      const resolved = resolveChat(chat)
      if (resolved.source) {
        row = handle.prepare(`
          SELECT * FROM sources WHERE platform = 'telegram' AND id = ?
        `).get(resolved.source.id)
      }
    }
  }
  if (!row) {
    throw new Error('Telegram source not found. Pass source_id from telegram_list_sources/list_telegram_chats, a known handle/title, or fetch the chat first.')
  }
  return row
}

function sourceSummary(row, { includeBreakdown = true, indexStatus = null } = {}) {
  const sourceId = Number(row.id)
  const itemsTotal = row.items_total != null
    ? Number(row.items_total)
    : (db.getDb().prepare('SELECT COUNT(*) AS n FROM items WHERE source_id = ?').get(sourceId)?.n || 0)
  const index = indexStatus || require('../electron/telegram-rag-index').telegramFragmentIndexStatus(db, sourceId)
  const indexed = index.searchable_messages
  const commentsTotal = row.comments_total != null ? Number(row.comments_total) : db.countCommentsBySource(sourceId)
  const range = (row.min_at != null || row.max_at != null)
    ? { min_at: row.min_at || null, max_at: row.max_at || null }
    : db.itemsDateRange(sourceId)
  const maxExternalId = row.max_external_id != null
    ? Number(row.max_external_id)
    : db.maxExternalId(sourceId)
  const out = {
    source_id: sourceId,
    handle: row.handle,
    title: row.display_name || row.handle,
    external_id: row.external_id || null,
    items_total: itemsTotal,
    items_indexed: indexed,
    items_indexable: index.messages_total,
    items_indexed_current: index.messages_complete,
    items_indexed_legacy_unverified: index.legacy_only_messages,
    index_missing: Math.max(0, index.messages_total - indexed),
    comments_total: commentsTotal,
    date_range: range,
    max_external_id: maxExternalId || null,
    has_discussion: row.has_discussion == null ? null : !!row.has_discussion,
    tg_session: row.tg_session || null,
    tg_session_conflict: !!row.tg_session_conflict,
    is_explicit: row.is_explicit == null ? null : !!row.is_explicit,
    last_synced_at: row.last_synced_at || null,
  }
  if (includeBreakdown) {
    out.type_breakdown = db.itemTypeBreakdown(sourceId)
  }
  return out
}

function telegramSourceKind(meta) {
  return meta.kind || meta.entity_kind || meta.dialog_kind || null
}

function telegramSourceAuto(meta) {
  const raw = (meta.tg_auto && typeof meta.tg_auto === 'object') ? meta.tg_auto : {}
  return {
    pull: !!raw.pull || !!raw.index,
    index: !!raw.index,
    types: Array.isArray(raw.types) ? raw.types.map(String).filter(Boolean) : [],
    engine: raw.engine || null,
  }
}

function compactTelegramSource(row) {
  const meta = parseMaybeJson(row.meta_json, {}) || {}
  const sourceId = Number(row.id)
  const itemsTotal = Number(row.items_count ?? row.items_total ?? 0)
  const indexable = Number(row.semantic_indexable_count ?? 0)
  const indexed = Number(row.semantic_indexed_count ?? row.items_indexed ?? 0)
  return {
    source_id: sourceId,
    handle: row.handle,
    title: row.display_name || row.handle,
    external_id: row.external_id || null,
    username: meta.username || meta.user_name || null,
    kind: telegramSourceKind(meta),
    tg_session: row.tg_session || null,
    tg_session_conflict: !!row.tg_session_conflict,
    is_explicit: !!row.is_explicit,
    items_total: itemsTotal,
    items_indexable: indexable,
    items_indexed: indexed,
    items_indexed_current: Number(row.semantic_current_count || 0),
    items_indexed_legacy_unverified: Number(row.semantic_legacy_count || 0),
    stale_messages: Number(row.semantic_stale_count || 0),
    index_missing: Math.max(0, indexable - indexed),
    last_item_at: row.last_item_at || row.max_at || null,
    last_synced_at: row.last_synced_at || null,
    type_counts: {
      text: Number(row.text_n || 0),
      voice: Number(row.voice_n || 0),
      video: Number(row.video_n || 0),
      photo: Number(row.photo_n || 0),
      audio: Number(row.audio_n || 0),
      document: Number(row.document_n || 0),
    },
    auto: telegramSourceAuto(meta),
  }
}

function formatTelegramFolder(row) {
  return {
    folder_id: Number(row.id),
    filter_id: row.tg_filter_id == null ? null : Number(row.tg_filter_id),
    title: row.title || 'Без названия',
    tg_session: row.tg_session || null,
    default_period_days: row.default_period_days == null ? null : Number(row.default_period_days),
    default_types: parseMaybeJson(row.default_types_json, []),
    sources_count: Number(row.sources_count || 0),
    last_fetched_at: row.last_fetched_at || null,
    added_at: row.added_at || null,
    updated_at: row.updated_at || null,
  }
}

function telegramSessionMatches(row, session) {
  if (!session) return true
  return !row.tg_session || row.tg_session === session
}

async function telegramFolderScope(args = {}) {
  if (args.all_sessions === true) return { all_sessions: true, session: null }
  const hasOverride = args.session || args.profile || args.account || args.tg_session
  const session = hasOverride ? await resolveTelegramSessionName(args) : activeTelegramSessionName()
  return { all_sessions: false, session: session || null }
}

function folderRowsForScope(scope) {
  return db.listFolders(scope?.all_sessions ? null : scope?.session || null)
}

async function listTelegramFoldersTool(args = {}) {
  const scope = await telegramFolderScope(args)
  const query = normaliseText(args.query)
  const includeSources = args.include_sources === true
  const sourceLimit = Math.min(500, coercePositiveInt(args.source_limit, 50))
  const rows = folderRowsForScope(scope)
    .filter(row => !query || normaliseText(row.title).includes(query))
  const folders = rows.map(row => {
    const folder = formatTelegramFolder(row)
    if (includeSources) {
      const sources = db.listFolderSources(row.id)
        .filter(src => scope.all_sessions || telegramSessionMatches(src, scope.session))
      folder.sources = sources
        .slice(0, sourceLimit)
        .map(compactTelegramSource)
      folder.sources_returned = folder.sources.length
      folder.sources_total = sources.length
      folder.sources_truncated = Math.max(0, sources.length - folder.sources.length)
    }
    return folder
  })
  return {
    scope: {
      all_sessions: !!scope.all_sessions,
      tg_session: scope.session,
      active_session: activeTelegramSessionName(),
    },
    query: args.query || null,
    returned: folders.length,
    folders,
  }
}

async function telegramRefreshFoldersTool(args = {}) {
  const hasOverride = args.session || args.profile || args.account || args.tg_session
  const session = hasOverride ? await resolveTelegramSessionName(args) : activeTelegramSessionName()
  const id = jobRunner().startTelegramFolderRefresh(
    session ? { _tg_session_override: session } : {},
  )
  return {
    ok: true,
    job_id: id,
    tg_session: session || null,
    job: jobRunner().getJobDetail(id) || null,
    next: 'Poll telegram_job_status with this job_id, then call telegram_list_folders or telegram_folder_state.',
  }
}

function resolveTelegramFolderLocal(args = {}, scope = { all_sessions: true, session: null }) {
  const folderId = args.folder_id != null ? Number(args.folder_id) : null
  const filterId = args.filter_id != null ? Number(args.filter_id) : null
  const title = args.title != null ? args.title : args.name
  let rows = folderRowsForScope(scope)

  if (folderId != null && Number.isFinite(folderId)) {
    rows = rows.filter(row => Number(row.id) === folderId)
  }
  if (filterId != null && Number.isFinite(filterId)) {
    rows = rows.filter(row => Number(row.tg_filter_id) === filterId)
  }
  if (title != null && String(title).trim()) {
    const q = normaliseText(title)
    const exact = rows.filter(row => normaliseText(row.title) === q)
    rows = exact.length ? exact : rows.filter(row => normaliseText(row.title).includes(q))
  }
  rows = rows.filter(row => scope.all_sessions || telegramSessionMatches(row, scope.session))

  if (!rows.length) {
    return {
      error: 'folder_not_found',
      hint: 'Pass folder_id from telegram_list_folders, filter_id, or a title/name substring.',
      candidates: folderRowsForScope(scope).slice(0, 20).map(formatTelegramFolder),
    }
  }
  if (rows.length > 1 && folderId == null) {
    return {
      error: 'ambiguous_folder',
      hint: 'Pass folder_id to disambiguate. Telegram filter_id is only unique inside one session.',
      candidates: rows.slice(0, 20).map(formatTelegramFolder),
    }
  }
  return { folder: rows[0] }
}

async function telegramFolderStateTool(args = {}) {
  const scope = await telegramFolderScope(args)
  const resolved = resolveTelegramFolderLocal(args, scope)
  if (resolved.error) {
    return {
      scope: {
        all_sessions: !!scope.all_sessions,
        tg_session: scope.session,
        active_session: activeTelegramSessionName(),
      },
      ...resolved,
    }
  }
  const limit = Math.min(1000, coercePositiveInt(args.source_limit, 200))
  const offset = Math.max(0, Number(args.source_offset || 0))
  const rows = db.listFolderSources(resolved.folder.id)
    .filter(src => scope.all_sessions || telegramSessionMatches(src, scope.session))
  const sources = rows.slice(offset, offset + limit).map(compactTelegramSource)
  return {
    scope: {
      all_sessions: !!scope.all_sessions,
      tg_session: scope.session,
      active_session: activeTelegramSessionName(),
    },
    folder: formatTelegramFolder(resolved.folder),
    sources_offset: offset,
    sources_returned: sources.length,
    sources_total: rows.length,
    has_more: offset + sources.length < rows.length,
    sources,
  }
}

function listTelegramSources({ indexed_only = false, explicit_only = false, limit = 200 } = {}) {
  const rows = db.listSources('telegram')
    .filter(row => !explicit_only || !!row.is_explicit)
    .sort((a, b) => b.items_count - a.items_count || b.semantic_indexed_count - a.semantic_indexed_count)
    .slice(0, coercePositiveInt(limit, 200))
  const sources = rows
    .filter(r => !indexed_only || Number(r.semantic_indexed_count || 0) > 0)
    .map(r => ({ ...r, items_total: r.items_count, items_indexed: r.semantic_indexed_count }))
    .map(r => sourceSummary(r))
  return {
    returned: sources.length,
    filters: { indexed_only: !!indexed_only, explicit_only: !!explicit_only },
    sources,
  }
}

function sourceState(sourceId, jobsLimit = 10, { coverage_offset = 0, coverage_limit = 200 } = {}) {
  const h = db.getDb()
  const row = h.prepare(`
    SELECT s.*,
           (SELECT COUNT(*) FROM items i WHERE i.source_id = s.id) AS items_total,
           (SELECT COUNT(*) FROM post_comments c WHERE c.source_id = s.id) AS comments_total,
           (SELECT MIN(published_at) FROM items i WHERE i.source_id = s.id) AS min_at,
           (SELECT MAX(published_at) FROM items i WHERE i.source_id = s.id) AS max_at,
           (SELECT MAX(CAST(external_id AS INTEGER)) FROM items i WHERE i.source_id = s.id) AS max_external_id
      FROM sources s
     WHERE s.platform = 'telegram' AND s.id = ?
  `).get(sourceId)
  if (!row) return { error: 'source not found', source_id: sourceId }
  const index = require('../electron/telegram-rag-index').telegramFragmentIndexStatus(db, sourceId)
  const summary = sourceSummary(row, { indexStatus: index })
  const allCoverage = db.listCoverage(sourceId)
  const offset = Math.max(0, Math.floor(Number(coverage_offset) || 0))
  const pageSize = Math.max(1, Math.min(1000, Math.floor(Number(coverage_limit) || 200)))
  const coverage = allCoverage.slice(offset, offset + pageSize)
  const jobsCount = Number.isInteger(Number(jobsLimit)) && Number(jobsLimit) >= 0
    ? Math.min(50, Number(jobsLimit)) : 10
  const recentJobs = db.listJobsForSource(sourceId, jobsCount)
    .filter(j => String(j.type || '').startsWith('tg_'))
    .map(formatJobRow)
  return {
    source: summary,
    index,
    coverage,
    coverage_offset: offset, coverage_total: allCoverage.length,
    coverage_has_more: offset + coverage.length < allCoverage.length,
    coverage_next_offset: offset + coverage.length < allCoverage.length ? offset + coverage.length : null,
    recent_jobs: recentJobs,
  }
}

async function telegramSearchChatsTool(args = {}) {
  const query = normaliseText(args.query)
  if (!query) throw new Error('query is required')

  const scope = await telegramFolderScope(args)
  let folder = null
  let rows
  if (args.folder_id != null || args.folder != null) {
    const resolved = resolveTelegramFolderLocal(
      { ...args, folder_id: args.folder_id, title: args.folder },
      scope,
    )
    if (resolved.error) {
      return {
        scope: {
          all_sessions: !!scope.all_sessions,
          tg_session: scope.session,
          active_session: activeTelegramSessionName(),
        },
        ...resolved,
      }
    }
    folder = formatTelegramFolder(resolved.folder)
    rows = db.listFolderSources(resolved.folder.id)
  } else {
    rows = db.listSources('telegram')
  }

  const limit = Math.min(500, coercePositiveInt(args.limit, 50))
  const sources = rows
    .filter(row => scope.all_sessions || telegramSessionMatches(row, scope.session))
    .filter(row => args.explicit_only !== true || !!row.is_explicit)
    .filter(row => {
      const indexed = Number(row.semantic_indexed_count ?? row.items_indexed ?? 0)
      return args.indexed_only !== true || indexed > 0
    })
    .map(row => {
      const meta = parseMaybeJson(row.meta_json, {}) || {}
      const haystack = [
        row.handle,
        row.display_name,
        row.external_id,
        meta.username,
        meta.user_name,
        meta.title,
      ].map(normaliseText).filter(Boolean).join('\n')
      return { row, haystack }
    })
    .filter(entry => entry.haystack.includes(query))
    .map(entry => compactTelegramSource(entry.row))
    .sort((a, b) => {
      const ai = Number(a.items_indexed || 0)
      const bi = Number(b.items_indexed || 0)
      if (bi !== ai) return bi - ai
      const at = Number(a.items_total || 0)
      const bt = Number(b.items_total || 0)
      if (bt !== at) return bt - at
      return String(a.title || '').localeCompare(String(b.title || ''), 'ru')
    })
    .slice(0, limit)

  return {
    scope: {
      all_sessions: !!scope.all_sessions,
      tg_session: scope.session,
      active_session: activeTelegramSessionName(),
    },
    query: args.query,
    folder,
    filters: {
      indexed_only: args.indexed_only === true,
      explicit_only: args.explicit_only === true,
    },
    returned: sources.length,
    sources,
  }
}

function normaliseTypes(types) {
  const raw = Array.isArray(types) ? types : []
  return new Set(raw.map(t => String(t || '').trim().toLowerCase()).filter(Boolean))
}

function targetFromArgs(args) {
  if (args.target != null && String(args.target).trim()) return String(args.target).trim()
  const source = resolveSourceOrThrow(args)
  return source.handle || source.external_id || String(source.id)
}

function liveChatTarget(value) {
  try {
    const source = resolveSourceOrThrow({ chat: value })
    return {
      target: source.external_id || source.handle || String(value),
      source,
    }
  } catch {
    return { target: String(value), source: null }
  }
}

async function liveSessionForArgs(args = {}, resolvedChats = []) {
  const explicit = await resolveTelegramSessionName(args)
  if (explicit) return explicit
  const sessions = [...new Set(
    resolvedChats
      .map(entry => entry?.source?.tg_session)
      .filter(Boolean),
  )]
  if (sessions.length > 1) {
    throw new Error(`Selected Telegram chats use different sessions (${sessions.join(', ')}). Pass session/profile explicitly.`)
  }
  return sessions[0] || null
}

async function buildTelegramPublicSearchRequest(args = {}) {
  const query = String(args.query || '').trim()
  if (!query) throw new Error('query is required')
  return {
    operation: 'public_search',
    session: await liveSessionForArgs(args, []),
    query,
    limit: args.limit,
  }
}

async function buildTelegramMembershipRequest(args = {}, operation) {
  const target = String(args.target || '').trim()
  if (!target) throw new Error('target is required')
  if (!['join', 'leave'].includes(operation)) throw new Error('invalid membership operation')
  if (args.confirm !== true) throw new Error(`${operation} requires confirm=true`)
  const resolved = liveChatTarget(target)
  return {
    operation,
    session: await liveSessionForArgs(args, [resolved]),
    target,
    confirm: true,
  }
}

async function buildTelegramLiveSearchRequest(args = {}, { batch = false } = {}) {
  const chatValues = batch ? args.chats : [args.chat]
  const queryValues = batch ? args.queries : [args.query]
  if (!Array.isArray(chatValues) || !chatValues.length) throw new Error('chat/chats is required')
  if (!Array.isArray(queryValues) || !queryValues.length) throw new Error('query/queries is required')
  const chats = chatValues.map(liveChatTarget)
  const session = await liveSessionForArgs(args, chats)
  const searches = []
  for (const chat of chats) {
    for (const query of queryValues) {
      searches.push({
        chat: chat.target,
        query: String(query || ''),
        limit: batch ? args.limit_per_query : args.limit,
        offset_id: batch ? 0 : args.offset_id,
        date_from: args.date_from,
        date_to: args.date_to,
        sender: args.sender == null ? null : String(args.sender),
        topic_id: args.topic_id,
        media_filter: args.media_filter,
      })
    }
  }
  return {
    operation: 'search',
    session,
    searches,
    concurrency: batch ? args.concurrency : 1,
    max_candidates: batch ? args.max_candidates : (args.limit || 20),
    caption_chars: args.caption_chars,
  }
}

async function buildTelegramLiveContextRequest(args = {}) {
  if (!args.url && (args.chat == null || args.message_id == null)) {
    throw new Error('url or chat + message_id is required')
  }
  const resolved = args.chat == null ? null : liveChatTarget(args.chat)
  return {
    operation: 'context',
    session: await liveSessionForArgs(args, resolved ? [resolved] : []),
    chat: resolved?.target || null,
    url: args.url || null,
    message_id: args.message_id || null,
    before: args.before,
    after: args.after,
    max_depth: args.max_depth,
    max_replies: args.max_replies,
    caption_chars: args.caption_chars,
  }
}

async function buildTelegramLiveRangeRequest(args = {}) {
  if (!(args.from_url && args.to_url) && (args.chat == null || args.from_id == null || args.to_id == null)) {
    throw new Error('from_url + to_url or chat + from_id + to_id is required')
  }
  const resolved = args.chat == null ? null : liveChatTarget(args.chat)
  return {
    operation: 'range',
    session: await liveSessionForArgs(args, resolved ? [resolved] : []),
    chat: resolved?.target || null,
    from_url: args.from_url || null,
    to_url: args.to_url || null,
    from_id: args.from_id || null,
    to_id: args.to_id || null,
    max_messages: args.max_messages,
    caption_chars: args.caption_chars,
  }
}

async function buildTelegramLiveAttachmentRequest(args = {}) {
  if (!args.url && (args.chat == null || args.message_id == null)) {
    throw new Error('url or chat + message_id is required')
  }
  const resolved = args.chat == null ? null : liveChatTarget(args.chat)
  return {
    operation: 'attachment',
    session: await liveSessionForArgs(args, resolved ? [resolved] : []),
    chat: resolved?.target || null,
    url: args.url || null,
    message_id: args.message_id || null,
    max_bytes: args.max_bytes,
    max_text_chars: args.max_text_chars,
    caption_chars: args.caption_chars,
  }
}

async function buildTelegramLiveTranscriptionRequest(args = {}) {
  if (!args.url && (args.chat == null || args.message_id == null)) {
    throw new Error('url or chat + message_id is required')
  }
  const resolved = args.chat == null ? null : liveChatTarget(args.chat)
  return {
    operation: 'transcribe',
    session: await liveSessionForArgs(args, resolved ? [resolved] : []),
    chat: resolved?.target || null,
    url: args.url || null,
    message_id: args.message_id || null,
    engine: args.engine || 'soniox',
    language_hints: args.language_hints,
    context: args.context,
    max_bytes: args.max_bytes,
    max_text_chars: args.max_text_chars,
    caption_chars: args.caption_chars,
  }
}

function telegramAttachmentFileInfo(filePath) {
  if (!filePath || typeof filePath !== 'string') return null
  const cacheRoot = path.resolve(db.LIB_ROOT, 'cache', 'telegram-live-attachments')
  const absolute = path.resolve(filePath)
  if (!fs.existsSync(absolute)) throw new Error(`Telegram attachment cache file is missing: ${absolute}`)
  const realRoot = fs.realpathSync(cacheRoot)
  const realPath = fs.realpathSync(absolute)
  const relative = path.relative(realRoot, realPath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Telegram attachment result points outside the SC Desktop cache')
  }
  const stat = fs.statSync(realPath)
  if (!stat.isFile()) throw new Error('Telegram attachment result is not a file')
  return { path: realPath, stat }
}

function telegramLiveAttachmentToolResult(out) {
  const result = out?.result
  if (!result || result.operation !== 'attachment') {
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
  }

  const rawAttachment = result.attachment && typeof result.attachment === 'object'
    ? result.attachment
    : null
  const extractedText = typeof rawAttachment?.extracted_text === 'string'
    ? rawAttachment.extracted_text
    : ''
  const attachment = rawAttachment ? { ...rawAttachment } : null
  if (attachment) delete attachment.extracted_text

  const file = telegramAttachmentFileInfo(result.file_path || rawAttachment?.file_path)
  const contentType = String(attachment?.content_type || 'application/octet-stream').toLowerCase()
  const inlineImageTypes = new Set([
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml',
  ])
  const inlineImageLimit = 20 * 1024 * 1024
  const imageIncluded = !!file
    && inlineImageTypes.has(contentType)
    && file.stat.size <= inlineImageLimit

  const publicResult = {
    ...result,
    file_path: file?.path || result.file_path || null,
    attachment: attachment ? {
      ...attachment,
      file_path: file?.path || attachment.file_path || null,
    } : null,
    delivery: {
      resource_link_included: !!file,
      image_content_included: imageIncluded,
      extracted_text_included: !!extractedText,
      image_inline_limit_bytes: inlineImageLimit,
      limitation: file && contentType.startsWith('image/') && !imageIncluded
        ? `image is available at file_path but cannot be inlined as MCP image content (${contentType}, ${file.stat.size} bytes)`
        : null,
    },
  }
  const content = [{
    type: 'text',
    text: JSON.stringify({ ...out, result: publicResult }, null, 2),
  }]

  if (file) {
    content.push({
      type: 'resource_link',
      uri: pathToFileURL(file.path).href,
      name: path.basename(file.path),
      title: `Telegram attachment #${result.message?.message_id || 'unknown'} · ${attachment?.file_name || path.basename(file.path)}`,
      description: result.message?.text || 'Telegram message attachment cached by SC Desktop',
      mimeType: contentType,
      size: file.stat.size,
    })
  }
  if (imageIncluded) {
    content.push({
      type: 'image',
      data: fs.readFileSync(file.path).toString('base64'),
      mimeType: contentType,
    })
  }
  if (extractedText) {
    content.push({
      type: 'text',
      text: `===== TELEGRAM ATTACHMENT: ${attachment?.file_name || path.basename(file?.path || 'attachment')} =====\n${extractedText}`,
    })
  }
  return { content }
}

function telegramLiveTranscriptionToolResult(out) {
  const result = out?.result
  if (!result || result.operation !== 'transcribe') {
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
  }

  const rawTranscription = result.transcription && typeof result.transcription === 'object'
    ? result.transcription
    : null
  const transcriptText = typeof rawTranscription?.text === 'string'
    ? rawTranscription.text
    : ''
  const transcription = rawTranscription ? { ...rawTranscription } : null
  if (transcription) delete transcription.text

  const rawAttachment = result.attachment && typeof result.attachment === 'object'
    ? result.attachment
    : null
  const attachment = rawAttachment ? { ...rawAttachment } : null
  if (attachment) delete attachment.extracted_text
  const mediaFile = telegramAttachmentFileInfo(result.file_path || rawAttachment?.file_path)
  const transcriptFile = telegramAttachmentFileInfo(result.transcript_path)
  const contentType = String(attachment?.content_type || 'application/octet-stream').toLowerCase()

  const publicResult = {
    ...result,
    file_path: mediaFile?.path || result.file_path || null,
    transcript_path: transcriptFile?.path || result.transcript_path || null,
    attachment: attachment ? {
      ...attachment,
      file_path: mediaFile?.path || attachment.file_path || null,
    } : null,
    transcription,
    delivery: {
      media_resource_link_included: !!mediaFile,
      transcript_resource_link_included: !!transcriptFile,
      transcript_text_included: !!transcriptText,
    },
  }
  const content = [{
    type: 'text',
    text: JSON.stringify({ ...out, result: publicResult }, null, 2),
  }]
  const messageId = result.message?.message_id || 'unknown'
  if (mediaFile) {
    content.push({
      type: 'resource_link',
      uri: pathToFileURL(mediaFile.path).href,
      name: path.basename(mediaFile.path),
      title: `Telegram media #${messageId}`,
      description: 'Original Telegram voice/audio/video cached by SC Desktop',
      mimeType: contentType,
      size: mediaFile.stat.size,
    })
  }
  if (transcriptFile) {
    content.push({
      type: 'resource_link',
      uri: pathToFileURL(transcriptFile.path).href,
      name: path.basename(transcriptFile.path),
      title: `Telegram transcript #${messageId} · ${transcription?.engine || 'soniox'}`,
      description: 'Transcript of one selected Telegram media message',
      mimeType: 'text/plain',
      size: transcriptFile.stat.size,
    })
  }
  if (transcriptText) {
    content.push({
      type: 'text',
      text: `===== TELEGRAM TRANSCRIPT #${messageId} · ${transcription?.engine || 'soniox'} =====\n${transcriptText}`,
    })
  }
  return { content }
}

async function resolveTelegramSessionName(args = {}) {
  const raw = args.session || args.profile || args.account || args.tg_session
  if (raw == null || String(raw).trim() === '') return null
  const wanted = String(raw).trim()
  // An exact session name needs no all-account network inventory. The selected
  // worker still checks authorization; account aliases use the normal resolver.
  if (!/^\d+$/.test(wanted) && /^[A-Za-z0-9_-]+$/.test(wanted) && [
    path.join(projectRoot, 'python-workers', 'telegram', `${wanted}.session`),
    path.join(db.LIB_ROOT, 'sessions', 'telegram', `${wanted}.session`),
  ].some(candidate => fs.existsSync(candidate))) return wanted
  // Preserve explicit +phone aliases without exposing them in public output.
  // Digit-only selectors are exact IDs, not an ordinal/phone fallback.
  if (/^\+[0-9 ()-]+$/.test(wanted)) {
    const raw = await jobRunner().runTgSessionsCommand(['list'])
    const privateInventory = telegramAccountInventory(raw, activeTelegramSessionName())
    const digits = wanted.replace(/\D/g, '')
    const matches = raw.filter(s => s.type === 'session' && String((s.me || s.me_cached)?.phone || '').replace(/\D/g, '') === digits)
    const ids = [...new Set(matches.map(s => (s.me || s.me_cached)?.id).filter(Boolean))]
    if (ids.length !== 1) throw Object.assign(new Error('Phone alias отсутствует или неоднозначен; используй account ID/session.'), { code: 'TELEGRAM_ACCOUNT_AMBIGUOUS' })
    const resolved = selectTelegramAccount(privateInventory, { account_id: Number(ids[0]) })
    if (!resolved.ok) throw Object.assign(new Error(resolved.error), { code: resolved.code })
    return resolved.session
  }
  const inventory = await listTelegramSessions()
  const selected = selectTelegramAccount(inventory, /^\d+$/.test(wanted)
    ? { account_id: Number(wanted) } : { name: wanted, allowSubstring: true })
  if (!selected.ok) throw Object.assign(new Error(selected.error), { code: selected.code })
  return selected.session
}

async function buildTelegramJobParams(args = {}, { preview = false } = {}) {
  const target = targetFromArgs(args)
  let mode = args.mode || 'last_n'
  if (mode === 'date_range') mode = 'from_date'
  const params = { target, mode }
  const session = await resolveTelegramSessionName(args)
  if (session) params._tg_session_override = session
  const source = (() => {
    try { return resolveSourceOrThrow({ ...args, target }) } catch { return null }
  })()
  if (source?.id) params.source_id_hint = source.id

  const limit = coercePositiveInt(args.limit, mode === 'last_n' ? 500 : null)
  if (limit) params.limit = limit
  if (args.date) params.date = String(args.date)
  if (args.date_to) params.date_to = String(args.date_to)
  if (args.url) params.url = String(args.url)
  if (args.sinceMessageId) {
    params.sinceMessageId = Number(args.sinceMessageId)
  } else if (mode === 'sync_new' && source?.id) {
    const maxId = db.maxExternalId(source.id)
    if (maxId) params.sinceMessageId = maxId
  }
  if (Array.isArray(args.topic_ids) && args.topic_ids.length) {
    params.topic_ids = args.topic_ids
      .map(v => Number(v))
      .filter(v => Number.isFinite(v) && v > 0)
  }

  if (!preview) {
    const types = normaliseTypes(args.types)
    const asks = (...names) => names.some(n => types.has(n))
    const hasTypes = types.size > 0
    const wantsVoice = args.process_voice === true
      || asks('voice', 'audio', 'video', 'video_note')
    const wantsPhoto = args.process_photo === true
      || asks('photo', 'photos', 'image', 'images')
    const wantsDocs = args.process_docs === true
      || asks('doc', 'docs', 'document', 'documents', 'pdf', 'file', 'files')
    const wantsComments = args.include_comments === true || asks('comment', 'comments')

    params.process_voice = wantsVoice
    params.process_photo = wantsPhoto
    params.process_docs = wantsDocs
    params.process_polls = args.process_polls !== false
      && (!hasTypes || asks('text', 'poll', 'polls') || args.process_polls === true)
    if (wantsComments) {
      params.include_comments = true
      params.comments_limit = coercePositiveInt(args.comments_limit, 0) || 0
    }
    if (wantsVoice) {
      params.transcribe_engine = args.transcribe_engine || args.engine || 'assemblyai'
      params.transcribe_lang = args.transcribe_lang || 'ru'
    } else if (args.transcribe_engine) {
      params.transcribe_engine = args.transcribe_engine
      params.transcribe_lang = args.transcribe_lang || 'ru'
    }
    if (args.redo_processed) params.redo_processed = true
    for (const key of ['request_id', 'expected_account_id', 'expected_peer_id', 'download_profile_photo', 'full_history', 'voice_types', 'voice_max_duration_sec', 'media_cache_dir', 'media_min_free_bytes', 'reuse_transcripts', 'message_ids']) {
      if (args[key] != null) params[key] = args[key]
    }
  }

  return require('../electron/telegram-fetch-policy').validateTelegramFetchPolicy(params)
}

function jobStartResult(id) {
  return {
    ok: true,
    job_id: id,
    job: jobRunner().getJobDetail(id) || null,
    next: 'Poll telegram_job_status with this job_id. After a successful fetch, run telegram_index for semantic search.',
  }
}

async function resolveTelegramChat(text, opts = {}) {
  const progress = []
  const result = await jobRunner().runTelegramResolveTitle(text, evt => {
    progress.push(evt)
  }, {
    _tg_session_override: opts.session || null,
    fuzzy: opts.fuzzy !== false,
    limit: opts.limit,
  })
  return {
    query: text,
    session: opts.session || null,
    fuzzy: opts.fuzzy !== false,
    progress_tail: progress.slice(-5),
    ...result,
  }
}

function selectPostsWithoutComments(sourceId, limit) {
  return db.getDb().prepare(`
    SELECT i.external_id
      FROM items i
      LEFT JOIN (
        SELECT DISTINCT post_external_id
          FROM post_comments
         WHERE source_id = ?
      ) c ON c.post_external_id = i.external_id
     WHERE i.source_id = ?
       AND i.external_id IS NOT NULL
       AND c.post_external_id IS NULL
     ORDER BY CAST(i.external_id AS INTEGER) DESC, i.id DESC
     LIMIT ?
  `).all(sourceId, sourceId, limit).map(r => String(r.external_id))
}

function startCommentsCatchup(args = {}) {
  const source = resolveSourceOrThrow(args)
  const target = args.target && String(args.target).trim()
    ? String(args.target).trim()
    : (source.handle || source.external_id || String(source.id))
  let postIds = Array.isArray(args.post_ids)
    ? args.post_ids.map(v => String(v).trim()).filter(Boolean)
    : []
  if (!postIds.length) {
    postIds = selectPostsWithoutComments(
      source.id,
      coercePositiveInt(args.limit_posts, 200),
    )
  }
  if (!postIds.length) {
    return {
      ok: true,
      noop: true,
      reason: 'no local posts without stored comments',
      source: sourceRef(source),
    }
  }
  const id = jobRunner().startTelegramCommentsCatchUp({
    source_id: source.id,
    target,
    post_ids: postIds,
    comments_limit: coercePositiveInt(args.comments_limit, 0) || 0,
  })
  return {
    ...jobStartResult(id),
    source: sourceRef(source),
    posts_requested: postIds.length,
    post_ids_sample: postIds.slice(0, 20),
  }
}

function formatJobRow(row) {
  const params = parseMaybeJson(row.parameters_json, null)
  return {
    id: row.id,
    type: row.type,
    source_id: row.source_id || null,
    status: row.status,
    items_done: row.items_done || 0,
    items_total: row.items_total,
    items_failed: row.items_failed || 0,
    error: row.error || null,
    started_at: row.started_at || null,
    finished_at: row.finished_at || null,
    file_path: row.file_path || null,
    params,
  }
}

function listTelegramJobs(args = {}) {
  let source = null
  try {
    if (args.source_id != null || args.chat != null) source = resolveSourceOrThrow(args)
  } catch (err) {
    throw err
  }
  const limit = coercePositiveInt(args.limit, 30)
  if (args.active_only === true) {
    const rows = db.getDb().prepare(`SELECT * FROM jobs
      WHERE status IN ('pending','running','cancelling','awaiting_ai')
        ${args.all_types === true ? '' : "AND type LIKE 'tg_%'"}
        ${source ? 'AND source_id = ?' : ''}
      ORDER BY id`).all(...(source ? [source.id] : []))
    return { source: sourceRef(source), live_scope: 'mcp_process_only',
      durable_scope: args.all_types === true ? 'all_application_job_types' : 'telegram',
      active_only: true, enumeration_complete: true, live: [], historic: rows.map(formatJobRow) }
  }
  const live = jobRunner().listJobs()
    .filter(j => String(j.type || '').startsWith('tg_'))
    .filter(j => !source || Number(j.source_id) === Number(source.id))
  const rows = source
    ? db.listJobsForSource(source.id, limit)
    : db.getDb().prepare(`
        SELECT * FROM jobs
         WHERE type LIKE 'tg_%'
         ORDER BY COALESCE(started_at, created_at) DESC
         LIMIT ?
      `).all(limit)
  return {
    source: sourceRef(source),
    live,
    historic: rows.map(formatJobRow),
  }
}

function telegramJobStatus(args = {}) {
  const out = {}
  if (args.job_id != null && args.job_id !== '') {
    out.job_id = args.job_id
    out.job = jobRunner().getJobDetail(args.job_id) || null
    if (!out.job) {
      const row = db.getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(Number(args.job_id))
      if (row) out.job = formatJobRow(row)
    }
  }
  if (args.source_id != null || args.chat != null) {
    const source = resolveSourceOrThrow(args)
    out.source = sourceRef(source)
    out.index = require('../electron/telegram-rag-index').telegramFragmentIndexStatus(db, source.id)
    out.source_state = sourceState(source.id, 5)
  }
  if (!('job' in out) && !out.source) {
    throw new Error('job_id or source_id/chat is required')
  }
  return out
}

function getStoredTelegramComments({ source, post_external_id, limit }) {
  const sourceId = source.id
  if (post_external_id != null && post_external_id !== '') {
    const comments = db.listCommentsForPosts(sourceId, [String(post_external_id)])
      .slice(0, limit)
    return {
      source: sourceRef(source),
      post_external_id: String(post_external_id),
      returned: comments.length,
      comments,
    }
  }
  const comments = db.getDb().prepare(`
    SELECT post_external_id, comment_id, parent_comment_id, sender, text, date
      FROM post_comments
     WHERE source_id = ?
     ORDER BY date DESC, comment_id DESC
     LIMIT ?
  `).all(sourceId, limit)
  return {
    source: sourceRef(source),
    returned: comments.length,
    comments,
  }
}

async function listTelegramSessions() {
  const events = await jobRunner().runTgSessionsCommand(['list', '--redact'])
  return telegramAccountInventory(events, activeTelegramSessionName())
}

async function telegramSendSavedMessageTool(args = {}) {
  const input = normalizeSavedMessageInput(args)
  const session = await resolveTelegramSessionName(args)
  const out = await jobRunner().sendTelegramSavedMessage({
    ...input,
    session: session || null,
  })
  return {
    ...out,
    active_session: activeTelegramSessionName(),
  }
}

function activeTelegramSessionName() {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.config', 'sc', 'settings.json'), 'utf8')
    const n = (JSON.parse(raw).telegram || {}).session
    return (typeof n === 'string' && n.trim()) ? n.trim() : null
  } catch {
    return null
  }
}

// ========== REDDIT HELPERS ==========

const REDDIT_BACKENDS = new Set(['api', 'auto', 'apify'])
const REDDIT_SORTS = new Set(['relevance', 'top', 'new', 'hot', 'comments'])
const REDDIT_TIMES = new Set(['all', 'year', 'month', 'week', 'day', 'hour'])

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function normaliseRedditBackend(value) {
  const v = String(value || 'api').trim().toLowerCase()
  return REDDIT_BACKENDS.has(v) ? v : 'api'
}

function normaliseRedditSort(value) {
  const v = String(value || 'relevance').trim().toLowerCase()
  return REDDIT_SORTS.has(v) ? v : 'relevance'
}

function normaliseRedditTime(value) {
  const v = String(value || 'year').trim().toLowerCase()
  return REDDIT_TIMES.has(v) ? v : 'year'
}

function normaliseSubreddit(value) {
  const s = String(value || '')
    .trim()
    .replace(/^https?:\/\/(?:www\.)?reddit\.com\//i, '')
    .replace(/^\/?r\//i, '')
    .replace(/^\/+|\/+$/g, '')
  return s || undefined
}

function parseRedditPostId(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  const urlMatch = raw.match(/\/comments\/([a-z0-9]+)/i)
  if (urlMatch) return urlMatch[1]
  const clean = raw.replace(/^t3_/i, '').replace(/^post:/i, '')
  return /^[a-z0-9]+$/i.test(clean) ? clean : null
}

function redditMeta(row) {
  return parseMaybeJson(row?.meta_json, {}) || {}
}

function redditSourceRef(source) {
  if (!source) return null
  const meta = redditMeta(source)
  return {
    source_id: source.id,
    handle: source.handle,
    kind: meta.kind || null,
    title: source.display_name || source.handle,
    external_id: source.external_id || null,
    subreddit: meta.subreddit || null,
    query: meta.query || null,
    url: meta.url || null,
    author: meta.author || null,
  }
}

function resolveRedditSource(args = {}) {
  const h = db.getDb()
  let row = null

  if (args.source_id != null && args.source_id !== '') {
    row = h.prepare(`SELECT * FROM sources WHERE platform = 'reddit' AND id = ?`)
      .get(Number(args.source_id))
  }

  if (!row && args.handle) {
    const handle = String(args.handle).trim()
    row = h.prepare(`
      SELECT * FROM sources
       WHERE platform = 'reddit' AND handle = ?
       ORDER BY last_synced_at DESC
       LIMIT 1
    `).get(handle)
  }

  const postId = !row ? (parseRedditPostId(args.url) || parseRedditPostId(args.post_id)) : null
  if (!row && postId) {
    row = h.prepare(`
      SELECT * FROM sources
       WHERE platform = 'reddit' AND (handle = ? OR external_id = ?)
       ORDER BY last_synced_at DESC
       LIMIT 1
    `).get(`t-${postId}`, postId)
  }

  return row || null
}

function resolveRedditSourceOrThrow(args = {}) {
  const row = resolveRedditSource(args)
  if (!row) {
    throw new Error('Reddit source not found. Pass source_id from reddit_list_sources, handle q-.../t-..., a Reddit post URL, or post_id.')
  }
  return row
}

function redditSourceSummary(row) {
  const h = db.getDb()
  const counts = h.prepare(`
    SELECT COUNT(*) AS items_total,
           SUM(CASE WHEN type = 'text' THEN 1 ELSE 0 END) AS posts_total,
           SUM(CASE WHEN type = 'comment' THEN 1 ELSE 0 END) AS comments_total,
           SUM(CASE WHEN has_media = 1 THEN 1 ELSE 0 END) AS media_items_total,
           SUM(CASE WHEN media_path IS NOT NULL THEN 1 ELSE 0 END) AS media_downloaded_total,
           MIN(published_at) AS min_at,
           MAX(published_at) AS max_at,
           MAX(comments) AS max_post_comments
      FROM items
     WHERE source_id = ?
  `).get(row.id) || {}
  return {
    ...redditSourceRef(row),
    items_total: Number(counts.items_total || 0),
    posts_total: Number(counts.posts_total || 0),
    comments_total: Number(counts.comments_total || 0),
    media_items_total: Number(counts.media_items_total || 0),
    media_downloaded_total: Number(counts.media_downloaded_total || 0),
    max_post_comments: counts.max_post_comments == null ? null : Number(counts.max_post_comments),
    date_range: { min_at: counts.min_at || null, max_at: counts.max_at || null },
    is_explicit: row.is_explicit == null ? null : !!row.is_explicit,
    last_synced_at: row.last_synced_at || null,
    type_breakdown: db.itemTypeBreakdown(row.id),
  }
}

function listRedditSources({ kind = 'all', limit = 100 } = {}) {
  const wantKind = String(kind || 'all').toLowerCase()
  const h = db.getDb()
  const rows = h.prepare(`
    SELECT *
      FROM sources
     WHERE platform = 'reddit'
     ORDER BY last_synced_at DESC, id DESC
     LIMIT ?
  `).all(Math.min(5000, Math.max(100, limit * 5)))
  const sources = rows
    .filter(row => wantKind === 'all' || redditMeta(row).kind === wantKind)
    .slice(0, limit)
    .map(redditSourceSummary)
  return { returned: sources.length, filters: { kind: wantKind }, sources }
}

function redditSourceState(sourceId, jobsLimit = 10) {
  const row = db.getDb().prepare(`
    SELECT * FROM sources WHERE platform = 'reddit' AND id = ?
  `).get(sourceId)
  if (!row) return { error: 'source not found', source_id: sourceId }
  const recentJobs = db.listJobsForSource(sourceId, coercePositiveInt(jobsLimit, 10))
    .filter(j => String(j.type || '').startsWith('rd_'))
    .map(formatJobRow)
  return {
    source: redditSourceSummary(row),
    recent_jobs: recentJobs,
  }
}

function redditOrderSql(order) {
  switch (String(order || 'tree').toLowerCase()) {
    case 'new': return 'published_at DESC, id DESC'
    case 'old': return 'published_at ASC, id ASC'
    case 'score': return 'COALESCE(likes, 0) DESC, id ASC'
    case 'tree':
    default:
      // Inserts follow scraper order: post first, then DFS-ish comments. This is
      // more useful than depth sort for reconstructing Reddit discussions.
      return 'id ASC'
  }
}

function redditTypeWhere(type) {
  const t = String(type || 'all').toLowerCase()
  if (t === 'post') return { sql: " AND type = 'text'", label: 'post' }
  if (t === 'comment') return { sql: " AND type = 'comment'", label: 'comment' }
  return { sql: '', label: 'all' }
}

function normaliseRedditMediaForOutput(rawMedia) {
  const arr = Array.isArray(rawMedia) ? rawMedia : []
  return arr.map((m, i) => {
    const filePath = m.local_path || m.file_path || null
    return {
      index: Number.isFinite(m.index) ? m.index : i,
      kind: m.kind || 'image',
      url: m.url || null,
      preview_url: m.preview_url || null,
      file_path: filePath,
      asset_url: filePath ? assetUrlForFile(filePath) : null,
      content_type: m.content_type || m.mime || null,
      bytes: Number.isFinite(m.bytes) ? m.bytes : null,
      width: Number.isFinite(m.width) ? m.width : null,
      height: Number.isFinite(m.height) ? m.height : null,
      source: m.source || null,
      error: m.error || null,
    }
  })
}

function formatRedditItem(row, { captionChars = 1200, includeRawMeta = false, includeMedia = false } = {}) {
  const n = coercePositiveInt(captionChars, 1200)
  const raw = parseMaybeJson(row.raw_meta_json, {}) || {}
  const media = normaliseRedditMediaForOutput(raw.media)
  const out = {
    item_id: row.id,
    external_id: row.external_id,
    type: row.type === 'text' ? 'post' : row.type,
    url: row.url || null,
    title: row.title || null,
    caption: n > 0 ? String(row.caption || '').slice(0, n) : '',
    published_at: row.published_at || null,
    score: row.likes == null ? null : Number(row.likes),
    comments: row.comments == null ? null : Number(row.comments),
    author: row.sender || null,
    parent_external_id: row.parent_external_id || null,
    depth: row.depth == null ? null : Number(row.depth),
    has_media: !!row.has_media,
    media_count: media.length,
    media_downloaded: media.filter(m => m.file_path).length,
  }
  if (includeMedia) out.media = media
  if (includeRawMeta) out.raw_meta = raw
  return out
}

function redditSourceItems(source, args = {}) {
  const limit = coercePositiveInt(args.limit, 200)
  const offset = Math.max(0, Number(args.offset || 0) || 0)
  const captionChars = Math.max(0, Math.min(8000, Number(args.caption_chars ?? 1200) || 0))
  const typeFilter = redditTypeWhere(args.type)
  const orderSql = redditOrderSql(args.order)
  const rows = db.getDb().prepare(`
    SELECT id, external_id, type, url, title, caption, published_at, likes,
           comments, sender, has_media, media_path, parent_external_id, depth,
           raw_meta_json
      FROM items
     WHERE source_id = ? ${typeFilter.sql}
     ORDER BY ${orderSql}
     LIMIT ? OFFSET ?
  `).all(source.id, limit, offset)
  return {
    source: redditSourceRef(source),
    filters: {
      type: typeFilter.label,
      order: args.order || 'tree',
      limit,
      offset,
      caption_chars: captionChars,
      include_raw_meta: !!args.include_raw_meta,
      include_media: !!args.include_media,
    },
    returned: rows.length,
    items: rows.map(r => formatRedditItem(r, {
      captionChars,
      includeRawMeta: !!args.include_raw_meta,
      includeMedia: !!args.include_media,
    })),
  }
}

function redditThreadTree(source, args = {}) {
  const maxNodes = coercePositiveInt(args.max_nodes, 500)
  const captionChars = Math.max(0, Math.min(8000, Number(args.caption_chars ?? 1200) || 0))
  const includeMedia = !!args.include_media
  const rows = db.getDb().prepare(`
    SELECT id, external_id, type, url, title, caption, published_at, likes,
           comments, sender, has_media, media_path, parent_external_id, depth,
           raw_meta_json
      FROM items
     WHERE source_id = ?
     ORDER BY id ASC
     LIMIT ?
  `).all(source.id, maxNodes)
  const allCount = db.getDb().prepare('SELECT COUNT(*) AS n FROM items WHERE source_id = ?').get(source.id)?.n || 0
  const nodes = new Map()
  let root = null
  for (const row of rows) {
    const item = formatRedditItem(row, { captionChars, includeRawMeta: false, includeMedia })
    item.children = []
    nodes.set(row.external_id, item)
    if (!row.parent_external_id && (row.depth === 0 || row.type === 'text')) root = item
  }
  const orphans = []
  for (const row of rows) {
    const node = nodes.get(row.external_id)
    if (!node || node === root) continue
    const parent = row.parent_external_id ? nodes.get(row.parent_external_id) : null
    if (parent) parent.children.push(node)
    else orphans.push(node)
  }
  if (!root && rows.length) {
    root = nodes.get(rows[0].external_id) || null
  }
  if (root && orphans.length) root.children.push(...orphans)
  return {
    source: redditSourceRef(source),
    returned_nodes: rows.length,
    total_nodes: Number(allCount),
    truncated: Number(allCount) > rows.length,
    tree: root,
    orphans: root ? [] : orphans,
  }
}

async function waitForJob(jobId, waitMs) {
  const ms = Math.max(0, Math.min(30000, Number(waitMs || 0) || 0))
  let job = jobRunner().getJobDetail(jobId)
  if (ms <= 0) return job
  const deadline = Date.now() + ms
  while (job && job.status === 'running' && Date.now() < deadline) {
    await sleep(120)
    job = jobRunner().getJobDetail(jobId)
  }
  return jobRunner().getJobDetail(jobId) || job
}

async function redditJobStartResult(jobId, waitMs, { returnItems = true } = {}) {
  const job = await waitForJob(jobId, waitMs)
  const out = {
    ok: true,
    job_id: jobId,
    job,
    next: 'Poll reddit_job_status with this job_id, or read reddit_source_items/reddit_thread_tree after source_id appears.',
  }
  if (job?.source_id) {
    const source = db.getDb().prepare(`SELECT * FROM sources WHERE platform = 'reddit' AND id = ?`)
      .get(job.source_id)
    if (source) {
      out.source = redditSourceSummary(source)
      if (returnItems && job.status !== 'running') {
        const kind = redditMeta(source).kind
        if (kind === 'thread') {
          out.items = redditSourceItems(source, {
            type: 'all',
            order: 'tree',
            limit: Math.min(500, Number(job.items_done || 200) || 200),
            caption_chars: 1200,
          }).items
        } else {
          out.items = redditSourceItems(source, {
            type: 'post',
            order: 'tree',
            limit: Math.min(250, Number(job.items_done || 100) || 100),
            caption_chars: 1200,
            include_raw_meta: true,
          }).items
        }
      }
    }
  }
  return out
}

async function startRedditSearchTool(args = {}) {
  const query = String(args.query || '').trim()
  if (!query) throw new Error('query is required')
  const params = {
    query,
    subreddit: normaliseSubreddit(args.subreddit),
    limit: Math.min(250, coercePositiveInt(args.limit, 25)),
    sort: normaliseRedditSort(args.sort),
    time: normaliseRedditTime(args.time),
    backend: normaliseRedditBackend(args.backend),
  }
  const id = jobRunner().startRedditSearch(params)
  const out = await redditJobStartResult(id, coercePositiveInt(args.wait_ms, 5000), {
    returnItems: args.return_items !== false,
  })
  if (args.download_media) {
    if (out.source?.source_id && out.job?.status !== 'running') {
      const mediaOut = await redditMediaFetch({
        source_id: out.source.source_id,
        limit: coercePositiveInt(args.media_limit, 50),
        include_items: false,
      })
      out.source = mediaOut.source
      out.media = mediaOut.media
      if (args.return_items !== false) {
        const source = db.getDb().prepare(`SELECT * FROM sources WHERE platform = 'reddit' AND id = ?`)
          .get(out.source.source_id)
        out.items = redditSourceItems(source, {
          type: 'post',
          order: 'tree',
          limit: Math.min(250, Number(out.job?.items_done || 100) || 100),
          caption_chars: args.caption_chars ?? 1200,
          include_media: true,
        }).items
      }
    } else {
      out.media = { downloaded: 0, failed: 0, skipped: 'job still running or source not ready' }
    }
  }
  return out
}

async function startRedditThreadTool(args = {}) {
  const url = String(args.url || '').trim()
  if (!url) throw new Error('url is required')
  const params = {
    url,
    maxComments: Math.min(5000, coercePositiveInt(args.max_comments, 200)),
    backend: normaliseRedditBackend(args.backend),
  }
  const id = jobRunner().startRedditThreadFetch(params)
  const out = await redditJobStartResult(id, coercePositiveInt(args.wait_ms, 5000), {
    returnItems: args.return_items !== false,
  })
  if (args.download_media) {
    if (out.source?.source_id && out.job?.status !== 'running') {
      const mediaOut = await redditMediaFetch({
        source_id: out.source.source_id,
        limit: coercePositiveInt(args.media_limit, 50),
        include_items: false,
      })
      out.source = mediaOut.source
      out.media = mediaOut.media
      if (args.return_items !== false) {
        const source = db.getDb().prepare(`SELECT * FROM sources WHERE platform = 'reddit' AND id = ?`)
          .get(out.source.source_id)
        out.items = redditSourceItems(source, {
          type: 'all',
          order: 'tree',
          limit: Math.min(500, Number(out.job?.items_done || 200) || 200),
          caption_chars: args.caption_chars ?? 1200,
          include_media: true,
        }).items
      }
    } else {
      out.media = { downloaded: 0, failed: 0, skipped: 'job still running or source not ready' }
    }
  }
  return out
}

function redditJobStatus(args = {}) {
  const out = {}
  if (args.job_id != null && args.job_id !== '') {
    out.job_id = args.job_id
    out.job = jobRunner().getJobDetail(args.job_id) || null
    if (!out.job) {
      const row = db.getDb().prepare(`SELECT * FROM jobs WHERE id = ? AND type LIKE 'rd_%'`)
        .get(Number(args.job_id))
      if (row) out.job = formatJobRow(row)
    }
  }
  if (args.source_id != null || args.handle || args.url || args.post_id) {
    const source = resolveRedditSourceOrThrow(args)
    out.source = redditSourceRef(source)
    out.source_state = redditSourceState(source.id, 5)
  }
  if (!('job' in out) && !out.source) {
    throw new Error('job_id or Reddit source reference is required')
  }
  return out
}

function redditItemKey(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  const postId = parseRedditPostId(raw)
  if (postId) return `post:${postId}`
  const clean = raw.replace(/^item:/i, '')
  if (/^(post|comment):[a-z0-9_]+$/i.test(clean)) return clean
  return null
}

function redditMediaExt(contentType, url) {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase()
  if (ct === 'image/png') return '.png'
  if (ct === 'image/webp') return '.webp'
  if (ct === 'image/gif') return '.gif'
  if (ct === 'image/jpeg' || ct === 'image/jpg') return '.jpg'
  try {
    const u = new URL(url)
    const ext = path.extname(u.pathname || '').toLowerCase()
    if (/^\.(jpe?g|png|webp|gif)$/.test(ext)) return ext.replace('.jpeg', '.jpg')
  } catch {}
  return '.jpg'
}

function redditMediaHostAllowed(url) {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return (
      /(^|\.)redd\.it$/.test(host) ||
      /(^|\.)redditmedia\.com$/.test(host) ||
      /(^|\.)redditstatic\.com$/.test(host) ||
      /(^|\.)imgur\.com$/.test(host) ||
      /(^|\.)giphy\.com$/.test(host) ||
      /(^|\.)tenor\.com$/.test(host)
    )
  } catch {
    return false
  }
}

function redditMediaFilePath(externalId, index, url, contentType) {
  const key = String(externalId || 'unknown')
    .replace(/^(post|comment):/i, '')
    .replace(/[^\w.-]+/g, '_') || 'unknown'
  const uniq = hash8(url)
  const ext = redditMediaExt(contentType, url)
  return path.join(db.LIB_ROOT, 'reddit-media', key, `${String(index + 1).padStart(2, '0')}-${uniq}${ext}`)
}

async function downloadRedditMediaEntry(externalId, media, index) {
  const url = String(media?.url || media?.preview_url || '').trim()
  if (!url) return { ...media, error: 'missing media url' }
  if (!redditMediaHostAllowed(url)) {
    let host = 'unknown'
    try { host = new URL(url).hostname } catch {}
    return { ...media, error: `blocked non-reddit media host: ${host}` }
  }
  let res
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Referer': 'https://www.reddit.com/',
      },
    })
  } catch (err) {
    return { ...media, error: String(err?.message || err) }
  }
  if (!res.ok) return { ...media, error: `HTTP ${res.status}` }
  const contentType = res.headers.get('content-type') || ''
  if (!String(contentType).toLowerCase().startsWith('image/')) {
    return { ...media, error: `unexpected content-type ${contentType || 'unknown'}` }
  }
  const ab = await res.arrayBuffer()
  const buf = Buffer.from(ab)
  if (!buf.length) return { ...media, error: 'empty image' }
  if (buf.length > 25 * 1024 * 1024) return { ...media, error: `image too large (${buf.length} bytes)` }
  const filePath = redditMediaFilePath(externalId, index, url, contentType)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, buf)
  return {
    ...media,
    local_path: filePath,
    file_path: filePath,
    asset_url: assetUrlForFile(filePath),
    content_type: contentType.split(';')[0].trim() || null,
    bytes: buf.length,
    error: null,
  }
}

async function downloadRedditMediaForItems(items, { limit = 80 } = {}) {
  let downloaded = 0
  let failed = 0
  const max = Math.max(1, Math.min(1000, Number(limit || 80) || 80))
  for (const item of items || []) {
    if (downloaded >= max) break
    const media = Array.isArray(item.media) ? item.media : []
    if (!item.external_id || !media.length) continue
    const next = []
    for (let i = 0; i < media.length; i++) {
      const m = media[i]
      if (downloaded >= max) {
        next.push(m)
        continue
      }
      const saved = await downloadRedditMediaEntry(item.external_id, m, i)
      next.push(saved)
      if (saved.local_path) downloaded++
      else if (saved.error) failed++
    }
    item.media = next
  }
  return { downloaded, failed }
}

async function redditMediaFetch(args = {}) {
  const source = resolveRedditSourceOrThrow(args)
  const limit = coercePositiveInt(args.limit, 50)
  const itemExternalId = redditItemKey(args.item_external_id || args.post_id)
  const extraWhere = itemExternalId ? ' AND external_id = ?' : ' AND has_media = 1'
  const params = itemExternalId
    ? [source.id, itemExternalId, limit]
    : [source.id, limit]
  const rows = db.getDb().prepare(`
    SELECT id, external_id, type, url, title, caption, published_at, duration_seconds,
           views, likes, comments, sender, has_media, media_path, parent_external_id,
           depth, raw_meta_json
      FROM items
     WHERE source_id = ? ${extraWhere}
     ORDER BY id ASC
     LIMIT ?
  `).all(...params)
  const started = Math.floor(Date.now() / 1000)
  let downloaded = 0
  let failed = 0
  const updatedRows = []
  for (const row of rows) {
    const raw = parseMaybeJson(row.raw_meta_json, {}) || {}
    const media = Array.isArray(raw.media) ? raw.media : []
    if (!media.length) continue
    const item = { external_id: row.external_id, media }
    const st = await downloadRedditMediaForItems([item], { limit: Math.max(1, limit - downloaded) })
    downloaded += st.downloaded
    failed += st.failed
    raw.media = item.media
    const firstLocal = item.media.find(m => m.local_path)?.local_path || row.media_path || null
    updatedRows.push({
      source_id: source.id,
      external_id: row.external_id,
      type: row.type,
      url: row.url,
      title: row.title,
      caption: row.caption,
      published_at: row.published_at,
      duration_seconds: row.duration_seconds,
      views: row.views,
      likes: row.likes,
      comments: row.comments,
      sender: row.sender,
      has_media: row.has_media,
      media_path: firstLocal,
      thumbnail_path: firstLocal,
      raw_meta: raw,
      parent_external_id: row.parent_external_id,
      depth: row.depth,
    })
    if (downloaded >= limit) break
  }
  if (updatedRows.length) db.bulkUpsertItems(updatedRows)
  const finished = Math.floor(Date.now() / 1000)
  const jobId = db.recordJob({
    type: 'rd_media_fetch',
    source_id: source.id,
    status: 'done',
    items_total: rows.length,
    items_done: updatedRows.length,
    cost_usd: 0,
    params: { item_external_id: itemExternalId || null, limit },
    started_at: started,
    finished_at: finished,
  })
  const out = {
    ok: true,
    job_id: jobId,
    source: redditSourceSummary(source),
    scanned_items: rows.length,
    updated_items: updatedRows.length,
    media: { downloaded, failed },
  }
  if (args.include_items !== false) {
    if (itemExternalId) {
      const row = db.getDb().prepare(`
        SELECT id, external_id, type, url, title, caption, published_at, likes,
               comments, sender, has_media, media_path, parent_external_id, depth,
               raw_meta_json
          FROM items
         WHERE source_id = ? AND external_id = ?
         LIMIT 1
      `).get(source.id, itemExternalId)
      out.items = row ? [formatRedditItem(row, { captionChars: 1200, includeMedia: true })] : []
    } else {
      out.items = redditSourceItems(source, {
        type: 'all',
        order: 'tree',
        limit: Math.min(200, updatedRows.length || rows.length || limit),
        include_media: true,
        caption_chars: 1200,
      }).items
    }
  }
  return out
}

// ========== X/TWITTER HELPERS ==========

const TWITTER_PLATFORM = 'twitter'
const TWITTER_JOB_TYPES = new Set(['tw_search', 'tw_thread_fetch', 'tw_media_fetch'])

function hash8(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 8)
}

function twitterStatusId(value) {
  const s = String(value || '').trim()
  if (!s) return null
  const fromUrl = parseTwitterStatusIdFromUrl(s)
  if (fromUrl) return fromUrl
  const clean = s.replace(/^tweet:/i, '').replace(/^status:/i, '')
  return /^\d{6,}$/.test(clean) ? clean : null
}

function twitterMeta(row) {
  return parseMaybeJson(row?.meta_json, {}) || {}
}

function twitterSourceRef(source) {
  if (!source) return null
  const meta = twitterMeta(source)
  return {
    source_id: source.id,
    handle: source.handle,
    kind: meta.kind || null,
    title: source.display_name || source.handle,
    external_id: source.external_id || null,
    query: meta.query || null,
    url: meta.url || null,
    root_status_id: meta.root_status_id || null,
    fetched_at: meta.fetched_at || null,
  }
}

function resolveTwitterSource(args = {}) {
  const h = db.getDb()
  let row = null
  if (args.source_id != null && args.source_id !== '') {
    row = h.prepare(`SELECT * FROM sources WHERE platform = ? AND id = ?`)
      .get(TWITTER_PLATFORM, Number(args.source_id))
  }
  if (!row && args.handle) {
    row = h.prepare(`
      SELECT * FROM sources
       WHERE platform = ? AND handle = ?
       ORDER BY last_synced_at DESC
       LIMIT 1
    `).get(TWITTER_PLATFORM, String(args.handle).trim())
  }
  const sid = !row ? (twitterStatusId(args.url) || twitterStatusId(args.status_id) || twitterStatusId(args.item_status_id)) : null
  if (!row && sid) {
    row = h.prepare(`
      SELECT * FROM sources
       WHERE platform = ?
         AND (handle = ? OR external_id = ? OR meta_json LIKE ?)
       ORDER BY last_synced_at DESC
       LIMIT 1
    `).get(TWITTER_PLATFORM, `xt-${sid}`, sid, `%"root_status_id":"${sid}"%`)
  }
  return row || null
}

function resolveTwitterSourceOrThrow(args = {}) {
  const row = resolveTwitterSource(args)
  if (!row) {
    throw new Error('X/Twitter source not found. Pass source_id, handle, status URL, or status_id.')
  }
  return row
}

function twitterSourceSummary(row) {
  const h = db.getDb()
  const counts = h.prepare(`
    SELECT COUNT(*) AS items_total,
           SUM(CASE WHEN type = 'text' THEN 1 ELSE 0 END) AS posts_total,
           SUM(CASE WHEN type = 'comment' THEN 1 ELSE 0 END) AS comments_total,
           SUM(CASE WHEN has_media = 1 THEN 1 ELSE 0 END) AS media_items_total,
           SUM(CASE WHEN media_path IS NOT NULL THEN 1 ELSE 0 END) AS media_downloaded_total,
           MIN(published_at) AS min_at,
           MAX(published_at) AS max_at,
           MAX(comments) AS max_replies
      FROM items
     WHERE source_id = ?
  `).get(row.id) || {}
  return {
    ...twitterSourceRef(row),
    items_total: Number(counts.items_total || 0),
    posts_total: Number(counts.posts_total || 0),
    comments_total: Number(counts.comments_total || 0),
    media_items_total: Number(counts.media_items_total || 0),
    media_downloaded_total: Number(counts.media_downloaded_total || 0),
    max_replies: counts.max_replies == null ? null : Number(counts.max_replies),
    date_range: { min_at: counts.min_at || null, max_at: counts.max_at || null },
    is_explicit: row.is_explicit == null ? null : !!row.is_explicit,
    last_synced_at: row.last_synced_at || null,
    type_breakdown: db.itemTypeBreakdown(row.id),
  }
}

function listTwitterSources({ kind = 'all', limit = 100 } = {}) {
  const wantKind = String(kind || 'all').toLowerCase()
  const rows = db.getDb().prepare(`
    SELECT *
      FROM sources
     WHERE platform = ?
     ORDER BY last_synced_at DESC, id DESC
     LIMIT ?
  `).all(TWITTER_PLATFORM, Math.min(5000, Math.max(100, limit * 5)))
  const sources = rows
    .filter(row => wantKind === 'all' || twitterMeta(row).kind === wantKind)
    .slice(0, limit)
    .map(twitterSourceSummary)
  return { returned: sources.length, filters: { kind: wantKind }, sources }
}

function twitterSourceState(sourceId, jobsLimit = 10) {
  const row = db.getDb().prepare(`SELECT * FROM sources WHERE platform = ? AND id = ?`)
    .get(TWITTER_PLATFORM, sourceId)
  if (!row) return { error: 'source not found', source_id: sourceId }
  const recentJobs = db.listJobsForSource(sourceId, coercePositiveInt(jobsLimit, 10))
    .filter(j => TWITTER_JOB_TYPES.has(String(j.type || '')))
    .map(formatJobRow)
  return {
    source: twitterSourceSummary(row),
    scrape: twitterMeta(row).scrape || null,
    recent_jobs: recentJobs,
  }
}

function twitterOrderSql(order) {
  switch (String(order || 'tree').toLowerCase()) {
    case 'new': return 'published_at DESC, id DESC'
    case 'old': return 'published_at ASC, id ASC'
    case 'likes': return 'COALESCE(likes, 0) DESC, id ASC'
    case 'replies': return 'COALESCE(comments, 0) DESC, id ASC'
    case 'tree':
    default:
      return 'id ASC'
  }
}

function twitterTypeWhere(type) {
  const t = String(type || 'all').toLowerCase()
  if (t === 'post') return { sql: " AND type = 'text'", label: 'post' }
  if (t === 'comment') return { sql: " AND type = 'comment'", label: 'comment' }
  return { sql: '', label: 'all' }
}

function assetUrlForFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return ''
  const abs = path.resolve(filePath)
  const rel = path.relative(db.LIB_ROOT, abs)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return ''
  return `sc-asset://${rel.split(path.sep).join('/')}`
}

function normaliseTwitterMediaForOutput(rawMedia) {
  const arr = Array.isArray(rawMedia) ? rawMedia : []
  return arr.map((m, i) => {
    const filePath = m.local_path || m.file_path || null
    return {
      index: Number.isFinite(m.index) ? m.index : i,
      kind: m.kind || 'image',
      url: m.url || null,
      preview_url: m.preview_url || null,
      file_path: filePath,
      asset_url: filePath ? assetUrlForFile(filePath) : null,
      content_type: m.content_type || m.mime || null,
      bytes: Number.isFinite(m.bytes) ? m.bytes : null,
      width: Number.isFinite(m.width) ? m.width : null,
      height: Number.isFinite(m.height) ? m.height : null,
      alt: m.alt || '',
      error: m.error || null,
    }
  })
}

function formatTwitterItem(row, { captionChars = 1200, includeMedia = false, includeRawMeta = false } = {}) {
  const rawCaptionChars = Number(captionChars)
  const n = Number.isFinite(rawCaptionChars)
    ? Math.max(0, Math.min(8000, Math.floor(rawCaptionChars)))
    : 1200
  const raw = parseMaybeJson(row.raw_meta_json, {}) || {}
  const media = normaliseTwitterMediaForOutput(raw.media)
  const out = {
    item_id: row.id,
    external_id: row.external_id,
    status_id: twitterStatusId(row.external_id),
    type: row.type === 'text' ? 'post' : row.type,
    url: row.url || null,
    title: row.title || null,
    caption: n > 0 ? String(row.caption || '').slice(0, n) : '',
    published_at: row.published_at || null,
    author: row.sender || raw.user || null,
    display_name: raw.display_name || null,
    likes: row.likes == null ? null : Number(row.likes),
    replies: row.comments == null ? null : Number(row.comments),
    views: row.views == null ? null : Number(row.views),
    parent_external_id: row.parent_external_id || null,
    depth: row.depth == null ? null : Number(row.depth),
    has_media: !!row.has_media,
    media_count: media.length,
    media_downloaded: media.filter(m => m.file_path).length,
  }
  if (includeMedia) out.media = media
  if (includeRawMeta) out.raw_meta = raw
  return out
}

function twitterSourceItems(source, args = {}) {
  const limit = coercePositiveInt(args.limit, 200)
  const offset = Math.max(0, Number(args.offset || 0) || 0)
  const captionChars = Math.max(0, Math.min(8000, Number(args.caption_chars ?? 1200) || 0))
  const typeFilter = twitterTypeWhere(args.type)
  const orderSql = twitterOrderSql(args.order)
  const rows = db.getDb().prepare(`
    SELECT id, external_id, type, url, title, caption, published_at, views,
           likes, comments, sender, has_media, media_path, parent_external_id,
           depth, raw_meta_json
      FROM items
     WHERE source_id = ? ${typeFilter.sql}
     ORDER BY ${orderSql}
     LIMIT ? OFFSET ?
  `).all(source.id, limit, offset)
  return {
    source: twitterSourceRef(source),
    filters: {
      type: typeFilter.label,
      order: args.order || 'tree',
      limit,
      offset,
      caption_chars: captionChars,
      include_media: !!args.include_media,
      include_raw_meta: !!args.include_raw_meta,
    },
    returned: rows.length,
    items: rows.map(r => formatTwitterItem(r, {
      captionChars,
      includeMedia: !!args.include_media,
      includeRawMeta: !!args.include_raw_meta,
    })),
  }
}

function twitterThreadTree(source, args = {}) {
  const maxNodes = coercePositiveInt(args.max_nodes, 500)
  const captionChars = Math.max(0, Math.min(8000, Number(args.caption_chars ?? 1200) || 0))
  const includeMedia = !!args.include_media
  const rows = db.getDb().prepare(`
    SELECT id, external_id, type, url, title, caption, published_at, views,
           likes, comments, sender, has_media, media_path, parent_external_id,
           depth, raw_meta_json
      FROM items
     WHERE source_id = ?
     ORDER BY id ASC
     LIMIT ?
  `).all(source.id, maxNodes)
  const allCount = db.getDb().prepare('SELECT COUNT(*) AS n FROM items WHERE source_id = ?').get(source.id)?.n || 0
  const nodes = new Map()
  let root = null
  for (const row of rows) {
    const item = formatTwitterItem(row, { captionChars, includeMedia, includeRawMeta: false })
    item.children = []
    nodes.set(row.external_id, item)
    if (!row.parent_external_id && (row.depth === 0 || row.type === 'text')) root = item
  }
  const orphans = []
  for (const row of rows) {
    const node = nodes.get(row.external_id)
    if (!node || node === root) continue
    const parent = row.parent_external_id ? nodes.get(row.parent_external_id) : null
    if (parent) parent.children.push(node)
    else orphans.push(node)
  }
  if (!root && rows.length) root = nodes.get(rows[0].external_id) || null
  if (root && orphans.length) root.children.push(...orphans)
  return {
    source: twitterSourceRef(source),
    returned_nodes: rows.length,
    total_nodes: Number(allCount),
    truncated: Number(allCount) > rows.length,
    tree: root,
    orphans: root ? [] : orphans,
  }
}

function twitterHandleForScrape(scrape) {
  if (scrape.kind === 'thread') return `xt-${scrape.root_status_id}`
  return `xq-${hash8(scrape.query || scrape.url || Date.now())}`
}

function scrapeTitle(scrape) {
  if (scrape.kind === 'thread') {
    const root = (scrape.items || []).find(it => it.status_id === scrape.root_status_id) || scrape.items?.[0]
    return root?.text ? `X thread: ${String(root.text).split('\n')[0].slice(0, 80)}` : `X thread ${scrape.root_status_id}`
  }
  return `X search: ${scrape.query}`
}

function scrapedTwitterItemToDbRow(sourceId, item) {
  const statusId = item.status_id || twitterStatusId(item.url)
  const media = Array.isArray(item.media) ? item.media : []
  const firstLocal = media.find(m => m.local_path)?.local_path || null
  const rawMeta = {
    user: item.user || null,
    display_name: item.display_name || null,
    raw_text: item.raw_text || null,
    counts: item.counts || null,
    replying_to: item.replying_to || null,
    is_quote: !!item.is_quote,
    is_ad: !!item.is_ad,
    media,
  }
  return {
    source_id: sourceId,
    external_id: item.external_id || `tweet:${statusId}`,
    type: item.type === 'comment' ? 'comment' : 'text',
    url: item.url || null,
    title: item.display_name || item.user || null,
    caption: item.text || item.raw_text || null,
    published_at: item.published_at ? Math.floor(new Date(item.published_at).getTime() / 1000) : null,
    duration_seconds: null,
    views: item.counts?.views ?? null,
    likes: item.counts?.likes ?? null,
    comments: item.counts?.replies ?? null,
    sender: item.user ? `@${item.user}` : null,
    has_media: media.length > 0 || !!item.has_media,
    media_path: firstLocal,
    thumbnail_path: firstLocal,
    raw_meta: rawMeta,
    parent_external_id: item.parent_external_id || null,
    depth: item.depth != null ? item.depth : null,
  }
}

function twitterSearchParamsFromArgs(args = {}) {
  return {
    query: String(args.query || '').trim(),
    exact_phrase: args.exact_phrase,
    any_words: args.any_words,
    exclude_words: args.exclude_words,
    from_user: args.from_user,
    to_user: args.to_user,
    mention_user: args.mention_user,
    since: args.since,
    until: args.until,
    lang: args.lang,
    min_likes: args.min_likes,
    min_replies: args.min_replies,
    min_retweets: args.min_retweets,
    only_replies: !!args.only_replies,
    exclude_replies: !!args.exclude_replies,
    only_links: !!args.only_links,
    only_media: !!args.only_media,
    only_images: !!args.only_images,
    only_videos: !!args.only_videos,
    tab: args.tab || 'latest',
    limit: Math.min(500, coercePositiveInt(args.limit, 50)),
    scroll_steps: args.scroll_steps,
    settle_ms: args.settle_ms,
    background: !(args.download_media || args.only_media || args.only_images),
    close_tab: args.close_tab !== false,
  }
}

function twitterThreadParamsFromArgs(args = {}) {
  return {
    url: normaliseStatusUrl(args.url || ''),
    max_items: Math.min(2000, coercePositiveInt(args.max_items ?? args.limit, 200)),
    reply_depth: Math.min(3, coercePositiveInt(args.reply_depth, 1)),
    branch_limit: Math.min(100, coercePositiveInt(args.branch_limit, 25)),
    scroll_steps: args.scroll_steps,
    settle_ms: args.settle_ms,
    background: false,
    close_tab: args.close_tab !== false,
  }
}

function twitterMediaExt(contentType, url) {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase()
  if (ct === 'image/png') return '.png'
  if (ct === 'image/webp') return '.webp'
  if (ct === 'image/gif') return '.gif'
  if (ct === 'image/jpeg' || ct === 'image/jpg') return '.jpg'
  try {
    const u = new URL(url)
    const fmt = u.searchParams.get('format')
    if (fmt && /^[a-z0-9]+$/i.test(fmt)) return `.${fmt.toLowerCase().replace('jpeg', 'jpg')}`
  } catch {}
  return '.jpg'
}

function twitterMediaFilePath(statusId, index, url, contentType) {
  const id = twitterStatusId(statusId) || String(statusId || 'unknown').replace(/[^\w.-]+/g, '_')
  const uniq = hash8(url)
  const ext = twitterMediaExt(contentType, url)
  return path.join(db.LIB_ROOT, 'twitter-media', id, `${String(index + 1).padStart(2, '0')}-${uniq}${ext}`)
}

async function downloadTwitterMediaEntry(statusId, media, index) {
  const url = String(media?.url || media?.preview_url || '').trim()
  if (!url) return { ...media, error: 'missing media url' }
  const u = new URL(url)
  if (!/(^|\.)twimg\.com$/i.test(u.hostname)) {
    return { ...media, error: `blocked non-twimg media host: ${u.hostname}` }
  }
  let res
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
    })
  } catch (err) {
    return { ...media, error: String(err?.message || err) }
  }
  if (!res.ok) return { ...media, error: `HTTP ${res.status}` }
  const contentType = res.headers.get('content-type') || ''
  if (!String(contentType).toLowerCase().startsWith('image/')) {
    return { ...media, error: `unexpected content-type ${contentType || 'unknown'}` }
  }
  const ab = await res.arrayBuffer()
  const buf = Buffer.from(ab)
  if (!buf.length) return { ...media, error: 'empty image' }
  if (buf.length > 25 * 1024 * 1024) return { ...media, error: `image too large (${buf.length} bytes)` }
  const filePath = twitterMediaFilePath(statusId, index, url, contentType)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, buf)
  return {
    ...media,
    local_path: filePath,
    file_path: filePath,
    asset_url: assetUrlForFile(filePath),
    content_type: contentType.split(';')[0].trim() || null,
    bytes: buf.length,
    error: null,
  }
}

async function downloadTwitterMediaForItems(items, { limit = 80 } = {}) {
  let downloaded = 0
  let failed = 0
  const max = Math.max(1, Math.min(1000, Number(limit || 80) || 80))
  for (const item of items || []) {
    if (downloaded >= max) break
    const statusId = item.status_id || twitterStatusId(item.external_id) || twitterStatusId(item.url)
    const media = Array.isArray(item.media) ? item.media : []
    if (!statusId || !media.length) continue
    const next = []
    for (let i = 0; i < media.length; i++) {
      const m = media[i]
      if (downloaded >= max) {
        next.push(m)
        continue
      }
      const saved = await downloadTwitterMediaEntry(statusId, m, i)
      next.push(saved)
      if (saved.local_path) downloaded++
      else if (saved.error) failed++
    }
    item.media = next
  }
  return { downloaded, failed }
}

function upsertTwitterScrape(scrape, params = {}) {
  const handle = twitterHandleForScrape(scrape)
  const meta = {
    kind: scrape.kind,
    query: scrape.query || null,
    url: scrape.url || null,
    root_status_id: scrape.root_status_id || null,
    fetched_at: scrape.fetched_at || new Date().toISOString(),
    filters: params,
    scrape: scrape.metrics || null,
  }
  const sourceId = db.upsertSource({
    platform: TWITTER_PLATFORM,
    handle,
    display_name: scrapeTitle(scrape),
    external_id: scrape.kind === 'thread' ? scrape.root_status_id : handle,
    meta,
    mark_synced: true,
    is_explicit: true,
  })
  const rows = (scrape.items || [])
    .filter(it => it?.status_id || twitterStatusId(it?.url))
    .map(it => scrapedTwitterItemToDbRow(sourceId, it))
  if (rows.length) db.bulkUpsertItems(rows)
  return { sourceId, rows }
}

async function startTwitterSearchTool(args = {}) {
  const params = twitterSearchParamsFromArgs(args)
  const query = buildTwitterQuery(params)
  if (!query) throw new Error('query is required')
  const started = Math.floor(Date.now() / 1000)
  try {
    const scrape = await scrapeTwitterSearch(params)
    let mediaStats = { downloaded: 0, failed: 0 }
    if (args.download_media) {
      mediaStats = await downloadTwitterMediaForItems(scrape.items, {
        limit: coercePositiveInt(args.media_limit, 80),
      })
    }
    const { sourceId } = upsertTwitterScrape(scrape, { ...params, query })
    const finished = Math.floor(Date.now() / 1000)
    const jobId = db.recordJob({
      type: 'tw_search',
      source_id: sourceId,
      status: 'done',
      items_total: scrape.items.length,
      items_done: scrape.items.length,
      cost_usd: 0,
      params: { ...params, built_query: query, download_media: !!args.download_media, media: mediaStats },
      started_at: started,
      finished_at: finished,
    })
    const source = db.getDb().prepare(`SELECT * FROM sources WHERE platform = ? AND id = ?`).get(TWITTER_PLATFORM, sourceId)
    const out = {
      ok: true,
      job_id: jobId,
      source: twitterSourceSummary(source),
      query,
      metrics: scrape.metrics,
      media: mediaStats,
      next: 'Use twitter_source_items. If has_media/media_count suggests visual context matters, call twitter_media_fetch.',
    }
    if (args.return_items !== false) {
      out.items = twitterSourceItems(source, {
        type: 'post',
        order: 'tree',
        limit: Math.min(500, scrape.items.length || params.limit),
        caption_chars: args.caption_chars ?? 1200,
        include_media: !!args.download_media,
      }).items
    }
    return out
  } catch (err) {
    db.recordJob({
      type: 'tw_search',
      status: 'error',
      items_total: 0,
      items_done: 0,
      cost_usd: 0,
      params: { ...params, built_query: query },
      error: String(err?.message || err),
      started_at: started,
      finished_at: Math.floor(Date.now() / 1000),
    })
    throw err
  }
}

async function startTwitterThreadTool(args = {}) {
  const params = twitterThreadParamsFromArgs(args)
  if (!params.url) throw new Error('url is required')
  const started = Math.floor(Date.now() / 1000)
  try {
    const scrape = await scrapeTwitterThread(params)
    let mediaStats = { downloaded: 0, failed: 0 }
    if (args.download_media) {
      mediaStats = await downloadTwitterMediaForItems(scrape.items, {
        limit: coercePositiveInt(args.media_limit, 80),
      })
    }
    const { sourceId } = upsertTwitterScrape(scrape, params)
    const finished = Math.floor(Date.now() / 1000)
    const jobId = db.recordJob({
      type: 'tw_thread_fetch',
      source_id: sourceId,
      status: 'done',
      items_total: scrape.items.length,
      items_done: scrape.items.length,
      cost_usd: 0,
      params: { ...params, download_media: !!args.download_media, media: mediaStats },
      started_at: started,
      finished_at: finished,
    })
    const source = db.getDb().prepare(`SELECT * FROM sources WHERE platform = ? AND id = ?`).get(TWITTER_PLATFORM, sourceId)
    const out = {
      ok: true,
      job_id: jobId,
      source: twitterSourceSummary(source),
      metrics: scrape.metrics,
      media: mediaStats,
      next: 'Use twitter_thread_tree for nested discussion, twitter_source_items for flat rows, twitter_media_fetch for screenshots/images.',
    }
    if (args.return_items !== false) {
      out.items = twitterSourceItems(source, {
        type: 'all',
        order: 'tree',
        limit: Math.min(1000, scrape.items.length || params.max_items),
        caption_chars: args.caption_chars ?? 1200,
        include_media: !!args.download_media,
      }).items
    }
    return out
  } catch (err) {
    db.recordJob({
      type: 'tw_thread_fetch',
      status: 'error',
      items_total: 0,
      items_done: 0,
      cost_usd: 0,
      params,
      error: String(err?.message || err),
      started_at: started,
      finished_at: Math.floor(Date.now() / 1000),
    })
    throw err
  }
}

async function twitterMediaFetch(args = {}) {
  const source = resolveTwitterSourceOrThrow(args)
  const limit = coercePositiveInt(args.limit, 50)
  const itemStatusId = twitterStatusId(args.item_status_id)
  const extraWhere = itemStatusId ? ' AND external_id = ?' : ' AND has_media = 1'
  const params = itemStatusId
    ? [source.id, `tweet:${itemStatusId}`, limit]
    : [source.id, limit]
  const rows = db.getDb().prepare(`
    SELECT id, external_id, type, url, title, caption, published_at, duration_seconds,
           views, likes, comments, sender, has_media, media_path, parent_external_id,
           depth, raw_meta_json
      FROM items
     WHERE source_id = ? ${extraWhere}
     ORDER BY id ASC
     LIMIT ?
  `).all(...params)
  const started = Math.floor(Date.now() / 1000)
  let downloaded = 0
  let failed = 0
  const updatedRows = []
  for (const row of rows) {
    const raw = parseMaybeJson(row.raw_meta_json, {}) || {}
    let media = Array.isArray(raw.media) ? raw.media : []
    if (!media.length && row.url && row.has_media) {
      try {
        const one = await scrapeTwitterThread({
          url: row.url,
          max_items: 5,
          reply_depth: 1,
          branch_limit: 1,
          scroll_steps: 6,
          settle_ms: 300,
          background: false,
          close_tab: true,
        })
        const sid = twitterStatusId(row.external_id)
        const found = (one.items || []).find(it => it.status_id === sid) || one.items?.[0]
        if (Array.isArray(found?.media) && found.media.length) media = found.media
      } catch (err) {
        media = [{
          kind: 'image',
          url: null,
          error: `media rediscovery failed: ${String(err?.message || err)}`,
        }]
      }
    }
    if (!media.length) continue
    const statusId = twitterStatusId(row.external_id)
    const item = { status_id: statusId, media }
    const st = await downloadTwitterMediaForItems([item], { limit: Math.max(1, limit - downloaded) })
    downloaded += st.downloaded
    failed += st.failed
    raw.media = item.media
    const firstLocal = item.media.find(m => m.local_path)?.local_path || row.media_path || null
    updatedRows.push({
      source_id: source.id,
      external_id: row.external_id,
      type: row.type,
      url: row.url,
      title: row.title,
      caption: row.caption,
      published_at: row.published_at,
      duration_seconds: row.duration_seconds,
      views: row.views,
      likes: row.likes,
      comments: row.comments,
      sender: row.sender,
      has_media: row.has_media,
      media_path: firstLocal,
      thumbnail_path: firstLocal,
      raw_meta: raw,
      parent_external_id: row.parent_external_id,
      depth: row.depth,
    })
    if (downloaded >= limit) break
  }
  if (updatedRows.length) db.bulkUpsertItems(updatedRows)
  const finished = Math.floor(Date.now() / 1000)
  const jobId = db.recordJob({
    type: 'tw_media_fetch',
    source_id: source.id,
    status: 'done',
    items_total: rows.length,
    items_done: updatedRows.length,
    cost_usd: 0,
    params: { item_status_id: itemStatusId || null, limit },
    started_at: started,
    finished_at: finished,
  })
  const out = {
    ok: true,
    job_id: jobId,
    source: twitterSourceSummary(source),
    scanned_items: rows.length,
    updated_items: updatedRows.length,
    media: { downloaded, failed },
  }
  if (args.include_items !== false) {
    out.items = twitterSourceItems(source, {
      type: 'all',
      order: 'tree',
      limit: Math.min(200, updatedRows.length || rows.length || limit),
      include_media: true,
      caption_chars: 1200,
    }).items.filter(it => !itemStatusId || it.status_id === itemStatusId)
  }
  return out
}

// Reactions arrive as a JSON-stringified list; parse + summarise once so all
// three tools surface the same shape: { total: <int>, top: [{e, n}, ...] }.
// `total` is `sum(n)`; `top` is the original list trimmed to 6 entries (rare
// for messages to have more, and it caps token cost in MCP output).
// Returns null when the row had no reactions (or the column was unparseable).
function summariseReactions(raw) {
  if (raw == null) return null
  let arr = raw
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw) } catch { return null }
  }
  if (!Array.isArray(arr) || arr.length === 0) return null
  let total = 0
  for (const r of arr) total += Number(r?.n) || 0
  if (total === 0) return null
  return { total, top: arr.slice(0, 6) }
}

function telegramMessageMetadata(row) {
  const raw = parseMaybeJson(row?.raw_meta_json, {}) || {}
  return {
    has_media: !!row?.has_media,
    media: Array.isArray(raw.media) ? raw.media : [],
    forward: raw.forward && typeof raw.forward === 'object' ? raw.forward : null,
  }
}

async function searchChat(args) {
  const { query } = args
  const scope = normalizeRagScope(args)
  const q = await embedQuery(query)
  const out = searchTelegramRag(db, { ...scope, query_embedding: q }, {
    annotateContextRefs: (row, refs) => annotateSemanticContextRefs(db.getDb(), row, refs),
  })
  const filtered = out.rows.map(row => {
    const item = serializeTelegramItem(row, out.source, { caption_chars: args.caption_chars ?? 1200 })
    const matches = (row._matched_chunks || []).map(chunk => ({
      chunk_id: chunk.chunk_id, chunk_index: chunk.chunk_index,
      document_hash: chunk.document_hash, cos: Number(chunk.cos.toFixed(3)),
      index_revision: chunk.index_revision, content_hash: chunk.content_hash,
      index_version: chunk.index_version, context_refs: chunk.context_refs,
      ...readTelegramCaptionSpan(row.caption || '', {
        start: chunk.start_char, end: chunk.end_char, offset_unit: 'utf16_code_units',
        expected_caption_hash: item.caption_hash,
      }),
    }))
    const origin = telegramForwardProvenance(item.forward)
    return {
      ...item, cos: Number(row._cos.toFixed(3)),
      index_mode: row._index_mode, index_freshness: row._freshness,
      matches,
      forward_origin_key: origin.key,
      forward_origin_basis: origin.basis,
    }
  })
  const chronology = out.chronology
  return {
    source_id: scope.source_id,
    query,
    query_embedding_sha256: crypto.createHash('sha256').update(Buffer.from(q.buffer, q.byteOffset, q.byteLength)).digest('hex'),
    returned: filtered.length,
    threshold: scope.min_cos,
    scope: { ...scope, date_timezone: 'UTC_for_date_only', date_bounds: 'inclusive' },
    corpus: { ...chronology, last_synced_at: out.source.last_synced_at || null, index: out.coverage },
    ...out.diagnostics,
    results: filtered,
  }
}

function neighbors(item_id, before, after) {
  const handle = db.getDb()
  const center = handle.prepare(
    'SELECT id, source_id, published_at FROM items WHERE id = ?'
  ).get(item_id)
  if (!center) return { error: 'item not found' }
  const beforeRows = handle.prepare(`
    SELECT id, external_id, published_at, sender, type, caption, reactions,
           has_media, raw_meta_json
      FROM items
     WHERE source_id = ? AND published_at IS NOT NULL
       AND (published_at < ? OR (published_at = ? AND id < ?))
     ORDER BY published_at DESC, id DESC
     LIMIT ?
  `).all(center.source_id, center.published_at, center.published_at, center.id, before).reverse()
  const afterRows = handle.prepare(`
    SELECT id, external_id, published_at, sender, type, caption, reactions,
           has_media, raw_meta_json
      FROM items
     WHERE source_id = ? AND published_at IS NOT NULL
       AND (published_at > ? OR (published_at = ? AND id > ?))
     ORDER BY published_at ASC, id ASC
     LIMIT ?
  `).all(center.source_id, center.published_at, center.published_at, center.id, after)
  const trim = (r) => ({
    item_id: r.id,
    external_id: r.external_id,
    published_at: r.published_at,
    sender: r.sender,
    type: r.type,
    caption: (r.caption || '').slice(0, 800),
    reactions: summariseReactions(r.reactions),
    ...telegramMessageMetadata(r),
  })
  const centerRow = handle.prepare(
    `SELECT id, external_id, published_at, sender, type, caption, reactions,
            has_media, raw_meta_json FROM items WHERE id = ?`
  ).get(item_id)
  return {
    before: beforeRows.map(trim),
    center: trim(centerRow),
    after: afterRows.map(trim),
  }
}

// Resolve a chat identifier in any of the four shapes the user might paste
// (source_id / handle / -100<id> / t.me URL) to a single source row. URL
// shape additionally yields external_id, returned as `urlExternalId`.
//
// Why a free-form `chat` field instead of a strict schema: Telegram URLs are
// the most common way users point at a message ("t.me/c/1769090887/22875/45751"
// — `45751` is the message_id, `22875` is the topic, `1769090887` is the
// internal chat_id). Forcing the user (or assistant) to pre-parse three
// numbers from one URL is friction; the tool does it.
function resolveChat(chat) {
  const handle = db.getDb()
  let urlExternalId = null

  if (typeof chat === 'string') {
    // t.me/c/<internal>/[topic/]<msg> or t.me/<handle>/[topic/]<msg>.
    // Normalise: strip protocol, query string, trailing slash.
    const m = chat.match(/(?:t\.me|telegram\.me)\/([^?]+)/i)
    if (m) {
      const segs = m[1].split('/').filter(Boolean)
      const last = segs[segs.length - 1]
      if (/^\d+$/.test(last)) urlExternalId = parseInt(last, 10)
      // c/<id>/... → private channel, id is internal
      if (segs[0] === 'c' && /^\d+$/.test(segs[1])) {
        chat = `-100${segs[1]}` // try as the standard supergroup form
      } else {
        chat = segs[0] // public handle
      }
    }
  }

  // Strategy: try multiple matches, fallback chain. Stop at first hit.
  let row = null
  if (typeof chat === 'number' || /^\d+$/.test(String(chat))) {
    const n = Number(chat)
    // Source PK
    row = handle.prepare(
      `SELECT id, handle, display_name FROM sources WHERE platform='telegram' AND id = ?`
    ).get(n)
    // Handle stored as digits (internal id without -100 prefix). Multi-row
    // possible when private + public have similar suffixes — pick the one
    // with most items_indexed-or-total to disambiguate.
    if (!row) {
      row = handle.prepare(`
        SELECT id, handle, display_name FROM sources
         WHERE platform='telegram' AND (handle = ? OR handle = ? OR handle = ?)
         ORDER BY (SELECT COUNT(*) FROM items i WHERE i.source_id = sources.id) DESC
         LIMIT 1
      `).get(String(n), `-100${n}`, `-${n}`)
    }
  }
  if (!row && typeof chat === 'string') {
    const stripped = chat.replace(/^@/, '')
    row = handle.prepare(`
      SELECT id, handle, display_name FROM sources
       WHERE platform='telegram'
         AND (handle = ? OR handle = ? OR display_name = ?)
       ORDER BY (SELECT COUNT(*) FROM items i WHERE i.source_id = sources.id) DESC
       LIMIT 1
    `).get(chat, stripped, stripped)
  }
  return { source: row, urlExternalId }
}

function getByExternalId(chat, externalIdArg, options = {}) {
  const { source, urlExternalId } = resolveChat(chat)
  if (!source) {
    return {
      error: 'chat not found',
      hint:
        'Pass numeric source_id from list_telegram_chats, a public handle, ' +
        'an internal id (e.g. "-1001769090887" or "1769090887"), or a full ' +
        't.me URL.',
    }
  }
  const externalId = urlExternalId != null ? urlExternalId : externalIdArg
  if (externalId == null) {
    return {
      error: 'external_id required',
      hint:
        'Either include external_id in args or pass a t.me URL with a ' +
        'message_id segment (last number in the path).',
      source: { source_id: source.id, handle: source.handle, title: source.display_name || source.handle },
    }
  }
  const handle = db.getDb()
  const row = handle.prepare(`
    SELECT id, source_id, external_id, parent_external_id, published_at,
           sender, type, caption, reactions, has_media, raw_meta_json
      FROM items
     WHERE source_id = ? AND external_id = ?
  `).get(source.id, String(externalId))
  if (!row) {
    return {
      error: 'item not found',
      source: { source_id: source.id, handle: source.handle, title: source.display_name || source.handle },
      external_id: externalId,
      hint:
        'The chat resolved but no item with this external_id exists. The ' +
        'message may not be indexed yet (run a fetch on this source) or the ' +
        'message_id belongs to a different chat (Telegram URLs sometimes ' +
        'point to a discussion-group reply, not the channel).',
    }
  }
  return createTelegramRagReaders(handle).readItem({ source_id: source.id, external_id: String(externalId), caption_chars: options.caption_chars ?? 16000 })
}

// Reply-graph walk. Two recursive CTEs: ancestors climb up via
// (source_id, parent_external_id) → (source_id, external_id), descendants
// walk the inverse edge with depth tracking. We bound both directions: ancestor
// chain by max_depth (rare to exceed 5), descendants by max_descendants
// (broad threads with 100+ "+1" replies blow context otherwise).
function replyThread(item_id, max_depth, max_descendants) {
  const handle = db.getDb()
  const center = handle.prepare(`
    SELECT id, source_id, external_id, parent_external_id, published_at,
           sender, type, caption, reactions, has_media, raw_meta_json
      FROM items WHERE id = ?
  `).get(item_id)
  if (!center) return { error: 'item not found' }

  const ancestorsSql = `
    WITH RECURSIVE chain(id, external_id, parent_external_id, published_at,
                         sender, type, caption, reactions, has_media,
                         raw_meta_json, hop) AS (
      SELECT id, external_id, parent_external_id, published_at,
             sender, type, caption, reactions, has_media, raw_meta_json, 0
        FROM items
       WHERE source_id = ? AND external_id = ?
      UNION ALL
      SELECT i.id, i.external_id, i.parent_external_id, i.published_at,
             i.sender, i.type, i.caption, i.reactions, i.has_media,
             i.raw_meta_json, c.hop + 1
        FROM items i
        JOIN chain c ON i.source_id = ? AND i.external_id = c.parent_external_id
       WHERE c.parent_external_id IS NOT NULL AND c.hop < ?
    )
    SELECT * FROM chain WHERE hop > 0 ORDER BY hop DESC
  `
  const ancestors = center.parent_external_id
    ? handle.prepare(ancestorsSql).all(
        center.source_id, center.external_id,
        center.source_id, max_depth)
    : []

  const descendantsSql = `
    WITH RECURSIVE tree(id, external_id, parent_external_id, published_at,
                       sender, type, caption, reactions, has_media,
                       raw_meta_json, hop) AS (
      SELECT id, external_id, parent_external_id, published_at,
             sender, type, caption, reactions, has_media, raw_meta_json, 1
        FROM items
       WHERE source_id = ? AND parent_external_id = ?
      UNION ALL
      SELECT i.id, i.external_id, i.parent_external_id, i.published_at,
             i.sender, i.type, i.caption, i.reactions, i.has_media,
             i.raw_meta_json, t.hop + 1
        FROM items i
        JOIN tree t ON i.source_id = ? AND i.parent_external_id = t.external_id
       WHERE t.hop < ?
    )
    SELECT * FROM tree
     ORDER BY published_at ASC, id ASC
     LIMIT ?
  `
  const descendants = handle.prepare(descendantsSql).all(
    center.source_id, center.external_id,
    center.source_id, max_depth, max_descendants)

  const trim = (r) => ({
    item_id: r.id,
    external_id: r.external_id,
    parent_external_id: r.parent_external_id || null,
    hop: r.hop,
    published_at: r.published_at,
    sender: r.sender,
    type: r.type,
    caption: (r.caption || '').slice(0, 800),
    reactions: summariseReactions(r.reactions),
    ...telegramMessageMetadata(r),
  })

  // Detect when ancestors hit the climb limit without finding the root —
  // useful signal for the caller ("there's more above, raise max_depth").
  const ancestorChainTruncated =
    ancestors.length === max_depth &&
    ancestors[0]?.parent_external_id != null
  // Same for descendants — if we returned exactly max_descendants the tree
  // probably had more.
  const descendantsTruncated = descendants.length === max_descendants

  return {
    center: {
      item_id: center.id,
      external_id: center.external_id,
      parent_external_id: center.parent_external_id || null,
      published_at: center.published_at,
      sender: center.sender,
      type: center.type,
      caption: (center.caption || '').slice(0, 800),
      reactions: summariseReactions(center.reactions),
      ...telegramMessageMetadata(center),
    },
    ancestors: ancestors.map(trim),
    descendants: descendants.map(trim),
    ancestor_chain_truncated: ancestorChainTruncated,
    descendants_truncated: descendantsTruncated,
  }
}

// ========== GT EDITOR HELPERS ==========

function gtListFolders() {
  const h = getGtDb()
  const rows = h.prepare(`
    SELECT root,
           COUNT(*) AS notes,
           MAX(indexed_at) AS last_at
      FROM search_notes
     GROUP BY root
     ORDER BY last_at DESC
  `).all()
  const out = []
  for (const r of rows) {
    const chunks = h.prepare(`
      SELECT COUNT(*) AS c FROM search_chunks
       WHERE note_id IN (SELECT id FROM search_notes WHERE root = ?)
    `).get(r.root)?.c || 0
    const embedded = h.prepare(`
      SELECT COUNT(*) AS c FROM search_chunks
       WHERE embedded = 1 AND note_id IN (SELECT id FROM search_notes WHERE root = ?)
    `).get(r.root)?.c || 0
    out.push({
      root: r.root,
      notes: r.notes,
      chunks,
      embedded,
      last_indexed_at: (r.last_at || 0) * 1000,
    })
  }
  return { folders: out }
}

// Cosine = 1 - L²/2 for L2-normalised vectors (same convention as sc-desktop).
async function gtSearch({ query, root, limit, min_cos }) {
  const h = getGtDb()
  // Reuse the existing embedder — it returns L2-normalised 768-d vectors
  // produced by gemini-embedding-001, identical to the gt-editor indexer.
  const queryVec = await embedQuery(query)
  const buf = Buffer.from(new Float32Array(queryVec).buffer)
  const k = Math.min(200, Math.max(limit * 3, 30))
  const params = [buf, k]
  let rootClause = ''
  if (root) { rootClause = 'AND n.root = ?'; params.push(root) }
  const rows = h.prepare(`
    SELECT v.chunk_id, v.distance,
           c.display_text, c.line_start, c.line_end, c.idx,
           n.id AS note_id, n.path, n.title, n.root
      FROM search_chunks_vec v
      JOIN search_chunks c ON c.id = v.chunk_id
      JOIN search_notes n ON n.id = c.note_id
     WHERE v.embedding MATCH ? AND k = ? ${rootClause}
     ORDER BY v.distance
  `).all(...params)

  const results = rows.map(r => {
    const d = r.distance
    const cos = 1 - (d * d) / 2
    return {
      chunk_id: r.chunk_id,
      note_id: r.note_id,
      path: r.path,
      title: r.title,
      root: r.root,
      idx: r.idx,
      line_start: r.line_start,
      line_end: r.line_end,
      cos: Number(cos.toFixed(3)),
      snippet: (r.display_text || '').slice(0, 1500),
    }
  }).filter(r => r.cos >= min_cos).slice(0, limit)

  // Group by file for compact output: hits_per_file lets the caller decide
  // whether to expand a whole file or stay with top chunks.
  const byFile = new Map()
  for (const r of results) {
    if (!byFile.has(r.path)) byFile.set(r.path, { path: r.path, note_id: r.note_id, max_cos: 0, hits: [] })
    const g = byFile.get(r.path)
    g.hits.push(r)
    if (r.cos > g.max_cos) g.max_cos = r.cos
  }
  return {
    query,
    root: root || null,
    threshold: min_cos,
    returned: results.length,
    results,                         // flat list, ranked by cos
    groups: Array.from(byFile.values()).sort((a, b) => b.max_cos - a.max_cos),
  }
}

function gtResolveNote({ note_id, path: filePath }) {
  const h = getGtDb()
  if (note_id) {
    return h.prepare('SELECT id, path, title, root, mtime FROM search_notes WHERE id = ?').get(note_id)
  }
  if (filePath) {
    return h.prepare('SELECT id, path, title, root, mtime FROM search_notes WHERE path = ?').get(filePath)
  }
  return null
}

// embed_error column was added by gt-editor's semantic-index migration. Guard against an
// older DB (sc-desktop may read before gt-editor upgraded it) by probing once.
let _gtHasEmbedError = null
function gtEmbedErrorAvailable(h) {
  if (_gtHasEmbedError === null) {
    try { _gtHasEmbedError = h.prepare("SELECT embed_error FROM search_chunks LIMIT 1") && true }
    catch { _gtHasEmbedError = false }
  }
  return _gtHasEmbedError
}

function gtNoteChunks({ note_id, path: filePath, offset, limit }) {
  const h = getGtDb()
  const note = gtResolveNote({ note_id, path: filePath })
  if (!note) return { error: 'note not found', hint: 'pass note_id (from gt_search) or an absolute path' }
  const hasErr = gtEmbedErrorAvailable(h)
  const rows = h.prepare(`
    SELECT id AS chunk_id, idx, line_start, line_end, display_text, embedded${hasErr ? ', embed_error' : ''}
      FROM search_chunks WHERE note_id = ?
     ORDER BY idx ASC
     LIMIT ? OFFSET ?
  `).all(note.id, limit, offset)
  const total = h.prepare('SELECT COUNT(*) AS c FROM search_chunks WHERE note_id = ?').get(note.id).c
  return {
    note: { note_id: note.id, path: note.path, title: note.title, root: note.root },
    total,
    offset,
    chunks: rows.map(r => ({
      chunk_id: r.chunk_id,
      idx: r.idx,
      line_start: r.line_start,
      line_end: r.line_end,
      text: r.display_text,
      // embedded=0 now means EITHER pending OR skipped-too-large; embed_error disambiguates.
      embedded: !!r.embedded,
      skipped: hasErr ? !!r.embed_error : false,   // true = intentionally not embedded (over token limit)
    })),
  }
}

function gtNoteContent({ note_id, path: filePath }) {
  const note = gtResolveNote({ note_id, path: filePath })
  if (!note) return { error: 'note not found' }
  try {
    const content = fs.readFileSync(note.path, 'utf8')
    return {
      note: { note_id: note.id, path: note.path, title: note.title, root: note.root, mtime: note.mtime },
      bytes: content.length,
      content,
    }
  } catch (e) {
    return { error: 'read failed', message: e.message, path: note.path }
  }
}

function gtNeighbors(chunk_id, before, after) {
  const h = getGtDb()
  const center = h.prepare(`
    SELECT id, note_id, idx, line_start, line_end, display_text
      FROM search_chunks WHERE id = ?
  `).get(chunk_id)
  if (!center) return { error: 'chunk not found' }
  const beforeRows = h.prepare(`
    SELECT id AS chunk_id, idx, line_start, line_end, display_text
      FROM search_chunks
     WHERE note_id = ? AND idx < ?
     ORDER BY idx DESC LIMIT ?
  `).all(center.note_id, center.idx, before).reverse()
  const afterRows = h.prepare(`
    SELECT id AS chunk_id, idx, line_start, line_end, display_text
      FROM search_chunks
     WHERE note_id = ? AND idx > ?
     ORDER BY idx ASC LIMIT ?
  `).all(center.note_id, center.idx, after)
  const note = h.prepare('SELECT id, path, title, root FROM search_notes WHERE id = ?').get(center.note_id)
  const trim = r => ({
    chunk_id: r.chunk_id, idx: r.idx,
    line_start: r.line_start, line_end: r.line_end,
    text: r.display_text,
  })
  return {
    note: { note_id: note?.id, path: note?.path, title: note?.title, root: note?.root },
    before: beforeRows.map(trim),
    center: { chunk_id: center.id, idx: center.idx,
              line_start: center.line_start, line_end: center.line_end,
              text: center.display_text },
    after: afterRows.map(trim),
  }
}

function gtKvGet(key, fallback = null) {
  const h = getGtDb()
  const row = h.prepare('SELECT value FROM kv_store WHERE key = ?').get(key)
  if (!row) return fallback
  try {
    return JSON.parse(row.value)
  } catch {
    return fallback
  }
}

function gtKvSet(key, value) {
  const h = getGtDb()
  h.prepare(`
    INSERT INTO kv_store (key, value, updated_at)
    VALUES (?, ?, strftime('%s', 'now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = strftime('%s', 'now')
  `).run(key, JSON.stringify(value))
}

function gtListBackgroundPalette() {
  const settings = gtKvGet('gt-settings', {}) || {}
  const palette = Array.isArray(settings.lineBackgrounds) && settings.lineBackgrounds.length
    ? settings.lineBackgrounds
    : GT_FALLBACK_LINE_BACKGROUNDS

  return {
    palette: palette
      .filter(bg => bg && typeof bg.id === 'string' && bg.id.trim())
      .map(bg => ({
        id: String(bg.id),
        name: typeof bg.name === 'string' ? bg.name : String(bg.id),
        color: typeof bg.color === 'string' ? bg.color : undefined,
      })),
  }
}

function gtReadAllLineBackgrounds() {
  const all = gtKvGet('gt-line-backgrounds', {})
  return all && typeof all === 'object' && !Array.isArray(all) ? all : {}
}

function gtIsStructuredLineBackgroundPayload(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.prototype.hasOwnProperty.call(value, 'lines') ||
     Object.prototype.hasOwnProperty.call(value, 'ranges'))
}

function gtGetLineBackgroundLines(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const raw = gtIsStructuredLineBackgroundPayload(value) ? value.lines : value
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [line, bgId] of Object.entries(raw)) {
    if (!bgId) continue
    out[String(line)] = String(bgId)
  }
  return out
}

function gtGetLineBackgroundRanges(value) {
  if (!gtIsStructuredLineBackgroundPayload(value) || !Array.isArray(value.ranges)) return []
  return value.ranges
    .filter(r => r && typeof r === 'object' && r.bgId)
    .map(r => ({
      fromLine: Number(r.fromLine),
      fromCh: Number(r.fromCh),
      toLine: Number(r.toLine),
      toCh: Number(r.toCh),
      bgId: String(r.bgId),
    }))
    .filter(r =>
      Number.isInteger(r.fromLine) && Number.isInteger(r.fromCh) &&
      Number.isInteger(r.toLine) && Number.isInteger(r.toCh) &&
      r.fromLine >= 1 && r.fromCh >= 0 && r.toLine >= 1 && r.toCh >= 0
    )
}

function gtBuildLineBackgroundPayload(lines, ranges = []) {
  const cleanLines = gtGetLineBackgroundLines(lines)
  const cleanRanges = Array.isArray(ranges)
    ? ranges.filter(r => r && typeof r === 'object' && r.bgId)
    : []
  if (cleanRanges.length > 0) return { lines: cleanLines, ranges: cleanRanges }
  return cleanLines
}

function gtIsEmptyLineBackgroundPayload(value) {
  return Object.keys(gtGetLineBackgroundLines(value)).length === 0 &&
    gtGetLineBackgroundRanges(value).length === 0
}

function gtReplaceLineBackgroundLines(existing, nextLines) {
  return gtBuildLineBackgroundPayload(nextLines, gtGetLineBackgroundRanges(existing))
}

function gtNormalizeBgId(raw) {
  const value = raw == null ? '' : String(raw).trim()
  if (!value || value === 'none' || value === 'null' || value === 'clear') return null
  return value
}

function gtReadFileLines(filePath) {
  const content = fs.readFileSync(filePath, 'utf8')
  return content.split('\n')
}

function gtGetLineCountForFile(filePath) {
  return gtReadFileLines(filePath).length
}

function gtNormalizeLineRanges(args, lineCount) {
  const out = []
  const addRange = (fromRaw, toRaw = fromRaw) => {
    const from = Number(fromRaw)
    const to = Number(toRaw)
    if (!Number.isInteger(from) || !Number.isInteger(to)) return
    const a = Math.min(from, to)
    const b = Math.max(from, to)
    if (a < 1 || b > lineCount) {
      throw new Error(`Line range ${a}-${b} is outside file bounds 1-${lineCount}`)
    }
    out.push([a, b])
  }

  if (Array.isArray(args.lines)) {
    for (const line of args.lines) addRange(line)
  }
  if (Array.isArray(args.ranges)) {
    for (const range of args.ranges) {
      if (!range || typeof range !== 'object') continue
      addRange(range.from ?? range.from_line ?? range.start, range.to ?? range.to_line ?? range.end ?? range.from ?? range.from_line ?? range.start)
    }
  }
  if (args.line != null) addRange(args.line)
  if (args.from != null || args.from_line != null || args.start != null) {
    const from = args.from ?? args.from_line ?? args.start
    const to = args.to ?? args.to_line ?? args.end ?? from
    addRange(from, to)
  }

  if (out.length === 0) throw new Error('No valid lines or ranges provided')
  return out
}

function gtNotifyLineBackgroundsChanged(filePath) {
  if (process.platform !== 'darwin') return false
  const url = 'gteditor://line-backgrounds-changed?path=' + encodeURIComponent(filePath)
  try {
    const child = spawn('/usr/bin/open', ['-g', url], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    return true
  } catch {
    return false
  }
}

function gtGetLineBackgrounds(filePath) {
  const all = gtReadAllLineBackgrounds()
  const payload = all[filePath] || {}
  return {
    path: filePath,
    backgrounds: gtGetLineBackgroundLines(payload),
    ranges: gtGetLineBackgroundRanges(payload),
    raw: payload,
  }
}

function gtSetLineBackgrounds(args) {
  const filePath = args.path
  if (!filePath || typeof filePath !== 'string') throw new Error('path is required')
  if (!path.isAbsolute(filePath)) throw new Error('path must be absolute')
  if (!fs.existsSync(filePath)) throw new Error('file does not exist: ' + filePath)

  const bgId = gtNormalizeBgId(args.bg_id ?? args.bgId ?? args.background_id)
  const palette = gtListBackgroundPalette().palette
  if (bgId && !palette.some(bg => bg.id === bgId)) {
    return {
      success: false,
      error: 'Unknown bg_id: ' + bgId,
      available: palette.map(bg => ({ id: bg.id, name: bg.name })),
    }
  }

  const lineCount = gtGetLineCountForFile(filePath)
  const ranges = gtNormalizeLineRanges(args, lineCount)
  const all = gtReadAllLineBackgrounds()
  const existingPayload = all[filePath] || {}
  const nextLines = { ...gtGetLineBackgroundLines(existingPayload) }
  let changed = 0

  for (const [from, to] of ranges) {
    for (let line = from; line <= to; line++) {
      const key = String(line)
      if (bgId) {
        if (nextLines[key] !== bgId) changed++
        nextLines[key] = bgId
      } else if (key in nextLines) {
        delete nextLines[key]
        changed++
      }
    }
  }

  const nextMap = gtReplaceLineBackgroundLines(existingPayload, nextLines)
  if (!gtIsEmptyLineBackgroundPayload(nextMap)) all[filePath] = nextMap
  else delete all[filePath]
  gtKvSet('gt-line-backgrounds', all)

  const notified = gtNotifyLineBackgroundsChanged(filePath)
  return {
    success: true,
    path: filePath,
    bg_id: bgId,
    changed,
    ranges: ranges.map(([from, to]) => ({ from, to })),
    backgrounds: nextLines,
    text_ranges: gtGetLineBackgroundRanges(nextMap),
    notified,
  }
}

function gtComparePoints(a, b) {
  if (a.line !== b.line) return a.line - b.line
  return a.ch - b.ch
}

function gtReadPoint(raw, prefix) {
  const obj = raw && typeof raw[prefix] === 'object' ? raw[prefix] : null
  const line =
    (obj ? obj.line : undefined) ??
    raw[`${prefix}_line`] ??
    raw[`${prefix}Line`] ??
    raw[`${prefix}_Line`]
  let ch =
    (obj ? obj.ch : undefined) ??
    raw[`${prefix}_ch`] ??
    raw[`${prefix}Ch`]
  const col =
    (obj ? obj.col : undefined) ??
    raw[`${prefix}_col`] ??
    raw[`${prefix}Col`]
  if (ch == null && col != null) ch = Number(col) - 1
  return { line: Number(line), ch: Number(ch) }
}

function gtNormalizeTextPoint(point, lines, label) {
  if (!Number.isInteger(point.line) || point.line < 1 || point.line > lines.length) {
    throw new Error(`${label}.line is outside file bounds 1-${lines.length}`)
  }
  const lineText = lines[point.line - 1] || ''
  if (!Number.isInteger(point.ch) || point.ch < 0 || point.ch > lineText.length) {
    throw new Error(`${label}.ch is outside line ${point.line} bounds 0-${lineText.length}`)
  }
  return point
}

function gtNormalizeTextRanges(args, lines) {
  const out = []
  const add = (raw) => {
    const from = gtNormalizeTextPoint(gtReadPoint(raw, 'from'), lines, 'from')
    const to = gtNormalizeTextPoint(gtReadPoint(raw, 'to'), lines, 'to')
    let a = from
    let b = to
    if (gtComparePoints(a, b) > 0) [a, b] = [b, a]
    if (gtComparePoints(a, b) === 0) return
    out.push({ fromLine: a.line, fromCh: a.ch, toLine: b.line, toCh: b.ch })
  }

  if (Array.isArray(args.ranges)) {
    for (const range of args.ranges) {
      if (range && typeof range === 'object') add(range)
    }
  }
  if (args.from_line != null || args.fromLine != null) {
    add({
      from_line: args.from_line ?? args.fromLine,
      from_ch: args.from_ch ?? args.fromCh ?? 0,
      to_line: args.to_line ?? args.toLine ?? args.from_line ?? args.fromLine,
      to_ch: args.to_ch ?? args.toCh,
      to_col: args.to_col ?? args.toCol,
    })
  }

  if (out.length === 0) throw new Error('No valid text ranges provided')
  return out
}

function gtLineStarts(lines) {
  const starts = []
  let pos = 0
  for (const line of lines) {
    starts.push(pos)
    pos += line.length + 1
  }
  return starts
}

function gtPointToOffset(point, lines, starts) {
  gtNormalizeTextPoint({ line: point.fromLine ?? point.line, ch: point.fromCh ?? point.ch }, lines, 'point')
  const line = point.fromLine ?? point.line
  const ch = point.fromCh ?? point.ch
  return starts[line - 1] + ch
}

function gtRangeToOffsets(range, lines, starts) {
  return {
    from: gtPointToOffset({ line: range.fromLine, ch: range.fromCh }, lines, starts),
    to: gtPointToOffset({ line: range.toLine, ch: range.toCh }, lines, starts),
    bgId: range.bgId,
  }
}

function gtStoredRangesToOffsets(payload, lines, starts) {
  const out = []
  for (const range of gtGetLineBackgroundRanges(payload)) {
    try {
      out.push(gtRangeToOffsets(range, lines, starts))
    } catch {
      // Stale range after out-of-band file edits. Drop it on the next write,
      // matching the editor-side "range belongs to text" model.
    }
  }
  return out
}

function gtOffsetToPoint(offset, lines, starts) {
  for (let i = 0; i < lines.length; i++) {
    const start = starts[i]
    const end = start + lines[i].length
    if (offset <= end || i === lines.length - 1) {
      return { line: i + 1, ch: Math.max(0, Math.min(offset - start, lines[i].length)) }
    }
  }
  const last = lines.length - 1
  return { line: lines.length, ch: lines[last].length }
}

function gtOffsetsToRange(range, lines, starts) {
  const from = gtOffsetToPoint(range.from, lines, starts)
  const to = gtOffsetToPoint(range.to, lines, starts)
  return {
    fromLine: from.line,
    fromCh: from.ch,
    toLine: to.line,
    toCh: to.ch,
    bgId: range.bgId,
  }
}

function gtNormalizeOffsetRanges(ranges) {
  const sorted = ranges
    .filter(r => r && r.bgId && Number.isFinite(r.from) && Number.isFinite(r.to) && r.from < r.to)
    .map(r => ({ from: r.from, to: r.to, bgId: String(r.bgId) }))
    .sort((a, b) => a.from - b.from || a.to - b.to)
  const out = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && last.bgId === r.bgId && r.from <= last.to) {
      last.to = Math.max(last.to, r.to)
    } else {
      out.push(r)
    }
  }
  return out
}

function gtCutOffsetRanges(ranges, cuts) {
  let result = ranges.map(r => ({ ...r }))
  for (const cut of cuts) {
    const from = Math.min(cut.from, cut.to)
    const to = Math.max(cut.from, cut.to)
    if (from >= to) continue
    const next = []
    for (const r of result) {
      if (r.to <= from || r.from >= to) {
        next.push(r)
        continue
      }
      if (r.from < from) next.push({ from: r.from, to: from, bgId: r.bgId })
      if (r.to > to) next.push({ from: to, to: r.to, bgId: r.bgId })
    }
    result = next
  }
  return gtNormalizeOffsetRanges(result)
}

function gtSetTextBackgrounds(args) {
  const filePath = args.path
  if (!filePath || typeof filePath !== 'string') throw new Error('path is required')
  if (!path.isAbsolute(filePath)) throw new Error('path must be absolute')
  if (!fs.existsSync(filePath)) throw new Error('file does not exist: ' + filePath)

  const bgId = gtNormalizeBgId(args.bg_id ?? args.bgId ?? args.background_id)
  const palette = gtListBackgroundPalette().palette
  if (bgId && !palette.some(bg => bg.id === bgId)) {
    return {
      success: false,
      error: 'Unknown bg_id: ' + bgId,
      available: palette.map(bg => ({ id: bg.id, name: bg.name })),
    }
  }

  const lines = gtReadFileLines(filePath)
  const starts = gtLineStarts(lines)
  const requestedRanges = gtNormalizeTextRanges(args, lines)
  const requestedOffsets = requestedRanges.map(r => ({
    from: gtPointToOffset({ line: r.fromLine, ch: r.fromCh }, lines, starts),
    to: gtPointToOffset({ line: r.toLine, ch: r.toCh }, lines, starts),
  }))

  const all = gtReadAllLineBackgrounds()
  const existingPayload = all[filePath] || {}
  const existingLines = gtGetLineBackgroundLines(existingPayload)
  const existingRanges = gtStoredRangesToOffsets(existingPayload, lines, starts)
  let nextRanges = gtCutOffsetRanges(existingRanges, requestedOffsets)
  if (bgId) {
    nextRanges = gtNormalizeOffsetRanges([
      ...nextRanges,
      ...requestedOffsets.map(r => ({ ...r, bgId })),
    ])
  }
  const serializedRanges = nextRanges.map(r => gtOffsetsToRange(r, lines, starts))
  const nextPayload = gtBuildLineBackgroundPayload(existingLines, serializedRanges)

  if (!gtIsEmptyLineBackgroundPayload(nextPayload)) all[filePath] = nextPayload
  else delete all[filePath]
  gtKvSet('gt-line-backgrounds', all)

  const notified = gtNotifyLineBackgroundsChanged(filePath)
  return {
    success: true,
    path: filePath,
    bg_id: bgId,
    changed: JSON.stringify(gtGetLineBackgroundRanges(existingPayload)) !== JSON.stringify(serializedRanges),
    ranges: requestedRanges,
    backgrounds: existingLines,
    text_ranges: serializedRanges,
    notified,
  }
}

// Long-running stdio transport. Errors after init shouldn't kill the process —
// MCP clients reuse the same connection across many tool calls.
const transport = new StdioServerTransport()
loadYougileToolBridge()
  .then((bridge) => {
    yougileToolBridge = bridge
    const existing = new Set(TOOLS.map(tool => tool.name))
    const collisions = bridge.tools.filter(tool => existing.has(tool.name))
    if (collisions.length) {
      throw new Error(`YouGile tool collision: ${collisions.map(tool => tool.name).join(', ')}`)
    }
    TOOLS.push(...bridge.tools)
    return server.connect(transport)
  })
  .catch((err) => {
    console.error('[sc-mcp] transport failed:', err)
    process.exit(1)
  })
