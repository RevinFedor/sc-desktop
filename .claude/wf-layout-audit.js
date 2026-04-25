export const meta = {
  name: 'layout-audit',
  description: 'Haiku-bulk + Opus-adjudication sweep of the SC Desktop renderer for layout/render bugs',
  phases: [
    { title: 'Review', detail: 'Haiku reviewers read file batches, flag layout/render bugs', model: 'haiku' },
    { title: 'Verify', detail: 'Haiku skeptics re-read each finding against the code', model: 'haiku' },
    { title: 'Adjudicate', detail: 'Opus makes the final real/false call + exact fix (≤8 agents total)', model: 'opus' },
  ],
}

// Model policy (per user directive): the BULK scan — reading 60 files and
// re-checking each candidate — is mechanical pattern-matching → Haiku. Opus is
// reserved for the final judgement pass and HARD-capped at OPUS_CAP agents for
// the whole workflow (we chunk the Haiku-confirmed findings into ≤OPUS_CAP
// groups, one Opus per group). No per-finding Opus.
const OPUS_CAP = 8

// LAYOUT/RENDER-focused rule set condensed from docs/methodology/переносимый-дизайн.md
// + the bugs fixed this session. Reviewers hunt VISUAL/STRUCTURAL defects
// ("что-то плывёт / нелогично отображается"), NOT business logic.
const RULES = `
You are auditing a React (Tailwind v4) Electron renderer for LAYOUT / RENDERING bugs only.
Ignore pure business-logic bugs. Hunt for things that look broken, shift, overflow, jitter,
or render wrong on screen. Known defect classes (each already seen in THIS codebase):

1. OVERFLOW (no flex-wrap): a horizontal \`flex\` row holding a variable number/width of
   buttons WITHOUT \`flex-wrap\` — children escape the row's right edge instead of wrapping.
   Look for \`flex items-center\` action-rows with many children and no \`flex-wrap\`.

2. WIDTH JITTER on toggle: a button whose label swaps between two strings of different
   length on click ("Новый запрос…" ↔ "Скрыть форму") with NO width stabilization → button
   resizes each click, neighbours dance. Correct = dual-label stacked render (inline-grid,
   both labels, one invisible) OR fixed min-width. Also a LOADER replacing a label
   ("Индексирую… 12 000 / 32 145") with no reserved min-width → row reflows every tick.

3. HEIGHT MISALIGN: action-row buttons must share one height (ToolbarButton = h-9). A
   sibling using \`py-2\`/\`py-1.5\`/no height sits a few px off → baseline breaks.

4. EMOJI AS FUNCTIONAL ICON: emoji (📊 ⚙ 📋 🧠 💬 🔄 ↻ ▾ ▴ ✕ ✓ 🗑 →) used as the icon
   INSIDE an action button must be a lucide-react icon instead. Emoji OK only as decorative
   status marker / named entity in text, never as a button's functional glyph.

5. ENGLISH LABEL in Russian UI: user-facing button/header text in English ("Loading…",
   "Scroll for more", "clear", "Clear history", "Start fetch", "Add source", "Refresh").
   Short acronyms (MCP/AI/URL/API/FTS) are fine.

6. DECORATIVE UPPERCASE: CSS \`uppercase\`/\`tracking-wider\` on short functional labels.

7. JSX && 0: \`{count && <X/>}\` where count is a SQLite integer renders literal "0" when
   count===0. Must be \`!!count &&\`, \`count > 0 &&\`, or \`Boolean(count)\`.

8. useSyncExternalStore NEW ARRAY: a getSnapshot / store hook returning \`arr.filter(...)\`
   / \`.map(...)\` fresh each call → infinite render loop. Flag non-memoized selectors.

9. MISSING truncate/min-w-0: flex children holding user text (titles, handles, filenames)
   without \`truncate\` + a \`min-w-0\` ancestor → long text blows out the column.

10. LOADER SHIFTS LAYOUT: busy state collapsing a button to "…" or a different-width
    spinner → row width jumps.

11. STICKY/OVERFLOW TRAP: \`sticky top-0\` inside a non-scrolling ancestor, or an
    intermediate \`overflow-*\` between sticky child and its scroll container.

12. DUPLICATE / DRIFTED labels for the same concept across two parallel UIs.

OUTPUT DISCIPLINE:
- Cite REAL line numbers you actually read. Quote the exact offending code in 'evidence'
  and say what the user SEES break.
- Only DEFECTS, not style opinions. If a button already uses dual-label or fixed min-width,
  it is NOT class 2. A false positive costs more than a miss.
`

const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          file:     { type: 'string' },
          lines:    { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          category: { type: 'string' },
          title:    { type: 'string' },
          evidence: { type: 'string' },
          fix:      { type: 'string' },
        },
        required: ['file', 'lines', 'severity', 'category', 'title', 'evidence', 'fix'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    verdict:  { type: 'string', enum: ['real', 'false', 'uncertain'] },
    reason:   { type: 'string' },
    severity: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['verdict', 'reason', 'severity'],
}

const ADJUDICATED_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          file:        { type: 'string' },
          lines:       { type: 'string' },
          verdict:     { type: 'string', enum: ['real', 'false'] },
          severity:    { type: 'string', enum: ['high', 'medium', 'low'] },
          category:    { type: 'string' },
          title:       { type: 'string' },
          user_impact: { type: 'string', description: 'what the user actually sees break' },
          fix:         { type: 'string', description: 'concrete, safe change' },
        },
        required: ['file', 'lines', 'verdict', 'severity', 'category', 'title', 'user_impact', 'fix'],
      },
    },
  },
  required: ['results'],
}

const ROOT = '/Users/fedor/Desktop/sc-desktop/src'

const BATCHES = [
  { name: 'action-row',    files: ['screens/SourceDetail.jsx', 'components/ToolbarButton.jsx', 'components/NewRequestSplitButton.jsx', 'components/IndexButton.jsx', 'components/CmdHoverTooltip.jsx'] },
  { name: 'chat-coverage', files: ['components/ChatView.jsx', 'components/CoverageBars.jsx', 'components/SendersBlock.jsx'] },
  { name: 'sidebar',       files: ['components/LibrarySidebar.jsx', 'components/SidebarContextMenu.jsx', 'components/Avatar.jsx', 'components/PlatformLogo.jsx', 'components/Breadcrumbs.jsx'] },
  { name: 'jobdetail',     files: ['screens/JobDetail.jsx'] },
  { name: 'yt-picker',     files: ['components/YouTubeBatchPicker.jsx'] },
  { name: 'tg-screen',     files: ['screens/TelegramScreen.jsx'] },
  { name: 'tg-forms',      files: ['components/TelegramConfigForm.jsx', 'components/TelegramScopeFields.jsx', 'components/TelegramTypesPopover.jsx', 'components/TelegramTopicsPopover.jsx', 'components/CopySavedPanel.jsx'] },
  { name: 'paste-shell',   files: ['screens/PasteScreen.jsx', 'components/TitleBar.jsx', 'components/Footer.jsx', 'components/HomeRecentActivities.jsx', 'components/QuickOpen.jsx'] },
  { name: 'yt-forms',      files: ['components/YouTubeSingleForm.jsx', 'components/YouTubeCommentsForm.jsx', 'components/YouTubeSearchForm.jsx', 'components/YouTubeChannelForm.jsx', 'components/YouTubeQuickFetchForm.jsx', 'components/YouTubeScopeFields.jsx'] },
  { name: 'single-forms',  files: ['components/TelegramSingleMessageForm.jsx', 'components/LocalFileTranscribeForm.jsx'] },
  { name: 'controls',      files: ['components/Select.jsx', 'components/Checkbox.jsx', 'components/DatePicker.jsx', 'components/ToastHost.jsx'] },
  { name: 'activity-mcp',  files: ['components/ActivityPanel.jsx', 'components/JobProgress.jsx', 'components/McpRunningPopover.jsx', 'components/McpHistoryPanel.jsx'] },
  { name: 'settings-ig',   files: ['screens/InstagramSettings.jsx', 'screens/TelegramSettings.jsx', 'screens/SettingsScreen.jsx', 'components/InstagramConfigForm.jsx', 'components/InstagramBatchPicker.jsx'] },
  { name: 'tiktok-reddit', files: ['components/TikTokBatchPicker.jsx', 'components/TikTokChannelForm.jsx', 'components/TikTokSingleForm.jsx', 'components/RedditThreadView.jsx', 'components/RedditSearchView.jsx', 'components/RedditSearchForm.jsx', 'components/RedditThreadForm.jsx'] },
  { name: 'misc-screens',  files: ['screens/NewResearchScreen.jsx', 'screens/AistudioJobScreen.jsx', 'screens/NotesScreen.jsx'] },
]

log(`Auditing ${BATCHES.length} file-batches. Bulk on Haiku; Opus capped at ${OPUS_CAP} for final adjudication.`)

// ── Stages 1+2 on HAIKU: review each batch, then verify each finding ──────────
const reviewed = await pipeline(
  BATCHES,
  (batch) => agent(
    `${RULES}\n\nRead these files FULLY and audit for the defect classes above. Files:\n` +
    `${batch.files.map(f => `- ${ROOT}/${f}`).join('\n')}\n\n` +
    `Read each file completely before judging. Report every real layout/render defect; if a ` +
    `file is clean, no findings for it. Cite real lines, quote code, flag only genuine visual defects.`,
    { label: `review:${batch.name}`, phase: 'Review', model: 'haiku', schema: FINDINGS_SCHEMA },
  ).then(r => ({ batch: batch.name, findings: (r && r.findings) || [] })),

  (review) => parallel(
    (review.findings || []).map(f => () =>
      agent(
        `You are a skeptical frontend reviewer. A reviewer flagged a LAYOUT/RENDER bug. RE-READ ` +
        `the actual code and decide if it's REAL.\n\nFile: ${f.file}\nLines: ${f.lines}\n` +
        `Class: ${f.category}\nClaim: ${f.title}\nEvidence: ${f.evidence}\n\n` +
        `Open the file, read the cited lines + surrounding context. Default to 'false' if the code ` +
        `already handles the concern (flex-wrap, fixed min-width, dual-label, truncate+min-w-0, ` +
        `!!/Boolean guard, memoized selector). Only 'real' if a user would actually SEE the defect.`,
        { label: `verify:${f.category}:${f.file.split('/').pop()}`, phase: 'Verify', model: 'haiku', schema: VERDICT_SCHEMA },
      ).then(v => ({ ...f, verdict: v }))
    )
  ).then(arr => ({ batch: review.batch, verified: arr.filter(Boolean) })),
)

const haikuConfirmed = reviewed
  .filter(Boolean)
  .flatMap(r => r.verified || [])
  .filter(f => f.verdict && f.verdict.verdict === 'real')
  .map(f => ({ ...f, severity: f.verdict.severity || f.severity }))

const haikuDropped = reviewed.flatMap(r => r.verified || []).filter(f => !f.verdict || f.verdict.verdict !== 'real').length
log(`Haiku: ${haikuConfirmed.length} candidates survived verify (${haikuDropped} dropped). Adjudicating with ≤${OPUS_CAP} Opus.`)

// ── Stage 3 on OPUS: chunk candidates into ≤OPUS_CAP groups, one Opus each ────
const chunks = []
if (haikuConfirmed.length) {
  const chunkSize = Math.max(1, Math.ceil(haikuConfirmed.length / OPUS_CAP))
  for (let i = 0; i < haikuConfirmed.length; i += chunkSize) chunks.push(haikuConfirmed.slice(i, i + chunkSize))
}

const adjudicated = await parallel(chunks.map((chunk, ci) => () =>
  agent(
    `${RULES}\n\nYou are the FINAL adjudicator. Haiku reviewers flagged the candidate ` +
    `layout/render bugs below and a Haiku skeptic already kept them. Your job: RE-READ the ` +
    `actual code for each, and make the authoritative call. Open each file, read the cited ` +
    `lines plus enough context to be certain. For each candidate return: verdict (real/false — ` +
    `be strict, drop anything already mitigated), final severity, and an EXACT, safe fix (the ` +
    `precise className/markup change). Candidates:\n\n` +
    chunk.map((f, i) => `[${i + 1}] ${f.file}:${f.lines} · ${f.category}\n    ${f.title}\n    evidence: ${f.evidence}\n    proposed: ${f.fix}`).join('\n\n'),
    { label: `adjudicate:${ci + 1}/${chunks.length}`, phase: 'Adjudicate', model: 'opus', schema: ADJUDICATED_SCHEMA },
  )
))

const SEV = { high: 0, medium: 1, low: 2 }
const final = adjudicated
  .filter(Boolean)
  .flatMap(a => a.results || [])
  .filter(r => r.verdict === 'real')
  .sort((a, b) => (SEV[a.severity] ?? 9) - (SEV[b.severity] ?? 9))

log(`Opus adjudication: ${final.length} confirmed real bugs (used ${chunks.length} Opus agents).`)

return {
  opus_agents_used: chunks.length,
  haiku_candidates: haikuConfirmed.length,
  confirmed_count: final.length,
  findings: final,
}
