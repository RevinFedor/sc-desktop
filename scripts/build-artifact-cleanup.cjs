'use strict';

// Shared local development checkout, not a runtime dependency of the apps.
const path = require('node:path');
function library() {
  try { return require(path.resolve(__dirname, '../../custom-terminal/scripts/lib/build-artifact-retention.cjs')); }
  catch (error) { console.warn('[BuildArtifactCleanup] helper unavailable; kept artifacts: ' + error.message); return null; }
}

async function prepared(root, source) {
  const retention = library();
  if (!retention) return;
  if (!retention.allowedRoot(path.resolve(root))) return;
  await retention.markPrepared(root, source);
}
async function installed(options) {
  try {
    const retention = library();
    if (!retention) return { removed: [], reason: 'helper-unavailable' };
    const result = await retention.cleanupVerifiedDeployment(options);
    console.log('[BuildArtifactCleanup] ' + JSON.stringify(result));
    return result;
  } catch (error) {
    // A completed installation must not be relabelled failed by housekeeping.
    // Keep everything on missing proof/probe/audit rather than guessing.
    console.warn('[BuildArtifactCleanup] kept artifacts: ' + error.message);
    return { removed: [], error: error.message };
  }
}
module.exports = { prepared, installed };
