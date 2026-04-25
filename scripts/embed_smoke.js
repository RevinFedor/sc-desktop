// Verifies Gemini embedding API works + that vectors behave: similar phrases
// should be closer than unrelated ones.
const { embedBatch, embedQuery, OUTPUT_DIM } = require('../electron/embedder')

function cos(a, b) {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot // already L2-normalised → dot == cos
}

async function main() {
  console.log('OUTPUT_DIM:', OUTPUT_DIM)
  const texts = [
    'react лоудер для клода',
    'спиннер на реакте топ',
    'купил квартиру в москве',
  ]
  const t0 = Date.now()
  const docVecs = await embedBatch(texts, 'RETRIEVAL_DOCUMENT')
  console.log(`embedBatch x${texts.length} → ${Date.now() - t0}ms, dim=${docVecs[0].length}`)

  const q = await embedQuery('как сделать индикатор загрузки в react')
  console.log('q dim:', q.length)
  for (let i = 0; i < texts.length; i++) {
    console.log(`  cos(q, "${texts[i]}") = ${cos(q, docVecs[i]).toFixed(4)}`)
  }
}
main().catch(e => { console.error('FAIL:', e.message); process.exit(1) })
