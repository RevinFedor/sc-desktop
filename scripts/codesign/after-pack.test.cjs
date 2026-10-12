'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const root = path.resolve(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function loadHook(spawn) {
  const file = path.join(root, pkg.build.afterPack);
  const result = { exports: {} };
  const wrapper = vm.runInThisContext(`(function(require, module, __dirname) {\n${fs.readFileSync(file, 'utf8')}\n})`, { filename: file });
  wrapper(id => id === 'node:child_process' ? { spawn } : require(id), result, path.dirname(file));
  return result.exports;
}

const context = (appOutDir = '/private/tmp/sc-isolated-build/mac-arm64') => ({
  electronPlatformName: 'darwin', appOutDir,
  packager: { appInfo: { productFilename: 'SC Desktop' } },
});

test('direct electron-builder packaging owns signing, including an alternate output directory', async () => {
  assert.equal(typeof pkg.build.afterPack, 'string', 'raw electron-builder must not bypass local signing');
  assert.equal(pkg.build.mac.identity, null, 'builder must not replace the local signature afterwards');
  assert.ok(!pkg.scripts['build:install'].includes('&& npm run sign:local'), 'do not sign twice');
  const calls = [];
  const child = new EventEmitter();
  const hook = loadHook((command, args, options) => {
    calls.push({ command, args, options });
    return child;
  });
  let complete = false;
  const result = hook(context('/private/tmp/a build with spaces/mac-arm64')).then(() => { complete = true; });
  await Promise.resolve();
  assert.equal(complete, false, 'packaging waits for signature verification');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/bin/bash');
  assert.deepEqual(calls[0].args, [path.join(__dirname, 'sign-local-fast.sh'), '/private/tmp/a build with spaces/mac-arm64/SC Desktop.app']);
  assert.equal(calls[0].options.shell, false);
  child.emit('exit', 0, null);
  await result;
  assert.equal(complete, true);
});

test('signing failure rejects packaging before build:install can quit or replace the app', async () => {
  const child = new EventEmitter();
  const result = loadHook(() => child)(context());
  const rejected = assert.rejects(result, /local signing failed.*17/);
  child.emit('exit', 17, null);
  await rejected;
});

test('signer startup failure is propagated', async () => {
  const child = new EventEmitter();
  const result = loadHook(() => child)(context());
  const rejected = assert.rejects(result, /cannot start signer/);
  child.emit('error', new Error('cannot start signer'));
  await rejected;
});

test('non-mac packaging does not invoke codesign', async () => {
  await loadHook(() => { throw new Error('must not spawn'); })({ ...context(), electronPlatformName: 'linux' });
});

test('missing pack context cannot silently fall back to the old release app', async () => {
  const hook = loadHook(() => { throw new Error('must not spawn'); });
  await assert.rejects(hook({ ...context(), appOutDir: '' }), /packaged app path/);
  await assert.rejects(hook({ ...context(), packager: { appInfo: { productFilename: '../wrong' } } }), /packaged app path/);
});

test('explicit portable packaging uses ad-hoc signing without an author certificate', async () => {
  const previous = process.env.SC_DESKTOP_CODESIGN_MODE;
  process.env.SC_DESKTOP_CODESIGN_MODE = 'adhoc';
  try {
    const child = new EventEmitter(), calls = [];
    const result = loadHook((command, args, options) => { calls.push({ command, args, options }); return child; })(context());
    assert.equal(calls[0].command, '/usr/bin/codesign');
    assert.deepEqual(calls[0].args, ['--deep', '--force', '--timestamp=none', '--sign', '-', '/private/tmp/sc-isolated-build/mac-arm64/SC Desktop.app']);
    assert.equal(calls[0].options.shell, false);
    child.emit('exit', 0, null); await result;
  } finally {
    if (previous === undefined) delete process.env.SC_DESKTOP_CODESIGN_MODE;
    else process.env.SC_DESKTOP_CODESIGN_MODE = previous;
  }
});
