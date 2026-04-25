#!/usr/bin/env node
// One-shot setup for SC Browser Parser:
// 1. Generates an RSA keypair on first run (saved to nmh/extension-key.pem).
// 2. Writes the public key into manifest.json — this FREEZES the extension ID.
//    Same ID in Chrome, Yandex, after reload, after moving the folder.
// 3. Derives the extension ID from the key (Chromium algorithm).
// 4. Installs Native Messaging Host manifests for Chrome AND Yandex with that ID.
// Idempotent: running again does nothing if everything is already in place.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const KEY_PATH = path.join(__dirname, 'extension-key.pem');
const MANIFEST_PATH = path.join(ROOT, 'manifest.json');
const HOST_NAME = 'com.fedor.aistudio_exporter';

// ── 1. Ensure private key exists ────────────────────────────────────────────
let privateKey;
if (fs.existsSync(KEY_PATH)) {
  privateKey = crypto.createPrivateKey(fs.readFileSync(KEY_PATH));
  console.log('[setup] Reusing existing private key:', KEY_PATH);
} else {
  console.log('[setup] Generating new RSA-2048 key (one-time)...');
  const { privateKey: pk } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pk;
  fs.writeFileSync(KEY_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.chmodSync(KEY_PATH, 0o600);
  console.log('[setup] Saved private key:', KEY_PATH, '(KEEP IT — losing it changes the extension ID)');
}

// ── 2. Public key → SPKI DER → base64 (this is what Chromium expects in manifest "key") ─
const publicKey = crypto.createPublicKey(privateKey);
const spki = publicKey.export({ type: 'spki', format: 'der' });
const keyB64 = spki.toString('base64');

// ── 3. Derive extension ID exactly the way Chromium does ────────────────────
// sha256(spki), take first 16 bytes (= 32 hex chars), map each hex digit (0..f) → letter (a..p).
const hashHex = crypto.createHash('sha256').update(spki).digest('hex').slice(0, 32);
const extId = hashHex.split('').map(c => String.fromCharCode(parseInt(c, 16) + 'a'.charCodeAt(0))).join('');
console.log('[setup] Extension ID:', extId);

// ── 4. Patch manifest.json (only if needed) ─────────────────────────────────
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
if (manifest.key !== keyB64) {
  manifest.key = keyB64;
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.log('[setup] Updated manifest.json — added "key" field (extension ID is now frozen)');
} else {
  console.log('[setup] manifest.json already has the correct key');
}

// ── 5. Write the host wrapper (absolute paths — needed because NMH spawns without PATH) ──
const wrapperPath = path.join(__dirname, 'host-wrapper.sh');
const nodePath = process.execPath;
const hostJsPath = path.join(__dirname, 'host.js');
const wrapperContent = `#!/usr/bin/env bash\nexec "${nodePath}" "${hostJsPath}" "$@"\n`;
let needsWrapperWrite = true;
if (fs.existsSync(wrapperPath)) {
  if (fs.readFileSync(wrapperPath, 'utf8') === wrapperContent) needsWrapperWrite = false;
}
if (needsWrapperWrite) {
  fs.writeFileSync(wrapperPath, wrapperContent);
  fs.chmodSync(wrapperPath, 0o755);
  console.log('[setup] Wrote host wrapper:', wrapperPath);
} else {
  console.log('[setup] Host wrapper already up-to-date');
}

// ── 6. Write NMH manifests for Chrome and Yandex ────────────────────────────
const nmhManifest = {
  name: HOST_NAME,
  description: 'SC Browser Parser local file logger',
  path: wrapperPath,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${extId}/`],
};
const nmhJson = JSON.stringify(nmhManifest, null, 2);

const targets = [
  { dir: path.join(os.homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts'), label: 'Chrome' },
  { dir: path.join(os.homedir(), 'Library/Application Support/Yandex/YandexBrowser/NativeMessagingHosts'), label: 'Yandex' },
];

for (const { dir, label } of targets) {
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${HOST_NAME}.json`);
  let needsWrite = true;
  if (fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') === nmhJson) needsWrite = false;
  if (needsWrite) {
    fs.writeFileSync(dest, nmhJson);
    console.log(`[setup] Installed ${label} NMH manifest:`, dest);
  } else {
    console.log(`[setup] ${label} NMH manifest already up-to-date:`, dest);
  }
}

console.log('');
console.log('Done. Now load the extension in your browser (chrome://extensions or browser://extensions).');
console.log('It will always have ID:', extId);
console.log('Logs go to:', path.join(ROOT, 'logs/exporter-YYYY-MM-DD.log'));
