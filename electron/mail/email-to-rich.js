// Письмо → Telegram Rich Message (Bot API 10.1+).
//
// Зачем отдельный слой: почтовый HTML — это вёрстка для браузера (таблицы,
// инлайн-стили, трекинг-пиксели, мусор от Outlook). Telegram понимает узкий
// набор тегов и рендерит остальное как попало. Мы не «экранируем» письмо,
// а пересобираем его в те блоки, которые Telegram умеет показывать.
//
// Проверенные на живом API границы (см. docs Rich Message Limits):
//   32768 UTF-8 символов, 500 блоков, 16 уровней вложенности.
//   Пустое тело → RICH_MESSAGE_EMPTY, перебор → RICH_MESSAGE_TEXT_TOO_LONG.

const RICH_TEXT_LIMIT = 32768
const RICH_BLOCK_LIMIT = 500
// Оставляем воздух: лимит считается по итоговому тексту, а мы не знаем точную
// формулу Telegram для alt-текста эмодзи и формул. 2000 символов запаса.
const SAFE_TEXT_LIMIT = 30000
const SUMMARY_LIMIT = 120

// Теги, которые Telegram реально рендерит в rich message. Всё остальное
// разворачивается в текст (unwrap) или выбрасывается вместе с содержимым.
const INLINE_KEEP = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code', 'mark', 'sub', 'sup'])
const DROP_WITH_CONTENT = new Set(['script', 'style', 'head', 'title', 'meta', 'link', 'noscript', 'svg', 'iframe', 'object', 'embed', 'form', 'button', 'input', 'select', 'textarea'])
const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'tr', 'table', 'tbody', 'thead', 'ul', 'ol', 'li', 'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'hr', 'td', 'th'])

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', bull: '•',
  middot: '·', copy: '©', reg: '®', trade: '™', deg: '°', euro: '€',
  pound: '£', times: '×', shy: '', zwnj: '', ensp: ' ', emsp: ' ', thinsp: ' ',
}

function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      try { return String.fromCodePoint(code) } catch { return whole }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()]
    return named === undefined ? whole : named
  })
}

// Telegram принимает только эти именованные сущности, остальные надо
// отдавать уже раскодированными.
function escapeText(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function isHttpUrl(href) {
  return /^https?:\/\//i.test(String(href || '').trim())
}

// Ссылки в письмах почти всегда обёрнуты в редирект-трекер. Показываем
// пользователю настоящий адрес, если он лежит в query-параметре.
function unwrapTrackingUrl(href) {
  const raw = String(href || '').trim()
  if (!isHttpUrl(raw)) return raw
  let url
  try { url = new URL(raw) } catch { return raw }
  for (const key of ['url', 'u', 'target', 'redirect', 'redirect_uri', 'dest', 'destination', 'link', 'r']) {
    const candidate = url.searchParams.get(key)
    if (candidate && isHttpUrl(candidate)) {
      try { return new URL(candidate).toString() } catch { /* keep original */ }
    }
  }
  return raw
}

module.exports = {
  RICH_TEXT_LIMIT,
  RICH_BLOCK_LIMIT,
  SAFE_TEXT_LIMIT,
  SUMMARY_LIMIT,
  INLINE_KEEP,
  DROP_WITH_CONTENT,
  BLOCK_TAGS,
  decodeEntities,
  escapeText,
  isHttpUrl,
  unwrapTrackingUrl,
}

// --- Разбор HTML письма -----------------------------------------------------
//
// Полноценный DOM-парсер здесь не нужен и вреден: почтовый HTML часто
// невалиден (незакрытые теги, битая вложенность), а строгий парсер на таком
// либо падает, либо тихо теряет текст. Мы идём потоком по тегам и собираем
// ровно то, что Telegram умеет показать.
//
// Инлайн-стиль накапливается не строками, а «активным набором» стилей на
// каждый кусок текста. Поэтому кривая вложенность вида
// `<b>жирный <i>оба</b> курсив</i>` не может породить рассогласованные теги:
// разметка синтезируется заново из состояния, а не копируется из письма.

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

function renderRun(run) {
  let out = escapeText(run.text)
  if (!out) return ''
  if (run.code) out = `<code>${out}</code>`
  for (const style of ['s', 'u', 'i', 'b']) {
    if (run[style]) out = `<${style}>${out}</${style}>`
  }
  if (run.href) out = `<a href="${escapeText(run.href).replace(/"/g, '&quot;')}">${out}</a>`
  return out
}

function htmlToLines(html) {
  const src = String(html || '')
  const lines = []
  let runs = []                       // куски текущей строки
  const style = { b: 0, i: 0, u: 0, s: 0, code: 0 }   // счётчики вложенности
  const hrefStack = []
  const listStack = []                // null = маркер, число = нумерация
  let blockquoteDepth = 0
  let headingLevel = 0
  let preDepth = 0
  let skipUntil = null
  let skipDepth = 0

  const pushLine = () => {
    const text = runs.map(renderRun).join('')
    const plain = runs.map(r => r.text).join('')
    if (plain.trim()) {
      // Многие письма рисуют цитату текстом «> …», а не тегом blockquote.
      // Для читателя это цитата, поэтому показываем её так же.
      const textQuote = preDepth === 0 && /^\s*(&gt;|>)\s?/.test(plain.trimStart())
      lines.push({
        html: text,
        plain,
        heading: headingLevel,
        quote: blockquoteDepth > 0 || textQuote,
        pre: preDepth > 0,
      })
    }
    runs = []
  }

  const addText = (raw) => {
    if (skipUntil) return
    let text = decodeEntities(raw)
    // Внутри <pre> переводы строк значимы, снаружи это просто вёрстка.
    if (preDepth > 0) {
      const parts = text.split('\n')
      parts.forEach((part, idx) => {
        if (idx > 0) pushLine()
        if (part) runs.push({ text: part, ...snapshot() })
      })
      return
    }
    text = text.replace(/\s+/g, ' ')
    if (!text) return
    if (!runs.length && !text.trim()) return   // ведущие пробелы строки
    runs.push({ text, ...snapshot() })
  }

  const snapshot = () => ({
    b: style.b > 0, i: style.i > 0, u: style.u > 0, s: style.s > 0,
    code: style.code > 0, href: hrefStack.length ? hrefStack[hrefStack.length - 1] : null,
  })

  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)\/?>|<!--[\s\S]*?-->/g
  let pos = 0
  let match

  while ((match = tagRe.exec(src)) !== null) {
    addText(src.slice(pos, match.index))
    pos = tagRe.lastIndex
    if (match[0].startsWith('<!--')) continue

    const tag = (match[1] || '').toLowerCase()
    const attrs = match[2] || ''
    const closing = match[0][1] === '/'
    const selfClosing = /\/\s*>$/.test(match[0])

    if (skipUntil) {
      if (tag === skipUntil) {
        if (closing) { skipDepth -= 1; if (skipDepth <= 0) skipUntil = null }
        else if (!selfClosing) skipDepth += 1
      }
      continue
    }
    if (DROP_WITH_CONTENT.has(tag)) {
      if (!closing && !selfClosing) { skipUntil = tag; skipDepth = 1 }
      continue
    }

    if (tag === 'br') { pushLine(); continue }
    if (tag === 'hr') { pushLine(); lines.push({ divider: true }); continue }

    if (INLINE_KEEP.has(tag)) {
      const key = (tag === 'strong' || tag === 'b') ? 'b'
        : (tag === 'em' || tag === 'i') ? 'i'
        : (tag === 'u' || tag === 'ins') ? 'u'
        : (tag === 's' || tag === 'strike' || tag === 'del') ? 's'
        : tag === 'code' ? 'code'
        : null
      if (!key) continue                       // mark/sub/sup — просто текст
      if (closing) style[key] = Math.max(0, style[key] - 1)
      else if (!selfClosing) style[key] += 1
      continue
    }

    if (tag === 'a') {
      if (closing) { hrefStack.pop(); continue }
      if (selfClosing) continue
      const hrefMatch = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs)
      const href = decodeEntities(hrefMatch?.[2] ?? hrefMatch?.[3] ?? hrefMatch?.[4] ?? '')
      const clean = unwrapTrackingUrl(href)
      hrefStack.push((isHttpUrl(clean) || /^(mailto|tel):/i.test(clean)) ? clean : null)
      continue
    }

    if (tag === 'pre') { pushLine(); preDepth += closing ? -1 : 1; preDepth = Math.max(0, preDepth); continue }
    if (tag === 'blockquote') { pushLine(); blockquoteDepth += closing ? -1 : 1; blockquoteDepth = Math.max(0, blockquoteDepth); continue }

    if (HEADING_TAGS.has(tag)) {
      pushLine()
      headingLevel = closing ? 0 : Number(tag[1])
      continue
    }

    if (tag === 'ul' || tag === 'ol') {
      pushLine()
      if (closing) listStack.pop()
      else listStack.push(tag === 'ol' ? 0 : null)
      continue
    }
    if (tag === 'li') {
      pushLine()
      if (closing) continue
      const depth = Math.max(1, listStack.length)
      const slot = listStack.length ? listStack[listStack.length - 1] : null
      let marker = '• '
      if (typeof slot === 'number') {
        listStack[listStack.length - 1] = slot + 1
        marker = `${slot + 1}. `
      }
      runs.push({ text: `${'    '.repeat(depth - 1)}${marker}`, ...snapshot(), href: null })
      continue
    }

    // Ячейки таблицы разделяем пробелами, а не переводом строки: иначе
    // «Метрика | 42 ms» рассыпается в столбик из огрызков.
    if (tag === 'td' || tag === 'th') {
      if (!closing && runs.length) runs.push({ text: '   ', ...snapshot(), href: null })
      continue
    }
    if (BLOCK_TAGS.has(tag)) { pushLine(); continue }
    // Неизвестный тег: содержимое сохраняем, сам тег выбрасываем.
  }
  addText(src.slice(pos))
  pushLine()
  return lines
}

module.exports.htmlToLines = htmlToLines
module.exports.renderRun = renderRun

// --- Сборка сообщения -------------------------------------------------------

function clip(text, limit) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(1, limit - 1)).trimEnd()}…`
}

// Из plain-text части письма строим те же строки, что и из HTML: так дальше
// работает один сборщик независимо от того, какая часть письма нам досталась.
function textToLines(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => {
      const plain = line.replace(/\s+$/g, '')
      if (!plain.trim()) return null
      // Псевдографика и отступы — признак того, что строку надо показать
      // как есть, моноширинно, иначе рамки письма разъедутся.
      const pre = /[│┃║╔╗╚╝═─━┌┐└┘├┤┬┴┼]/.test(plain) || /^\s{2,}\S/.test(line)
      return { html: escapeText(plain), plain, heading: 0, quote: /^\s*>/.test(line), pre }
    })
    .filter(Boolean)
}

function linesToHtml(lines) {
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.divider) { out.push('<hr/>'); i += 1; continue }

    // Соседние строки одного вида склеиваем в один блок — иначе цитата из
    // пяти строк превратится в пять отдельных цитат.
    if (line.pre) {
      const chunk = []
      while (i < lines.length && lines[i].pre) { chunk.push(lines[i].plain); i += 1 }
      out.push(`<pre>${escapeText(chunk.join('\n'))}</pre>`)
      continue
    }
    if (line.quote) {
      const chunk = []
      while (i < lines.length && lines[i].quote && !lines[i].pre) {
        chunk.push(lines[i].html.replace(/^(\s|<[^>]+>)*\K\s*(&gt;|>)\s?/, '').replace(/^\s*(&gt;|>)\s?/, ''))
        i += 1
      }
      out.push(`<blockquote>${chunk.join('<br/>')}</blockquote>`)
      continue
    }
    if (line.heading) {
      const level = Math.min(6, Math.max(2, line.heading + 1))   // h1 письма ≠ заголовок сообщения
      out.push(`<h${level}>${line.html}</h${level}>`)
      i += 1
      continue
    }
    out.push(`<p>${line.html}</p>`)
    i += 1
  }
  return out
}

/**
 * Собирает Telegram rich message из разобранного письма.
 *
 * @param {object} mail
 * @param {string} mail.subject      тема письма
 * @param {string} mail.fromName     отображаемое имя отправителя
 * @param {string} mail.fromAddress  адрес отправителя
 * @param {string} [mail.html]       HTML-часть
 * @param {string} [mail.text]       plain-text часть
 * @param {Date}   [mail.date]
 * @param {string} [mail.headerUrl]  куда ведёт заголовок (сайт отправителя)
 * @param {string} [mail.gmailUrl]   ссылка «открыть в Gmail»
 */
function buildRichMessage(mail = {}) {
  const subject = clip(mail.subject, 200) || '(без темы)'
  const fromName = clip(mail.fromName, 80)
  const fromAddress = clip(mail.fromAddress, 120)

  const lines = mail.html ? htmlToLines(mail.html) : textToLines(mail.text)
  const bodyLines = lines.length ? lines : textToLines(mail.text)
  let body = linesToHtml(bodyLines)
  let truncated = false

  // Строка 1: тема + время. Всё, что нужно увидеть в ленте, не раскрывая.
  // Внутри темы ссылкой подсвечено только имя отправителя.
  const when = mail.date instanceof Date && !Number.isNaN(mail.date.valueOf())
    ? ` · <tg-time unix="${Math.floor(mail.date.getTime() / 1000)}" format="wDT">${escapeText(formatWhen(mail.date))}</tg-time>`
    : ''
  const head = `<h3>${linkifyBrand(subject, mail.headerUrl, mail.fromAddress)}${when}</h3>`

  // Адрес отправителя — деталь, а не заголовок: он уезжает внутрь блока,
  // первой строкой перед телом письма.
  const senderLine = fromAddress || fromName
    ? `<p><i>${escapeText(fromAddress || fromName)}</i></p>`
    : ''
  const footer = mail.gmailUrl && isHttpUrl(mail.gmailUrl)
    ? `<footer><a href="${escapeText(mail.gmailUrl).replace(/"/g, '&quot;')}">Открыть в Gmail</a></footer>`
    : ''

  const assemble = (blocks) => {
    const inner = blocks.join('')
    // Тело письма прячем под раскрывающийся блок: в ленте видно только тему
    // со временем, всё остальное — по тапу.
    const details = inner
      ? `<details><summary>${escapeText(clip(summaryFor(bodyLines, subject), SUMMARY_LIMIT))}</summary>${senderLine}${inner}${footer}</details>`
      : `<p><i>Письмо без текстового содержимого.</i></p>${senderLine}${footer}`
    return `${head}${details}`
  }

  let html = assemble(body)
  // Лимиты Telegram: режем тело, а не заголовок — шапка всегда должна дойти.
  while ((html.length > SAFE_TEXT_LIMIT || body.length > RICH_BLOCK_LIMIT - 12) && body.length > 1) {
    body = body.slice(0, Math.max(1, Math.floor(body.length * 0.8)))
    truncated = true
    html = assemble([...body, '<p><i>…письмо показано не полностью.</i></p>'])
  }
  return { html, truncated }
}

// В свёрнутой строке должен быть смысл, а не первая попавшаяся строка:
// письма часто начинаются с ASCII-рамки, логотипа или «view in browser».
const BOX_DRAWING = /[\u2500-\u257f\u2580-\u259f]|(?<![\p{L}\p{N}])[=_*~+#|]{2,}(?![\p{L}\p{N}])/gu
const BOILERPLATE = /^(view (this )?(e-?mail )?in (your )?browser|unsubscribe|отписаться|если письмо не отображается|no-?reply)/i

// Ссылкой делаем не весь заголовок, а только имя отправителя внутри него:
// целиком синяя строка читается как кнопка и мешает читать тему письма.
// Ищем в теме название сайта (например «codexresets» из codexresets.com) и
// подсвечиваем только его. Не нашли — заголовок остаётся обычным текстом.
function linkifyBrand(subject, headerUrl, fromAddress) {
  const plain = escapeText(subject)
  if (!headerUrl || !isHttpUrl(headerUrl)) return plain

  const domain = String(fromAddress || '').split('@')[1] || ''
  const brand = domain
    .replace(/^(mail|email|mailer|smtp|news|notifications?|no-?reply)\./i, '')
    .split('.')[0]
  if (brand.length < 3) return plain

  // Ищем название в теме без учёта регистра; экранируем то, что нашли.
  const at = subject.toLowerCase().indexOf(brand.toLowerCase())
  const href = escapeText(headerUrl).replace(/"/g, '&quot;')
  if (at === -1) {
    // Названия в теме нет — вешаем ссылку на сам домен в конце строки.
    return `${plain} · <a href="${href}">${escapeText(domain || brand)}</a>`
  }
  const before = escapeText(subject.slice(0, at))
  const hit = escapeText(subject.slice(at, at + brand.length))
  const after = escapeText(subject.slice(at + brand.length))
  return `${before}<a href="${href}">${hit}</a>${after}`
}

function summaryFor(lines, subject) {
  const meaningful = lines.find(line => {
    const value = String(line?.plain || '').trim()
    if (value.length < 4) return false
    if (BOILERPLATE.test(value)) return false
    // Убираем рамки/разделители и смотрим, остаётся ли живой текст.
    const stripped = value.replace(BOX_DRAWING, ' ').trim()
    if (stripped.length < 4) return false
    const words = stripped.split(/\s+/).filter(w => /[\p{L}\p{N}]{2,}/u.test(w))
    return words.length >= 2
  })
  return meaningful
    ? meaningful.plain.replace(BOX_DRAWING, ' ').replace(/\s+/g, ' ').trim()
    : (subject || 'Читать письмо')
}

function formatWhen(date) {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    }).format(date)
  } catch { return date.toISOString().slice(0, 16).replace('T', ' ') }
}

module.exports.buildRichMessage = buildRichMessage
module.exports.textToLines = textToLines
module.exports.linesToHtml = linesToHtml
module.exports.clip = clip
