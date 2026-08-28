'use client'

import { useState } from 'react'

/**
 * An ordered list of short strings as chips: add with Enter, remove with ×,
 * optional ↑/↓ when order carries meaning (optimize_for is a priority order).
 */
export default function ListEditor({
  label,
  hint,
  value,
  onChange,
  ordered = false,
  placeholder = 'Add and press Enter',
}: {
  label: string
  hint?: string
  value: string[]
  onChange: (next: string[]) => void
  ordered?: boolean
  placeholder?: string
}) {
  const [draft, setDraft] = useState('')

  function add() {
    const v = draft.trim()
    if (!v || value.includes(v)) return setDraft('')
    onChange([...value, v])
    setDraft('')
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir
    if (j < 0 || j >= value.length) return
    const next = [...value]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }

  return (
    <div>
      <label className="block text-xs font-semibold text-slate-600">{label}</label>
      {hint && <p className="text-[11px] text-slate-400 mb-1">{hint}</p>}
      <div className="flex flex-wrap gap-1.5 mb-1.5">
        {value.map((v, i) => (
          <span key={`${v}-${i}`} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border bg-slate-50 border-slate-200 text-slate-700">
            {ordered && <span className="text-slate-400">{i + 1}.</span>}
            {v}
            {ordered && (
              <>
                <button type="button" onClick={() => move(i, -1)} className="text-slate-400 hover:text-slate-700" title="Move up">
                  ↑
                </button>
                <button type="button" onClick={() => move(i, 1)} className="text-slate-400 hover:text-slate-700" title="Move down">
                  ↓
                </button>
              </>
            )}
            <button type="button" onClick={() => onChange(value.filter((_, k) => k !== i))} className="text-slate-400 hover:text-rose-600" title="Remove">
              ×
            </button>
          </span>
        ))}
        {value.length === 0 && <span className="text-xs text-slate-400">none</span>}
      </div>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            add()
          }
        }}
        onBlur={add}
        placeholder={placeholder}
        className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
      />
    </div>
  )
}
