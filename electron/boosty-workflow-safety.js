'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { authorHandle, fail } = require('./boosty-catalog-contract')

const hash = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
function key(value) {
  if (!/^[A-Za-z0-9_.:-]{1,192}$/.test(value || '')) throw fail('BOOSTY_REQUEST_ID_REQUIRED', 'A stable request_id is required')
  return value
}
function handle(value) { return authorHandle(value) }
function asrProfile(value) {
  if (!value || value.approved_by_user !== true || value.engine !== 'assemblyai'
      || value.language_detection !== true || value.speaker_labels !== true
      || !Array.isArray(value.speech_models) || !value.speech_models.length || value.speech_models.length > 3
      || value.speech_models.some(v => typeof v !== 'string' || !/^[a-z0-9_-]{2,80}$/.test(v))
      || !Number.isFinite(value.estimated_cost_usd) || value.estimated_cost_usd < 0
      || !Number.isFinite(value.max_cost_usd) || value.max_cost_usd <= 0 || value.estimated_cost_usd > value.max_cost_usd) {
    throw fail('BOOSTY_ASR_MODEL_COST_RELEASE_REQUIRED', 'No media/ASR until the user-approved exact model, language detection, diarization and cost ceiling are provided; no hidden fallback')
  }
  return { engine: 'assemblyai', release_id: key(value.release_id), approved_by_user: true,
    speech_models: [...value.speech_models], language_detection: true, speaker_labels: true,
    estimated_cost_usd: value.estimated_cost_usd, max_cost_usd: value.max_cost_usd }
}
function atomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const fd = fs.openSync(`${file}.part`, 'w', 0o600)
  try { fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(`${file}.part`, file)
}
function realFuture(value) {
  let probe = path.resolve(value), tail = []
  while (!fs.existsSync(probe)) { tail.unshift(path.basename(probe)); const parent = path.dirname(probe); if (parent === probe) throw fail('BOOSTY_STORAGE_UNVERIFIED', 'No existing path ancestor'); probe = parent }
  return path.join(fs.realpathSync(probe), ...tail)
}
function inside(file, root) {
  const rel = path.relative(fs.realpathSync(root), fs.realpathSync(file))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}
function sealFile(file, root) {
  if (!file || !fs.existsSync(file) || !inside(file, root) || fs.lstatSync(file).isSymbolicLink()) throw fail('BOOSTY_FILE_PROOF_FAILED', 'File must physically remain inside its admitted root')
  const before = fs.statSync(file)
  if (!before.isFile() || before.size === 0) throw fail('BOOSTY_FILE_PROOF_FAILED', 'A stable nonempty file is required')
  const content = fs.readFileSync(file), after = fs.statSync(file)
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw fail('BOOSTY_FILE_CHANGED', 'File changed during verification')
  return { path: fs.realpathSync(file), sha256: hash(content), bytes: after.size, dev: after.dev, ino: after.ino }
}
function verifyPair(txt, transcriptRoot) {
  const a = sealFile(txt, transcriptRoot), b = sealFile(txt.replace(/\.txt$/i, '.srt'), transcriptRoot)
  const text = fs.readFileSync(a.path, 'utf8').replace(/^#[\s\S]*?\n\n/, '').trim()
  const srt = fs.readFileSync(b.path, 'utf8')
  if (!text || !/\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(srt) || !srt.replace(/\d+\n|\d{2}:.*?\n/g, '').trim()) throw fail('BOOSTY_EMPTY_TRANSCRIPT', 'Full TXT and timed SRT are required before eviction')
  return { txt: a, srt: b }
}
function sameFile(proof, root) {
  const current = sealFile(proof.path, root)
  if (current.sha256 !== proof.sha256 || current.dev !== proof.dev || current.ino !== proof.ino) throw fail('BOOSTY_FILE_CHANGED', 'Owned file was replaced or changed; no deletion')
}
function ownedDirectory(directory, owner) {
  const marker = path.join(directory, '.sc-boosty-owner.json')
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    fs.writeFileSync(marker, JSON.stringify(owner), { flag: 'wx', mode: 0o600 })
  } else {
    if (fs.lstatSync(directory).isSymbolicLink() || !fs.existsSync(marker) || fs.lstatSync(marker).isSymbolicLink()
        || JSON.stringify(JSON.parse(fs.readFileSync(marker, 'utf8'))) !== JSON.stringify(owner)) throw fail('BOOSTY_MEDIA_OWNERSHIP_UNVERIFIED', 'Existing media directory is not owned by this exact workflow')
  }
  return marker
}
function mediaManifest(directory, owner) {
  ownedDirectory(directory, owner)
  const files = []
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) throw fail('BOOSTY_MEDIA_OWNERSHIP_UNVERIFIED', 'Symlink in owned media; retain everything')
      if (entry.isDirectory()) walk(file)
      else if (file !== path.join(directory, '.sc-boosty-owner.json')) {
        if (!/\.(mp3|m4a|mp4|webm|aac|wav|opus|ogg|part|ytdl)$/.test(entry.name)) throw fail('BOOSTY_MEDIA_OWNERSHIP_UNVERIFIED', 'Unexpected file in media directory; retain everything')
        files.push(sealFile(file, directory))
      }
    }
  }
  walk(directory)
  return files
}
// No recursive deletion. Exact owned manifest is rechecked before each unlink;
// successful partial cleanup is recoverable and cannot erase a changed file.
function evictManifest(directory, owner, manifest) {
  ownedDirectory(directory, owner)
  const actual = mediaManifest(directory, owner)
  if (actual.some(p => !manifest.some(m => m.path === p.path && m.sha256 === p.sha256 && m.ino === p.ino))) throw fail('BOOSTY_MEDIA_CHANGED', 'New or changed media; no cleanup')
  let deletedBytes = 0
  for (const proof of manifest) {
    if (!fs.existsSync(proof.path)) continue
    sameFile(proof, directory)
    fs.unlinkSync(proof.path)
    deletedBytes += proof.bytes
  }
  return { deleted_bytes: deletedBytes, files: actual.length }
}
module.exports = { hash, key, handle, asrProfile, atomic, realFuture, inside, sealFile, verifyPair, sameFile, ownedDirectory, mediaManifest, evictManifest }
