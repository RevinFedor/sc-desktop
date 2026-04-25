/**
 * FILE: extension/src/v2/inspector.ts
 * PURPOSE: Self-contained function body for page inspection — scans for interactable elements,
 *          penetrates same-origin iframes and open shadow roots, returns structured anchor data.
 * OWNS: Page inspection logic (injectable string body).
 * EXPORTS: inspectFunctionBody, listFramesFunctionBody
 * DOCS: agent_chat/plan_adr001_v2_2026-05-12.md (Phase 2d)
 */

/**
 * Self-contained function expression body for page inspection.
 * Runs inside the page via chrome.scripting.executeScript.
 *
 * Returns structured data about interactable elements with anchor IDs.
 * Penetrates same-origin iframes and open shadow roots.
 * Limits results to `limit` (default 50).
 *
 * Parameters: (limit, includeHidden, compact)
 *
 * NOTE: Uses `function` keyword (not arrow `=>`) to avoid Vite/Oxc parser
 * confusion with template literals containing arrow syntax.
 */
/** @deprecated Logic moved to content-actions.ts inspectElements(). Kept for reference. */
export const inspectFunctionBody = `function(limit, includeHidden, compact) {
  var maxAnchors = limit || 50;
  var isCompact = !!compact;
  var anchors = [];
  var anchorIndex = 0;

  function isInteractable(el) {
    var tag = el.tagName.toLowerCase();
    var role = el.getAttribute("role") || "";
    var type = el.getAttribute("type") || "";

    var clickable = tag === "button" || tag === "a" || tag === "select" || tag === "textarea"
      || (tag === "input" && type !== "hidden")
      || role === "button" || role === "link" || role === "checkbox" || role === "radio"
      || role === "textbox" || role === "combobox" || role === "listbox"
      || role === "tab" || role === "menuitem" || role === "option"
      || el.hasAttribute("onclick") || el.hasAttribute("tabindex")
      || el.getAttribute("contenteditable") === "true";

    if (!clickable) return false;

    if (!includeHidden) {
      if (el.style.display === "none" || el.style.visibility === "hidden") return false;
      if (el.offsetParent === null && tag !== "a") {
        if (!el.getAttribute("aria-hidden")) return false;
      }
      if (el.getClientRects().length === 0 && tag !== "a") return false;
    }

    return true;
  }

  function getTarget(el) {
    var tag = el.tagName.toLowerCase();
    var role = el.getAttribute("role");
    var ariaLabel = el.getAttribute("aria-label");
    var placeholder = el.getAttribute("placeholder");
    var testId = el.getAttribute("data-testid");
    var text = (el.textContent || "").trim().slice(0, 100) || el.getAttribute("value") || "";

    if (role && ariaLabel) return { role: role, name: ariaLabel };
    if (role && text) return { role: role, name: text };
    if (testId) return { testId: testId };
    if (ariaLabel) return { label: ariaLabel };
    if (placeholder) return { placeholder: placeholder };
    if (el.id) return { css: "#" + el.id };
    if (tag === "button" || tag === "a") return { text: text };
    return { css: tag + (el.className ? "." + el.className.trim().split(/\\s+/).join(".") : "") };
  }

  function getAnchorInfo(el, compact) {
    var tag = el.tagName.toLowerCase();
    var role = el.getAttribute("role");
    var type = el.getAttribute("type");
    var ariaLabel = el.getAttribute("aria-label");
    var placeholder = el.getAttribute("placeholder");
    var text = (el.textContent || "").trim().slice(0, 100);

    anchorIndex++;
    var id = "a" + anchorIndex;

    // Full anchor info: all fields for detailed inspection
    if (!compact) {
      var visible = !!(el.offsetParent !== null || tag === "a");
      var enabled = !el.disabled;
      var checked = el.checked;
      var selected = el.selected;

      var info = {
        anchor: id,
        role: role || tag,
        name: ariaLabel || text.slice(0, 50) || undefined,
        label: ariaLabel || undefined,
        placeholder: placeholder || undefined,
        text: text || undefined,
        tag: tag,
        type: type || undefined,
        visible: visible
      };
      if (enabled !== undefined) info.enabled = enabled;
      if (checked !== undefined) info.checked = checked;
      if (selected !== undefined) info.selected = selected;
      info.target = getTarget(el);
      return info;
    }

    // Compact anchor info: only essential fields for follow-up actions
    var info = {
      anchor: id,
      tag: tag,
      text: text || undefined
    };
    info.target = getTarget(el);
    return info;
  }

  function walkElements(root, collected) {
    if (collected.length >= maxAnchors) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
    var node;
    while ((node = walker.nextNode()) && collected.length < maxAnchors) {
      var el = node;
      if (isInteractable(el)) {
        collected.push(getAnchorInfo(el, isCompact));
      }
      if (el.shadowRoot) {
        walkElements(el.shadowRoot, collected);
      }
    }
  }

  var collected = [];
  walkElements(document.body || document.documentElement, collected);

  var iframes = document.querySelectorAll("iframe");
  for (var fi = 0; fi < iframes.length; fi++) {
    if (collected.length >= maxAnchors) break;
    try {
      if (iframes[fi].contentDocument && iframes[fi].contentDocument.body) {
        walkElements(iframes[fi].contentDocument.body, collected);
      }
    } catch (_) {}
  }

  var documentId = "doc-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  return {
    url: location.href,
    title: document.title,
    documentId: documentId,
    anchors: collected.slice(0, maxAnchors)
  };
}
`;

/**
 * Self-contained function body for listing frames in the current page.
 * Returns frame IDs that can be used with chrome.scripting.executeScript's frameId parameter.
 * NOTE: Uses `function` keyword (not arrow `=>`) to avoid parser confusion.
 */
/** @deprecated Logic moved to content-actions.ts listFrames(). Kept for reference. */
export const listFramesFunctionBody = `function() {
  var frames = [];
  var iframes = document.querySelectorAll("iframe");
  for (var i = 0; i < iframes.length; i++) {
    var iframe = iframes[i];
    var frameInfo = {
      index: i,
      id: iframe.id || undefined,
      name: iframe.name || undefined,
      src: (iframe.src || "").slice(0, 200),
      sameOrigin: false
    };
    try {
      if (iframe.contentDocument) {
        frameInfo.sameOrigin = true;
        frameInfo.title = iframe.contentDocument.title || undefined;
        frameInfo.url = iframe.contentDocument.URL || undefined;
      }
    } catch (e) {
      // Cross-origin — can't access content
    }
    frames.push(frameInfo);
  }
  return frames;
}
`;
