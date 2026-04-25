import React, { useState, useEffect, useRef, useMemo } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

/**
 * Minimal date picker: input + popover.
 *
 *   <DatePicker value="2026-04-21" onChange={iso => …} />
 *
 *   value     — ISO 'YYYY-MM-DD' or '' (empty)
 *   onChange  — receives the same shape
 *   placeholder, ariaLabel — usual input props
 *   presets   — optional [{label, daysAgo}] quick-shortcuts at the bottom
 *
 * Popover layout:
 *   ← month-name year▾ →     (year is a select for fast jumps)
 *   Mon Tue Wed Thu Fri Sat Sun     header
 *   ┌──────────────────────┐
 *   │   1  2  3  4  5  6  7│
 *   │   8  9 10 ...        │      grid 6×7, dimmed days from prev/next month
 *   └──────────────────────┘
 *   [-7 дн]  [-1 мес]  [-1 год]    (optional preset row)
 *   [Сегодня]  [Очистить]
 *
 * Click outside to close. Keyboard ESC to close.
 */
export default function DatePicker({
  value, onChange,
  placeholder = 'дата',
  ariaLabel,
  presets,
  direction = 'down',          // 'down' | 'up' — popover anchor side
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  // The "view" cursor — what month grid we're rendering. Defaults to the
  // selected date's month if value is set, else today.
  const initialView = parseISO(value) || new Date()
  const [viewYear, setViewYear] = useState(initialView.getFullYear())
  const [viewMonth, setViewMonth] = useState(initialView.getMonth())

  // Sync view to value when value changes externally (e.g. preset click).
  useEffect(() => {
    const d = parseISO(value)
    if (d) {
      setViewYear(d.getFullYear())
      setViewMonth(d.getMonth())
    }
  }, [value])

  // Close on outside click / ESC. The mousedown listener is registered
  // *after* the click that opens the popover finishes propagating —
  // otherwise the same physical click that toggles open=true would also
  // close it. We delay attachment by one task via setTimeout(0).
  useEffect(() => {
    if (!open) return
    function onDoc(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    function onKey(e) {
      if (e.key === 'Escape') setOpen(false)
    }
    const tid = setTimeout(() => {
      document.addEventListener('mousedown', onDoc)
    }, 0)
    document.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(tid)
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  function pick(d) {
    onChange(toISO(d))
    setOpen(false)
  }

  function shiftMonth(delta) {
    let m = viewMonth + delta
    let y = viewYear
    if (m < 0)  { m = 11; y -= 1 }
    if (m > 11) { m = 0;  y += 1 }
    setViewMonth(m)
    setViewYear(y)
  }

  const display = formatHuman(value)

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label={ariaLabel}
        className={`bg-zinc-900 border rounded px-2 py-0.5 text-zinc-200 hover:bg-zinc-800 focus:outline-none ${
          open ? 'border-zinc-500' : 'border-zinc-800'
        }`}
        style={{ fontSize: '13px', minWidth: '95px', textAlign: 'left' }}
      >
        {display || <span className="text-zinc-600">{placeholder}</span>}
      </button>
      {open && (
        <CalendarPopover
          viewYear={viewYear}
          viewMonth={viewMonth}
          selectedISO={value}
          onShiftMonth={shiftMonth}
          onSetYear={(y) => setViewYear(y)}
          onPick={pick}
          onClear={() => { onChange(''); setOpen(false) }}
          onToday={() => pick(new Date())}
          presets={presets}
          direction={direction}
        />
      )}
    </div>
  )
}

// ─── popover ────────────────────────────────────────────────────────────

function CalendarPopover({
  viewYear, viewMonth, selectedISO,
  onShiftMonth, onSetYear, onPick, onClear, onToday,
  presets,
  direction = 'down',
}) {
  const cells = useMemo(() => buildMonthGrid(viewYear, viewMonth), [viewYear, viewMonth])
  const today = new Date()
  const todayISO = toISO(today)
  const selDate = parseISO(selectedISO)

  // Year range: ±10 from current to ±50 (cheap, 0.5KB list).
  const thisYear = today.getFullYear()
  const yearOptions = useMemo(() => {
    const arr = []
    for (let y = thisYear - 30; y <= thisYear + 1; y++) arr.push(y)
    return arr
  }, [thisYear])

  return (
    <div
      className={`absolute z-50 bg-zinc-950 border border-zinc-600 rounded-lg p-2 ${
        direction === 'up'
          ? 'bottom-full mb-1 left-0'
          : 'top-full mt-1 left-0'
      }`}
      style={{
        width: 240,
        boxShadow: '0 16px 32px -8px rgba(0,0,0,0.85), 0 4px 12px rgba(0,0,0,0.65)',
      }}
    >
      {/* Header: ← month-name year▾ → */}
      <div className="flex items-center justify-between mb-2 px-1">
        <button
          type="button"
          onClick={() => onShiftMonth(-1)}
          className="w-6 h-6 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100"
          title="Предыдущий месяц"
        ><ChevronLeft size={16} className="mx-auto" /></button>
        <div className="flex items-center gap-1.5">
          <span className="text-zinc-200" style={{ fontSize: '13px' }}>
            {MONTH_NAMES[viewMonth]}
          </span>
          <select
            value={viewYear}
            onChange={e => onSetYear(Number(e.target.value))}
            className="bg-zinc-900 border border-zinc-800 rounded px-1 py-0.5 text-zinc-200 focus:outline-none focus:border-zinc-600"
            style={{ fontSize: '12px' }}
          >
            {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <button
          type="button"
          onClick={() => onShiftMonth(1)}
          className="w-6 h-6 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100"
          title="Следующий месяц"
        ><ChevronRight size={16} className="mx-auto" /></button>
      </div>

      {/* Day-of-week header */}
      <div className="grid grid-cols-7 gap-0.5 mb-1">
        {WEEKDAY_NAMES.map(d => (
          <div
            key={d}
            className="text-center text-zinc-600 tabular-nums uppercase"
            style={{ fontSize: '10px' }}
          >{d}</div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((c, i) => {
          const iso = toISO(c.date)
          const isSel = selDate && iso === selectedISO
          const isToday = iso === todayISO
          return (
            <button
              key={i}
              type="button"
              onClick={() => onPick(c.date)}
              className={`h-7 rounded tabular-nums transition-colors text-center ${
                isSel
                  ? 'bg-emerald-600 text-zinc-50 hover:bg-emerald-500'
                  : isToday
                    ? 'bg-zinc-800 text-zinc-100 hover:bg-zinc-700'
                    : c.outside
                      ? 'text-zinc-700 hover:bg-zinc-900'
                      : 'text-zinc-300 hover:bg-zinc-800'
              }`}
              style={{ fontSize: '12px' }}
            >
              {c.date.getDate()}
            </button>
          )
        })}
      </div>

      {/* Presets */}
      {presets && presets.length > 0 && (
        <div className="flex items-center gap-1 mt-2 pt-2 border-t border-zinc-900">
          {presets.map(p => (
            <button
              key={p.label}
              type="button"
              onClick={() => {
                const d = new Date()
                d.setDate(d.getDate() - (p.daysAgo || 0))
                onPick(d)
              }}
              className="flex-1 px-1 py-0.5 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
              style={{ fontSize: '11px' }}
            >{p.label}</button>
          ))}
        </div>
      )}

      {/* Quick actions */}
      <div className="flex items-center justify-between mt-2 px-0.5">
        <button
          type="button"
          onClick={onToday}
          className="text-zinc-400 hover:text-zinc-100"
          style={{ fontSize: '12px' }}
        >Сегодня</button>
        <button
          type="button"
          onClick={onClear}
          className="text-zinc-500 hover:text-zinc-200"
          style={{ fontSize: '12px' }}
        >Очистить</button>
      </div>
    </div>
  )
}

// ─── helpers ────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
]

const WEEKDAY_NAMES = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']

function pad2(n) { return n < 10 ? `0${n}` : String(n) }

function toISO(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function parseISO(iso) {
  if (!iso) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return null
  const [, y, mo, da] = m
  const d = new Date(Number(y), Number(mo) - 1, Number(da))
  return isNaN(d.getTime()) ? null : d
}

function formatHuman(iso) {
  const d = parseISO(iso)
  if (!d) return ''
  return d.toLocaleDateString('ru-RU', {
    day: 'numeric', month: 'short', year: 'numeric',
  }).replace(/\sг\.$/, '')
}

/**
 * Build the 6×7 grid for the given month.
 * Week starts on Monday (Russian convention).
 * Returns [{date: Date, outside: bool}].
 */
function buildMonthGrid(year, month) {
  const first = new Date(year, month, 1)
  // JS getDay(): 0=Sun..6=Sat — convert to Mon-first index 0=Mon..6=Sun
  const offset = (first.getDay() + 6) % 7
  const start = new Date(year, month, 1 - offset)
  const cells = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    cells.push({ date: d, outside: d.getMonth() !== month })
  }
  return cells
}
