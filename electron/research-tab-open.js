function errorText(error) {
  return String(error?.message || error || 'unknown extension error')
}

function researchIdFromUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''))
    const queryId = url.searchParams.get('sc-research')
    if (queryId) return queryId
    const hashMatch = String(url.hash || '').match(/(?:^#|[&#])sc-research=([\w-]+)/)
    return hashMatch ? decodeURIComponent(hashMatch[1]) : null
  } catch (_) {
    return null
  }
}

function isAmbiguousDeliveryError(error) {
  if (error?.deliveryUnknown === true) return true
  const code = String(error?.code || '')
  if (code === 'extension_disconnected_delivery_unknown') return true
  return /Extension disconnected|command result.*unknown|command timeout|mcp bridge closed/i.test(errorText(error))
}

function tabIdFromResponse(response) {
  const value = response?.tabId ?? response?.result?.tabId
  return Number.isInteger(value) ? value : null
}

function jobHasStarted(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false
  if (Number.isInteger(snapshot.tabId)) return true
  if (snapshot.status && snapshot.status !== 'queued') return true
  return !!(snapshot.stage && !['queued', 'prepared', 'opening'].includes(snapshot.stage))
}

async function reconcileResearchTabOpen({ openTab, findTab, getSnapshot, delay, retryAfterMissing = true }) {
  try {
    const response = await openTab()
    if (response?.success === false || response?.result?.success === false) {
      return { tabId: null, openState: 'failed', attempts: 1,
        openError: errorText(response.error || response.result?.error || 'extension rejected browser open'), response }
    }
    const tabId = tabIdFromResponse(response)
    if (tabId == null) {
      const snapshot = typeof getSnapshot === 'function' ? getSnapshot() : null
      return { tabId: null,
        openState: jobHasStarted(snapshot) ? 'started_without_tab_ack' : 'delivery_unknown',
        attempts: 1, response,
        openWarning: 'The extension returned no browser tab identity' }
    }
    return { tabId, openState: 'opened', attempts: 1, response }
  } catch (firstError) {
    if (!isAmbiguousDeliveryError(firstError)) {
      return { tabId: null, openState: 'failed', attempts: 1, openError: errorText(firstError) }
    }

    if (delay) await delay()
    try {
      const found = await findTab()
      const foundTabId = tabIdFromResponse(found)
      if (foundTabId != null) {
        return {
          tabId: foundTabId,
          openState: 'reconciled',
          attempts: 2,
          openWarning: errorText(firstError),
          response: found,
        }
      }

      if (!retryAfterMissing) {
        return {
          tabId: null, openState: 'delivery_unknown', attempts: 2,
          openWarning: errorText(firstError),
        }
      }

      // `mcp_find_research_tab` itself succeeded, therefore the extension
      // advertises the idempotent contract. A repeated open cannot duplicate
      // a tab: the handler performs the same lookup before creating one.
      const retry = await openTab()
      return {
        tabId: tabIdFromResponse(retry),
        openState: 'opened_after_reconnect',
        attempts: 3,
        openWarning: errorText(firstError),
        response: retry,
      }
    } catch (reconcileError) {
      const snapshot = typeof getSnapshot === 'function' ? getSnapshot() : null
      const snapshotTabId = Number.isInteger(snapshot?.tabId) ? snapshot.tabId : null
      if (snapshotTabId != null) {
        return {
          tabId: snapshotTabId,
          openState: 'reconciled_from_state',
          attempts: 2,
          openWarning: `${errorText(firstError)}; ${errorText(reconcileError)}`,
        }
      }
      return {
        tabId: null,
        openState: jobHasStarted(snapshot) ? 'started_without_tab_ack' : 'delivery_unknown',
        attempts: 2,
        openWarning: `${errorText(firstError)}; ${errorText(reconcileError)}`,
      }
    }
  }
}

module.exports = {
  isAmbiguousDeliveryError,
  researchIdFromUrl,
  tabIdFromResponse,
  jobHasStarted,
  reconcileResearchTabOpen,
}
