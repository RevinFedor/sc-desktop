const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-learning-db-'))
process.env.SC_DESKTOP_DIR = tempRoot
process.env.SC_DESKTOP_DB = path.join(tempRoot, 'library.db')

const db = require('./database')

test.after(() => {
  db.close()
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

test('translation cache stores provider payload without changing its shape', () => {
  const response = { translations: [{ text: 'партнёр', to: 'ru' }] }
  db.upsertTranslationCache({
    cacheKey: 'abc', operation: 'translate', sourceLang: 'en', targetLang: 'ru',
    sourceText: 'partner', response,
  })
  const cached = db.getTranslationCache('abc')
  assert.deepEqual(cached.response, response)
  assert.equal(cached.provider, 'azure')

})

test('one vocabulary entry keeps examples from multiple video cues', () => {
  const first = db.upsertLearningEntry({
    kind: 'word', state: 'saved', sourceLang: 'en', targetLang: 'ru',
    sourceText: 'partners', normalizedText: 'partner', translation: 'партнёры',
    context: {
      videoId: 'video-a', startMs: 1000, endMs: 2000,
      sourceText: 'We are partners.', translation: 'Мы партнёры.',
    },
  })
  const second = db.upsertLearningEntry({
    kind: 'word', state: 'known', sourceLang: 'en', targetLang: 'ru',
    sourceText: 'partner', normalizedText: 'partner', translation: 'партнёр',
    context: {
      videoId: 'video-b', startMs: 3000, endMs: 4000,
      sourceText: 'My partner agreed.', translation: 'Мой партнёр согласился.',
    },
  })
  assert.equal(first.entry.id, second.entry.id)
  assert.equal(second.entry.state, 'known')
  assert.equal(second.examples_count, 2)
  assert.deepEqual(
    db.listLearningExamples(second.entry.id).map(row => row.video_id).sort(),
    ['video-a', 'video-b'],
  )
  const exported = db.listLearningEntries()
  assert.equal(exported.length, 1)
  assert.equal(exported[0].normalized_text, 'partner')
  assert.equal(exported[0].examples.length, 2)
})
