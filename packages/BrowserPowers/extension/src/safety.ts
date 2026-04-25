/**
 * Safety guard — returns true only when running in a real browser extension.
 *
 * Detection strategy: chrome.runtime.id is the primary signal.
 * Fall back to checking window + no process for content script contexts.
 */
export function isExtensionContext(): boolean {
  // The chrome.runtime.id check is the primary signal
  if (typeof chrome !== "undefined" && !!chrome.runtime?.id) {
    return true;
  }
  // If we got here and have window + no process.versions.node, we're in a content script
  if (typeof window !== "undefined" && typeof process === "undefined") {
    return true;
  }
  return false;
}
