'use strict'

// A shared vec corpus can contain hundreds of thousands of TG/Boosty rows.
// One correlated vec0 COUNT per channel multiplies that corpus by N sources,
// even for public limit=1 (which is applied later). Restrict by real chunk PKs
// once, group once, then retain the existing channel summary semantics.
function youtubeSourceRows(handle) {
  return handle.transaction(() => {
    const hasVectors = !!handle.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='semantic_chunks_vec'").get()
    const vectors = hasVectors ? handle.prepare(`
      SELECT c.source_id, COUNT(*) AS fragments_indexed, COUNT(DISTINCT c.item_id) AS videos_indexed
      FROM semantic_chunks_vec v JOIN semantic_chunks c ON c.id=v.chunk_id AND c.source_id=v.source_id
      WHERE v.chunk_id IN (
        SELECT c.id FROM semantic_chunks c JOIN sources s ON s.id=c.source_id WHERE s.platform='youtube'
      ) GROUP BY c.source_id
    `).all() : []
    const bySource = new Map(vectors.map(row => [Number(row.source_id), row]))
    return handle.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM items i WHERE i.source_id=s.id) AS items_total,
        (SELECT COUNT(*) FROM items i WHERE i.source_id=s.id AND i.transcript_path IS NOT NULL) AS transcribed_videos,
        (SELECT COUNT(*) FROM semantic_chunks c WHERE c.source_id=s.id) AS fragments_total
      FROM sources s WHERE s.platform='youtube'
      ORDER BY transcribed_videos DESC,items_total DESC,s.last_synced_at DESC
    `).all().map(row => ({ ...row, fragments_indexed: Number(bySource.get(Number(row.id))?.fragments_indexed || 0),
      videos_indexed: Number(bySource.get(Number(row.id))?.videos_indexed || 0) }))
  }).deferred()
}

module.exports = { youtubeSourceRows }
