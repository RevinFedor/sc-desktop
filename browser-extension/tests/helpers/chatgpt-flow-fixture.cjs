const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { File } = require('node:buffer');
const { scKeepResearchTabAfterDone } = require('../../research-tab-policy.js');

// Small offline DOM fixture. Selectors, tree order and File payloads are real
// inputs to the content script; no entrypoint, browser, bridge or model is run.
class Element {
  constructor(tag = 'div', attrs = {}, text = '') {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.children = [];
    this.parentElement = null;
    this.text = text;
    this.handlers = {};
    this.style = {};
    this.visible = true;
    this.complete = true;
    this.naturalWidth = this.naturalHeight = 100;
    this.classList = { contains: value => (this.attrs.class || '').split(/\s+/).includes(value) };
  }
  get id() { return this.attrs.id || ''; }
  set id(value) { this.attrs.id = value; }
  get src() { return this.attrs.src || ''; }
  get currentSrc() { return this.src; }
  get alt() { return this.attrs.alt || ''; }
  get disabled() { return this.hasAttribute('disabled'); }
  get offsetParent() { return this.visible ? this.parentElement : null; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this.text = value; }
  get innerText() { return this.textContent; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  hasAttribute(name) { return name in this.attrs; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  removeAttribute(name) { delete this.attrs[name]; }
  appendChild(child) { child.remove(); this.children.push(child); child.parentElement = this; return child; }
  insertBefore(child, reference) {
    child.remove();
    this.children.splice(this.children.indexOf(reference), 0, child);
    child.parentElement = this;
    return child;
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
  contains(el) { return !!el && (this === el || this.children.some(child => child.contains(el))); }
  cloneNode(deep = false) {
    const clone = new Element(this.tagName, this.attrs, this.text);
    clone.visible = this.visible;
    if (deep) this.children.forEach(child => clone.appendChild(child.cloneNode(true)));
    return clone;
  }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  matches(selectors) {
    return selectors.split(',').some(raw => {
      let selector = raw.trim();
      const excluded = [...selector.matchAll(/:not\(([^)]+)\)/g)].map(match => match[1]);
      if (excluded.some(part => this.matches(part))) return false;
      selector = selector.replace(/:not\([^)]+\)/g, '');
      let valid = true;
      selector = selector.replace(/\[([\w-]+)(?:([*^$]?=)(?:"([^"]*)"|'([^']*)'|([^\]\s]+))(?:\s+(i))?)?\]/g,
        (_, name, operator, double, single, bare, insensitive) => {
          let value = this.getAttribute(name);
          let expected = double ?? single ?? bare;
          if (value == null) valid = false;
          else if (operator) {
            value = String(value);
            if (insensitive) { value = value.toLowerCase(); expected = expected.toLowerCase(); }
            if (operator === '=' && value !== expected) valid = false;
            if (operator === '*=' && !value.includes(expected)) valid = false;
            if (operator === '^=' && !value.startsWith(expected)) valid = false;
            if (operator === '$=' && !value.endsWith(expected)) valid = false;
          }
          return '';
        });
      selector = selector.replace(/#([\w-]+)/g, (_, id) => { if (this.id !== id) valid = false; return ''; });
      selector = selector.replace(/\.([\w-]+)/g, (_, name) => { if (!this.classList.contains(name)) valid = false; return ''; });
      return valid && (!selector || selector === '*' || selector.toUpperCase() === this.tagName);
    });
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelectorAll(selector) { return this.descendants().filter(el => el.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  compareDocumentPosition(other) {
    const root = el => { while (el.parentElement) el = el.parentElement; return el; };
    if (!other || root(this) !== root(other)) return 1;
    const elements = [root(this), ...root(this).descendants()];
    return this === other ? 0 : elements.indexOf(this) < elements.indexOf(other) ? 4 : 2;
  }
  getBoundingClientRect() { return { x: 0, y: 0, width: this.visible ? 100 : 0, height: this.visible ? 30 : 0 }; }
  getClientRects() { return this.visible ? [{}] : []; }
  dispatchEvent(event) { this.handlers[event.type]?.(event); return true; }
  click() { this.handlers.click?.(); }
  focus() {}
}

function fakeClock() {
  let now = 10000, nextId = 0;
  const tasks = new Map();
  const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
  const schedule = (fn, delay, repeat = false) => {
    const id = ++nextId;
    tasks.set(id, { fn, at: now + delay, delay, repeat });
    return id;
  };
  return {
    now: () => now,
    setTimeout: (fn, ms) => schedule(fn, ms),
    setInterval: (fn, ms) => schedule(fn, ms, true),
    clearTimeout: id => tasks.delete(id),
    clearInterval: id => tasks.delete(id),
    flush,
    async advance(ms) {
      await flush();
      const end = now + ms;
      while (true) {
        const next = [...tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, task] = next;
        now = task.at;
        if (task.repeat) task.at += task.delay;
        else tasks.delete(id);
        task.fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

function fixture({ form = true, temporary = false, sourcePath, mutationObserver } = {}) {
  const clock = fakeClock();
  const html = new Element('html');
  const body = html.appendChild(new Element('body'));
  const main = body.appendChild(new Element('main'));
  const history = main.appendChild(new Element('section'));
  const composer = main.appendChild(new Element(form ? 'form' : 'div'));
  const editor = composer.appendChild(new Element('div', { id: 'prompt-textarea', contenteditable: 'true' }));
  const input = composer.appendChild(new Element('input', { id: 'upload-files', type: 'file' }));
  const voice = composer.appendChild(new Element('button', { 'aria-label': 'Voice mode' }));
  const send = new Element('button', { 'data-testid': 'send-button' });
  const stop = new Element('button', { 'data-testid': 'stop-button' });
  const document = {
    body, documentElement: html, title: 'Offline fixture', readyState: 'loading', visibilityState: 'visible',
    addEventListener() {}, removeEventListener() {},
    getElementById: id => html.descendants().find(el => el.id === id) || null,
    querySelectorAll: selector => html.querySelectorAll(selector),
    querySelector: selector => html.querySelector(selector),
    createElement: tag => new Element(tag),
  };
  const location = new URL(`https://chatgpt.com/${temporary ? '?temporary-chat=true&' : 'c/fixture?'}sc-research=new-job`);
  const requests = [];
  let attachmentData = { name: 'context.txt', mime: 'text/plain', base64: Buffer.from('NEW CONTENT').toString('base64') };
  const window = { location, name: '', scBridgeFetch: async (url, init) => {
    requests.push({ url, init });
    return { ok: true, json: async () => attachmentData };
  } };
  class DataTransfer {
    constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; this.data = {}; }
    setData(type, value) { this.data[type] = value; }
    getData(type) { return this.data[type]; }
  }
  class Event { constructor(type, options) { this.type = type; Object.assign(this, options); } }
  const source = fs.readFileSync(sourcePath || process.env.SC_CHATGPT_SOURCE
    || path.join(__dirname, '..', '..', 'chatgpt-research.js'), 'utf8');
  const marker = "  if (document.readyState === 'loading') {";
  const exports = `globalThis.flow = { latestApiTurnSnapshotFromData, createTurnBoundary,
    submittedUserElement, submittedAssistantElement, assistantTarget, apiProofForSubmittedTurn,
    createTerminalProbe, startDoneWatcher, waitSubmitAccepted, clickSend,
    ...(typeof runReadOnlyConversationImport === 'function' ? { runReadOnlyConversationImport } : {}),
    readAnswerText, readThinkingText, readThinkingLine, findSourcesChip, extractSources,
    extractAnswerStable, collectGeneratedImages, showPastedTextInComposer,
    composerRoot, composerFilePreviewState,
    composerHasFilePreview, uploadFiles, uploadAttachments, fetchAttachmentFile,
    pasteIntoComposer, waitComposerReadyAfterPaste, composerBusySnapshot,
    main, findVoiceBtn, postTerminalState };`;
  if (!source.includes(marker)) throw new Error('content-script export marker missing');
  const context = vm.createContext({
    document, window, location, URL, AbortController, File, DataTransfer, Event, ClipboardEvent: Event, MouseEvent: Event,
    scKeepResearchTabAfterDone,
    Node: { DOCUMENT_POSITION_DISCONNECTED: 1, DOCUMENT_POSITION_FOLLOWING: 4 },
    MutationObserver: mutationObserver || class { observe() {} disconnect() {} },
    performance: { now: clock.now }, Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [clock.now()])); }
      static now() { return clock.now(); }
    },
    setTimeout: clock.setTimeout, setInterval: clock.setInterval,
    clearTimeout: clock.clearTimeout, clearInterval: clock.clearInterval, queueMicrotask,
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    console: { log() {} },
    chrome: { runtime: { lastError: null, onMessage: { addListener() {} },
      sendMessage(_message, callback) { callback({ ok: true }); } } },
    fetch() { throw new Error('offline fixture forbids network requests'); },
  });
  vm.runInContext(source.replace(marker, `${exports}\n${marker}`), context);
  function turn(role, id, text = '', { sources = false, thinking = '', final = true, domId = true } = {}) {
    const root = history.appendChild(new Element('article', { 'data-testid': `conversation-turn-${id}`, 'data-turn': role }));
    const message = root.appendChild(new Element('div', { 'data-message-author-role': role, ...(domId ? { 'data-message-id': id } : {}) }));
    if (thinking) {
      root.appendChild(new Element('button', {}, 'Thought for 10s\n'));
      message.appendChild(new Element('div', { class: 'markdown result-thinking' }, thinking));
    }
    message.appendChild(new Element('div', { class: 'markdown' }, text));
    if (role === 'assistant' && final) root.appendChild(new Element('button', { 'data-testid': 'copy-turn-action-button' }));
    if (sources) root.appendChild(new Element('button', { 'aria-label': 'Sources' }));
    return { root, message };
  }
  function preview(name = '', parent = composer) {
    const card = parent.appendChild(new Element('div', { 'data-testid': 'attachment-preview' }));
    if (name) card.appendChild(new Element('span', {}, name));
    card.appendChild(new Element('button', { 'aria-label': 'Remove file' }));
    return card;
  }
  return { ...context.flow, clock, document, window, history, composer, editor, input, voice, send, stop,
    requests, turn, preview, Element, chrome: context.chrome,
    setFetch: fetcher => { context.fetch = fetcher; },
    setAttachmentData: data => { attachmentData = data; } };
}

function apiConversation(turns) {
  const mapping = {};
  let parent = null;
  for (const { id, role, text = '', ...extra } of turns) {
    mapping[id] = { id, parent, message: { id, author: { role }, content: { content_type: 'text', parts: [text] },
      ...(role === 'assistant' ? { channel: 'final', end_turn: true, status: 'finished_successfully' } : {}), ...extra } };
    parent = id;
  }
  return { current_node: parent, mapping };
}

module.exports = { fixture, apiConversation };
