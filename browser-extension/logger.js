// SC Browser Parser — universal logger (loaded into content scripts).
// Sends every event to background (which relays to native messaging host) AND console.
// Designed to NEVER throw — logging must never break the export.

(function () {
  if (typeof window !== 'undefined' && window.__AISE_LOGGER__) return;

  const NMH_NAME = 'com.fedor.aistudio_exporter';
  let exportId = null;
  let seq = 0;

  function safeStringifyData(d) {
    if (d === undefined) return undefined;
    try {
      // Strip non-serialisable cycles by JSON round-trip.
      return JSON.parse(JSON.stringify(d));
    } catch (_) {
      try { return { __serialize_failed: String(d) }; } catch (_) { return { __serialize_failed: true }; }
    }
  }

  function send(level, tag, msg, data) {
    seq++;
    const evt = {
      ts: new Date().toISOString(),
      level,
      tag,
      msg,
      data: safeStringifyData(data),
      exportId,
      seq,
    };

    // Console mirror (always — invaluable for live debugging in DevTools).
    try {
      const consoleFn = ({ error: console.error, warn: console.warn, info: console.info, log: console.log, debug: console.log }[level]) || console.log;
      const prefix = `[AISE][${tag}]${exportId ? `[exp:${exportId}]` : ''}`;
      if (data !== undefined) consoleFn(prefix, msg, data);
      else consoleFn(prefix, msg);
    } catch (_) {}

    // Relay to background so it forwards to native host.
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ __aise_log: true, evt }, () => {
          // Read lastError to silence Chrome's "unchecked runtime.lastError".
          const _ = chrome.runtime.lastError;
        });
      }
    } catch (_) {}
  }

  const t0 = (typeof performance !== 'undefined' && performance.now) ? () => performance.now() : () => Date.now();

  const logger = {
    setExportId(id) { exportId = id; send('info', 'logger', 'exportId set', { exportId: id }); },
    clearExportId() { send('info', 'logger', 'exportId cleared', { exportId }); exportId = null; },

    debug(tag, msg, data) { send('debug', tag, msg, data); },
    log(tag, msg, data) { send('log', tag, msg, data); },
    info(tag, msg, data) { send('info', tag, msg, data); },
    warn(tag, msg, data) { send('warn', tag, msg, data); },
    error(tag, msg, data) {
      // Auto-extract Error fields.
      let payload = data;
      if (data instanceof Error) {
        payload = { name: data.name, message: data.message, stack: data.stack };
      } else if (data && data.error instanceof Error) {
        payload = { ...data, error: { name: data.error.name, message: data.error.message, stack: data.error.stack } };
      }
      send('error', tag, msg, payload);
    },

    // Time a synchronous or async block. Logs duration_ms on completion.
    async timed(tag, name, fn, extraData) {
      const start = t0();
      send('debug', tag, `${name} START`, extraData);
      try {
        const result = await fn();
        const dur = +(t0() - start).toFixed(2);
        send('info', tag, `${name} END`, { duration_ms: dur, ...(extraData || {}) });
        return result;
      } catch (e) {
        const dur = +(t0() - start).toFixed(2);
        send('error', tag, `${name} FAIL`, { duration_ms: dur, error: { name: e?.name, message: e?.message, stack: e?.stack }, ...(extraData || {}) });
        throw e;
      }
    },

    // Lightweight timer for inline code: const t = log.timer(); ... log.info('x', 'done', { ms: t() });
    timer() {
      const start = t0();
      return () => +(t0() - start).toFixed(2);
    },

    // Snapshot helpers — ALWAYS deterministic, no DOM strings, just counts/booleans/lengths.
    domSnapshot(tag, name, selectors) {
      const counts = {};
      try {
        for (const [key, sel] of Object.entries(selectors || {})) {
          counts[key] = document.querySelectorAll(sel).length;
        }
      } catch (e) {
        counts.__error = String(e?.message || e);
      }
      send('debug', tag, `dom-snapshot ${name}`, { counts, location: location.href });
    },
  };

  if (typeof window !== 'undefined') window.__AISE_LOGGER__ = logger;
  if (typeof globalThis !== 'undefined') globalThis.__AISE_LOG = logger;
})();
