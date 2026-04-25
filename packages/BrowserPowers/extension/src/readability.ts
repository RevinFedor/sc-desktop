/**
 * Simplified Readability extractor — runs inside a page
 * via chrome.scripting.executeScript.
 *
 * Strips navigation, sidebars, footers, ads, and other boilerplate
 * to isolate the main page content.
 */

export interface ReadableResult {
  title: string;
  content: string;
  excerpt: string;
  byline?: string;
  length: number;
  fallback: boolean;
}

// This function body is injected as a string into executeScript — it
// cannot reference any imports or closure variables.
export const readabilityFunctionBody = `() => {
  const NON_CONTENT_TAGS = new Set([
    "NAV", "HEADER", "FOOTER", "ASIDE", "SCRIPT", "STYLE",
    "NOSCRIPT", "IFRAME", "SVG", "CANVAS", "VIDEO", "AUDIO",
    "OBJECT", "EMBED", "TEMPLATE",
  ]);

  const NON_CONTENT_SELECTORS = [
    '[role="navigation"]',
    '[role="banner"]',
    '[role="contentinfo"]',
    '[role="complementary"]',
    ".nav", ".navbar", ".navigation", ".menu", ".sidebar",
    ".footer", ".header", ".advertisement", ".ad", ".ads",
    ".social-share", ".related-posts", ".comments",
    "#nav", "#navbar", "#navigation", "#menu", "#sidebar",
    "#footer", "#header", "#comments",
    '[id*="sidebar"]', '[class*="sidebar"]',
    '[id*="footer"]', '[class*="footer"]',
    '[id*="nav"]', '[class*="nav-"]',
    '[id*="menu"]', '[class*="menu"]',
    '[id*="ad-"]', '[class*="ad-"]', '[class*="ads-"]',
  ];

  function isNonContent(el: Element): boolean {
    if (NON_CONTENT_TAGS.has(el.tagName)) return true;
    for (const sel of NON_CONTENT_SELECTORS) {
      try { if (el.matches(sel)) return true; } catch (_) { /* invalid selector */ }
    }
    return false;
  }

  function cloneWithoutBoilerplate(body: HTMLElement): HTMLElement {
    const clone = body.cloneNode(true) as HTMLElement;
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT);
    const toRemove: Element[] = [];
    let node: Element | null;
    while ((node = walker.nextNode() as Element | null)) {
      if (isNonContent(node)) toRemove.push(node);
    }
    for (const el of toRemove) {
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    return clone;
  }

  function findMainElement(doc: HTMLElement): Element | null {
    // Prefer <main>, <article>, or [role="main"]
    for (const sel of ['main', 'article', '[role="main"]', '.post-content', '.article-content', '.entry-content']) {
      try {
        const el = doc.querySelector(sel);
        if (el) return el;
      } catch (_) { /* invalid selector */ }
    }
    return null;
  }

  try {
    const body = document.body;
    if (!body) throw new Error("No body element");

    const title = document.title || "";
    const cleaned = cloneWithoutBoilerplate(body);
    const main = findMainElement(cleaned);

    let content = (main ?? cleaned).textContent || "";
    // Normalize whitespace: collapse multiple newlines/spaces
    content = content.replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();

    const firstPara = content.split("\n\n").find(p => p.length > 40) || content.slice(0, 200);
    const excerpt = firstPara.slice(0, 300);

    return {
      title,
      content,
      excerpt,
      byline: undefined,
      length: content.length,
      fallback: !main,
    };
  } catch (err) {
    // Ultimate fallback: raw innerText
    const body = document.body;
    const raw = body ? (body.innerText || document.documentElement.innerText) : "";
    return {
      title: document.title || "",
      content: raw,
      excerpt: raw.slice(0, 200),
      length: raw.length,
      fallback: true,
    };
  }
}`;
