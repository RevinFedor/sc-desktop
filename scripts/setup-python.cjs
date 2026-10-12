'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const probe = 'import sys; print(str(sys.version_info.major) + "." + str(sys.version_info.minor))';
const candidates = process.env.SC_DESKTOP_SETUP_PYTHON
  ? [process.env.SC_DESKTOP_SETUP_PYTHON]
  : ['python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3'];
const supported = executable => {
  const result = spawnSync(executable, ['-c', probe], { encoding: 'utf8' });
  const [major, minor] = String(result.stdout || '').trim().split('.').map(Number);
  return result.status === 0 && (major > 3 || (major === 3 && minor >= 10));
};
const python = candidates.find(supported);
if (!python) {
  console.error('[PythonSetup] Python 3.10+ is required. Install a current Python and set SC_DESKTOP_SETUP_PYTHON to its absolute executable path.');
  process.exit(1);
}
const venvPython = path.join(root, '.venv', 'bin', 'python3');
if (fs.existsSync(venvPython) && !supported(venvPython)) {
  console.error('[PythonSetup] Existing .venv uses an older Python. Move that environment aside and run setup again; user data is outside .venv.');
  process.exit(1);
}
function run(executable, args) {
  const result = spawnSync(executable, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('[PythonSetup] Using ' + python);
run(python, ['-m', 'venv', '.venv']);
run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip']);
run(venvPython, ['-m', 'pip', 'install', '-r', 'python-workers/requirements.txt']);
