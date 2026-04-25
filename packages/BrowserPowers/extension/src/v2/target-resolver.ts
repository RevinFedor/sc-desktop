/**
 * FILE: extension/src/v2/target-resolver.ts
 * PURPOSE: Provide a self-contained injectable function body that resolves a structured Target or anchor
 *          to DOM element(s) in the page context. Penetrates same-origin iframes and open shadow roots.
 * OWNS: Target → element resolution logic (injectable string body).
 * EXPORTS: targetResolverBody
 * DOCS: agent_chat/plan_adr001_v2_2026-05-12.md (Phase 2b)
 */

/**
 * Injectable function body for resolving a structured Target object.
 *
 * The resolved function signature: _bpResolveTarget(target, anchorId, anchorMap)
 *
 * Resolution order:
 *   1. anchor (fast path — pre-resolved CSS selector from anchorMap)
 *   2. target.css
 *   3. target.role + optional target.name (aria-label / text filter)
 *   4. target.label (aria-label)
 *   5. target.placeholder
 *   6. target.text (text-content matching on clickable/focusable elements)
 *   7. target.testId
 *
 * Penetrates same-origin iframes and open shadow roots.
 *
 * Returns:
 *   { element, source, summary, matchCount, found } on success
 *   { found: false, error: "..." } on failure
 *
 * NOTE: The returned `element` is the actual DOM Element — this function body must be
 *       combined with an action function inside a single injected script (not serialized
 *       across the executeScript boundary).
 */
/** @deprecated Logic moved to content-actions.ts resolveTarget(). Kept for reference. */
export const targetResolverBody = `
function _bpResolveTarget(target, anchorId, anchorMap) {
  // ── Anchor fast path ──
  if (anchorId && anchorMap && anchorMap[anchorId]) {
    var el = document.querySelector(anchorMap[anchorId]);
    if (el) return { element: el, source: "anchor", summary: "anchor " + anchorId, matchCount: 1, found: true };
    return { found: false, error: "Anchor " + anchorId + " not found (stale)" };
  }
  if (!target) return { found: false, error: "No target or anchor provided" };

  var candidates = [];

  // ── Collect helper ──
  function collect(selector, source) {
    try {
      var els = document.querySelectorAll(selector);
      for (var i = 0; i < els.length; i++) {
        candidates.push({ element: els[i], source: source, summary: selector });
        // Penetrate open shadow roots
        if (els[i].shadowRoot) {
          var shadowEls = els[i].shadowRoot.querySelectorAll(selector);
          for (var j = 0; j < shadowEls.length; j++) {
            candidates.push({ element: shadowEls[j], source: source + "(shadow)", summary: selector });
          }
        }
      }
      // Penetrate same-origin iframes
      var frames = document.querySelectorAll("iframe");
      for (var f = 0; f < frames.length; f++) {
        try {
          if (frames[f].contentDocument) {
            var frameEls = frames[f].contentDocument.querySelectorAll(selector);
            for (var k = 0; k < frameEls.length; k++) {
              candidates.push({ element: frameEls[k], source: source, summary: selector });
            }
          }
        } catch(_) {}
      }
    } catch(_) {}
  }

  // ── Try in order ──
  if (target.css) collect(target.css, "css");
  if (target.role) {
    var roleSel = '[role="' + target.role.replace(/"/g, '\\\\"') + '"]';
    collect(roleSel, "role");
  }
  if (target.label) {
    collect('[aria-label="' + target.label.replace(/"/g, '\\\\"') + '"]', "label");
    // Also try aria-labelledby
    collect('[aria-labelledby="' + target.label.replace(/"/g, '\\\\"') + '"]', "label");
  }
  if (target.placeholder) {
    collect('[placeholder="' + target.placeholder.replace(/"/g, '\\\\"') + '"]', "placeholder");
  }
  if (target.testId) {
    collect('[data-testid="' + target.testId.replace(/"/g, '\\\\"') + '"]', "testId");
  }
  if (target.text) {
    var clickables = document.querySelectorAll('button, a, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [tabindex]');
    var t = target.text.toLowerCase();
    for (var ci = 0; ci < clickables.length; ci++) {
      var textContent = (clickables[ci].textContent || "").trim().toLowerCase();
      if (textContent.indexOf(t) !== -1) {
        candidates.push({ element: clickables[ci], source: "text", summary: "text:" + target.text });
      }
    }
  }

  if (candidates.length === 0) {
    return { found: false, error: "No element matched target", matchCount: 0 };
  }

  // ── Deduplicate by element reference ──
  var seen = new Set();
  var unique = [];
  for (var ci2 = 0; ci2 < candidates.length; ci2++) {
    if (!seen.has(candidates[ci2].element)) {
      seen.add(candidates[ci2].element);
      unique.push(candidates[ci2]);
    }
  }

  // ── If role+name, filter by name ──
  if (target.role && target.name) {
    var named = [];
    var nameLower = target.name.toLowerCase();
    for (var ni = 0; ni < unique.length; ni++) {
      var el = unique[ni].element;
      var ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
      var text = (el.textContent || "").trim().toLowerCase();
      var val = (el.getAttribute("value") || "").toLowerCase();
      if (ariaLabel === nameLower || text === nameLower || val === nameLower) {
        named.push(unique[ni]);
      }
    }
    if (named.length > 0) {
      return { element: named[0].element, source: named[0].source, summary: named[0].summary, matchCount: named.length, found: true };
    }
  }

  // ── Return first unique match ──
  return { element: unique[0].element, source: unique[0].source, summary: unique[0].summary, matchCount: unique.length, found: true };
}
`;
