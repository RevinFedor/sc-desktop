const AI_STUDIO_DEFAULT_SETTINGS = Object.freeze({
  scrapeImages: true,
  scrapeAttachments: true,
  scrapeAttachmentPreview: true,
  scrapeAttachmentTitle: true,
  scrapeAttachmentSize: true,
  scrapeReasoning: true,
});

function sanitizeSettings(raw = {}) {
  const sanitized = { ...AI_STUDIO_DEFAULT_SETTINGS };
  const coerceBool = (v, fb) => typeof v === 'boolean' ? v : fb;
  sanitized.scrapeImages            = coerceBool(raw.scrapeImages,            sanitized.scrapeImages);
  sanitized.scrapeAttachments       = coerceBool(raw.scrapeAttachments,       sanitized.scrapeAttachments);
  sanitized.scrapeAttachmentPreview = coerceBool(raw.scrapeAttachmentPreview, sanitized.scrapeAttachmentPreview);
  sanitized.scrapeAttachmentTitle   = coerceBool(raw.scrapeAttachmentTitle,   sanitized.scrapeAttachmentTitle);
  sanitized.scrapeAttachmentSize    = coerceBool(raw.scrapeAttachmentSize,    sanitized.scrapeAttachmentSize);
  sanitized.scrapeReasoning         = coerceBool(raw.scrapeReasoning,         sanitized.scrapeReasoning);
  return sanitized;
}

const EXPORT_DEFAULT_SETTINGS = Object.freeze({
  downloadFile: false,
});

function sanitizeExportSettings(raw = {}) {
  const s = { ...EXPORT_DEFAULT_SETTINGS };
  s.downloadFile = typeof raw.downloadFile === 'boolean' ? raw.downloadFile : s.downloadFile;
  return s;
}

function isAIStudioUrl(maybeUrl) {
  try {
    const parsed = new URL(maybeUrl);
    return parsed.protocol === 'https:' &&
      parsed.hostname === 'aistudio.google.com' &&
      /^\/(?:u\/\d+\/)?prompts\//.test(parsed.pathname);
  } catch (error) {
    return false;
  }
}

function isPerplexityUrl(maybeUrl) {
  try {
    const parsed = new URL(maybeUrl);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.perplexity.ai') return false;
    return /^\/(?:search|computer\/tasks)\//.test(parsed.pathname);
  } catch (error) {
    return false;
  }
}

function isClaudeChatUrl(maybeUrl) {
  try {
    const parsed = new URL(maybeUrl);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'claude.ai') return false;
    return /^\/chat\/[0-9a-f-]+/i.test(parsed.pathname);
  } catch (error) {
    return false;
  }
}

function isYouTubeUrl(maybeUrl) {
  try {
    const parsed = new URL(maybeUrl);
    if (parsed.protocol !== 'https:') return false;
    return parsed.hostname === 'www.youtube.com'
        || parsed.hostname === 'm.youtube.com'
        || parsed.hostname === 'youtube.com';
  } catch (error) {
    return false;
  }
}

function detectSite(maybeUrl) {
  if (isAIStudioUrl(maybeUrl)) return 'aistudio';
  if (isPerplexityUrl(maybeUrl)) return 'perplexity';
  if (isClaudeChatUrl(maybeUrl)) return 'claude';
  if (isYouTubeUrl(maybeUrl))   return 'youtube';
  return null;
}

const PERPLEXITY_DEFAULT_SETTINGS = Object.freeze({
  show_sources: true,    // include web_results as a footnote list under each answer
  show_related: true,    // include related_queries under the LAST entry
  asi_min_chunk_len: 250,// in ASI mode, plan.goals[].description shorter than this is status text, ignore
});

function sanitizePerplexitySettings(raw = {}) {
  const s = { ...PERPLEXITY_DEFAULT_SETTINGS };
  const cb = (v, fb) => typeof v === 'boolean' ? v : fb;
  s.show_sources = cb(raw.show_sources, s.show_sources);
  s.show_related = cb(raw.show_related, s.show_related);
  const n = Number(raw.asi_min_chunk_len);
  if (Number.isFinite(n) && n >= 50 && n <= 2000) s.asi_min_chunk_len = Math.round(n);
  return s;
}

const CLAUDE_EXPORT_DEFAULT_SETTINGS = Object.freeze({
  includeReattachedFiles: true,
});

function sanitizeClaudeExportSettings(raw = {}) {
  const s = { ...CLAUDE_EXPORT_DEFAULT_SETTINGS };
  s.includeReattachedFiles = typeof raw.includeReattachedFiles === 'boolean'
    ? raw.includeReattachedFiles
    : s.includeReattachedFiles;
  return s;
}

// YouTube settings — управляют «забрать видео в sc-desktop» flow.
// auto_aistudio = после готовности транскрипта открывать AI Studio в новой
// вкладке, выбирать модель, проставлять system instruction и paste'ить текст.
// Хранится плоским объектом под ключом __yt в chrome.storage.sync.
// Доступные модели в Gemini Studio. Названия — ТОЧНО как в карточке
// `button.model-selector-card .title` (текст с UI). Если YouTube или
// Gemini переименует — поменять здесь, остальная логика не зависит.
// Расширяй массивом, не запоминай порядок — popup рендерит select из этого.
const YOUTUBE_AVAILABLE_MODELS = Object.freeze([
  'Gemini 3 Flash Preview',
  'Gemini 3.1 Pro Preview',
]);

// Доступные модели в claude.ai dropdown'е (текст в model-selector-dropdown).
// Имена — как они отображаются в Radix-меню при клике на model-selector.
// Подменю «More models» сюда НЕ включаем — там устаревшие варианты,
// автоскрапинг работает только с top-level радио.
const CLAUDE_AVAILABLE_MODELS = Object.freeze([
  'Opus 4.7',
  'Sonnet 4.6',
  'Haiku 4.5',
]);

// Куда отправляется транскрипт после клика «+ ai» на YouTube-карточке.
// Один target за раз — выбор Gemini или Claude. Раздельные настройки
// (sys-prompt, проект, модель) каждого target'а живут параллельно в
// storage, чтобы переключение target'а не теряло прошлую конфигурацию.
const YOUTUBE_TARGETS = Object.freeze(['aistudio', 'claude']);

const YOUTUBE_ENGINES = Object.freeze(['gemini', 'assemblyai']);

const YOUTUBE_DEFAULT_SETTINGS = Object.freeze({
  auto_aistudio: false,           // legacy-поле, всегда false (split-pill решает)
  with_comments: false,
  // Движок AI-транскрипции когда субтитров нет (awaiting_ai → resume).
  // gemini (дёшево, быстро) | assemblyai (длинные файлы 1-10ч). Прокидывается
  // в __sc_track_job → trackJob.engine → POST /yt-resume-ai. Дефолт gemini.
  engine: 'gemini',
  // Куда отправлять: `aistudio` (Gemini Studio) или `claude` (claude.ai).
  target: 'aistudio',
  // ── Gemini-side настройки ─────────────────────────────────────────
  system_instruction: '',
  post_system_instruction: '',
  model_title: 'Gemini 3 Flash Preview',
  post_model_title: 'Gemini 3.1 Pro Preview',
  // ── Claude-side настройки ─────────────────────────────────────────
  // Проект — НАЗВАНИЕ из «Add to project» submenu claude.ai. Пустая строка
  // = не выбирать проект (отправить в обычный чат). Аналог
  // system_instruction в Gemini'и.
  claude_project: '',
  // Проект, на который переключаем ПОСЛЕ submit — чтобы наш sys-prompt
  // (через project) не висел над следующими вопросами юзера. Пустая
  // строка = не переключать (остаётся claude_project).
  // Внимание: технически на claude.ai переключить project в существующем
  // чате нельзя — chat создан внутри проекта при первом submit. Это поле
  // используется как дефолт для СЛЕДУЮЩЕГО видоса (если юзер запустит
  // второй submit в той же вкладке после reload).
  claude_post_project: '',
  // Модель на claude.ai. Одна — без post_model переключения (Claude не
  // переключает модель mid-chat, только при создании нового).
  claude_model: 'Opus 4.7',
  // Adaptive thinking — checkbox в модель-меню. По умолчанию ON.
  claude_adaptive_thinking: true,
});

function sanitizeYoutubeSettings(raw = {}) {
  const s = { ...YOUTUBE_DEFAULT_SETTINGS };
  const cb = (v, fb) => typeof v === 'boolean' ? v : fb;
  s.auto_aistudio = cb(raw.auto_aistudio, s.auto_aistudio);
  s.with_comments = cb(raw.with_comments, s.with_comments);
  if (typeof raw.engine === 'string' && YOUTUBE_ENGINES.includes(raw.engine)) {
    s.engine = raw.engine;
  }
  if (typeof raw.target === 'string' && YOUTUBE_TARGETS.includes(raw.target)) {
    s.target = raw.target;
  }
  if (typeof raw.system_instruction === 'string') {
    s.system_instruction = raw.system_instruction.slice(0, 8000); // sane cap
  }
  if (typeof raw.post_system_instruction === 'string') {
    s.post_system_instruction = raw.post_system_instruction.slice(0, 8000);
  }
  // Модели: разрешаем только то что мы знаем (enum) — иначе ensureModel
  // поломается на неизвестном тайтле. Если в storage'е лежит legacy-значение
  // не из списка — игнорируем и оставляем default.
  if (typeof raw.model_title === 'string' && YOUTUBE_AVAILABLE_MODELS.includes(raw.model_title)) {
    s.model_title = raw.model_title;
  }
  if (typeof raw.post_model_title === 'string') {
    if (raw.post_model_title === '' || YOUTUBE_AVAILABLE_MODELS.includes(raw.post_model_title)) {
      s.post_model_title = raw.post_model_title;
    }
  }
  if (typeof raw.claude_project === 'string') {
    s.claude_project = raw.claude_project.slice(0, 200);
  }
  if (typeof raw.claude_post_project === 'string') {
    s.claude_post_project = raw.claude_post_project.slice(0, 200);
  }
  if (typeof raw.claude_model === 'string' && CLAUDE_AVAILABLE_MODELS.includes(raw.claude_model)) {
    s.claude_model = raw.claude_model;
  }
  s.claude_adaptive_thinking = cb(raw.claude_adaptive_thinking, s.claude_adaptive_thinking);
  return s;
}
