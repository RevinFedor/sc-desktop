(function () {
  'use strict';
  if (window.__scYtLearningMainBridgeInstalled) return;
  window.__scYtLearningMainBridgeInstalled = true;

  function visibleArea(element) {
    if (!element) return 0;
    const rect = element.getBoundingClientRect();
    const width = Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left));
    const height = Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top));
    return width * height;
  }

  function activePlayer() {
    if (!location.pathname.startsWith('/shorts/')) {
      return document.getElementById('movie_player');
    }
    const reels = Array.from(document.querySelectorAll('ytd-reel-video-renderer'));
    reels.sort((a, b) => visibleArea(b) - visibleArea(a));
    return reels[0]?.querySelector('#movie_player') || document.getElementById('movie_player');
  }

  function trackLabel(track) {
    const name = track?.name;
    if (typeof name?.simpleText === 'string') return name.simpleText;
    if (Array.isArray(name?.runs)) return name.runs.map(run => run?.text || '').join('');
    return track?.languageCode || '';
  }

  function publicTrack(track) {
    if (!track || typeof track !== 'object') return null;
    return {
      baseUrl: typeof track.baseUrl === 'string' ? track.baseUrl : '',
      languageCode: track.languageCode || '',
      kind: track.kind || '',
      vssId: track.vssId || track.vss_id || '',
      label: trackLabel(track),
      isTranslatable: track.isTranslatable !== false,
    };
  }

  function captionSnapshot() {
    const player = activePlayer();
    let response = null;
    let selected = null;
    try { response = player?.getPlayerResponse?.() || null; } catch {}
    if (!response) response = window.ytInitialPlayerResponse || window.ytplayer?.config?.args?.raw_player_response || null;
    try { selected = player?.getOption?.('captions', 'track') || null; } catch {}
    const renderer = response?.captions?.playerCaptionsTracklistRenderer || {};
    const tracks = Array.isArray(renderer.captionTracks)
      ? renderer.captionTracks.map(publicTrack).filter(track => track?.baseUrl)
      : [];
    return {
      videoId: response?.videoDetails?.videoId || null,
      title: response?.videoDetails?.title || document.title.replace(/\s+-\s+YouTube\s*$/, ''),
      tracks,
      selected: publicTrack(selected),
      translationLanguages: Array.isArray(renderer.translationLanguages)
        ? renderer.translationLanguages.map(item => ({
            languageCode: item.languageCode || '',
            label: trackLabel(item),
          }))
        : [],
      ccEnabled: document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed') === 'true',
      currentTimeMs: Number.isFinite(Number(player?.getCurrentTime?.()))
        ? Math.round(Number(player.getCurrentTime()) * 1_000)
        : null,
    };
  }

  async function captionFetch(rawUrl) {
    const url = new URL(String(rawUrl || ''), location.origin);
    if (url.origin !== location.origin || url.pathname !== '/api/timedtext') {
      throw new Error('caption URL is outside YouTube timedtext');
    }
    const response = await fetch(url.toString(), { credentials: 'include' });
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error('caption response is too large');
    return {
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get('content-type') || '',
      text,
    };
  }

  window.addEventListener('message', async event => {
    if (event.source !== window) return;
    const request = event.data;
    if (!request || request.source !== 'sc-yt-learning-content') return;
    if (request.type !== 'caption-snapshot' && request.type !== 'caption-fetch') return;
    let payload;
    try {
      payload = request.type === 'caption-fetch'
        ? { ok: true, ...await captionFetch(request.url) }
        : { ok: true, ...captionSnapshot() };
    } catch (error) {
      payload = { ok: false, error: error?.message || String(error) };
    }
    window.postMessage({
      source: 'sc-yt-learning-main',
      type: request.type,
      requestId: request.requestId,
      payload,
    }, '*');
  });

  window.postMessage({ source: 'sc-yt-learning-main', type: 'ready' }, '*');
})();
