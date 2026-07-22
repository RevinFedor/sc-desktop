const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'settings.js'), 'utf8');
const context = vm.createContext({ URL });
vm.runInContext(`${source}\n;globalThis.__settingsExports = {
  sanitizeYoutubeSettings,
  YOUTUBE_DEFAULT_SETTINGS,
  diffYoutubeSettings,
  chatgptModelsForMode,
  chatgptEffortsFor,
};`, context);

const { sanitizeYoutubeSettings, YOUTUBE_DEFAULT_SETTINGS, diffYoutubeSettings, chatgptModelsForMode, chatgptEffortsFor } = context.__settingsExports;

test('YouTube ChatGPT defaults to Chat with separate Chat and Work pairs', () => {
  const settings = sanitizeYoutubeSettings({});
  assert.equal(settings.chatgpt_mode, 'chat');
  assert.equal(settings.chatgpt_chat_model, '5.5');
  assert.equal(settings.chatgpt_chat_effort, 'xhigh');
  assert.equal(settings.chatgpt_work_model, '5.5');
  assert.equal(settings.chatgpt_work_effort, 'xhigh');
  assert.equal(settings.chatgpt_model, settings.chatgpt_chat_model);
  assert.equal(settings.chatgpt_effort, settings.chatgpt_chat_effort);
});

test('legacy ChatGPT model and effort migrate to Chat without changing Work defaults', () => {
  const settings = sanitizeYoutubeSettings({
    chatgpt_model: '5.4',
    chatgpt_effort: 'high',
  });
  assert.equal(settings.chatgpt_chat_model, '5.4');
  assert.equal(settings.chatgpt_chat_effort, 'high');
  assert.equal(settings.chatgpt_work_model, YOUTUBE_DEFAULT_SETTINGS.chatgpt_work_model);
  assert.equal(settings.chatgpt_work_effort, YOUTUBE_DEFAULT_SETTINGS.chatgpt_work_effort);
  assert.equal(settings.chatgpt_model, '5.4');
  assert.equal(settings.chatgpt_effort, 'high');
});

test('active aliases follow Work while both mode-specific pairs remain intact', () => {
  const settings = sanitizeYoutubeSettings({
    chatgpt_mode: 'work',
    chatgpt_chat_model: '5.4',
    chatgpt_chat_effort: 'medium',
    chatgpt_work_model: '5.6',
    chatgpt_work_effort: 'ultra',
    preferred_lang: ' en ',
  });
  assert.equal(settings.chatgpt_chat_model, '5.4');
  assert.equal(settings.chatgpt_chat_effort, 'medium');
  assert.equal(settings.chatgpt_work_model, '5.6');
  assert.equal(settings.chatgpt_work_effort, 'ultra');
  assert.equal(settings.chatgpt_model, '5.6');
  assert.equal(settings.chatgpt_effort, 'ultra');
  assert.equal(settings.preferred_lang, 'en');
});

test('GPT-5.6 capabilities follow Chat and Work availability', () => {
  assert.deepEqual(Array.from(chatgptModelsForMode('work'), m => m.id), ['5.6', '5.5']);
  assert.deepEqual(Array.from(chatgptEffortsFor('work', '5.6'), e => e.id), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(Array.from(chatgptEffortsFor('work', '5.5'), e => e.id), ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(Array.from(chatgptEffortsFor('chat', '5.6'), e => e.id), ['instant', 'medium', 'high', 'xhigh', 'pro']);
  assert.deepEqual(Array.from(chatgptEffortsFor('chat', '5.5'), e => e.id), ['instant', 'medium', 'high', 'xhigh', 'pro', 'pro-extended']);
});

test('unavailable model and effort combinations clamp without leaking across modes', () => {
  const settings = sanitizeYoutubeSettings({
    chatgpt_mode: 'work',
    chatgpt_chat_model: '5.6',
    chatgpt_chat_effort: 'pro-extended',
    chatgpt_work_model: '5.4',
    chatgpt_work_effort: 'ultra',
  });
  assert.equal(settings.chatgpt_chat_model, '5.6');
  assert.equal(settings.chatgpt_chat_effort, 'xhigh');
  assert.equal(settings.chatgpt_work_model, '5.5');
  assert.equal(settings.chatgpt_work_effort, 'xhigh');
  assert.equal(settings.chatgpt_model, '5.5');
  assert.equal(settings.chatgpt_effort, 'xhigh');
});

test('Chat to Work transition is an immediate pending patch', () => {
  const before = sanitizeYoutubeSettings({
    chatgpt_mode: 'chat',
    chatgpt_chat_model: '5.4',
    chatgpt_work_model: '5.5',
  });
  const after = sanitizeYoutubeSettings({ ...before, chatgpt_mode: 'work' });
  const patch = diffYoutubeSettings(before, after);
  assert.equal(patch.chatgpt_mode, 'work');
  assert.equal(patch.chatgpt_model, '5.5');
});
