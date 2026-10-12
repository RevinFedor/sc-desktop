#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function publishStudyBundle(staged, live) {
  for (const name of ['index.html', 'study.js', 'study.css']) {
    const file = path.join(staged, name);
    if (!fs.existsSync(file) || !fs.statSync(file).size) throw new Error(`Incomplete Study bundle: ${name}`);
  }
  const files = fs.readdirSync(staged, { recursive: true })
    .filter(name => fs.statSync(path.join(staged, name)).isFile())
    .sort((a, b) => {
      const rank = name => name === 'index.html' ? 2 : name === 'study.js' ? 1 : 0;
      return rank(a) - rank(b) || a.localeCompare(b);
    });
  fs.mkdirSync(live, { recursive: true });
  for (const name of files) {
    const target = path.join(live, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.sc-publish-${crypto.randomUUID()}.tmp`;
    try {
      fs.copyFileSync(path.join(staged, name), temporary);
      fs.renameSync(temporary, target);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  // Keep old chunks: a page open during publication may still reference them.
  return files;
}

function build() {
  const repo = path.resolve(__dirname, '..');
  const base = path.join(os.homedir(), 'Library', 'Application Support', 'sc-desktop', 'test-artifacts', 'study-builds');
  fs.mkdirSync(base, { recursive: true });
  const staged = fs.mkdtempSync(path.join(base, 'build-'));
  try {
    execFileSync(process.execPath, [path.join(repo, 'node_modules/vite/bin/vite.js'), 'build',
      '--config', path.join(repo, 'vite.extension.config.js'), '--outDir', staged], { cwd: repo, stdio: 'inherit' });
    const files = publishStudyBundle(staged, path.join(repo, 'browser-extension/study'));
    console.log(`[StudyBuild] Published ${files.length} complete files; live options page retained`);
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
  }
}

module.exports = { publishStudyBundle };
if (require.main === module) build();
