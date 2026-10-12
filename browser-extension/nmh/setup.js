#!/usr/bin/env node
// Optional exporter file logs. Browser MCP itself uses WebSockets, not NMH.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

function install({ extensionRoot = path.resolve(__dirname, '..'),
  dataDir = process.env.SC_BROWSER_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'sc-desktop', 'browser-mcp'),
  targetRoot, dryRun = false } = {}) {
  if (os.platform() !== 'darwin' && !targetRoot) throw new Error('Native log installer supports macOS Chrome/Yandex. Browser MCP does not require it.');
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'));
  if (!manifest.key) throw new Error('manifest.key is missing. Use the public extension manifest; no private signing key is needed.');
  const spki = Buffer.from(manifest.key, 'base64');
  crypto.createPublicKey({ key: spki, type: 'spki', format: 'der' });
  const extId = crypto.createHash('sha256').update(spki).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
  const wrapperPath = path.resolve(dataDir, 'nmh', 'host-wrapper.sh');
  const targets = targetRoot ? ['Chrome', 'Yandex'].map(label => ({ label,
    dir: path.resolve(targetRoot, label, 'NativeMessagingHosts') })) : [
    { label: 'Chrome', dir: path.join(os.homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts') },
    { label: 'Yandex', dir: path.join(os.homedir(), 'Library/Application Support/Yandex/YandexBrowser/NativeMessagingHosts') },
  ];
  const nmhManifest = { name: 'com.fedor.aistudio_exporter', description: 'SC Browser Parser local file logger',
    path: wrapperPath, type: 'stdio', allowed_origins: ['chrome-extension://' + extId + '/'] };
  const destinations = targets.map(target => path.join(target.dir, nmhManifest.name + '.json'));
  const plan = { extensionId: extId, wrapperPath, destinations,
    logs: path.resolve(dataDir, 'exporter-YYYY-MM-DD.log'), dryRun };
  if (dryRun) return plan;
  const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
  const wrapper = '#!/usr/bin/env bash\nSC_BROWSER_DATA_DIR=' + quote(path.resolve(dataDir))
    + ' exec ' + quote(process.execPath) + ' ' + quote(path.join(extensionRoot, 'nmh', 'host.js')) + ' "$@"\n';
  fs.mkdirSync(path.dirname(wrapperPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(wrapperPath, wrapper, { mode: 0o700 });
  fs.chmodSync(wrapperPath, 0o700);
  for (const destination of destinations) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, JSON.stringify(nmhManifest, null, 2) + '\n');
  }
  return plan;
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const target = args.indexOf('--target-root');
    if (args.includes('--help')) {
      console.log('node nmh/setup.js [--dry-run] [--target-root <fixture-directory>]');
      process.exit(0);
    }
    if (target >= 0 && !args[target + 1]) throw new Error('--target-root requires a directory');
    console.log(JSON.stringify(install({ dryRun: args.includes('--dry-run'), targetRoot: target >= 0 ? args[target + 1] : undefined }), null, 2));
  } catch (error) { console.error('[setup] ' + error.message); process.exitCode = 1; }
}
module.exports = { install };
