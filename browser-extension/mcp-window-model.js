(function exposeScMcpWindowModel(root) {
  function optionalInteger(value) {
    return Number.isInteger(value) ? value : null;
  }

  function scMcpSerializeTab(tab, browserWindow = null) {
    return {
      id: tab.id,
      windowId: tab.windowId,
      windowType: browserWindow?.type || null,
      windowFocused: browserWindow?.focused === true,
      windowState: browserWindow?.state || null,
      index: tab.index,
      url: tab.url || tab.pendingUrl || '',
      title: tab.title || '',
      active: tab.active === true,
      incognito: tab.incognito === true,
      status: tab.status || null,
      discarded: tab.discarded === true,
      openerTabId: optionalInteger(tab.openerTabId),
    };
  }

  function scMcpSerializeWindow(browserWindow) {
    const tabs = Array.isArray(browserWindow?.tabs)
      ? [...browserWindow.tabs].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      : [];
    return {
      id: browserWindow.id,
      type: browserWindow.type || null,
      state: browserWindow.state || null,
      focused: browserWindow.focused === true,
      incognito: browserWindow.incognito === true,
      alwaysOnTop: browserWindow.alwaysOnTop === true,
      bounds: {
        left: optionalInteger(browserWindow.left),
        top: optionalInteger(browserWindow.top),
        width: optionalInteger(browserWindow.width),
        height: optionalInteger(browserWindow.height),
      },
      tabs: tabs.map(tab => scMcpSerializeTab(tab, browserWindow)),
    };
  }

  function scMcpSerializeWindows(browserWindows) {
    return (Array.isArray(browserWindows) ? browserWindows : [])
      .map(scMcpSerializeWindow);
  }

  function scMcpFlattenWindows(browserWindows) {
    return scMcpSerializeWindows(browserWindows).flatMap(browserWindow => browserWindow.tabs);
  }

  function scMcpWindowCreateOptions(command = {}) {
    const options = {
      url: command.url || 'about:blank',
      type: command.type === 'popup' ? 'popup' : 'normal',
      focused: command.focused !== false,
    };
    for (const key of ['left', 'top', 'width', 'height']) {
      if (Number.isInteger(command[key])) options[key] = command[key];
    }
    return options;
  }

  const api = {
    scMcpSerializeTab,
    scMcpSerializeWindow,
    scMcpSerializeWindows,
    scMcpFlattenWindows,
    scMcpWindowCreateOptions,
  };
  Object.assign(root, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
