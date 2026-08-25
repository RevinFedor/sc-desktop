const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // Unified, non-secret application settings exposed to the Settings screen.
  appSettingsGet:   ()        => ipcRenderer.invoke('appSettings:get'),
  appSettingsPatch: (payload) => ipcRenderer.invoke('appSettings:patch', payload),

  // Telegram fetch via tg_fetch_json.py (ndjson stream).
  tgFetch:           (params)   => ipcRenderer.invoke('tg:fetch', params),
  tgPreview:         (params)   => ipcRenderer.invoke('tg:preview', params),
  tgResolveTitle:    (text)     => ipcRenderer.invoke('tg:resolveTitle', text),
  tgSearchDialogs:   (payload)  => ipcRenderer.invoke('tg:searchDialogs', payload),

  // Telegram folders — group of sources, sequential batch fetch.
  tgResolveFolder:    (payload) => ipcRenderer.invoke('tg:resolveFolder', payload),
  tgRefreshFolders:   ()        => ipcRenderer.invoke('tg:refreshFolders'),
  tgReplyBackfill:    (payload) => ipcRenderer.invoke('tg:replyBackfill', payload),
  folderList:         (tgSession) => ipcRenderer.invoke('folder:list', tgSession || null),
  sourceSetSession:   (id, session) => ipcRenderer.invoke('sources:setSession', { id, session }),
  folderGet:          (id)      => ipcRenderer.invoke('folder:get', id),
  folderListSources:  (id)      => ipcRenderer.invoke('folder:listSources', id),
  folderRemove:       (id)      => ipcRenderer.invoke('folder:remove', id),
  folderUpdateParams: (id, patch) => ipcRenderer.invoke('folder:updateParams', { id, patch }),
  folderFetch:        (params)  => ipcRenderer.invoke('folder:fetch', params),
  tgCatchUp:          (params)  => ipcRenderer.invoke('tg:catchUp', params),
  sourcesSetTelegramAuto: (params) => ipcRenderer.invoke('sources:setTelegramAuto', params),
  tgCatchUpComments: (params)   => ipcRenderer.invoke('tg:catchUpComments', params),
  tgCountComments:   (sourceId) => ipcRenderer.invoke('tg:countComments', sourceId),
  tgPostsWithComments: (id)     => ipcRenderer.invoke('tg:postsWithComments', id),

  // Semantic indexing + hybrid search (Telegram).
  tgIndex:        (params) => ipcRenderer.invoke('tg:index', params),
  tgIndexStatus:  (id)     => ipcRenderer.invoke('tg:indexStatus', id),
  tgIndexCancel:  (id)     => ipcRenderer.invoke('tg:indexCancel', id),
  tgSearch:       (params) => ipcRenderer.invoke('tg:search', params),

  // Telegram session management.
  tgListSessions:      ()         => ipcRenderer.invoke('tg:listSessions'),
  tgSetActiveSession:  (name)     => ipcRenderer.invoke('tg:setActiveSession', name),
  tgLoginStart:        (payload)  => ipcRenderer.invoke('tg:loginStart', payload),
  tgLoginFinish:       (payload)  => ipcRenderer.invoke('tg:loginFinish', payload),
  tgDeleteSession:     (name)     => ipcRenderer.invoke('tg:deleteSession', name),

  // Instagram settings + session inventory + profile fetch.
  igGetSettings:    (options)  => ipcRenderer.invoke('ig:getSettings', options || {}),
  igSetBackend:     (payload)  => ipcRenderer.invoke('ig:setBackend', payload),
  igSetApifyToken:  (token)    => ipcRenderer.invoke('ig:setApifyToken', token),
  igListSessions:   ()         => ipcRenderer.invoke('ig:listSessions'),
  igLogin:          ()         => ipcRenderer.invoke('ig:login'),
  igDeleteSession:  (kind)     => ipcRenderer.invoke('ig:deleteSession', kind),
  igOverview:       (payload)  => ipcRenderer.invoke('ig:overview', payload),
  igLookupProfile:  (payload)  => ipcRenderer.invoke('ig:lookupProfile', payload),
  igLookupReel:     (payload)  => ipcRenderer.invoke('ig:lookupReel', payload),
  igProfileFetch:   (params)   => ipcRenderer.invoke('ig:profileFetch', params),
  igBatchTranscribe:(params)   => ipcRenderer.invoke('ig:batchTranscribe', params),
  igAssembleBatch:  (payload)  => ipcRenderer.invoke('ig:assembleBatchTranscript', payload),

  // YouTube single-video transcript (yt_single_ndjson.py).
  ytLookupCache:    (videoId) => ipcRenderer.invoke('yt:lookupCache', videoId),
  ytCopyCachedFile: (path)    => ipcRenderer.invoke('yt:copyCachedFile', path),
  ytCopyWithTimestamps: (payload) => ipcRenderer.invoke('yt:copyWithTimestamps', payload),
  ytSingle:         (params)  => ipcRenderer.invoke('yt:single', params),
  ytResumeAi:       (payload) => ipcRenderer.invoke('yt:resumeAi', payload),

  // Rutube — one-shot transcript, free subtitles first and explicit AI fallback.
  rutubeLookupCache:    (videoId) => ipcRenderer.invoke('rutube:lookupCache', videoId),
  rutubeCopyCachedFile: (path)    => ipcRenderer.invoke('rutube:copyCachedFile', path),
  rutubeSingle:         (params)  => ipcRenderer.invoke('rutube:single', params),
  rutubeResumeAi:       (payload) => ipcRenderer.invoke('rutube:resumeAi', payload),

  // YouTube comments (yt_comments_ndjson.py). Cache lookup matches an exact
  // (video_id, sort, limit, includeReplies) tuple.
  ytLookupCommentsCache: (payload) => ipcRenderer.invoke('yt:lookupCommentsCache', payload),
  ytComments:            (params)  => ipcRenderer.invoke('yt:comments', params),
  ytBatchComments:       (params)  => ipcRenderer.invoke('yt:batchComments', params),

  // YouTube channel + batch transcribe.
  ytChannelLookup:        (payload) => ipcRenderer.invoke('yt:channelLookup', payload),
  ytChannelFetch:         (params)  => ipcRenderer.invoke('yt:channelFetch', params),
  ytBatchTranscribe:      (params)  => ipcRenderer.invoke('yt:batchTranscribe', params),
  ytItemsState:           (payload) => ipcRenderer.invoke('yt:itemsState', payload),
  ytItemsStateGlobal:     (payload) => ipcRenderer.invoke('yt:itemsStateGlobal', payload),
  ytItemsCommentsState:   (payload) => ipcRenderer.invoke('yt:itemsCommentsState', payload),
  ytAssembleBatch:        (payload) => ipcRenderer.invoke('yt:assembleBatchTranscript', payload),
  ytSearchFetch:          (params)  => ipcRenderer.invoke('yt:searchFetch', params),
  ytResumeBatch:          (payload) => ipcRenderer.invoke('yt:resumeBatch', payload),

  // TikTok — channel-fetch, single-video, batch transcribe.
  tkLookupCache:    (videoId) => ipcRenderer.invoke('tk:lookupCache', videoId),
  tkCopyCachedFile: (path)    => ipcRenderer.invoke('tk:copyCachedFile', path),
  tkSingle:         (params)  => ipcRenderer.invoke('tk:single', params),
  tkChannelLookup:  (payload) => ipcRenderer.invoke('tk:channelLookup', payload),
  tkChannelFetch:   (params)  => ipcRenderer.invoke('tk:channelFetch', params),
  tkBatchTranscribe:(params)  => ipcRenderer.invoke('tk:batchTranscribe', params),

  // Reddit — thread fetch (post + tree of comments), search (keyword → posts).
  rdThreadFetch:    (params)  => ipcRenderer.invoke('rd:threadFetch', params),
  rdSearch:         (params)  => ipcRenderer.invoke('rd:search', params),

  // Boosty — catalog, post preview, batch audio/transcription and local cache.
  boostyChannelLookup:  (payload) => ipcRenderer.invoke('boosty:channelLookup', payload),
  boostyChannelFetch:   (params)  => ipcRenderer.invoke('boosty:channelFetch', params),
  boostyPostPreview:    (params)  => ipcRenderer.invoke('boosty:postPreview', params),
  boostyBatchTranscribe:(params)  => ipcRenderer.invoke('boosty:batchTranscribe', params),
  boostyPosts:          (payload) => ipcRenderer.invoke('boosty:posts', payload),
  boostyDeleteAudio:    (payload) => ipcRenderer.invoke('boosty:deleteAudio', payload),
  boostyPlatformStorage:()        => ipcRenderer.invoke('boosty:platformStorage'),
  boostyStorageConfig: ()         => ipcRenderer.invoke('boosty:storageConfig'),
  boostyDeletePlatformAudio:()    => ipcRenderer.invoke('boosty:deletePlatformAudio'),
  boostyCopyTranscripts:(payload) => ipcRenderer.invoke('boosty:copyTranscripts', payload),
  boostySingle:         (params)  => ipcRenderer.invoke('boosty:single', params),

  // Local file transcribe — paste an absolute path → AssemblyAI/Gemini.
  localTranscribe:  (params)  => ipcRenderer.invoke('local:transcribe', params),
  copyText:       (text)    => ipcRenderer.invoke('clipboard:writeText', text),
  jobsList:       ()       => ipcRenderer.invoke('jobs:list'),
  jobsSetLiveSource: (sourceId) => ipcRenderer.invoke('jobs:setLiveSource', sourceId),

  // AI Studio MCP jobs зеркало из browser-bridge (RAM-only, перезапуск
  // sc-desktop = очистка; CS auto-восстановит на следующем log-event).
  aistudioListJobs: (options) => ipcRenderer.invoke('aistudio:listJobs', options || {}),
  aistudioClearJob: (payload) => ipcRenderer.invoke('aistudio:clearJob', payload),
  aistudioSetKeepTab: (payload) => ipcRenderer.invoke('aistudio:setKeepTab', payload),

  // Research-старт из приложения (NewResearchScreen). Идёт через main, а не
  // прямым fetch'ем — bridge CORS-allowlist не пускает renderer-origin.
  researchStart:     (payload) => ipcRenderer.invoke('research:start', payload),
  researchStatus:    (payload) => ipcRenderer.invoke('research:status', payload),
  researchPplxModels: ()       => ipcRenderer.invoke('research:pplxModels'),
  // Стоп джобы (job→error + закрыть вкладку) и tab-команды (focus/close/open-url)
  // для попапа «Запущенные MCP» / страницы джобы — тоже через main (CORS).
  researchStop:      (payload) => ipcRenderer.invoke('research:stop', payload),
  bridgeTabCommand:  (payload) => ipcRenderer.invoke('bridge:tabCommand', payload),
  onAistudioUpdate: (fn) => {
    const handler = (_evt, payload) => fn(payload)
    ipcRenderer.on('aistudio:update', handler)
    return () => ipcRenderer.removeListener('aistudio:update', handler)
  },
  jobDetail:      (payload) => ipcRenderer.invoke('jobs:detail', payload),
  jobSetAutoIndexAfterFetch: (payload) => ipcRenderer.invoke('jobs:setAutoIndexAfterFetch', payload),
  cancelJob:      (id)     => ipcRenderer.invoke('jobs:cancel', id),
  copyFile:       (path)   => ipcRenderer.invoke('jobs:copyFile', path),
  copyCombined:   (paths)  => ipcRenderer.invoke('jobs:copyCombined', paths),
  openExternal:   (path)   => ipcRenderer.invoke('jobs:openExternal', path),
  openUrl:        (url)    => ipcRenderer.invoke('jobs:openUrl', url),
  revealInFinder: (path)   => ipcRenderer.invoke('jobs:revealInFinder', path),

  // DB-backed reads (ChkPnt B+).
  uiPreferenceGet: (key) => ipcRenderer.invoke('ui:getPreference', key),
  uiPreferenceSet: (key, value) => ipcRenderer.invoke('ui:setPreference', { key, value }),
  sourcesList:   (platform) => ipcRenderer.invoke('sources:list', platform),
  sourceGet:     (id)       => ipcRenderer.invoke('sources:get', id),
  sourceFindTelegram: (target) => ipcRenderer.invoke('sources:findTelegram', target),
  sourceDetail:  (id)       => ipcRenderer.invoke('sources:detail', id),
  sourceSocialOverview: (id) => ipcRenderer.invoke('sources:socialOverview', id),
  sourceStorage: (id)       => ipcRenderer.invoke('sources:storage', id),
  storageOpenRoot: (dir)    => ipcRenderer.invoke('storage:openRoot', dir),
  storagePathInfo: (dir)    => ipcRenderer.invoke('storage:pathInfo', dir),
  storageChooseDirectory: (payload) => ipcRenderer.invoke('storage:chooseDirectory', payload),
  // Принимает голый id или {id, limit} — см. main.js handler.
  jobsListForSource: (payload) => ipcRenderer.invoke('jobs:listForSource', payload),
  jobsListForSourcePage: (payload) => ipcRenderer.invoke('jobs:listForSourcePage', payload),
  itemsList:     (params)   => ipcRenderer.invoke('items:list', params),
  itemsListPage: (params)   => ipcRenderer.invoke('items:listPage', params),
  itemsSearch:   (params)   => ipcRenderer.invoke('items:search', params),
  itemsTopics:   (sourceId) => ipcRenderer.invoke('items:topics', sourceId),
  itemsTypeBreakdown: (params) => ipcRenderer.invoke('items:typeBreakdown', params),
  itemsTelegramMediaEstimate: (scope) => ipcRenderer.invoke('items:telegramMediaEstimate', scope),
  itemsCopyMany:      (payload) => ipcRenderer.invoke('items:copyMany', payload),
  itemsAssembleEstimate: (scope) => ipcRenderer.invoke('items:assembleEstimate', scope),
  itemsAssembleCopy:     (scope) => ipcRenderer.invoke('items:assembleCopy', scope),
  itemsAssembleSave:     (payload) => ipcRenderer.invoke('items:assembleSave', payload),

  // Destructive — caller must confirm.
  sourcesDelete:      (id) => ipcRenderer.invoke('sources:delete', id),
  itemsDelete:        (id) => ipcRenderer.invoke('items:delete', id),
  jobsDeleteOne:      (id) => ipcRenderer.invoke('jobs:deleteOne', id),
  jobsClearForSource: (id) => ipcRenderer.invoke('jobs:clearForSource', id),
  sourceMaxExternalId:(id) => ipcRenderer.invoke('sources:maxExternalId', id),
  diagLog:            (payload) => ipcRenderer.send('diag:rendererEvent', payload),
  sourceGetNotes:     (id) => ipcRenderer.invoke('sources:getNotes', id),
  sourceSetNotes:     (id, notes) => ipcRenderer.invoke('sources:setNotes', { id, notes }),

  // Subscribe to job updates. Returns an unsubscribe fn.
  onJobUpdate: (fn) => {
    const handler = (_evt, job) => fn(job)
    ipcRenderer.on('job:update', handler)
    return () => ipcRenderer.removeListener('job:update', handler)
  },

  // Live progress for the synchronous tgResolveTitle invoke. Telegram's
  // iter_dialogs() walk can take 30-60s on large sessions; without a counter
  // the spinner reads as "stuck". Returns an unsubscribe fn.
  onTgResolveProgress: (fn) => {
    const handler = (_evt, payload) => fn(payload)
    ipcRenderer.on('tg:resolveProgress', handler)
    return () => ipcRenderer.removeListener('tg:resolveProgress', handler)
  },
})
