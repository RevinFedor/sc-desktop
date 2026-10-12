'use strict'

// Normal SC Requests jobs, not a hidden sidecar. The existing Boosty worker
// does auth/download/AAI; the coordinator owns per-child verification/index/eviction.
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const rag = require('./boosty-rag')
const { fail } = require('./boosty-catalog-contract')
const safe = require('./boosty-workflow-safety')
const terminal = value => ['done', 'error', 'cancelled', 'interrupted'].includes(value)

function createBoostyWorkflow({ db, jobs, allocateId, emit, markJobClosed, spawn, workerEnv, python, workersRoot,
  libraryRoot, authProvider, indexJob, probeOverride = null, logger = console }) {
  const directory = path.join(libraryRoot, 'tmp', 'boosty-workflow')
  const active = new Map(), admitting = new Map()
  const fileFor = id => path.join(directory, `${safe.hash(id)}.json`)
  function load(id) {
    safe.key(id)
    try { return JSON.parse(fs.readFileSync(fileFor(id), 'utf8')) }
    catch { throw fail('BOOSTY_WORKFLOW_NOT_FOUND', 'Exact workflow receipt not found; no replacement started') }
  }
  function status(id) {
    const state = load(id), live = active.get(id)
    return { ok: true, ...state, status: live ? live.status : terminal(state.status) ? state.status : 'interrupted' }
  }
  function commit(job, state) {
    job._workflowState = state
    state.status = job.status; state.stage = job.phase; state.updated_at = Date.now()
    state.revision = Number(state.revision || 0) + 1
    safe.atomic(fileFor(state.job_id), state)
    job.params = { origin: 'mcp', autoCopy: false, workflow_id: state.job_id, operation: state.operation,
      plan_id: state.plan_id || null, _boosty_workflow: { stage: state.stage, ledger: state.ledger || [], error_code: state.error_code || null } }
    job.source_id = state.source_id || null
    job.items_total = state.ledger?.length || 0
    job.items_done = state.ledger?.filter(c => ['reused', 'ready_evicted'].includes(c.state)).length || 0
    db.updateJob(job.dbRowId, { source_id: job.source_id, status: job.status, params: job.params,
      items_total: job.items_total, items_done: job.items_done, error: state.error_code || null, finished_at: job.finished_at || null })
    emit(job)
  }
  function check(job) { if (job._cancelRequested) throw fail('BOOSTY_WORKFLOW_CANCELLED', 'Exact workflow cancellation requested') }
  function foreignSource(sourceId, ownJob) {
    for (const job of jobs.values()) if (job !== ownJob && !terminal(job.status) && job.type.startsWith('boosty')
      && Number(job.source_id) === Number(sourceId)) throw fail('BOOSTY_SOURCE_BUSY', 'Another Boosty operation owns this source; no replacement or duplicate ASR')
  }
  function runPython(job, args, { auth = null, envExtra = {}, onEvent = () => {} } = {}) {
    return new Promise((resolve, reject) => {
      let result = null, failure = null
      const env = { ...workerEnv(), ...envExtra }
      delete env.SC_BOOSTY_AUTH_COOKIE; delete env.SC_BOOSTY_AUTH_EXPIRES
      if (auth) { env.SC_BOOSTY_AUTH_COOKIE = auth.value; if (auth.expirationDate) env.SC_BOOSTY_AUTH_EXPIRES = String(auth.expirationDate) }
      const child = spawn(python, args, { cwd: workersRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
      job.child = child
      const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
      lines.on('line', line => {
        let event
        try { event = JSON.parse(line) } catch { return }
        try {
          if (event.type === 'result') result = event.result
          if (['error', 'item_error'].includes(event.type)) failure = fail('BOOSTY_CHILD_FAILED', 'Worker failed; media retained, original paid receipt must be recovered')
          onEvent(event)
        } catch (e) { failure = e; child.kill('SIGTERM') }
      })
      child.stderr.on('data', () => {}) // upstream may contain a signed URL/token: never echo
      child.on('error', () => { failure = fail('BOOSTY_WORKER_UNAVAILABLE', 'Boosty worker could not start') })
      child.once('close', code => {
        job.child = null
        lines.close()
        if (job._cancelRequested) reject(fail('BOOSTY_WORKFLOW_CANCELLED', 'Cancelled; uncertain/failed media retained'))
        else if (failure || code !== 0) reject(failure || fail('BOOSTY_CHILD_FAILED', 'Worker failed; no automatic paid resubmit'))
        else resolve(result)
      })
    })
  }
  async function probe(job, config) {
    if (probeOverride) return probeOverride(config) // explicit physical-disk double in isolated tests only
    const configFile = path.join(directory, `probe-${job.id}.json`)
    safe.atomic(configFile, config)
    try { return await runPython(job, [path.join(workersRoot, 'web', 'boosty_workflow_ndjson.py'), 'probe', '--config-file', configFile]) }
    finally { try { fs.unlinkSync(configFile) } catch {} }
  }
  async function storage() {
    const dummy = { id: allocateId(), child: null }
    return { ok: true, storage: await runPython(dummy, [path.join(workersRoot, 'web', 'boosty_workflow_ndjson.py'), 'storage']) }
  }
  function begin(state, execute) {
    const id = allocateId(), now = Math.floor(Date.now() / 1000)
    const job = { id, type: state.operation === 'preflight' ? 'boosty_account_preflight' : 'boosty_catchup',
      target: state.handle || `source:${state.source_id}`, source_id: state.source_id || null,
      status: 'running', phase: 'starting', started_at: now, params: { origin: 'mcp', autoCopy: false, workflow_id: state.job_id }, child: null }
    job.dbRowId = db.recordJob({ ...job, cost_usd: 0 })
    jobs.set(id, job); active.set(state.job_id, job)
    job.cancel = () => {
      job._cancelRequested = true; job.status = 'cancelling'
      if (job.child) job.child.kill('SIGTERM')
      if (job._indexId) indexJob.cancelById(job._indexId)
    }
    commit(job, state)
    void (async () => {
      try { await execute(job, state); check(job); job.status = 'done' }
      catch (e) {
        job.status = e.code === 'BOOSTY_WORKFLOW_CANCELLED' || job._cancelRequested ? 'cancelled' : 'error'
        state.error_code = e.code || 'BOOSTY_WORKFLOW_FAILED'
        const unfinished = state.ledger?.find(c => ['processing', 'saved_verified'].includes(c.state))
        if (unfinished) unfinished.error_code = state.error_code
        // Never serialize arbitrary SDK/auth/upstream error text.
        job.error = state.error_code
      }
      finally {
        job.phase = 'terminal'; job.finished_at = Math.floor(Date.now() / 1000)
        try { commit(job, state) } catch { job.status = 'error'; job.error = 'BOOSTY_RECEIPT_SAVE_FAILED'; emit(job) }
        active.delete(state.job_id); markJobClosed(job)
        logger.log(`[BoostyWorkflow] end ${state.job_id} status=${job.status}`)
      }
    })()
    return { ok: true, accepted: true, job_id: state.job_id, request_id: state.request_id, db_id: job.dbRowId, status: 'running' }
  }
  async function admit(input, operation, execute) {
    const requestId = safe.key(input.request_id), jobId = `boosty-workflow:${requestId}`, requestHash = safe.hash({ operation, input })
    if (requestId.length > 160) throw fail('BOOSTY_REQUEST_ID_REQUIRED', 'request_id maximum is 160 characters')
    const old = admitting.get(jobId)
    if (old) {
      if (old.hash !== requestHash) throw fail('BOOSTY_REQUEST_ID_CONFLICT', 'Request identity changed')
      const receipt = await old.promise
      return { ...receipt, deduplicated: true, status: status(receipt.job_id).status }
    }
    try {
      const previous = load(jobId)
      if (previous.request_hash !== requestHash) throw fail('BOOSTY_REQUEST_ID_CONFLICT', 'Request identity changed')
      return { ok: true, accepted: true, deduplicated: true, job_id: jobId, request_id: requestId, status: status(jobId).status }
    } catch (e) { if (e.code !== 'BOOSTY_WORKFLOW_NOT_FOUND') throw e }
    const promise = execute({ version: 1, operation, request_id: requestId, request_hash: requestHash, job_id: jobId,
      created_at: Date.now(), autoCopy: false, origin: 'mcp' })
    admitting.set(jobId, { hash: requestHash, promise })
    try { return await promise } catch (e) { admitting.delete(jobId); throw e }
  }
  async function preflight(input) {
    const handle = safe.handle(input.handle || input.url)
    const externalMount = path.resolve(input.external_mount || '/Volumes/digma512')
    if (!externalMount.startsWith('/Volumes/') || externalMount === '/Volumes') throw fail('BOOSTY_INVALID_STORAGE', 'A specific external mount is required')
    return admit({ request_id: safe.key(input.request_id), handle, external_mount: externalMount }, 'preflight', async state => {
      const existing = db.listSources('boosty').find(s => s.handle === handle)
      if (existing) foreignSource(existing.id)
      if ([...active.values()].some(j => j.target === handle)) throw fail('BOOSTY_SOURCE_BUSY', 'Account preflight already running for this author')
      state.handle = handle
      return begin(state, async (job, state) => {
        check(job)
        const auth = await authProvider()
        check(job)
        job.phase = 'account_catalog'; commit(job, state)
        const plan = await runPython(job, [path.join(workersRoot, 'web', 'boosty_workflow_ndjson.py'), 'plan', '--target', `https://boosty.to/${handle}`], { auth })
        check(job)
        if (plan?.catalogue?.remote_eof !== true || plan.handle !== handle) throw fail('BOOSTY_ACCOUNT_EOF_UNVERIFIED', 'No paid selection without full account EOF')
        state.source_id = plan.source_id
        const namespace = path.join(externalMount, 'SC Desktop', 'Boosty', 'catchup', `${plan.source_id}-${safe.hash(state.job_id).slice(0, 16)}`)
        const config = { external_mount: externalMount, audio_dir: path.join(namespace, 'audio'), work_dir: path.join(namespace, 'work'),
          transcript_dir: path.join(libraryRoot, 'transcripts', 'boosty'), library_root: libraryRoot, reserve_bytes: 5 * 1024 ** 3 }
        job.phase = 'storage_preflight'; commit(job, state)
        const storageProof = await probe(job, config)
        if (!storageProof?.ok) throw fail('BOOSTY_STORAGE_UNVERIFIED', 'Physical storage preflight required')
        state.config = { ...config, ...(storageProof.roots || {}), external_mount: storageProof.external_mount || config.external_mount,
          volume_uuid: storageProof.volume_uuid }
        state.storage = storageProof
        state.plan = plan
        state.plan_hash = safe.hash({ plan, config: state.config })
      })
    })
  }
  function rowFor(sourceId, videoId) {
    const row = db.getItemsByExternalIds(sourceId, [videoId])[0]
    if (!row || row.type !== 'boosty_video') throw fail('BOOSTY_SELECTION_SOURCE_MISMATCH', 'Exact selected child is not in this author')
    return row
  }
  function verifiedDocument(sourceId, itemId) {
    const doc = rag.document(db, itemId)
    if (doc.reason || doc.row.source_id !== sourceId || doc.kind !== 'transcript' || !doc.cues.length) throw fail('BOOSTY_ORIGINAL_PROOF_FAILED', 'Full own-child original/cues required')
    const original = rag.readOriginal(db, { item_id: itemId, expected_document_hash: doc.documentHash, max_chars: 32 })
    const context = rag.context(db, { item_id: itemId, expected_document_hash: doc.documentHash, cue_index: 0, before_cues: 1, after_cues: 1 })
    if (original.item_id !== itemId || context.item_id !== itemId || original.document_hash !== doc.documentHash || context.document_hash !== doc.documentHash) throw fail('BOOSTY_ORIGINAL_PROOF_FAILED', 'Original/context must prove the same child version')
    return doc
  }
  async function index(job, sourceId, ids, requestId) {
    const activeIndex = indexJob.currentSnapshot(sourceId, 'boosty')
    if (activeIndex) throw fail('BOOSTY_INDEX_BUSY', 'Existing index is not owned by this catchup; no cancellation/replacement')
    const start = indexJob.startTracked({ mode: 'boosty', sourceId, itemIds: ids, requestId })
    job._indexId = start.id
    try {
      await new Promise((resolve, reject) => {
        const off = indexJob.subscribe(snapshot => {
          if (snapshot.id !== start.id) return
          if (snapshot.phase === 'terminal' || terminal(snapshot.status)) { off(); snapshot.status === 'done' ? resolve(snapshot) : reject(fail('BOOSTY_INDEX_INTERRUPTED', 'Saved text retained; index receipt remains resumable')) }
        })
        // Workers publish terminal events after durable persistence; there is
        // no speculative sleep or repeated job-status polling here.
        const now = indexJob.getActiveSnapshot(start.id)
        if (now?.phase === 'terminal' || terminal(start.status)) { off(); start.status === 'done' ? resolve(start) : reject(fail('BOOSTY_INDEX_INTERRUPTED', 'Index did not complete')) }
        if (job._cancelRequested) indexJob.cancelById(start.id)
      })
      return { job_id: start.id, db_id: start.dbRowId || null, request_id: requestId, status: 'done' }
    } finally { job._indexId = null }
  }
  async function clean(job, state, child) {
    check(job)
    await probe(job, child.config)
    check(job)
    const row = rowFor(state.source_id, child.video_id)
    if (child.pair) { safe.sameFile(child.pair.txt, child.config.transcript_dir); safe.sameFile(child.pair.srt, child.config.transcript_dir) }
    const doc = verifiedDocument(state.source_id, row.id)
    if (doc.documentHash !== child.document_hash || rag.documentStatus(db.getDb(), doc).state !== 'ready_current') throw fail('BOOSTY_INDEX_NOT_READY', 'No eviction until the SAME full original is current-ready')
    if (!child.media_manifest) throw fail('BOOSTY_MEDIA_OWNERSHIP_UNVERIFIED', 'No exact own-media manifest; retain files')
    const cleanup = safe.evictManifest(child.owned_root, child.owner, child.media_manifest)
    // Preserve user media that existed before this run and never clear a
    // concurrently replaced pointer. Deleted own media may be null/evicted.
    if (row.media_path && child.media_manifest.some(p => p.path === row.media_path)) db.clearItemMediaPaths(state.source_id, [child.video_id], 'evicted')
    child.cleanup = cleanup; child.state = 'ready_evicted'
    commit(job, state)
  }
  async function process(job, state) {
    foreignSource(state.source_id, job)
    let auth = null
    const savedIds = rag.documents(db, state.source_id).filter(d => !d.reason && rag.documentStatus(db.getDb(), d).state !== 'ready_current').map(d => d.row.id)
    if (savedIds.length) { job.phase = 'index_saved_texts'; commit(job, state); state.saved_index_receipt = await index(job, state.source_id, savedIds, `saved-${safe.hash(state.job_id).slice(0, 24)}`); commit(job, state) }
    for (const child of state.ledger) {
      check(job); foreignSource(state.source_id, job)
      if (child.state === 'ready_evicted' || child.state === 'reused') continue
      const row = rowFor(state.source_id, child.video_id)
      // Success is text, not MP3 existence. Evicted media never triggers ASR.
      if (row.transcript_path && fs.existsSync(row.transcript_path) && fs.statSync(row.transcript_path).size > 0) {
        if (!child.owned_root) { child.state = 'reused'; commit(job, state); continue }
        child.pair = safe.verifyPair(row.transcript_path, state.config.transcript_dir)
      } else {
        const owner = { workflow_id: state.job_id, source_id: state.source_id, video_id: child.video_id }
        const ownedRoot = path.join(path.dirname(state.config.audio_dir), 'children', child.video_id)
        child.owner ||= owner; child.owned_root ||= ownedRoot
        child.config ||= { ...state.config, audio_dir: path.join(ownedRoot, 'audio'), work_dir: path.join(ownedRoot, 'work') }
        await probe(job, child.config); check(job)
        safe.ownedDirectory(ownedRoot, child.owner)
        const receiptFile = path.join(libraryRoot, 'jobs', 'boosty-asr-receipts', String(state.source_id), `${child.video_id}.json`)
        if (fs.existsSync(receiptFile)) {
          let receipt
          try { receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8')) } catch { throw fail('BOOSTY_ASR_DELIVERY_UNKNOWN', 'Unreadable paid receipt; no download or resubmit') }
          if (receipt.state !== 'not_submitted' && !receipt.transcript_id) throw fail('BOOSTY_ASR_DELIVERY_UNKNOWN', 'Original paid delivery unknown; no download or resubmit')
        }
        child.state = 'processing'; job.phase = 'transcribe'; commit(job, state)
        const selectionPath = path.join(directory, `${safe.hash(state.job_id)}-${child.item_id}-selection.json`)
        const configPath = path.join(directory, `${safe.hash(state.job_id)}-${child.item_id}-storage.json`)
        if (child.audio_proof) safe.sameFile(child.audio_proof, child.owned_root)
        safe.atomic(selectionPath, { items: [{ url: child.url, video_id: child.video_id, title: child.worker_title || child.title,
          duration_sec: child.duration_sec, audio_path: child.audio_proof?.path || null }] })
        safe.atomic(configPath, { ...child.config, source_id: state.source_id, asr_profile: state.asr_profile,
          owner_workflow_id: child.owner.workflow_id })
        const receiptDir = path.join(libraryRoot, 'jobs', 'boosty-asr-receipts', String(state.source_id))
        let saved = null
        try {
          auth ||= await authProvider(); check(job)
          await runPython(job, [path.join(workersRoot, 'web', 'boosty_single_ndjson.py'), '--selection-file', selectionPath,
            '--media-dir', child.config.audio_dir, '--work-dir', child.config.work_dir, '--transcript-dir', child.config.transcript_dir,
            '--strict-storage-plan', configPath, '--asr-receipt-dir', receiptDir],
          { auth, envExtra: { TMPDIR: child.config.work_dir, TMP: child.config.work_dir, TEMP: child.config.work_dir }, onEvent: event => {
            if (event.video_id && event.video_id !== child.video_id) throw fail('BOOSTY_WRONG_CHILD', 'Worker returned a different video; no ASR replay or cleanup')
            if (event.type === 'transcribe_progress' && event.transcript_id) child.provider_transcript_id = event.transcript_id
            if (event.type === 'metadata' && event.title) child.worker_title = event.title
            if (event.type === 'download_done' && event.audio_path) { child.audio_proof = safe.sealFile(event.audio_path, child.owned_root); commit(job, state) }
            if (event.type === 'saved') saved = event
            if (['download_processing', 'transcribe_start', 'transcribe_progress'].includes(event.type)) { job.phase = event.type; commit(job, state) }
          } })
          if (!saved?.file_path) throw fail('BOOSTY_SAVE_UNCONFIRMED', 'No confirmed transcription; retain own media')
          const paid = JSON.parse(fs.readFileSync(receiptFile, 'utf8'))
          if (paid.state !== 'completed' || paid.identity?.video_id !== child.video_id || paid.identity?.source_id !== state.source_id || !paid.transcript_id) throw fail('BOOSTY_ASR_DELIVERY_UNKNOWN', 'Saved pair has no matching paid completion receipt')
          child.provider_transcript_id = paid.transcript_id
          child.pair = safe.verifyPair(saved.file_path, child.config.transcript_dir)
          if (paid.saved_pair?.txt_sha256 !== child.pair.txt.sha256 || paid.saved_pair?.srt_sha256 !== child.pair.srt.sha256) throw fail('BOOSTY_ASR_FILE_HASH_MISMATCH', 'Saved TXT/SRT must match this exact paid completion; retain media')
          child.media_manifest = safe.mediaManifest(ownedRoot, child.owner)
          db.markItemTranscribed({ source_id: state.source_id, external_id: child.video_id, transcript_path: child.pair.txt.path, engine: 'assemblyai', cost_usd: saved.cost_usd || null })
          if (!row.media_path && saved.audio_path) db.markItemDownloaded({ source_id: state.source_id, external_id: child.video_id, media_path: saved.audio_path })
          child.newly_transcribed = true
        } finally { for (const file of [selectionPath, configPath]) try { fs.unlinkSync(file) } catch {} }
      }
      const doc = verifiedDocument(state.source_id, child.item_id)
      if (doc.postUuid !== child.post_id || String(doc.row.external_id) !== child.video_id) throw fail('BOOSTY_WRONG_PARENT_CHILD', 'Canonical original must belong to the exact planned post and child')
      child.document_hash = doc.documentHash; child.state = 'saved_verified'; job.phase = 'index'; commit(job, state)
      const completion = JSON.parse(fs.readFileSync(path.join(libraryRoot, 'jobs', 'boosty-asr-receipts', String(state.source_id), `${child.video_id}.json`), 'utf8'))
      if (completion.saved_pair?.txt_sha256 !== child.pair.txt.sha256 || completion.saved_pair?.srt_sha256 !== child.pair.srt.sha256) throw fail('BOOSTY_ASR_FILE_HASH_MISMATCH', 'Paid saved-pair proof differs; no cleanup')
      if (!child.media_manifest) {
        const receipt = JSON.parse(fs.readFileSync(path.join(libraryRoot, 'jobs', 'boosty-asr-receipts', String(state.source_id), `${child.video_id}.json`), 'utf8'))
        if (receipt.state !== 'completed' || receipt.identity?.source_id !== state.source_id || receipt.identity?.video_id !== child.video_id) throw fail('BOOSTY_ASR_DELIVERY_UNKNOWN', 'No matching completion proof for media cleanup')
        child.media_manifest = safe.mediaManifest(child.owned_root, child.owner); commit(job, state)
      }
      if (rag.documentStatus(db.getDb(), doc).state !== 'ready_current') {
        child.index_receipt = { request_id: `${safe.hash(state.job_id).slice(0, 24)}-${child.item_id}-${Date.now()}`, status: 'requested' }
        commit(job, state)
        child.index_receipt = await index(job, state.source_id, [child.item_id], child.index_receipt.request_id)
        commit(job, state)
      }
      job.phase = 'verified_cleanup'; await clean(job, state, child)
    }
    state.coverage = rag.indexStatus(db, { source_id: state.source_id })
    state.account_ledger = load(state.plan_id).plan
  }
  async function start(input) {
    if (input.confirm_asr !== true) throw fail('BOOSTY_ASR_CONFIRMATION_REQUIRED', 'Explicit confirm_asr=true required for paid missing-child processing')
    const profile = safe.asrProfile(input.asr_profile)
    const planState = load(input.plan_id)
    if (planState.operation !== 'preflight' || planState.status !== 'done' || planState.plan_hash !== input.expected_plan_hash) throw fail('BOOSTY_PLAN_NOT_READY', 'Use the completed exact account/storage plan hash')
    if (input.video_ids != null && (!Array.isArray(input.video_ids) || input.video_ids.length > 5000)) throw fail('BOOSTY_INVALID_SELECTION', 'video_ids must be a bounded exact child array')
    const requested = input.video_ids == null ? planState.plan.children.filter(c => c.state === 'missing' && c.has_access === true).map(c => c.video_id)
      : [...new Set(input.video_ids)].sort()
    if (requested.some(id => !/^[0-9a-fA-F-]{36}$/.test(id))) throw fail('BOOSTY_INVALID_SELECTION', 'Real Boosty child UUIDs required')
    const eligible = planState.plan.children.filter(c => requested.includes(c.video_id))
    if (eligible.length !== requested.length || eligible.some(c => c.has_access !== true || c.state !== 'missing')) throw fail('BOOSTY_SELECTION_NOT_MISSING_AUTHORIZED', 'Only exact missing authorized children may be selected; no force/replay')
    if (eligible.some(c => !(c.duration_sec > 0))) throw fail('BOOSTY_DURATION_UNKNOWN', 'Duration/cost scope unknown; complete metadata duration proof before paid release')
    return admit({ request_id: safe.key(input.request_id), plan_id: input.plan_id, expected_plan_hash: input.expected_plan_hash, video_ids: requested, confirm_asr: true, asr_profile: profile }, 'catchup', async state => {
      if (Date.now() - planState.updated_at > 60 * 60 * 1000) throw fail('BOOSTY_PLAN_EXPIRED', 'Refresh account preflight; old access is not current entitlement')
      foreignSource(planState.source_id)
      for (const c of eligible) if (fs.existsSync(path.join(libraryRoot, 'jobs', 'boosty-asr-receipts', String(planState.source_id), `${c.video_id}.json`))) {
        throw fail('BOOSTY_EXISTING_PAID_RECEIPT', 'An earlier exact child receipt exists; resume its original workflow, never start a replacement')
      }
      // A physical USB proof is needed BEFORE reserving/dispatching any paid job.
      const dummy = { id: allocateId(), child: null }
      await probe(dummy, planState.config)
      const sourceActive = indexJob.currentSnapshot(planState.source_id, 'boosty')
      if (sourceActive) throw fail('BOOSTY_INDEX_BUSY', 'Wait for the source index; it is not owned by catchup')
      state.source_id = planState.source_id; state.plan_id = input.plan_id; state.config = planState.config
      state.asr_profile = profile
      state.ledger = eligible.map(c => ({ ...c }))
      return begin(state, process)
    })
  }
  async function resume(input) {
    const previous = load(input.job_id)
    if (previous.operation !== 'catchup' || active.has(input.job_id) || !['error', 'cancelled', 'interrupted'].includes(status(input.job_id).status)) throw fail('BOOSTY_RESUME_NOT_TERMINAL', 'Resume only the exact failed/interrupted catchup')
    return admit({ request_id: safe.key(input.request_id), previous_job_id: input.job_id }, 'catchup', async state => {
      foreignSource(previous.source_id)
      await probe({ id: allocateId(), child: null }, previous.config)
      // Keep the original ownership/namespace/paid receipts, not a new media run.
      state.source_id = previous.source_id; state.plan_id = previous.plan_id; state.config = previous.config
      state.asr_profile = safe.asrProfile(previous.asr_profile)
      state.ledger = previous.ledger; state.resumed_from = input.job_id
      return begin(state, process)
    })
  }
  function cancel(id) {
    const job = active.get(safe.key(id))
    if (!job) return { ok: true, cancel_requested: false, job: status(id) }
    job.cancel(); job.phase = 'cancelling'; commit(job, job._workflowState)
    return { ok: true, cancel_requested: true, job_id: id }
  }
  async function cleanup(input) {
    const state = load(input.job_id)
    if (active.has(state.job_id)) throw fail('BOOSTY_SOURCE_BUSY', 'Cleanup is owned by the running coordinator')
    if (state.operation !== 'catchup') throw fail('BOOSTY_INVALID_CLEANUP', 'Not a media-owning workflow')
    const child = state.ledger.find(c => c.video_id === input.video_id)
    if (!child || !['saved_verified', 'ready_evicted'].includes(child.state)) throw fail('BOOSTY_INVALID_CLEANUP', 'Only a verified own child can be cleaned')
    foreignSource(state.source_id)
    const dummy = { id: allocateId(), status: state.status, phase: state.stage, dbRowId: null }
    // Explicit cleanup uses the same verification as the automatic coordinator.
    await clean({ ...dummy, dbRowId: db.getDb().prepare("SELECT id FROM jobs WHERE json_extract(parameters_json,'$.workflow_id')=? ORDER BY id DESC LIMIT 1").get(state.job_id)?.id }, state, child)
    return { ok: true, child }
  }
  function diarization(input) {
    const state = load(input.job_id), child = state.ledger?.find(c => c.video_id === input.video_id)
    if (!child?.pair || !child.document_hash) throw fail('BOOSTY_DIARIZATION_UNAVAILABLE', 'No verified diarization original for this exact workflow child')
    const doc = verifiedDocument(state.source_id, child.item_id)
    if (input.expected_document_hash !== doc.documentHash || doc.documentHash !== child.document_hash) throw fail('BOOSTY_ORIGINAL_CHANGED', 'Read the current child hash; never join changed transcript and speakers')
    safe.sameFile(child.pair.txt, state.config.transcript_dir); safe.sameFile(child.pair.srt, state.config.transcript_dir)
    const paid = JSON.parse(fs.readFileSync(path.join(libraryRoot, 'jobs/boosty-asr-receipts', String(state.source_id), `${child.video_id}.json`), 'utf8'))
    const offset = Number(input.offset || 0), limit = Number(input.limit || 100)
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw fail('BOOSTY_INVALID_PAGINATION', 'Bounded utterance paging required')
    const rows = paid.asr_metadata?.utterances
    if (!Array.isArray(rows)) throw fail('BOOSTY_DIARIZATION_UNAVAILABLE', 'Provider output is absent; existing saved text remains readable')
    const hash = safe.hash(rows)
    if (offset && !input.expected_diarization_hash || input.expected_diarization_hash && input.expected_diarization_hash !== hash) throw fail('BOOSTY_DIARIZATION_CHANGED', 'Same diarization hash required for continuation')
    return { ok: true, item_id: child.item_id, video_id: child.video_id, post_id: child.post_id, canonical_url: child.url,
      document_hash: doc.documentHash, diarization_hash: hash, total: rows.length, utterances: rows.slice(offset, offset + limit),
      next_offset: offset + limit < rows.length ? offset + limit : null,
      speaker_labels: 'provider_assigned_not_verified_identity_or_role', mixed_RU_EN_quality_verified: false }
  }
  return { preflight, storage, status, start, resume, cancel, cleanup, diarization }
}
module.exports = { createBoostyWorkflow }
