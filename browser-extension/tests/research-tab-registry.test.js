const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RESEARCH_TAB_REGISTRY_KEY,
  scResearchIdFromUrl,
  scRememberResearchTab,
  scForgetResearchTabByTabId,
  scReplaceResearchTabId,
  scFindResearchTab,
} = require('../research-tab-registry.js');

function fakeChrome() {
  const state = {};
  const tabs = new Map();
  return {
    state,
    tabsMap: tabs,
    storage: {
      local: {
        async get(defaults) { return { ...defaults, ...structuredClone(state) }; },
        async set(patch) { Object.assign(state, structuredClone(patch)); },
      },
    },
    tabs: {
      async get(id) {
        if (!tabs.has(id)) throw new Error('No tab');
        return structuredClone(tabs.get(id));
      },
      async query() { return Array.from(tabs.values(), value => structuredClone(value)); },
    },
  };
}

test('research id is recovered from query or hash', () => {
  assert.equal(scResearchIdFromUrl('https://chatgpt.com/?sc-research=abc#sc-research=abc'), 'abc');
  assert.equal(scResearchIdFromUrl('https://claude.ai/new#sc-research=xyz-1'), 'xyz-1');
  assert.equal(scResearchIdFromUrl('https://chatgpt.com/'), null);
});

test('registry survives URL rewrites and returns the already-created tab', async () => {
  const chromeApi = fakeChrome();
  const tab = { id: 42, windowId: 7, url: 'https://chatgpt.com/?sc-research=job-1' };
  chromeApi.tabsMap.set(tab.id, tab);
  await scRememberResearchTab(chromeApi, 'job-1', tab);
  chromeApi.tabsMap.set(tab.id, { ...tab, url: 'https://chatgpt.com/' });

  const found = await scFindResearchTab(chromeApi, 'https://chatgpt.com/?sc-research=job-1');
  assert.equal(found.id, 42);
  assert.equal(chromeApi.state[RESEARCH_TAB_REGISTRY_KEY]['job-1'].tabId, 42);
});

test('stale entries are removed and URL lookup repairs the registry', async () => {
  const chromeApi = fakeChrome();
  chromeApi.state[RESEARCH_TAB_REGISTRY_KEY] = { stale: { tabId: 9 } };
  chromeApi.tabsMap.set(11, { id: 11, url: 'https://chatgpt.com/?sc-research=stale#sc-research=stale' });

  const found = await scFindResearchTab(chromeApi, 'https://chatgpt.com/?sc-research=stale');
  assert.equal(found.id, 11);
  assert.equal(chromeApi.state[RESEARCH_TAB_REGISTRY_KEY].stale.tabId, 11);
  await scForgetResearchTabByTabId(chromeApi, 11);
  assert.equal(chromeApi.state[RESEARCH_TAB_REGISTRY_KEY].stale, undefined);
});

test('tab replacement keeps the research identity attached to the new tab id', async () => {
  const chromeApi = fakeChrome();
  chromeApi.tabsMap.set(21, { id: 21, windowId: 4, url: 'https://chatgpt.com/?sc-research=replace-me' });
  await scRememberResearchTab(chromeApi, 'replace-me', chromeApi.tabsMap.get(21));
  chromeApi.tabsMap.delete(21);
  chromeApi.tabsMap.set(22, { id: 22, windowId: 4, url: 'https://chatgpt.com/' });

  await scReplaceResearchTabId(chromeApi, 21, 22);
  assert.equal(chromeApi.state[RESEARCH_TAB_REGISTRY_KEY]['replace-me'].tabId, 22);
});

test('ten concurrent registrations survive URL rewrites and one tab closing independently', async () => {
  const chromeApi = fakeChrome();
  const tabs = Array.from({ length: 10 }, (_, i) => ({
    id: 100 + i, windowId: 7, url: `https://chatgpt.com/?sc-research=parallel-${i}`,
  }));
  tabs.forEach(tab => chromeApi.tabsMap.set(tab.id, tab));
  await Promise.all(tabs.map((tab, i) => scRememberResearchTab(chromeApi, `parallel-${i}`, tab)));
  assert.equal(Object.keys(chromeApi.state[RESEARCH_TAB_REGISTRY_KEY]).length, 10);
  tabs.forEach((tab, i) => chromeApi.tabsMap.set(tab.id, { ...tab, url: `https://chatgpt.com/c/conversation-${i}` }));
  const restored = await Promise.all(tabs.map(tab => scFindResearchTab(chromeApi, tab.url)));
  assert.deepEqual(restored.map(tab => tab.id), tabs.map(tab => tab.id));
  await scForgetResearchTabByTabId(chromeApi, 104);
  chromeApi.tabsMap.delete(104);
  assert.equal(await scFindResearchTab(chromeApi, tabs[4].url), null);
  assert.equal(Object.keys(chromeApi.state[RESEARCH_TAB_REGISTRY_KEY]).length, 9);
  assert.equal((await scFindResearchTab(chromeApi, tabs[9].url)).id, 109);
});
