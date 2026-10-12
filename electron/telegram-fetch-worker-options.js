'use strict'

const path = require('node:path')
const crypto = require('node:crypto')

// Pure optional CLI extension. No legacy flags/engine/defaults are changed.
function telegramFetchWorkerOptions(params, { jobsDir, session } = {}) {
  const args = []
  const namespace = crypto.createHash('sha256').update(String(session || 'default')).digest('hex').slice(0, 32)
  if (params.expected_account_id != null) args.push('--expected-account-id', String(params.expected_account_id))
  if (params.expected_peer_id != null) args.push('--expected-peer-id', String(params.expected_peer_id))
  if (params.download_profile_photo === false) args.push('--skip-profile-photo')
  if (params.voice_types) args.push('--voice-types', params.voice_types.join(','))
  if (params.voice_max_duration_sec != null) args.push('--voice-max-duration-sec', String(params.voice_max_duration_sec))
  if (params.media_cache_dir) args.push('--media-cache-dir', params.media_cache_dir)
  if (params.media_min_free_bytes != null) args.push('--media-min-free-bytes', String(params.media_min_free_bytes))
  if (params.reuse_transcripts) args.push('--reuse-transcripts')
  if (params.voice_types || params.voice_max_duration_sec != null || params.media_cache_dir || params.reuse_transcripts) {
    args.push('--media-state-dir', path.join(jobsDir, 'telegram-asr-state', namespace))
  }
  if (params.full_history) {
    args.push('--full-history-report')
    const historyKey = params._fetch_history_request_id || params.request_id
    if (historyKey) args.push('--traversal-state-dir', path.join(jobsDir, 'telegram-history-state', namespace),
      '--traversal-request-id', historyKey)
  }
  return args
}

module.exports = { telegramFetchWorkerOptions }
