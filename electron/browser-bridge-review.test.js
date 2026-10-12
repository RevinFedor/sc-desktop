const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')

test('extension sync forwards partial and its undo in order without upgrading partial to remembered', async () => {
  const text = fs.readFileSync(require.resolve('./browser-bridge'), 'utf8')
  const ast = ts.createSourceFile('browser-bridge.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const names = new Set(['normalizeVocabularyTerm', 'normalizeVocabularyPartOfSpeech', 'vocabularyIdentityKey', 'remoteVocabularyIndex', 'syncVocabularyWithVoice'])
  const code = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text)).map(node => node.getText(ast)).join('\n')
  let count = 0
  const calls = []
  const item = () => ({ id: 'word-id', term: 'retain', lemma: 'retain', kind: 'word', state: 'saved', sourceLang: 'en', targetLang: 'ru', partialCount: count })
  const sandbox = vm.createContext({
    console, Date,
    voiceVocabularyRequest: async (method, path, body) => {
      calls.push({ method, path, body })
      if (method === 'GET') return { items: [item()] }
      if (path.endsWith('/review/undo')) { count -= 1; return { item: item() } }
      assert.equal(body.result, 'partial')
      assert.equal(body.operationId, 'partial-operation')
      count += 1
      return { item: item() }
    },
  })
  vm.runInContext(code, sandbox)
  const result = await sandbox.syncVocabularyWithVoice({ entries: [], reviews: [
    { id: 'partial-operation', remoteId: 'word-id', type: 'review', result: 'partial', mode: 'scheduled', reviewedAt: 1, createdAt: 1 },
    { id: 'undo-operation', remoteId: 'word-id', type: 'undo-review', reviewOperationId: 'partial-operation', createdAt: 2 },
  ] })
  assert.deepEqual(Array.from(result.acknowledgedReviews), ['partial-operation', 'undo-operation'])
  assert.equal(count, 0)
  assert.equal(calls.filter(call => call.method === 'POST').length, 2)
})

test('sync rereads a changed server card before applying a patch based on an older snapshot', async () => {
  const text = fs.readFileSync(require.resolve('./browser-bridge'), 'utf8')
  const ast = ts.createSourceFile('browser-bridge.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const names = new Set(['normalizeVocabularyTerm', 'normalizeVocabularyPartOfSpeech', 'vocabularyIdentityKey',
    'vocabularySyncPayload', 'remoteVocabularyIndex', 'syncVocabularyWithVoice'])
  const code = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text)).map(node => node.getText(ast)).join('\n')
  let current = { id: 'word-id', term: 'retain', lemma: 'retain', kind: 'word', state: 'saved', sourceLang: 'en',
    targetLang: 'ru', updatedAt: 100, stateUpdatedAt: 100, translationUpdatedAt: 100, translation: 'сохранять',
    translationSource: 'machine', partOfSpeech: 'verb', partsOfSpeech: ['verb'], analysisConfidence: 'high',
    observedForms: [], contexts: [], senseCatalog: { validatedAt: 100 } }
  let injected = false, conflicts = 0
  const sandbox = vm.createContext({ console, Date, LEARNING_EXPRESSION_TYPES: new Set(['phrasal_verb', 'function_phrase', 'idiom']),
    voiceVocabularyRequest: async (method, path, body) => {
      if (method === 'GET') return { items: [structuredClone(current)] }
      assert.equal(method, 'PATCH')
      if (!injected) {
        injected = true
        current = { ...current, state: 'archived', stateUpdatedAt: 300, updatedAt: 300 }
      }
      if (body.expectedUpdatedAt !== undefined && body.expectedUpdatedAt !== current.updatedAt) {
        conflicts += 1
        throw Object.assign(new Error('vocabulary item changed; reload before applying catalogue'), { status: 409 })
      }
      const { expectedUpdatedAt, ...patch } = body
      current = { ...current, ...patch, updatedAt: current.updatedAt + 1 }
      return { item: structuredClone(current) }
    },
  })
  vm.runInContext(code, sandbox)
  const result = await sandbox.syncVocabularyWithVoice({ reviews: [], entries: [{
    key: 'word|en|ru|retain', remoteId: current.id, sourceText: 'retain', lemma: 'retain', sourceLang: 'en',
    targetLang: 'ru', kind: 'word', state: 'known', updatedAt: 200, stateUpdatedAt: 200,
    translation: 'сохранять', translationSource: 'machine', translationUpdatedAt: 100,
  }] })
  assert.equal(current.state, 'archived', 'the server edit made after GET must not be overwritten')
  assert.equal(result.items[0].state, 'archived')
  assert.equal(conflicts, 1)
  assert.deepEqual(Array.from(result.syncedKeys), ['word|en|ru|retain'])
})
