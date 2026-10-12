export function wireResearchNavigation({ api, navigate, closeOverlays, getScreen, reportError }) {
  if (!api?.onResearchOpenRequest || !api.researchOpenReady || !api.researchOpenAck) return () => {}
  let alive = true, latestSequence = 0, appliedRequest = null
  const open = async request => {
    if (!alive || !request?.jobId || !request.requestId || !Number.isSafeInteger(request.sequence)
      || request.sequence < latestSequence || appliedRequest === request.requestId) return
    latestSequence = request.sequence
    const before = getScreen()
    const current = await api.researchOpenReady()
    if (!alive || current?.requestId !== request.requestId || latestSequence !== request.sequence) return
    if (getScreen() !== before) {
      await api.researchOpenAck({ ...request, success: false, error: 'research_navigation_cancelled_by_user' })
      return
    }
    appliedRequest = request.requestId
    closeOverlays()
    navigate('aistudio-job', { jobId: request.jobId, navigationRequestId: request.requestId })
  }
  const off = api.onResearchOpenRequest(request => { void open(request).catch(reportError) })
  api.researchOpenReady().then(open).catch(reportError)
  return () => { alive = false; off?.() }
}
