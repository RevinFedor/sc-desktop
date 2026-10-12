const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { apiConversation } = require('./helpers/chatgpt-flow-fixture.cjs');

const source = fs.readFileSync(path.join(__dirname, '..', 'chatgpt-research.js'), 'utf8');
const marker = "  if (document.readyState === 'loading') {";
const context = vm.createContext({
  URL, AbortController, TextDecoder, setTimeout, clearTimeout, performance,
  location: { href: 'https://chatgpt.com/c/export-fixture' },
  document: { readyState: 'loading', title: 'Export fixture', getElementById() { return null; }, addEventListener() {} },
  chrome: { runtime: { onMessage: { addListener() {} } } },
  window: {}, console: { log() {} },
});
vm.runInContext(source.replace(marker, `globalThis.exportTest = {
  fetchChatGPTTextAttachment, resolveChatGPTExportAttachments,
  buildChatGPTApiMarkdown, exportTextFileBlock, domExportDocumentCards, resolveDOMExportDocument,
};\n${marker}`), context);
const api = context.exportTest;
const options = { includeImages: false, includeReasoning: false, includeSources: false, includeSourceActivity: false };
const newStats = () => ({ user: 0, assistant: 0, sources: 0, activity: 0, images: 0 });
const attachment = (id, name = 'Вставленный текст.txt') => ({ id, name, mime_type: 'text/plain', is_big_paste: true });
const withFiles = files => apiConversation([
  { id: 'user', role: 'user', text: 'Summarize these documents', metadata: { attachments: files } },
  { id: 'answer', role: 'assistant', text: 'Summary' },
]);

test('both pasted documents export in full even with images disabled; long text and code fences survive', async () => {
  const first = 'BEGIN\r\n' + 'длинный текст\n'.repeat(18000) + '\n```js\nconst x = 1;\n```\nEND-FIRST';
  const second = '# Rules\n\n\nKeep original whitespace.\nEND-SECOND\n';
  const data = withFiles([attachment('file_one'), attachment('file_two', 'Вставленный текст (2).txt')]);
  const texts = await api.resolveChatGPTExportAttachments(data, {
    read: async file => ({ ok: true, text: file.id === 'file_one' ? first : second, bytes: 300000 }),
  });
  const stats = newStats();
  const built = api.buildChatGPTApiMarkdown(data, options, stats, 'chat', texts);
  assert(built.markdown.includes(first));
  assert(built.markdown.includes(second));
  assert(built.markdown.includes('````text\nBEGIN'));
  assert.equal(stats.images, 0);
  assert.equal(stats.documents, 2);
  assert.equal(built.textDocuments, 2);
  assert.equal(built.failedDocuments, 0);
});

test('same-named YouTube and pasted files use their own IDs; repeated reference reads bytes once', async () => {
  const data = apiConversation([
    { id: 'u1', role: 'user', text: 'first', metadata: { attachments: [{ ...attachment('file_one', 'video.txt'), is_big_paste: false }] } },
    { id: 'a1', role: 'assistant', text: 'first answer' },
    { id: 'u2', role: 'user', text: 'second', metadata: { attachments: [attachment('file_two', 'video.txt'), attachment('file_one', 'video.txt')] } },
    { id: 'a2', role: 'assistant', text: 'second answer' },
  ]);
  let reads = 0;
  const texts = await api.resolveChatGPTExportAttachments(data, {
    read: async file => { reads++; return { ok: true, text: `BYTES:${file.id}`, bytes: 20 }; },
  });
  const built = api.buildChatGPTApiMarkdown(data, options, newStats(), 'chat', texts);
  assert.equal(reads, 2);
  assert.equal(built.markdown.split('BYTES:file_one').length - 1, 2);
  assert.equal(built.markdown.split('BYTES:file_two').length - 1, 1);
});

test('only current branch attachments are read; hidden context, images and binary files are not fetched as text', async () => {
  const files = [attachment('file_txt'), { id: 'file_img', name: 'photo.png', mime_type: 'image/png' },
    { id: 'file_pdf', name: 'paper.pdf', mime_type: 'application/pdf' }];
  const data = withFiles(files);
  data.mapping.side = { id: 'side', parent: 'user', message: { author: { role: 'user' }, metadata: { attachments: [attachment('file_side')] } } };
  data.mapping.hidden = { id: 'hidden', parent: 'user', message: { author: { role: 'tool' }, metadata: { is_visually_hidden_from_conversation: true, attachments: [attachment('file_hidden')] } } };
  data.mapping.answer.parent = 'hidden';
  const readIds = [];
  const texts = await api.resolveChatGPTExportAttachments(data, {
    read: async file => { readIds.push(file.id); return { ok: true, text: 'TEXT', bytes: 4 }; },
  });
  assert.deepEqual(readIds, ['file_txt']);
  const built = api.buildChatGPTApiMarkdown(data, options, newStats(), 'chat', texts);
  assert.doesNotMatch(built.markdown, /photo\.png/);
  assert.match(built.markdown, /paper\.pdf/);
});

test('failed text download is explicit in the export rather than silently replacing contents with filename', async () => {
  const data = withFiles([attachment('file_missing')]);
  const texts = await api.resolveChatGPTExportAttachments(data, { read: async () => { throw new Error('HTTP 404'); } });
  const built = api.buildChatGPTApiMarkdown(data, options, newStats(), 'chat', texts);
  assert.equal(built.failedDocuments, 1);
  assert.match(built.markdown, /ВНИМАНИЕ/);
  assert.match(built.markdown, /Содержимое вложения не получено: HTTP 404/);
  assert.match(built.markdown, /Summarize these documents/);
});

const rawResponse = text => {
  const bytes = Buffer.from(text, 'utf8');
  return { ok: true, status: 200, headers: new Map(),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
};

test('real download resolver contract reads original UTF-8 bytes and verifies declared size', async () => {
  const text = 'Полный текст\r\n\nEND';
  const calls = [];
  const result = await api.fetchChatGPTTextAttachment({ ...attachment('file_test'), size: Buffer.byteLength(text) }, {
    accessToken: 'test-token',
    fetch: async (url, init) => {
      calls.push({ url, init });
      return calls.length === 1
        ? { ok: true, json: async () => ({ download_url: '/backend-api/estuary/content?id=file_test', file_size_bytes: Buffer.byteLength(text) }) }
        : rawResponse(text);
    },
  });
  assert.equal(result.text, text);
  assert.equal(result.bytes, Buffer.byteLength(text));
  assert.equal(calls[0].url, '/backend-api/files/download/file_test');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-token');
  assert.equal(calls[1].init.redirect, 'error');
});

test('signed CDN download never receives the ChatGPT bearer or cookies', async () => {
  const calls = [];
  await api.fetchChatGPTTextAttachment(attachment('file_test'), {
    accessToken: 'private-token',
    fetch: async (url, init) => {
      calls.push({ url, init });
      return calls.length === 1
        ? { ok: true, json: async () => ({ download_url: 'https://files.oaiusercontent.com/doc.txt?signature=test' }) }
        : rawResponse('document');
    },
  });
  assert.equal(calls[1].init.headers, undefined);
  assert.equal(calls[1].init.credentials, 'omit');
});

test('UTF-8 byte-order marker and final newline remain part of the exported document', async () => {
  const text = '\uFEFForiginal\n';
  const result = await api.fetchChatGPTTextAttachment({ ...attachment('file_bom'), size: Buffer.byteLength(text) }, {
    accessToken: 'token', fetch: async url => String(url).startsWith('/backend-api/files/download/')
      ? { ok: true, json: async () => ({ download_url: '/backend-api/estuary/content' }) }
      : rawResponse(text),
  });
  assert.equal(result.text, text);
  assert(api.exportTextFileBlock(result.text).includes(text));
});

test('unsupported URL, wrong preview filename and truncated bytes are rejected before claiming full content', async () => {
  const makeFetch = metadata => async url => String(url).startsWith('/backend-api/files/download/')
    ? { ok: true, json: async () => metadata } : rawResponse('short');
  await assert.rejects(api.fetchChatGPTTextAttachment(attachment('file_bad'), {
    accessToken: 'token', fetch: makeFetch({ download_url: 'https://attacker.example/data' }),
  }), /не принадлежит/);
  await assert.rejects(api.fetchChatGPTTextAttachment({ ...attachment('file_other'), verifyName: true }, {
    accessToken: 'token', fetch: makeFetch({ file_name: 'another.txt', download_url: '/backend-api/estuary/content' }),
  }), /другому документу/);
  await assert.rejects(api.fetchChatGPTTextAttachment({ ...attachment('file_short'), size: 200 }, {
    accessToken: 'token', fetch: makeFetch({ download_url: '/backend-api/estuary/content' }),
  }), /Размер документа не совпал/);
});

test('empty UTF-8 file is preserved; safety size limit reports failure without truncation', async () => {
  const empty = await api.fetchChatGPTTextAttachment({ ...attachment('file_empty'), size: 0 }, {
    accessToken: 'token', fetch: async url => String(url).startsWith('/backend-api/files/download/')
      ? { ok: true, json: async () => ({ download_url: '/backend-api/estuary/content', file_size_bytes: 0 }) }
      : rawResponse(''),
  });
  assert.equal(empty.ok, true);
  assert.equal(empty.text, '');
  let fetched = false;
  await assert.rejects(api.fetchChatGPTTextAttachment({ ...attachment('file_huge'), size: 21 * 1024 * 1024 }, {
    accessToken: 'token', fetch: async () => { fetched = true; },
  }), /20 MiB/);
  assert.equal(fetched, false);
});

test('DOM fallback identifies attached document cards and excludes citations or image controls', () => {
  const buttons = ['video.txt', 'Вставленный текст (2).txt', 'Open preview file old.txt', 'photo.png', 'Download', 'Send'];
  const scope = { querySelectorAll: () => buttons.map(label => ({ getAttribute: () => label })) };
  const cards = api.domExportDocumentCards(scope);
  assert.deepEqual(Array.from(cards, card => card.attachment.name), ['video.txt', 'Вставленный текст (2).txt']);
});

test('DOM preview never exports the wrong bytes when two observed files share a name', async () => {
  let bodyReads = 0;
  await assert.rejects(api.resolveDOMExportDocument({ attachment: attachment(null, 'same.txt') }, {
    downloadIds: async () => ['file_old', 'file_new'],
    read: async (file, options) => {
      if (options?.metadataOnly) return { ok: true, name: file.name };
      bodyReads++;
      return { ok: true, text: file.id, bytes: 10 };
    },
  }), /одинаковое имя/);
  assert.equal(bodyReads, 0);
});
