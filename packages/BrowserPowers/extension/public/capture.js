/**
 * FILE: public/capture.js
 * PURPOSE: Injected into the page's MAIN world via registerContentScripts.
 *          Overrides console methods and pipes entries to the isolated world
 *          via a shared DOM <meta> attribute.
 * OWNS: Console.log/warn/error/info/debug override, error+rejection capture,
 *        data-e attribute pipe to isolated world.
 * DOCS: docs/arch_extension.md §10
 */
(function () {
  if (window.__bpConsoleInit) return;
  window.__bpConsoleInit = true;

  var _buf = [];
  var _max = 500;

  // Pipe element — shared DOM node: MAIN world writes, isolated world reads
  // via MutationObserver. Both worlds share the DOM, so this bypasses the
  // broken postMessage / world:"MAIN" executeScript paths.
  function getPipe() {
    var el = document.getElementById('__bp_pipe');
    if (!el) {
      el = document.createElement('meta');
      el.id = '__bp_pipe';
      (document.head || document.documentElement).appendChild(el);
    }
    return el;
  }

  function send(entry) {
    _buf.push(entry);
    if (_buf.length > _max) _buf.splice(0, _buf.length - _max);
    try { getPipe().setAttribute('data-e', JSON.stringify(entry)); } catch (e) {}
  }

  // Override console methods — chain to originals
  var _ol = console.log.bind(console);
  var _ow = console.warn.bind(console);
  var _oe = console.error.bind(console);
  var _oi = console.info.bind(console);
  var _od = console.debug.bind(console);

  console.log = function () {
    send({ level: 'log', messages: Array.from(arguments), timestamp: Date.now() });
    _ol.apply(console, arguments);
  };
  console.warn = function () {
    send({ level: 'warn', messages: Array.from(arguments), timestamp: Date.now() });
    _ow.apply(console, arguments);
  };
  console.error = function () {
    send({ level: 'error', messages: Array.from(arguments), timestamp: Date.now() });
    _oe.apply(console, arguments);
  };
  console.info = function () {
    send({ level: 'info', messages: Array.from(arguments), timestamp: Date.now() });
    _oi.apply(console, arguments);
  };
  console.debug = function () {
    send({ level: 'debug', messages: Array.from(arguments), timestamp: Date.now() });
    _od.apply(console, arguments);
  };

  // Uncaught exceptions
  window.onerror = function (event, source, lineno, colno, error) {
    var msg = event instanceof Event ? ((event.message) || String(event)) : String(event);
    send({
      level: 'error',
      messages: [msg],
      timestamp: Date.now(),
      stack: (error && error.stack) || source + ':' + lineno + ':' + colno
    });
  };

  // Unhandled promise rejections
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    send({
      level: 'error',
      messages: [r && r.message != null ? r.message : String(r || 'Unhandled Promise rejection')],
      timestamp: Date.now(),
      stack: r && r.stack || undefined
    });
  });

  window.__bpConsoleBuffer = _buf;

  // Self-test marker
  console.log('[bp] capture initialized');
})();
