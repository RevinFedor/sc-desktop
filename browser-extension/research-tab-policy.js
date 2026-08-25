(function exposeResearchTabPolicy(root) {
  function scKeepResearchTabAfterDone(options = {}) {
    return options?.keepTab === true || options?.autoClose === false;
  }

  root.scKeepResearchTabAfterDone = scKeepResearchTabAfterDone;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { scKeepResearchTabAfterDone };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
