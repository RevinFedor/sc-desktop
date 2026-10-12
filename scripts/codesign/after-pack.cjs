'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

// Signing belongs to packaging, including direct electron-builder calls with
// an alternate outDir. A trailing npm command only covered build:install and
// left other packaged apps with Electron's changing ad-hoc identity.
module.exports = async function signPackagedMacApp(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const output = context.appOutDir;
  const name = context.packager?.appInfo?.productFilename;
  if (typeof output !== 'string' || !path.isAbsolute(output)
    || typeof name !== 'string' || !name || name === '.' || name === '..'
    || path.basename(name) !== name) {
    throw new Error('Cannot determine the packaged app path for local signing');
  }
  const app = path.join(output, name + '.app');
  await new Promise((resolve, reject) => {
    const adHoc = process.env.SC_DESKTOP_CODESIGN_MODE === 'adhoc';
    const child = spawn(adHoc ? '/usr/bin/codesign' : '/bin/bash',
      adHoc ? ['--deep', '--force', '--timestamp=none', '--sign', '-', app]
        : [path.join(__dirname, 'sign-local-fast.sh'), app], {
      stdio: 'inherit', shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error('SC Desktop local signing failed: ' + (signal || code)));
    });
  });
};
