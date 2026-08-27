const test = require('node:test')
const assert = require('node:assert/strict')

const {
  parseJson3Cues,
  parseVttCues,
  pairAdjacentAsrCues,
  splitTimedCuesToFit,
  findCueIndex,
  examplesForTerm,
  expressionMatchesForCue,
  batchTexts,
  cueLookaheadItems,
  inclusiveWordRange,
  cueWordRangeForPhrase,
  phraseTextAcrossCues,
  annotatedTextSegments,
  cueNavigationDelta,
  dictionaryMeaningPairs,
  mergeDictionaryMeaningPairs,
  dictionaryExampleRows,
  classifyRepeatedWordClick,
  dismissalPlaybackOwner,
  overlayDeactivationPlan,
  lexemeRefinementNeeded,
  sourceWordIsActive,
  alignedTargetRanges,
  exactTermRanges,
  snapTextRangeToWords,
  literalSpacingFromReference,
  cueWindowItems,
  cueWindowText,
  subtitleCardPlacement,
  subtitleWidthLayout,
  obstacleAvoidingTop,
  wordPopoverLayout,
  floatingPopoverScrollState,
  exampleTranslationChoice,
  literalTargetRangesForTerms,
  learningExamplePresentation,
  sentenceForTerm,
  sentenceForCueTerm,
  sentenceIsComplete,
  segmentWords,
  isDesktopChromiumSpeech,
  preferredEnglishSpeechVoice,
  shouldAutoplayCard,
} = require('../youtube-learning-utils')

test('desktop Chromium selects the installed study voice without changing iPhone WebKit', () => {
  assert.equal(isDesktopChromiumSpeech('Mozilla/5.0 Chrome/148.0.0.0 Safari/537.36'), true)
  assert.equal(isDesktopChromiumSpeech('Mozilla/5.0 (iPhone) AppleWebKit/605.1.15'), false)
  const fallback = { name: 'Eddy (English US)', lang: 'en-US', localService: true }
  const samantha = { name: 'Саманта', lang: 'en-US', localService: true }
  assert.equal(preferredEnglishSpeechVoice([
    fallback,
    { name: 'Daniel', lang: 'en-GB', localService: true },
    samantha,
  ], 'en-US'), samantha)
})

test('card autoplay only fires after the deck advances to another card', () => {
  assert.equal(shouldAutoplayCard('', 'measure'), false)
  assert.equal(shouldAutoplayCard('measure', 'measure'), false)
  assert.equal(shouldAutoplayCard('measure', 'actually'), true)
})

test('native YouTube click exclusively owns playback when dismissing an interaction', () => {
  assert.equal(
    dismissalPlaybackOwner({ via: 'outside-pointer', insidePlayer: true }),
    'native-player',
  )
  assert.equal(
    dismissalPlaybackOwner({ via: 'outside-pointer', insidePlayer: false }),
    'extension',
  )
  assert.equal(
    dismissalPlaybackOwner({ via: 'explicit', insidePlayer: true }),
    'extension',
  )
})

test('inactive YouTube pages never clear native selection or focus', () => {
  assert.deepEqual(overlayDeactivationPlan({
    overlayActive: false,
    subtitleHovered: false,
    pausedForSubtitleHover: false,
    phraseSelectionOpen: false,
    hasPhraseSelection: false,
    wordPopoverOpen: false,
    hasWordPopover: false,
  }), {
    clearPhrase: false,
    closePopover: false,
    releaseHover: false,
  })
  assert.equal(overlayDeactivationPlan({ phraseSelectionOpen: true }).clearPhrase, true)
  assert.equal(overlayDeactivationPlan({ hasWordPopover: true }).closePopover, true)
})

test('popover refinement compares the stored card identity, not only the current query', () => {
  assert.equal(lexemeRefinementNeeded({
    storedKey: 'word|en|ru|sequence',
    nextKey: 'word|en|ru|sequence',
    previous: { partOfSpeech: 'verb', analysisConfidence: 'high' },
    next: { partOfSpeech: 'noun', analysisConfidence: 'high' },
  }), true)
  assert.equal(lexemeRefinementNeeded({
    storedKey: 'word|en|ru|sequence',
    nextKey: 'word|en|ru|sequence',
    previous: { partOfSpeech: 'noun', analysisConfidence: 'high' },
    next: { partOfSpeech: 'noun', analysisConfidence: 'high' },
  }), false)
})

test('opened word stays active only in its exact source cue position', () => {
  assert.equal(sourceWordIsActive({
    currentCueIndex: 4,
    wordIndex: 7,
    popoverCueIndex: 4,
    popoverWordIndex: 7,
  }), true)
  assert.equal(sourceWordIsActive({
    currentCueIndex: 4,
    wordIndex: 6,
    popoverCueIndex: 4,
    popoverWordIndex: 7,
  }), false)
})

test('parses JSON3 cues and merges append events', () => {
  const cues = parseJson3Cues({
    events: [
      { tStartMs: 1000, dDurationMs: 900, segs: [{ utf8: 'Hello' }] },
      { tStartMs: 1500, dDurationMs: 900, aAppend: 1, segs: [{ utf8: ' world' }] },
      { tStartMs: 2600, dDurationMs: 700, segs: [{ utf8: 'Next line' }] },
    ],
  })
  assert.equal(cues.length, 2)
  assert.equal(cues[0].text, 'Hello world')
  assert.equal(cues[0].startMs, 1000)
  assert.ok(cues[0].endMs >= 2400)
})

test('long subtitles become timed one-line iterations without hiding words', () => {
  const text = 'Frank leaves, a girl named Athena approaches him. She secretly hands him a lapel pin and'
  const cues = splitTimedCuesToFit([
    { startMs: 15200, endMs: 19760, text },
  ], {
    maxWidth: 70,
    measureText: value => value.length,
    language: 'en',
  })
  assert.deepEqual(cues.map(cue => cue.text), [
    'Frank leaves, a girl named Athena approaches him.',
    'She secretly hands him a lapel pin and',
  ])
  assert.equal(cues[0].startMs, 15200)
  assert.equal(cues[0].endMs, cues[1].startMs)
  assert.equal(cues[1].endMs, 19760)
  assert.ok(cues.every(cue => cue.text.length <= 70))
  assert.equal(cues.map(cue => cue.text).join(' '), text)
})

test('shift-click phrase range works in both directions', () => {
  assert.deepEqual(inclusiveWordRange(2, 7), { fromWordIndex: 2, toWordIndex: 7 })
  assert.deepEqual(inclusiveWordRange(7, 2), { fromWordIndex: 2, toWordIndex: 7 })
})

test('hyphenated compounds are one clickable word without joining spaced dashes', () => {
  assert.deepEqual(
    segmentWords('a short-term and state-of-the-art model', 'en')
      .filter(part => part.word)
      .map(part => ({ text: part.text, normalized: part.normalized })),
    [
      { text: 'a', normalized: 'a' },
      { text: 'short-term', normalized: 'short-term' },
      { text: 'and', normalized: 'and' },
      { text: 'state-of-the-art', normalized: 'state-of-the-art' },
      { text: 'model', normalized: 'model' },
    ],
  )
  assert.deepEqual(
    segmentWords('short - term', 'en').filter(part => part.word).map(part => part.text),
    ['short', 'term'],
  )
  assert.equal(
    segmentWords('short\u2011term', 'en').find(part => part.word)?.normalized,
    'short-term',
  )
})

test('phrase range spans whole intermediate cues in both directions', () => {
  const anchor = { cueIndex: 2, wordIndex: 1 }
  const focus = { cueIndex: 4, wordIndex: 2 }
  assert.deepEqual(cueWordRangeForPhrase(anchor, focus, 2, 5), { fromWordIndex: 1, toWordIndex: 4 })
  assert.deepEqual(cueWordRangeForPhrase(anchor, focus, 3, 4), { fromWordIndex: 0, toWordIndex: 3 })
  assert.deepEqual(cueWordRangeForPhrase(anchor, focus, 4, 6), { fromWordIndex: 0, toWordIndex: 2 })
  assert.deepEqual(cueWordRangeForPhrase(focus, anchor, 3, 4), { fromWordIndex: 0, toWordIndex: 3 })
  assert.equal(cueWordRangeForPhrase(anchor, focus, 1, 4), null)
})

test('phrase text includes crossed cues and only the selected edge words', () => {
  const cues = [
    { text: 'Zero cue.' },
    { text: 'Start with this phrase.' },
    { text: 'The whole middle cue.' },
    { text: 'Finish right here please.' },
  ]
  const anchor = { cueIndex: 1, wordIndex: 1 }
  const focus = { cueIndex: 3, wordIndex: 2 }
  const expected = 'with this phrase. The whole middle cue. Finish right here'
  assert.equal(phraseTextAcrossCues(cues, anchor, focus, 'en'), expected)
  assert.equal(phraseTextAcrossCues(cues, focus, anchor, 'en'), expected)
})

test('translation annotations preserve saved state and active overlap', () => {
  assert.deepEqual(
    annotatedTextSegments('один два три', [
      { start: 5, end: 8, state: 'saved' },
      { start: 5, end: 13, active: true },
    ]),
    [
      { start: 0, end: 5, text: 'один ', state: '', active: false },
      { start: 5, end: 8, text: 'два', state: 'saved', active: true },
      { start: 8, end: 12, text: ' три', state: '', active: true },
    ],
  )
})

test('literal highlights snap a cross-word fragment to the intended complete word', () => {
  const text = 'Фрэнк уходит, девушка по имени Афина подходит к нему.'
  assert.deepEqual(snapTextRangeToWords(text, 35, 40), { start: 37, end: 45 })
  assert.equal(text.slice(37, 45), 'подходит')
})

test('literal translation restores a missing space from the natural reference without shifting alignments', () => {
  const result = literalSpacingFromReference(
    'Она тайно передаёт ему значокна лацкан и',
    'Она тайно передаёт ему значок на лацкан и',
    [
      { sourceWordIndex: 3, targetStart: 19, targetEnd: 22 },
      { sourceWordIndex: 5, targetStart: 29, targetEnd: 31 },
    ],
  )
  assert.equal(result.literalText, 'Она тайно передаёт ему значок на лацкан и')
  assert.deepEqual(result.alignments, [
    { sourceWordIndex: 3, targetStart: 19, targetEnd: 22 },
    { sourceWordIndex: 5, targetStart: 30, targetEnd: 32 },
  ])
})

test('literal example mode never flashes the natural Azure translation', () => {
  assert.deepEqual(exampleTranslationChoice({
    naturalTranslation: 'Завершите аутентификацию.',
    translationOrder: 'source',
  }), { state: 'pending', text: '', literal: false })
  assert.deepEqual(exampleTranslationChoice({
    naturalTranslation: 'Завершите аутентификацию.',
    literalTranslation: { literalText: 'Завершите аутентификацию сначала.' },
    translationOrder: 'source',
  }), { state: 'ready', text: 'Завершите аутентификацию сначала.', literal: true })
  assert.deepEqual(exampleTranslationChoice({
    naturalTranslation: 'Завершите аутентификацию.',
    translationOrder: 'source',
    literalFailed: true,
  }), { state: 'fallback', text: 'Завершите аутентификацию.', literal: false })
})

test('literal example highlighting follows every occurrence of the selected source word', () => {
  assert.deepEqual(literalTargetRangesForTerms(
    'Finish authentication first. Finish history next.',
    [
      { sourceWordIndex: 0, targetStart: 0, targetEnd: 9 },
      { sourceWordIndex: 3, targetStart: 33, targetEnd: 42 },
      { sourceWordIndex: 4, targetStart: 43, targetEnd: 50 },
    ],
    ['finish'],
    'en',
  ), [
    { sourceWordIndex: 0, start: 0, end: 9 },
    { sourceWordIndex: 3, start: 33, end: 42 },
  ])
})

test('physical A, D and square brackets navigate cues independently of keyboard layout', () => {
  assert.equal(cueNavigationDelta('KeyA'), -1)
  assert.equal(cueNavigationDelta('KeyD'), 1)
  assert.equal(cueNavigationDelta('BracketLeft'), -1)
  assert.equal(cueNavigationDelta('BracketRight'), 1)
  assert.equal(cueNavigationDelta('KeyF'), 0)
})

test('dictionary examples are selected per meaning without an arbitrary group cap', () => {
  const pairs = dictionaryMeaningPairs({
    normalizedSource: 'fine',
    translations: [
      { normalizedTarget: 'прекрасно', posTag: 'ADJ', backTranslations: [{ normalizedText: 'perfectly' }, { normalizedText: 'fine' }, { normalizedText: 'perfect' }] },
      { normalizedTarget: 'отлично', posTag: 'ADJ', backTranslations: [{ normalizedText: 'great' }, { normalizedText: 'perfectly' }, { normalizedText: 'fine' }] },
      { normalizedTarget: 'штраф', posTag: 'NOUN', backTranslations: [{ normalizedText: 'fine' }, { normalizedText: 'penalty' }] },
      { normalizedTarget: 'тонкий', posTag: 'ADJ', backTranslations: [{ normalizedText: 'fine' }, { normalizedText: 'thin' }, { normalizedText: 'subtle' }] },
      { normalizedTarget: 'мелкий', posTag: 'ADJ', backTranslations: [{ normalizedText: 'fine' }, { normalizedText: 'small-grained' }] },
      { normalizedTarget: 'изысканный', posTag: 'ADJ', backTranslations: [{ normalizedText: 'fine' }, { normalizedText: 'refined' }] },
    ],
  })
  assert.deepEqual(pairs.map(pair => pair.translation), ['прекрасно', 'штраф', 'тонкий', 'мелкий', 'изысканный'])
  assert.deepEqual(pairs[0].targets, ['прекрасно', 'отлично'])
})

test('AI groups are completed with later dictionary senses before examples validate them', () => {
  const dictionary = {
    normalizedSource: 'word',
    translations: [
      { normalizedTarget: 'первый', posTag: 'NOUN', backTranslations: [{ normalizedText: 'first' }] },
      { normalizedTarget: 'второй', posTag: 'VERB', backTranslations: [{ normalizedText: 'second' }] },
      { normalizedTarget: 'третий', posTag: 'ADJ', backTranslations: [{ normalizedText: 'third' }] },
      { normalizedTarget: 'четвёртый', posTag: 'ADV', backTranslations: [{ normalizedText: 'fourth' }] },
    ],
  }
  const merged = mergeDictionaryMeaningPairs(dictionary, [
    { text: 'word', translation: 'первый', targets: ['первый'], pos: 'NOUN' },
  ])
  assert.deepEqual(merged.flatMap((pair) => pair.targets), ['первый', 'второй', 'третий', 'четвёртый'])
})

test('explicit provider errors are not reintroduced while completing omitted meanings', () => {
  const dictionary = {
    normalizedSource: 'wrap',
    translations: [
      { normalizedTarget: 'обернуть', posTag: 'VERB', backTranslations: [{ normalizedText: 'wrap' }] },
      { normalizedTarget: 'упаковка', posTag: 'NOUN', backTranslations: [{ normalizedText: 'packaging' }] },
      { normalizedTarget: 'запахом', posTag: 'NOUN', backTranslations: [{ normalizedText: 'scent' }] },
    ],
  }
  const merged = mergeDictionaryMeaningPairs(dictionary, [
    { text: 'wrap', translation: 'обернуть', targets: ['обернуть'], pos: 'VERB' },
  ], ['запахом'])
  assert.deepEqual(merged.flatMap((pair) => pair.targets), ['обернуть', 'упаковка'])
})

test('second click on the same word distinguishes phrase mode from close', () => {
  const previous = { cueIndex: 4, wordIndex: 7, at: 1000 }
  assert.equal(classifyRepeatedWordClick(previous, 4, 7, 1300), 'quick')
  assert.equal(classifyRepeatedWordClick(previous, 4, 7, 1800), 'slow')
  assert.equal(classifyRepeatedWordClick(previous, 4, 8, 1200), 'different')
})

test('copy window adds the requested neighboring cues on one side', () => {
  const cues = [
    { text: 'First.' },
    { text: 'Second.' },
    { text: 'Third.' },
    { text: 'Fourth.' },
  ]
  assert.equal(cueWindowText(cues, 2, 0, 'left'), 'Third.')
  assert.equal(cueWindowText(cues, 2, 2, 'left'), 'First. Second. Third.')
  assert.equal(cueWindowText(cues, 1, 2, 'right'), 'Second. Third. Fourth.')
  assert.equal(cueWindowText(cues, 0, 3, 'left'), 'First.')
  assert.equal(cueWindowItems(cues, 2, 1, 'left').length, 2)
  assert.equal(cueWindowItems(cues, 0, 3, 'left').length, 1)
})

test('subtitle drag placement stays inside the player', () => {
  const centered = subtitleCardPlacement({
    rootWidth: 1000, rootHeight: 600, cardWidth: 760, cardHeight: 120,
    position: 'bottom', offsetX: 0, offsetY: 0,
  })
  assert.equal(centered.left, 500)
  assert.equal(centered.top, 420)

  const clamped = subtitleCardPlacement({
    rootWidth: 1000, rootHeight: 600, cardWidth: 760, cardHeight: 120,
    position: 'bottom', offsetX: 1, offsetY: -1,
  })
  assert.equal(clamped.left, 608)
  assert.equal(clamped.top, 12)
  assert.ok(clamped.offsetX < 0.11)
})

test('subtitle width is capped by the side control rails', () => {
  assert.deepEqual(subtitleWidthLayout({
    rootWidth: 1920,
    requestedWidth: 1800,
    sideInset: 68,
  }), {
    width: 1784,
    maxWidth: 1784,
    sideInset: 68,
    clamped: true,
  })
  assert.equal(subtitleWidthLayout({ rootWidth: 1920, requestedWidth: 1400 }).width, 1400)
})

test('move handle leaves the vertical rail when their bounds intersect', () => {
  assert.equal(obstacleAvoidingTop({
    containerHeight: 600,
    itemHeight: 36,
    preferredTop: 290,
    obstacleTop: 240,
    obstacleBottom: 360,
  }), 368)
  assert.equal(obstacleAvoidingTop({
    containerHeight: 600,
    itemHeight: 36,
    preferredTop: 440,
    obstacleTop: 240,
    obstacleBottom: 360,
  }), 440)
})

test('word popover keeps viewport height when subtitles move upward', () => {
  const common = {
    viewportWidth: 1000,
    viewportHeight: 700,
    popoverWidth: 480,
    popoverHeight: 540,
  }
  const raised = wordPopoverLayout({ ...common, anchorLeft: 420, anchorTop: 230, anchorWidth: 80 })
  const lowered = wordPopoverLayout({ ...common, anchorLeft: 420, anchorTop: 660, anchorWidth: 80 })

  assert.equal(raised.maxHeight, 676)
  assert.equal(lowered.maxHeight, 676)
  assert.equal(raised.height, 540)
  assert.equal(lowered.height, 540)
  assert.equal(raised.top, 12)
  assert.equal(raised.overlapsAnchor, true)
  assert.equal(raised.tailVisible, false)
  assert.equal(lowered.top, 112)
  assert.equal(lowered.tailVisible, true)
})

test('word popover remains inside the viewport horizontally', () => {
  const layout = wordPopoverLayout({
    viewportWidth: 800,
    viewportHeight: 600,
    anchorLeft: 790,
    anchorTop: 580,
    anchorWidth: 20,
    popoverWidth: 480,
    popoverHeight: 420,
  })
  assert.equal(layout.left, 308)
  assert.ok(layout.tailLeft <= layout.width - 32)
})

test('page scroll detaches a fixed word popover and hides it only after the player leaves', () => {
  const base = {
    openedScrollX: 0,
    openedScrollY: 200,
    currentScrollX: 0,
    viewportWidth: 1200,
    viewportHeight: 800,
    playerRect: { left: 100, top: 100, right: 1100, bottom: 700, width: 1000, height: 600 },
  }
  assert.deepEqual(
    floatingPopoverScrollState({ ...base, currentScrollY: 201 }),
    {
      detached: false,
      playerVisible: true,
      visibleWidth: 1000,
      visibleHeight: 600,
      verticalRatio: 1,
    },
  )
  assert.equal(floatingPopoverScrollState({ ...base, currentScrollY: 260 }).detached, true)
  const offscreen = floatingPopoverScrollState({
    ...base,
    currentScrollY: 900,
    playerRect: { left: 100, top: -580, right: 1100, bottom: 20, width: 1000, height: 600 },
  })
  assert.equal(offscreen.detached, true)
  assert.equal(offscreen.playerVisible, false)
})

test('single-word handoff keeps the complete sentence containing that word', () => {
  assert.equal(
    sentenceForTerm('The first sentence ends. This word matters here. Another follows.', 'word', 'en'),
    'This word matters here.',
  )
  assert.equal(sentenceForTerm('unfinished subtitle with word', 'word', 'en'), 'unfinished subtitle with word')
})

test('saved video context reconstructs one complete sentence across adjacent subtitle cues', () => {
  const cues = [
    { text: 'The previous sentence ends. The selected' },
    { text: 'word belongs to this sentence even though' },
    { text: 'the subtitle cue ends early. Another sentence starts' },
  ]
  assert.equal(
    sentenceForCueTerm(cues, 1, 'word', 'en'),
    'The selected word belongs to this sentence even though the subtitle cue ends early.',
  )
  assert.equal(sentenceIsComplete(sentenceForCueTerm(cues, 1, 'word', 'en'), 'en'), true)
})

test('dictionary example selection skips fragments and keeps exactly one complete sentence', () => {
  const rows = dictionaryExampleRows({
    examples: [{
      normalizedSource: 'approach',
      normalizedTarget: 'подойти',
      examples: [
        {
          sourcePrefix: '... when we ', sourceTerm: 'approach', sourceSuffix: ' the end',
          targetPrefix: '... когда мы ', targetTerm: 'подходим', targetSuffix: ' к концу',
        },
        {
          sourcePrefix: 'May we ', sourceTerm: 'approach', sourceSuffix: ' the bench?',
          targetPrefix: 'Можно ', targetTerm: 'подойти', targetSuffix: ' к судье?',
        },
      ],
    }],
  }, [{ text: 'approach', translation: 'подойти', targets: ['подойти', 'приблизиться'], pos: 'VERB' }])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].sourceText, 'May we approach the bench?')
  assert.equal(rows[0].targetText, 'Можно подойти к судье?')
  assert.equal(rows[0].sourceTerm, 'approach')
})

test('different meanings never collapse onto the same example sentence', () => {
  const duplicate = {
    sourcePrefix: 'I ', sourceTerm: 'assume', sourceSuffix: ' this is true.',
    targetPrefix: 'Я ', targetTerm: 'полагаю', targetSuffix: ', что это правда.',
  }
  const rows = dictionaryExampleRows({
    examples: [
      { normalizedSource: 'assume', normalizedTarget: 'полагать', examples: [duplicate] },
      { normalizedSource: 'assume', normalizedTarget: 'брать на себя', examples: [duplicate] },
    ],
  }, [
    {
      text: 'assume', translation: 'полагать', targets: ['полагать'], pos: 'VERB',
      example: 'I assume this is true.', exampleTranslation: 'Я полагаю, что это правда.',
    },
    {
      text: 'assume', translation: 'брать на себя', targets: ['брать на себя'], pos: 'VERB',
      example: 'The company will assume full responsibility.', exampleTranslation: 'Компания возьмёт на себя полную ответственность.',
    },
  ])
  assert.deepEqual(rows.map((row) => row.sourceText), [
    'I assume this is true.',
    'The company will assume full responsibility.',
  ])
})

test('generated meaning example is rejected when the English sentence does not contain the word', () => {
  const rows = dictionaryExampleRows({ examples: [{ examples: [] }] }, [{
    text: 'wrap',
    translation: 'запахом',
    targets: ['запахом'],
    pos: 'NOUN',
    example: 'The strong scent filled the room.',
    exampleTranslation: 'Сильный запах наполнил комнату.',
  }])
  assert.deepEqual(rows, [])
})

test('Azure alignment maps the selected English word to its Russian form', () => {
  const source = 'you want it if you want to'
  const target = 'вы хотите этого, если хотите'
  const ranges = alignedTargetRanges(
    source,
    target,
    'want',
    '0:2-0:1 4:7-3:8 9:10-10:14 12:13-17:20 15:17-22:27 19:22-22:27',
    'en',
  )
  assert.deepEqual(ranges.map(range => target.slice(range.start, range.end)), ['хотите', 'хотите'])
})

test('exact Russian dictionary term is a safe fallback when Azure omits alignment', () => {
  const target = 'Это недокументированная функция.'
  const ranges = exactTermRanges(target, ['недокументированная', 'нелегальная'], 'ru')
  assert.deepEqual(ranges.map(range => target.slice(range.start, range.end)), ['недокументированная'])
})

test('shared learning example highlights source and multi-word contextual translation', () => {
  const presentation = learningExamplePresentation({
    sourceText: 'This is actually useful.',
    targetText: 'Это на самом деле полезно.',
    sourceTerms: ['actually'],
    targetTerms: ['на самом деле'],
    sourceLanguage: 'en',
    targetLanguage: 'ru',
  })
  assert.equal(presentation.sourceSegments.filter(segment => segment.active).map(segment => segment.text).join(''), 'actually')
  assert.equal(presentation.targetSegments.filter(segment => segment.active).map(segment => segment.text).join(''), 'на самом деле')
})

test('examples can match several observed forms of one lexeme', () => {
  const cues = [
    { startMs: 0, endMs: 1000, text: 'They describe it.' },
    { startMs: 1000, endMs: 2000, text: 'She describes it.' },
    { startMs: 2000, endMs: 3000, text: 'We are describing it.' },
  ]
  const matches = examplesForTerm(cues, ['describe', 'describes', 'describing'], 1, 6, 'en')
  assert.equal(matches.length, 3)
})

test('saved expressions match across cues and the longest overlap wins', () => {
  const cues = [
    { text: 'Available as' },
    { text: 'of today for everyone.' },
  ]
  const matches = expressionMatchesForCue(cues, 1, [
    { key: 'short', sourceText: 'as of', expressionType: 'function_phrase' },
    { key: 'long', sourceText: 'as of today', expressionType: 'function_phrase' },
  ], 'en')
  assert.equal(matches.length, 1)
  assert.equal(matches[0].key, 'long')
  assert.deepEqual(matches[0].wordIndexes, [0, 1])
  assert.equal(matches[0].fromCueIndex, 0)
})

test('parses VTT and finds the active cue', () => {
  const cues = parseVttCues(`WEBVTT

00:00:01.000 --> 00:00:02.500
First line

00:00:03.000 --> 00:00:04.000
Second line
`)
  assert.equal(cues.length, 2)
  assert.equal(findCueIndex(cues, 1800), 0)
  assert.equal(findCueIndex(cues, 2800), -1)
  assert.equal(findCueIndex(cues, 3200), 1)
})

test('current-video examples match whole words and prefer nearby cues', () => {
  const cues = [
    { startMs: 0, endMs: 1000, text: 'A partner can help.' },
    { startMs: 1000, endMs: 2000, text: 'Partnership is different.' },
    { startMs: 2000, endMs: 3000, text: 'My partner agreed.' },
    { startMs: 3000, endMs: 4000, text: 'Another partner arrived.' },
  ]
  const examples = examplesForTerm(cues, 'partner', 2, 2, 'en')
  assert.deepEqual(examples.map(item => item.cueIndex), [2, 3])
})

test('translation batches respect item and character ceilings', () => {
  const items = Array.from({ length: 30 }, (_, index) => ({ index, text: `line-${index}-${'x'.repeat(210)}` }))
  const batches = batchTexts(items, 25, 1000)
  assert.ok(batches.length > 1)
  for (const batch of batches) {
    assert.ok(batch.length <= 25)
    assert.ok(batch.reduce((sum, item) => sum + item.text.length, 0) <= 1000)
  }
})

test('literal subtitle lookahead starts at the active cue, clamps at the end, and skips duplicate text', () => {
  const cues = [
    { text: 'current' },
    { text: 'next' },
    { text: 'next' },
    { text: 'last' },
  ]
  assert.deepEqual(
    cueLookaheadItems(cues, 0, 16).map(item => [item.index, item.cue.text]),
    [[0, 'current'], [1, 'next'], [3, 'last']],
  )
  assert.deepEqual(
    cueLookaheadItems(cues, 3, 16).map(item => item.index),
    [3],
  )
  assert.deepEqual(cueLookaheadItems(cues, -1, 16), [])
})

test('pairs adjacent rolling ASR fragments into longer readable cues', () => {
  const cues = pairAdjacentAsrCues([
    { startMs: 41520, endMs: 43680, text: 'shipped three other models. The training' },
    { startMs: 43680, endMs: 45680, text: 'itself had reportedly already been' },
    { startMs: 45680, endMs: 47840, text: 'underway before that announcement. That' },
    { startMs: 47840, endMs: 50480, text: 'one sentence is what spawned 3 months of' },
  ])

  assert.deepEqual(cues.map(cue => ({ startMs: cue.startMs, endMs: cue.endMs, text: cue.text })), [
    {
      startMs: 41520,
      endMs: 45680,
      text: 'shipped three other models. The training itself had reportedly already been',
    },
    {
      startMs: 45680,
      endMs: 50480,
      text: 'underway before that announcement. That one sentence is what spawned 3 months of',
    },
  ])
})
