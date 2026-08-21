const assert = require('node:assert/strict')
const test = require('node:test')
const {
  buildRichMessage, htmlToLines, textToLines, decodeEntities,
  unwrapTrackingUrl, clip, SAFE_TEXT_LIMIT, RICH_BLOCK_LIMIT,
} = require('./email-to-rich')

const summaryOf = html => /<summary>(.*?)<\/summary>/s.exec(html)?.[1] ?? null
const bodyOf = html => /<details><summary>.*?<\/summary>(.*)<\/details>/s.exec(html)?.[1] ?? ''

test('кривая вложенность не даёт рассогласованных тегов', () => {
  const [line] = htmlToLines('<p><b>жирный <i>оба</b> курсив</i></p>')
  const opens = (line.html.match(/<(b|i|u|s|a|code)\b/g) || []).length
  const closes = (line.html.match(/<\/(b|i|u|s|a|code)>/g) || []).length
  assert.equal(opens, closes)
  assert.equal(line.plain, 'жирный оба курсив')
})

test('незакрытый тег в конце письма не ломает разметку', () => {
  const [line] = htmlToLines('<p>текст <b>без закрытия')
  assert.match(line.html, /<b>без закрытия<\/b>/)
})

test('script/style выбрасываются вместе с содержимым', () => {
  const lines = htmlToLines('<style>.a{color:red}</style><p>видно</p><script>alert(1)</script>')
  assert.deepEqual(lines.map(l => l.plain), ['видно'])
})

test('вложенные script не обрывают выброс раньше времени', () => {
  const lines = htmlToLines('<script>var a="<script>"</script></script><p>после</p>')
  assert.ok(lines.every(l => !l.plain.includes('var a')))
})

test('трекинг-ссылка разворачивается в настоящий адрес', () => {
  const [line] = htmlToLines('<a href="https://t.co/r?url=https%3A%2F%2Fcodexresets.com%2Fx">клик</a>')
  assert.match(line.html, /href="https:\/\/codexresets\.com\/x"/)
})

test('javascript: и data: ссылки не попадают в сообщение', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x', 'vbscript:msgbox']) {
    const [line] = htmlToLines(`<a href="${bad}">клик</a>`)
    assert.ok(!line.html.includes('<a '), `должно отбросить: ${bad}`)
    assert.equal(line.plain, 'клик')
  }
})

test('кавычка в href не разрывает атрибут', () => {
  const [line] = htmlToLines('<a href=\'https://e.com/?a="b\'>x</a>')
  assert.ok(!/href="[^"]*"[^>]*"/.test(line.html))
  assert.match(line.html, /&quot;/)
})

test('таблица склеивается в строку, а не в столбик', () => {
  const lines = htmlToLines('<table><tr><td>Метрика</td><td>42 ms</td></tr></table>')
  assert.equal(lines.length, 1)
  assert.match(lines[0].plain, /Метрика\s+42 ms/)
})

test('нумерованный список считает пункты', () => {
  const lines = htmlToLines('<ol><li>раз</li><li>два</li><li>три</li></ol>')
  assert.deepEqual(lines.map(l => l.plain), ['1. раз', '2. два', '3. три'])
})

test('вложенные списки не сбивают нумерацию внешнего', () => {
  const lines = htmlToLines('<ol><li>раз<ul><li>под</li></ul></li><li>два</li></ol>')
  const plain = lines.map(l => l.plain)
  assert.ok(plain.includes('1. раз'))
  assert.ok(plain.some(p => p.trim() === '• под'))
  assert.ok(plain.includes('2. два'))
})

test('pre сохраняет переводы строк', () => {
  const lines = htmlToLines('<pre>a\nb</pre>')
  assert.deepEqual(lines.map(l => l.plain), ['a', 'b'])
  assert.ok(lines.every(l => l.pre))
})

test('числовые и именованные сущности раскодируются', () => {
  assert.equal(decodeEntities('a &amp; b &#8212; &#x2014; &laquo;c&raquo;'), 'a & b — — «c»')
  assert.equal(decodeEntities('&unknownentity;'), '&unknownentity;')
})

test('амперсанд в тексте не превращается в битую сущность', () => {
  const [line] = htmlToLines('<p>Rock &amp; Roll &lt;тег&gt;</p>')
  assert.equal(line.plain, 'Rock & Roll <тег>')
  assert.match(line.html, /Rock &amp; Roll &lt;тег&gt;/)
})

test('plain-текст: цитаты и псевдографика распознаются', () => {
  const lines = textToLines('> цитата\n╔═══╗\nобычная строка')
  assert.ok(lines[0].quote)
  assert.ok(lines[1].pre)
  assert.ok(!lines[2].quote && !lines[2].pre)
})

test('соседние цитаты склеиваются в один блок', () => {
  const { html } = buildRichMessage({ subject: 'т', fromAddress: 'a@b.c', text: '> раз\n> два\n\nхвост' })
  assert.equal((bodyOf(html).match(/<blockquote>/g) || []).length, 1)
})

test('ссылкой становится только имя отправителя внутри темы, не вся строка', () => {
  const { html } = buildRichMessage({
    subject: '[codexresets] confirm your subscription',
    fromAddress: 'noreply@codexresets.com', text: 'тело письма тут',
    headerUrl: 'https://codexresets.com/',
  })
  assert.match(html, /<h3>\[<a href="https:\/\/codexresets\.com\/">codexresets<\/a>\] confirm your subscription<\/h3>/)
})

test('если имени отправителя в теме нет, ссылка уходит в конец строки', () => {
  const { html } = buildRichMessage({
    subject: 'Ваш заказ отправлен', fromAddress: 'no-reply@shop.example.com',
    text: 'тело', headerUrl: 'https://example.com/',
  })
  assert.match(html, /<h3>Ваш заказ отправлен · <a href="https:\/\/example\.com\/">/)
})

test('без headerUrl заголовок остаётся обычным текстом', () => {
  const { html } = buildRichMessage({ subject: 'Тема', fromAddress: 'a@b.c', text: 'тело' })
  assert.match(html, /<h3>Тема<\/h3>/)
})

test('в ленте видно только тему со временем, отправитель — внутри блока', () => {
  const { html } = buildRichMessage({
    subject: '[codexresets] confirm', fromName: 'Codex Resets',
    fromAddress: 'noreply@codexresets.com', text: 'тело',
    date: new Date('2026-08-21T04:09:00Z'), headerUrl: 'https://codexresets.com/',
    gmailUrl: 'https://mail.google.com/mail/u/0/#search/x',
  })
  const head = /^<h3>(.*?)<\/h3>/s.exec(html)[1]
  assert.match(head, /tg-time/, 'время должно быть в первой строке')
  assert.ok(!head.includes('noreply@'), 'адреса в заголовке быть не должно')
  // Адрес и ссылка на Gmail живут внутри раскрывающегося блока.
  const body = /<details><summary>.*?<\/summary>(.*)<\/details>/s.exec(html)[1]
  assert.match(body, /<i>noreply@codexresets\.com<\/i>/)
  assert.match(body, /Открыть в Gmail/)
})

test('подчёркивание в тексте не съедается превью', () => {
  const { html } = buildRichMessage({
    subject: 'Тема', fromAddress: 'a@b.c', text: '> subscription_request received',
  })
  assert.match(html, /<summary>[^<]*subscription_request received/)
})

test('превью пропускает рамку и boilerplate', () => {
  const { html } = buildRichMessage({
    subject: 'Тема', fromAddress: 'a@b.c',
    text: 'View this email in your browser\n╔══════╗\n║ x ║\nВаш заказ отправлен сегодня.',
  })
  assert.equal(summaryOf(html), 'Ваш заказ отправлен сегодня.')
})

test('письмо без текста не падает и не шлёт пустой details', () => {
  const { html } = buildRichMessage({ subject: 'Пусто', fromAddress: 'a@b.c', html: '<img src="x">' })
  assert.ok(!html.includes('<details>'))
  assert.match(html, /без текстового содержимого/)
})

test('длинное письмо обрезается под лимит и признаётся обрезанным', () => {
  const huge = Array.from({ length: 4000 }, (_, i) => `<p>строка письма номер ${i} с текстом</p>`).join('')
  const { html, truncated } = buildRichMessage({ subject: 'Длинное', fromAddress: 'a@b.c', html: huge })
  assert.ok(truncated)
  assert.ok(html.length <= SAFE_TEXT_LIMIT, `${html.length} > ${SAFE_TEXT_LIMIT}`)
  assert.match(html, /показано не полностью/)
})

test('много мелких абзацев не пробивает лимит блоков', () => {
  const many = Array.from({ length: 900 }, (_, i) => `<p>${i}</p>`).join('')
  const { html } = buildRichMessage({ subject: 'Блоки', fromAddress: 'a@b.c', html: many })
  const blocks = (html.match(/<(p|h[1-6]|pre|blockquote|hr|details|footer)\b/g) || []).length
  assert.ok(blocks < RICH_BLOCK_LIMIT, `блоков ${blocks}`)
})

test('clip не режет строку короче лимита', () => {
  assert.equal(clip('коротко', 100), 'коротко')
  assert.equal(clip('a'.repeat(50), 10).length, 10)
})

test('unwrapTrackingUrl не трогает обычную ссылку', () => {
  assert.equal(unwrapTrackingUrl('https://codexresets.com/x'), 'https://codexresets.com/x')
})
