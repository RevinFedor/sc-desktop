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
};`, context);

const { sanitizeYoutubeSettings, YOUTUBE_DEFAULT_SETTINGS, diffYoutubeSettings } = context.__settingsExports;

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
    chatgpt_work_model: '5.3',
    chatgpt_work_effort: 'xhigh',
    preferred_lang: ' en ',
  });
  assert.equal(settings.chatgpt_chat_model, '5.4');
  assert.equal(settings.chatgpt_chat_effort, 'medium');
  assert.equal(settings.chatgpt_work_model, '5.3');
  assert.equal(settings.chatgpt_work_effort, 'xhigh');
  assert.equal(settings.chatgpt_model, '5.3');
  assert.equal(settings.chatgpt_effort, 'xhigh');
  assert.equal(settings.preferred_lang, 'en');
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
