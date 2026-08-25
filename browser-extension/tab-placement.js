(function exposeScTabPlacement(root) {
  function scTabCreateOptionsBesideSource(baseOptions, sourceTab) {
    const options = { ...(baseOptions || {}) };
    if (!Number.isInteger(sourceTab?.windowId) || sourceTab.windowId < 0) return options;
    if (!Number.isInteger(sourceTab?.index) || sourceTab.index < 0) return options;
    options.windowId = sourceTab.windowId;
    options.index = sourceTab.index + 1;
    return options;
  }

  root.scTabCreateOptionsBesideSource = scTabCreateOptionsBesideSource;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { scTabCreateOptionsBesideSource };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
