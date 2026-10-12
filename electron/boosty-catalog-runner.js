'use strict'

const readline = require('node:readline')
const { normalizeRequest, authorHandle, projectPost, projectTiers, fail } = require('./boosty-catalog-contract')
const { savePublicCatalog } = require('./boosty-catalog-store')

function createPublicCatalogRunner({ db, jobs, allocateId, spawn, workerEnv, python, script, cwd,
  emit, emitEvent = () => {}, markJobClosed = () => {}, finalizeCatalog, logger = console }) {
  function start(input) {
    const params = normalizeRequest(input)
    for (const active of jobs.values()) if (active.type === 'boosty_channel_fetch' && active.params?.auth_mode === 'public'
        && active.params.handle === params.handle && !['done', 'error', 'cancelled', 'interrupted'].includes(active.status)) {
      throw fail('BOOSTY_CATALOG_ALREADY_RUNNING', 'A public catalogue for this author is already running; inspect its exact job instead')
    }
    const id = allocateId(), startedAt = Math.floor(Date.now() / 1000)
    const progress = { stage: 'starting', auth_mode: 'public', metadata_only: true, loaded: 0, page: 0, catalog_complete: false }
    const job = { id, type: 'boosty_channel_fetch', target: params.target, params: { ...params, _boosty_channel: progress },
      status: 'running', phase: 'starting', items_done: 0, items_total: null, source_id: null,
      started_at: startedAt, entity_kind: 'boosty_channel', boosty_channel: progress, child: null }
    job.dbRowId = db.recordJob({ ...job, cost_usd: 0 })
    jobs.set(id, job)
    emit(job)
    const args = [script, params.target, '--auth-mode', 'public', '--limit', String(params.limit), '--order', params.order,
      '--page-size', String(params.page_size), '--max-pages', String(params.max_pages)]
    if (params.from_ts) args.push('--from-ts', String(params.from_ts))
    if (params.to_ts) args.push('--to-ts', String(params.to_ts))
    if (params.tags.length) args.push('--tags', params.tags.join(','))
    if (params.only_allowed) args.push('--only-allowed')
    if (params.tiers_only) args.push('--tiers-only')
    const env = workerEnv()
    // Even inherited credentials are not forwarded to this public worker.
    delete env.SC_BOOSTY_AUTH_COOKIE
    delete env.SC_BOOSTY_AUTH_EXPIRES
    let entity = null, posts = [], summary = null, tiers = { status: 'not_checked', tiers: [], complete: false }
    function persistProgress() {
      job.params = { ...params, _boosty_channel: job.boosty_channel }
      db.updateJob(job.dbRowId, { status: job.status, source_id: job.source_id, items_done: job.items_done, params: job.params })
    }
    async function finish(code) {
      if (job.phase === 'terminal') return
      job.child = null
      job.phase = 'finalizing'
      let status = job._cancelRequested ? 'cancelled' : code === 0 && summary && !job.error ? 'done' : 'error'
      if (status === 'error' && !job.error) job.error = 'Не удалось прочитать публичные метаданные Boosty'
      const checkpoint = { ...job.boosty_channel, ...(summary || {}), tiers,
        started_at: startedAt, checked_at: Math.floor(Date.now() / 1000),
        stop_reason: status === 'cancelled' ? 'cancelled' : summary?.stop_reason || job.boosty_channel.stop_reason || 'worker_error' }
      if (summary?.posts_total !== posts.length) {
        checkpoint.catalog_complete = false
        checkpoint.stop_reason = status === 'done' ? 'metadata_count_mismatch' : checkpoint.stop_reason
      }
      emit(job)
      try {
        if (entity) {
          const payload = { kind: 'boosty-public-catalog', entity, items: posts, summary: checkpoint, params, status }
          let saved
          if (finalizeCatalog) {
            try { saved = await finalizeCatalog(payload) }
            catch { logger.warn('[BoostyCatalog] finalizer unavailable; using the same public metadata transaction in main') }
          }
          saved ||= savePublicCatalog(db, { ...payload, posts })
          job.source_id = saved.sourceId
          job.items_done = saved.counts.posts
          job.boosty_channel = { ...checkpoint, stage: status, catalog_revision: saved.state.catalog_revision,
            stored_posts: saved.counts.posts, stored_videos: saved.counts.videos,
            posts_total: saved.counts.posts, video_posts: params.tiers_only ? 0 : saved.state.latest?.video_posts || 0,
            videos_total: params.tiers_only ? 0 : saved.state.latest?.declared_video_count || 0,
            visible_videos: params.tiers_only ? 0 : saved.state.latest?.visible_video_count || 0,
            accessible_posts: params.tiers_only ? 0 : saved.state.latest?.anonymous_access_counts?.public_access || 0,
            catalog_complete: saved.state.latest?.job_id === params.public_job_id && saved.state.latest.complete_visible_feed === true }
        } else job.boosty_channel = { ...checkpoint, stage: status, catalog_complete: false }
      } catch {
        status = 'error'
        job.error = 'Публичный каталог не удалось сохранить; прежнее покрытие не заменено'
        job.boosty_channel = { ...checkpoint, stage: 'error', catalog_complete: false }
      }
      posts = []
      job.status = status
      job.phase = 'terminal'
      job.finished_at = Math.floor(Date.now() / 1000)
      job.params = { ...params, _boosty_channel: job.boosty_channel }
      if (status === 'cancelled') job.error = null
      try { db.updateJob(job.dbRowId, { status, source_id: job.source_id, items_done: job.items_done,
        error: job.error || null, finished_at: job.finished_at, params: job.params }) }
      catch { job.status = 'error'; job.error = 'Не удалось сохранить терминальный статус каталога' }
      emit(job)
      markJobClosed(job)
      logger.log(`[BoostyCatalog] end #${id} status=${job.status} posts=${job.items_done}`)
    }
    let child
    try { child = spawn(python, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch { void finish(1); return id }
    job.child = child
    logger.log(`[BoostyCatalog] start #${id} public metadata-only author=${params.handle}`)
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
    lines.on('line', line => {
      let event
      try { event = JSON.parse(line) } catch { return }
      try {
        if (event.type === 'entity') {
          const handle = authorHandle(event.author_handle)
          if (handle !== params.handle) throw fail('BOOSTY_AUTHOR_MISMATCH', 'Unexpected author')
          entity = { author_handle: handle, author_id: event.author_id != null && /^[\w-]{1,100}$/.test(String(event.author_id)) ? String(event.author_id) : null,
            title: typeof event.title === 'string' ? event.title.slice(0, 5000) : handle, canonical_url: params.target,
            posts_count: Number.isSafeInteger(event.posts_count) ? event.posts_count : null }
          job.entity_title = entity.title
          job.source_id = db.upsertBoostyChannel({ author_id: entity.author_id, handle, display_name: entity.title,
            meta: {}, is_explicit: true, mark_synced: false })
          job.boosty_channel = { ...job.boosty_channel, stage: 'catalog', remote_total: entity.posts_count }
          persistProgress()
          emitEvent(job, { type: 'entity', ...entity, auth_mode: 'public' })
          emit(job)
        } else if (event.type === 'post') {
          const post = projectPost(event.data, params.handle)
          if (post) posts.push(post)
        } else if (event.type === 'page') {
          job.items_done = posts.length
          job.boosty_channel = { ...job.boosty_channel, stage: 'catalog', loaded: posts.length,
            page: Number(event.page) || 0, fetched: Number(event.fetched) || 0, duplicates: Number(event.duplicates) || 0,
            invalid_rows: Number(event.invalid_rows) || 0,
            next_cursor: typeof event.next_cursor === 'string' ? event.next_cursor : null,
            remote_eof: event.is_last === true, oldest_at: Number(event.oldest_at) || null,
            stop_reason: String(event.stop_reason || 'continuing').slice(0, 100) }
          persistProgress()
          emit(job)
        } else if (event.type === 'tiers') {
          tiers = projectTiers(event)
          job.boosty_channel = { ...job.boosty_channel, tiers }
          persistProgress()
          emit(job)
        } else if (event.type === 'done') {
          summary = { remote_eof: event.remote_eof === true, catalog_complete: event.catalog_complete === true,
            stop_reason: String(event.stop_reason || 'unknown').slice(0, 100),
            next_cursor: typeof event.next_cursor === 'string' ? event.next_cursor : null,
            fetched: Number(event.fetched) || 0, duplicates: Number(event.duplicates) || 0, pages: Number(event.pages) || 0 }
          summary.posts_total = Number(event.posts_total)
          summary.invalid_rows = Number(event.invalid_rows) || 0
        } else if (event.type === 'error') {
          job.error = 'Не удалось прочитать публичные метаданные Boosty'
          job.boosty_channel = { ...job.boosty_channel, http_status: Number(event.http_status) || null,
            stop_reason: Number(event.http_status) === 429 ? 'rate_limited' : 'http_error' }
          emit(job)
        }
      } catch {
        job.error = 'Недопустимый ответ публичного каталога Boosty'
        try { child.kill('SIGTERM') } catch {}
      }
    })
    child.stderr.on('data', () => {}) // Never echo arbitrary upstream stderr.
    child.on('error', () => { job.error = 'Не удалось запустить обработчик публичного каталога' })
    child.once('close', code => { void finish(code).catch(() => {
      job.status = 'error'; job.phase = 'terminal'; job.error = 'Публичный каталог не завершён'; emit(job); markJobClosed(job)
    }) })
    return id
  }
  return { start }
}

module.exports = { createPublicCatalogRunner }
