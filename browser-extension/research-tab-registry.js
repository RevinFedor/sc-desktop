(function exposeResearchTabRegistry(root) {
  const RESEARCH_TAB_REGISTRY_KEY = '__sc_research_tab_registry';

  function scResearchIdFromUrl(rawUrl) {
    try {
      const url = new URL(String(rawUrl || ''));
      const queryId = url.searchParams.get('sc-research');
      if (queryId) return queryId;
      const hashMatch = String(url.hash || '').match(/(?:^#|[&#])sc-research=([\w-]+)/);
      return hashMatch ? decodeURIComponent(hashMatch[1]) : null;
    } catch (_) {
      return null;
    }
  }

  async function mutateRegistry(chromeApi, mutate) {
    root.__scResearchTabRegistryLock = (root.__scResearchTabRegistryLock || Promise.resolve())
      .then(async () => {
        const stored = await chromeApi.storage.local.get({ [RESEARCH_TAB_REGISTRY_KEY]: {} });
        const registry = stored?.[RESEARCH_TAB_REGISTRY_KEY] && typeof stored[RESEARCH_TAB_REGISTRY_KEY] === 'object'
          ? { ...stored[RESEARCH_TAB_REGISTRY_KEY] }
          : {};
        await mutate(registry);
        await chromeApi.storage.local.set({ [RESEARCH_TAB_REGISTRY_KEY]: registry });
      });
    return root.__scResearchTabRegistryLock;
  }

  async function scRememberResearchTab(chromeApi, researchId, tab) {
    if (!researchId || !Number.isInteger(tab?.id)) return;
    await mutateRegistry(chromeApi, registry => {
      registry[researchId] = {
        tabId: tab.id,
        windowId: Number.isInteger(tab.windowId) ? tab.windowId : null,
        url: typeof tab.url === 'string' ? tab.url : null,
        updatedAt: Date.now(),
      };
    });
  }

  async function scForgetResearchTab(chromeApi, researchId) {
    if (!researchId) return;
    await mutateRegistry(chromeApi, registry => { delete registry[researchId]; });
  }

  async function scForgetResearchTabByTabId(chromeApi, tabId) {
    if (!Number.isInteger(tabId)) return;
    await mutateRegistry(chromeApi, registry => {
      for (const [researchId, entry] of Object.entries(registry)) {
        if (entry?.tabId === tabId) delete registry[researchId];
      }
    });
  }

  async function scReplaceResearchTabId(chromeApi, removedTabId, addedTabId) {
    if (!Number.isInteger(removedTabId) || !Number.isInteger(addedTabId)) return;
    let addedTab = null;
    try { addedTab = await chromeApi.tabs.get(addedTabId); } catch (_) {}
    await mutateRegistry(chromeApi, registry => {
      for (const entry of Object.values(registry)) {
        if (entry?.tabId !== removedTabId) continue;
        entry.tabId = addedTabId;
        entry.windowId = Number.isInteger(addedTab?.windowId) ? addedTab.windowId : entry.windowId;
        entry.url = typeof addedTab?.url === 'string' ? addedTab.url : entry.url;
        entry.updatedAt = Date.now();
      }
    });
  }

  async function scFindResearchTab(chromeApi, rawUrl) {
    const researchId = scResearchIdFromUrl(rawUrl);
    if (!researchId) return null;
    const stored = await chromeApi.storage.local.get({ [RESEARCH_TAB_REGISTRY_KEY]: {} });
    const entry = stored?.[RESEARCH_TAB_REGISTRY_KEY]?.[researchId];
    if (Number.isInteger(entry?.tabId)) {
      try {
        const tab = await chromeApi.tabs.get(entry.tabId);
        if (tab) return tab;
      } catch (_) {
        await scForgetResearchTab(chromeApi, researchId);
      }
    }

    const target = new URL(rawUrl);
    const tabs = await chromeApi.tabs.query({ url: `${target.origin}/*` });
    const tab = (tabs || []).find(candidate => scResearchIdFromUrl(candidate?.url) === researchId) || null;
    if (tab) await scRememberResearchTab(chromeApi, researchId, tab);
    return tab;
  }

  root.RESEARCH_TAB_REGISTRY_KEY = RESEARCH_TAB_REGISTRY_KEY;
  root.scResearchIdFromUrl = scResearchIdFromUrl;
  root.scRememberResearchTab = scRememberResearchTab;
  root.scForgetResearchTab = scForgetResearchTab;
  root.scForgetResearchTabByTabId = scForgetResearchTabByTabId;
  root.scReplaceResearchTabId = scReplaceResearchTabId;
  root.scFindResearchTab = scFindResearchTab;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      RESEARCH_TAB_REGISTRY_KEY,
      scResearchIdFromUrl,
      scRememberResearchTab,
      scForgetResearchTab,
      scForgetResearchTabByTabId,
      scReplaceResearchTabId,
      scFindResearchTab,
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
