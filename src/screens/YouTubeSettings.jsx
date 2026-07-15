import React from 'react'
import Checkbox from '../components/Checkbox'
import Select from '../components/Select'
import { useAppSettingsSection } from '../lib/appSettings'

const DEFAULTS = {
  preferred_lang: 'ru',
  engine: 'gemini',
  with_comments: false,
  target: 'aistudio',
  system_instruction: '',
  post_system_instruction: '',
  model_title: 'Gemini 3 Flash Preview',
  post_model_title: 'Gemini 3.1 Pro Preview',
  claude_project: '',
  claude_post_project: '',
  claude_model: 'Opus 4.7',
  claude_adaptive_thinking: true,
  chatgpt_mode: 'chat',
  chatgpt_prompt: 'перескажи кратко',
  chatgpt_chat_model: '5.5',
  chatgpt_chat_effort: 'xhigh',
  chatgpt_work_model: '5.5',
  chatgpt_work_effort: 'xhigh',
}

const TARGETS = [
  { id: 'aistudio', label: 'Gemini Studio' },
  { id: 'claude', label: 'Claude' },
  { id: 'chatgpt', label: 'ChatGPT' },
]

const GPT_MODELS = [
  { id: '5.5', label: 'GPT-5.5' },
  { id: '5.4', label: 'GPT-5.4' },
  { id: '5.3', label: 'GPT-5.3' },
  { id: '5.2', label: 'GPT-5.2' },
  { id: '4.5', label: 'GPT-4.5' },
  { id: 'o3', label: 'o3' },
]

const GPT_EFFORTS = [
  { id: 'xhigh', label: 'Очень высокий' },
  { id: 'high', label: 'Высокий' },
  { id: 'medium', label: 'Средний' },
  { id: 'instant', label: 'Мгновенный' },
  { id: 'pro', label: 'Pro стандартный' },
  { id: 'pro-extended', label: 'Pro расширенный' },
]

export default function YouTubeSettings() {
  const state = useAppSettingsSection('youtube')
  const settings = { ...DEFAULTS, ...(state.value || {}) }

  function setLocal(key, value) {
    state.setValue(prev => ({ ...(prev || {}), [key]: value }))
  }

  function saveText(key) {
    const value = state.value?.[key]
    state.patch({ [key]: typeof value === 'string' ? value : '' })
  }

  if (state.loading && !state.value) return <Loading />

  const gptMode = settings.chatgpt_mode === 'work' ? 'work' : 'chat'
  const modelKey = gptMode === 'work' ? 'chatgpt_work_model' : 'chatgpt_chat_model'
  const effortKey = gptMode === 'work' ? 'chatgpt_work_effort' : 'chatgpt_chat_effort'

  return (
    <div>
      <SaveState saving={state.saving} error={state.error} />

      <Section title="Субтитры">
        <SettingsCard>
          <ControlRow label="Предпочитаемый язык" hint="Сначала ищем субтитры на этом языке, затем пробуем запасные.">
            <div className="w-56" data-setting="youtube-language">
              <Select compact hideHint value={settings.preferred_lang} onChange={v => state.patch({ preferred_lang: v })} options={[
                { id: 'ru', label: 'Русский' },
                { id: 'en', label: 'English' },
              ]} />
            </div>
          </ControlRow>
          <ControlRow label="Если субтитров нет" hint="Движок для расшифровки звука.">
            <div className="w-56" data-setting="youtube-engine">
              <Select compact hideHint value={settings.engine} onChange={v => state.patch({ engine: v })} options={[
                { id: 'gemini', label: 'Gemini' },
                { id: 'assemblyai', label: 'AssemblyAI' },
              ]} />
            </div>
          </ControlRow>
          <ControlRow label="Комментарии" hint="Добавлять комментарии к тексту перед отправкой в AI.">
            <Checkbox checked={!!settings.with_comments} onChange={v => state.patch({ with_comments: v })} label="Добавлять по умолчанию" />
          </ControlRow>
        </SettingsCard>
      </Section>

      <Section title="AI parsing">
        <SettingsCard>
          <ControlRow label="Куда отправлять" hint="Обычное нажатие «+ AI» использует выбранный сервис.">
            <div className="w-56" data-setting="youtube-target">
              <Select compact hideHint value={settings.target} onChange={v => state.patch({ target: v })} options={TARGETS} />
            </div>
          </ControlRow>
        </SettingsCard>

        {settings.target === 'aistudio' && (
          <TargetCard title="Gemini Studio">
            <TextSetting label="Системная инструкция" value={settings.system_instruction} onChange={v => setLocal('system_instruction', v)} onBlur={() => saveText('system_instruction')} rows={4} />
            <SelectSetting label="Модель" value={settings.model_title} onChange={v => state.patch({ model_title: v })} options={[
              { id: 'Gemini 3 Flash Preview', label: 'Gemini 3 Flash Preview' },
              { id: 'Gemini 3.1 Pro Preview', label: 'Gemini 3.1 Pro Preview' },
            ]} />
            <SelectSetting label="Модель после отправки" value={settings.post_model_title} onChange={v => state.patch({ post_model_title: v })} options={[
              { id: '', label: 'Не переключать' },
              { id: 'Gemini 3 Flash Preview', label: 'Gemini 3 Flash Preview' },
              { id: 'Gemini 3.1 Pro Preview', label: 'Gemini 3.1 Pro Preview' },
            ]} />
            <TextSetting label="Инструкция после отправки" value={settings.post_system_instruction} onChange={v => setLocal('post_system_instruction', v)} onBlur={() => saveText('post_system_instruction')} rows={3} />
          </TargetCard>
        )}

        {settings.target === 'claude' && (
          <TargetCard title="Claude">
            <TextSetting label="Проект" value={settings.claude_project} onChange={v => setLocal('claude_project', v)} onBlur={() => saveText('claude_project')} placeholder="Название проекта; пусто — обычный чат" />
            <TextSetting label="Проект для следующего видео" value={settings.claude_post_project} onChange={v => setLocal('claude_post_project', v)} onBlur={() => saveText('claude_post_project')} placeholder="Пусто — не переключать" />
            <SelectSetting label="Модель" value={settings.claude_model} onChange={v => state.patch({ claude_model: v })} options={[
              { id: 'Opus 4.7', label: 'Opus 4.7' },
              { id: 'Sonnet 4.6', label: 'Sonnet 4.6' },
              { id: 'Haiku 4.5', label: 'Haiku 4.5' },
            ]} />
            <ControlRow label="Рассуждение" hint="Использовать адаптивное рассуждение Claude.">
              <Checkbox checked={!!settings.claude_adaptive_thinking} onChange={v => state.patch({ claude_adaptive_thinking: v })} label="Включено" />
            </ControlRow>
          </TargetCard>
        )}

        {settings.target === 'chatgpt' && (
          <TargetCard title="ChatGPT">
            <div className="px-4 py-3 border-b border-zinc-900">
              <div className="text-sm text-zinc-400 mb-2">Режим по умолчанию</div>
              <div className="inline-flex rounded-md border border-zinc-800 bg-zinc-950 p-1">
                {[
                  { id: 'chat', label: 'Chat' },
                  { id: 'work', label: 'Work' },
                ].map(mode => (
                  <button
                    key={mode.id}
                    data-chatgpt-mode={mode.id}
                    type="button"
                    onClick={() => state.patch({ chatgpt_mode: mode.id })}
                    className={`min-w-24 rounded px-4 py-1.5 text-sm ${
                      gptMode === mode.id
                        ? 'bg-zinc-700 text-zinc-100'
                        : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-900'
                    }`}
                  >{mode.label}</button>
                ))}
              </div>
            </div>
            <TextSetting label="Промпт перед транскриптом" value={settings.chatgpt_prompt} onChange={v => setLocal('chatgpt_prompt', v)} onBlur={() => saveText('chatgpt_prompt')} rows={4} />
            <SelectSetting settingId="chatgpt-model" label={`Модель · ${gptMode === 'work' ? 'Work' : 'Chat'}`} value={settings[modelKey]} onChange={v => state.patch({ [modelKey]: v })} options={GPT_MODELS} />
            <SelectSetting settingId="chatgpt-effort" label={`Интеллект · ${gptMode === 'work' ? 'Work' : 'Chat'}`} value={settings[effortKey]} onChange={v => state.patch({ [effortKey]: v })} options={GPT_EFFORTS} />
          </TargetCard>
        )}
      </Section>
    </div>
  )
}

function Loading() {
  return <div className="text-zinc-500 italic text-sm py-4">Загрузка настроек YouTube…</div>
}

function SaveState({ saving, error }) {
  if (!saving && !error) return null
  return (
    <div className={`mb-4 text-sm ${error ? 'text-red-300' : 'text-zinc-500'}`}>
      {error || 'Сохраняю…'}
    </div>
  )
}

function Section({ title, children }) {
  return (
    <section className="mb-8">
      <h2 className="text-zinc-200 font-medium mb-3">{title}</h2>
      {children}
    </section>
  )
}

function SettingsCard({ children }) {
  return <div className="rounded-md border border-zinc-800 bg-zinc-950 divide-y divide-zinc-900">{children}</div>
}

function TargetCard({ title, children }) {
  return (
    <div className="mt-4 rounded-md border border-zinc-800 bg-zinc-950 divide-y divide-zinc-900 overflow-visible">
      <div className="px-4 py-3 font-medium text-zinc-200 text-sm">{title}</div>
      {children}
    </div>
  )
}

function ControlRow({ label, hint, children }) {
  return (
    <div className="px-4 py-3 flex items-center gap-6 min-h-16">
      <div className="flex-1 min-w-0">
        <div className="text-zinc-200 text-sm">{label}</div>
        {hint && <div className="text-zinc-500 text-xs mt-1">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function SelectSetting({ settingId, label, value, onChange, options }) {
  return (
    <ControlRow label={label}>
      <div className="w-64" data-setting={settingId}><Select compact hideHint value={value} onChange={onChange} options={options} /></div>
    </ControlRow>
  )
}

function TextSetting({ label, value, onChange, onBlur, rows = 1, placeholder = '' }) {
  const common = 'w-full bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500'
  return (
    <div className="px-4 py-3">
      <label className="block text-sm text-zinc-300 mb-2">{label}</label>
      {rows > 1 ? (
        <textarea rows={rows} value={value || ''} onChange={e => onChange(e.target.value)} onBlur={onBlur} placeholder={placeholder} className={`${common} resize-y`} />
      ) : (
        <input value={value || ''} onChange={e => onChange(e.target.value)} onBlur={onBlur} placeholder={placeholder} className={common} />
      )}
    </div>
  )
}
