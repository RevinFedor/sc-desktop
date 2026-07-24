import React, { useRef, useState } from 'react'
import { Settings, Activity, History, Plus } from 'lucide-react'
import { useStore, pushScreen, toggleScreen, openSettings, toggleActivity, closeActivity } from '../lib/store'
import { SETTINGS_SECTIONS } from '../lib/settingsSections'
import { useJobs } from '../lib/jobs'
import { useAistudioJobs } from '../lib/aistudioJobs'
import McpRunningPopover from './McpRunningPopover'
import RequestsRunningPopover from './RequestsRunningPopover'
import PlatformLogo from './PlatformLogo'
import { isActiveRequestJob, isVisibleRequestJob } from './ActivityPanel'

export default function TitleBar({
  toggleRef, mcpToggleRef, mcpHistoryToggleRef,
  onToggleMcpHistory, mcpHistoryOpen, closeMcpHistory,
}) {
  const screen = useStore(s => s.screen)
  const activityOpen = useStore(s => s.activityOpen)
  const jobs = useJobs()
  const activeCount = jobs.filter(j => isVisibleRequestJob(j) && isActiveRequestJob(j)).length
  const mcpActiveCount = useAistudioJobs(arr =>
    arr.filter(j => j.status === 'running' || j.status === 'pending').length
  )
  const isHome = screen.name === 'paste'
  const isSettings = screen.name === 'settings'

  // Popover текущих MCP — открывается по клику на основную часть кнопки
  // (не по стикеру "История").
  const [mcpPopoverOpen, setMcpPopoverOpen] = useState(false)
  const mcpBtnRef = useRef(null)
  const [requestsPopoverOpen, setRequestsPopoverOpen] = useState(false)
  const fallbackRequestsBtnRef = useRef(null)
  const requestsBtnRef = toggleRef || fallbackRequestsBtnRef

  // Правые поверхности (MCP-popover, История MCP, панель Запросов) —
  // взаимоисключающие: открытие любой закрывает остальные, иначе панели
  // перекрывают друг друга по z-index и юзер видит «слоёный пирог».
  function openOnly(which) {
    if (which !== 'popover') setMcpPopoverOpen(false)
    if (which !== 'requestsPopover') setRequestsPopoverOpen(false)
    if (which !== 'history') closeMcpHistory?.()
    if (which !== 'activity') closeActivity()
  }

  return (
    <div className="titlebar h-10 border-b border-zinc-800 flex items-stretch select-none relative">
      <div className="flex items-center px-3 gap-2 leading-none">
        <button
          type="button"
          onClick={() => pushScreen('paste', {
            focusComposer: true,
            focusRequestId: Date.now(),
          })}
          className={`no-drag px-2.5 py-1 rounded-md border inline-flex items-center gap-1.5 text-sm transition-colors ${
            isHome ? 'border-zinc-600 bg-zinc-800' : 'border-zinc-800 hover:border-zinc-700'
          } ${isHome ? 'text-zinc-100' : 'text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800'}`}
          title="Главная · новый запрос"
        >
          <span>Главная</span>
          <Plus size={14} />
        </button>
      </div>

      {/* drag spacer */}
      <div className="flex-1" />

      <div className="flex items-center px-3 gap-2 leading-none">
        {/* Кнопка "Запущенные MCP" — три зоны:
              [+]  новый research (форма provider/model/prompt)
              [Запущенные MCP (n)]  popover с active jobs
              [История]  sidepanel истории research */}
        <div
          ref={mcpBtnRef}
          className={`no-drag flex items-stretch rounded overflow-hidden border ${
            mcpPopoverOpen || mcpHistoryOpen
              ? 'border-zinc-600 bg-zinc-800'
              : 'border-zinc-800 hover:border-zinc-700'
          }`}
        >
          <button
            onClick={() => pushScreen('new-research')}
            className="px-2 py-1 border-r border-zinc-700 flex items-center text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
            title="Новый research (Claude / Perplexity / AI Studio / ChatGPT)"
          >
            <Plus size={14} />
          </button>
          <button
            ref={mcpToggleRef}
            onClick={() => {
              openOnly('popover')
              setMcpPopoverOpen(o => !o)
            }}
            className="px-2.5 py-1 text-sm text-zinc-300 hover:text-zinc-100 flex items-center gap-1.5"
            title="Текущие запущенные MCP"
          >
            <span>Запущенные MCP</span>
            {mcpActiveCount > 0 && (
              <span className="text-xs text-emerald-400 tabular-nums font-medium">
                ({mcpActiveCount})
              </span>
            )}
          </button>
          <button
            ref={mcpHistoryToggleRef}
            onClick={() => {
              openOnly('history')
              onToggleMcpHistory()
            }}
            className={`px-2 py-1 border-l border-zinc-700 flex items-center ${
              mcpHistoryOpen
                ? 'bg-zinc-700 text-zinc-100'
                : 'text-zinc-100 hover:bg-zinc-700'
            }`}
            title="История MCP"
          >
            <History size={14} />
          </button>
        </div>

        {/* Вертикальный белый разделитель */}
        <div className="w-px h-5 bg-zinc-600 mx-1" />

        {/* Кнопка "Запросы" — та же split-логика что у MCP:
            main-zone = текущие активные запросы, history-zone = полная история. */}
        <div
          ref={requestsBtnRef}
          className={`no-drag flex items-stretch rounded overflow-hidden border ${
            requestsPopoverOpen || activityOpen
              ? 'border-zinc-600 bg-zinc-800'
              : 'border-zinc-800 hover:border-zinc-700'
          }`}
        >
          <button
            onClick={() => {
              openOnly('requestsPopover')
              setRequestsPopoverOpen(o => !o)
            }}
            className="px-2.5 py-1 text-sm text-zinc-300 hover:text-zinc-100 flex items-center gap-1.5"
            title="Текущие запросы приложения — парсинг, транскрипция"
          >
            <Activity size={14} className="text-zinc-400" />
            <span>Запросы</span>
            {activeCount > 0 && (
              <span className="text-xs text-emerald-400 tabular-nums">{activeCount}</span>
            )}
          </button>
          <button
            onClick={() => {
              openOnly('activity')
              toggleActivity()
            }}
            className={`px-2 py-1 border-l border-zinc-700 flex items-center ${
              activityOpen
                ? 'bg-zinc-700 text-zinc-100'
                : 'text-zinc-100 hover:bg-zinc-700'
            }`}
            title="История запросов"
          >
            <History size={14} />
          </button>
        </div>

        <div className="no-drag relative group flex h-full items-center">
          <button
            type="button"
            onClick={() => {
              openOnly('settings')
              toggleScreen('settings')
            }}
            className={`px-2 py-1 rounded text-sm hover:text-zinc-200 hover:bg-zinc-800 ${
              isSettings ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400'
            }`}
            title={isSettings ? 'Закрыть настройки' : 'Настройки'}
            aria-label={isSettings ? 'Закрыть настройки' : 'Открыть настройки'}
          >
            <Settings size={14} />
          </button>

          <div className="absolute right-0 top-full z-50 pt-1 invisible opacity-0 pointer-events-none group-hover:visible group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity">
            <div
              className="flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-950 p-1 shadow-xl"
              role="menu"
              aria-label="Быстрый переход к настройкам"
            >
              {SETTINGS_SECTIONS.map(section => (
                <button
                  key={section.id}
                  type="button"
                  role="menuitem"
                  data-settings-shortcut={section.id}
                  onClick={() => {
                    openOnly('settings')
                    openSettings(section.id)
                  }}
                  className={`w-8 h-8 rounded flex items-center justify-center transition-colors ${
                    isSettings && (screen.payload?.section || 'main') === section.id
                      ? 'bg-zinc-700 text-zinc-100'
                      : 'text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800'
                  }`}
                  title={section.label}
                  aria-label={`Настройки ${section.label}`}
                >
                  {section.platform
                    ? <PlatformLogo platform={section.platform} size={16} />
                    : <Settings size={16} />}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <McpRunningPopover
        open={mcpPopoverOpen}
        onClose={() => setMcpPopoverOpen(false)}
        anchorRef={mcpBtnRef}
        onOpenHistory={() => { setMcpPopoverOpen(false); if (!mcpHistoryOpen) onToggleMcpHistory?.() }}
      />
      <RequestsRunningPopover
        open={requestsPopoverOpen}
        onClose={() => setRequestsPopoverOpen(false)}
        anchorRef={requestsBtnRef}
      />
    </div>
  )
}
