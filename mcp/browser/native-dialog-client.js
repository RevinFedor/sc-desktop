import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { mkdir, readFile, access, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);
const source = join(dirname(fileURLToPath(import.meta.url)), 'native-dialogs-macos.swift');

export class NativeDialogClient {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.startWorker = options.startWorker || (() => this.buildAndSpawn());
    this.timeoutMs = options.timeoutMs || 10000;
    this.log = options.log || (() => {});
    this.worker = null;
    this.starting = null;
    this.pending = new Map();
    this.stopped = false;
  }
  async buildAndSpawn() {
    const hash = createHash('sha256').update(await readFile(source)).digest('hex').slice(0, 20);
    const directory = join(homedir(), 'Library', 'Application Support', 'sc-desktop', 'browser-mcp');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const binary = join(directory, `native-dialogs-${hash}`);
    try { await access(binary); } catch {
      const output = join(directory, `native-dialogs-${hash}-${randomUUID()}.building`);
      await execFileAsync('/usr/bin/xcrun', ['swiftc', '-O', source, '-o', output], { timeout: 30000, maxBuffer: 100000 });
      await rename(output, binary);
    }
    return spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  }
  async ensureWorker() {
    if (this.stopped) throw new Error('Native dialog client stopped');
    if (this.worker) return this.worker;
    if (!this.starting) {
      this.starting = Promise.resolve().then(this.startWorker).then(worker => {
        if (this.stopped) { worker.stdin.end(); throw new Error('Native dialog client stopped'); }
        this.worker = worker;
        const lines = createInterface({ input: worker.stdout });
        lines.on('line', line => {
          let value;
          try { value = JSON.parse(line); } catch { return; }
          const pending = this.pending.get(value.requestId);
          if (!pending) return;
          this.pending.delete(value.requestId); clearTimeout(pending.timer); pending.resolve(value);
        });
        // UI text is returned only to its explicit caller, never dumped to logs.
        worker.stderr.on('data', () => {});
        const unavailable = () => {
          if (this.worker === worker) this.worker = null;
          lines.close();
          for (const [key, p] of this.pending) {
            this.pending.delete(key); clearTimeout(p.timer);
            p.resolve({ success: false, errorCode: 'NATIVE_HELPER_UNAVAILABLE',
              error: 'Native helper exited; original action outcome may be unknown', retrySafe: false });
          }
        };
        worker.once('exit', unavailable); worker.once('error', unavailable);
        return worker;
      }).finally(() => { this.starting = null; });
    }
    return this.starting;
  }
  async call(args) {
    if (this.platform !== 'darwin') return { success: false, errorCode: 'NATIVE_PLATFORM_UNSUPPORTED',
      error: 'Native recovery helper requires macOS. The tab-bound debugger dialog tools remain available.' };
    let worker;
    try { worker = await this.ensureWorker(); } catch (e) {
      return { success: false, errorCode: 'NATIVE_HELPER_UNAVAILABLE', error: e.message, retrySafe: false };
    }
    const requestId = randomUUID();
    const response = await new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ success: false, errorCode: 'NATIVE_OUTCOME_UNKNOWN',
          error: 'Native response timed out; do not repeat a destructive action', requestId, retrySafe: false });
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, timer });
      worker.stdin.write(JSON.stringify({ ...args, requestId }) + '\n', error => {
        if (!error || !this.pending.has(requestId)) return;
        this.pending.delete(requestId); clearTimeout(timer);
        resolve({ success: false, errorCode: 'NATIVE_OUTCOME_UNKNOWN', error: error.message, requestId, retrySafe: false });
      });
    });
    try { this.log('mcp.native_dialog.' + args.action, {
      requestId, dialogId: args.dialogId || response.dialog?.dialogId || null,
      nativeWindowId: args.nativeWindowId || response.dialog?.nativeWindowId || null,
      browser: args.browser || response.dialog?.browser || null,
      type: response.dialog?.type || null, success: response.success,
      status: response.status || null, errorCode: response.errorCode || null,
      accepted: response.accepted ?? null, count: response.dialogs?.length ?? null,
    }); } catch {}
    return response;
  }
  stop() {
    this.stopped = true;
    // EOF exits only our helper. Never signal Yandex, the bridge or MCP hub.
    this.worker?.stdin.end();
  }
}
