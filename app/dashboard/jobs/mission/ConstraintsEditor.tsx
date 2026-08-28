'use client'

import type { HardConstraint } from '@/lib/career/types'

const OPERATORS: HardConstraint['operator'][] = ['equals', 'not_equals', 'in', 'not_in', 'contains', 'before', 'after']
const DIMENSIONS = ['employment_type', 'season', 'location_country', 'graduation_window', 'work_mode', 'role_family']
const LIST_OPS: HardConstraint['operator'][] = ['in', 'not_in']

/**
 * Hard constraints are filters, not weights: a job failing one is rejected
 * before fit is ever judged. `in` / `not_in` take a comma-separated list.
 */
export default function ConstraintsEditor({ value, onChange }: { value: HardConstraint[]; onChange: (next: HardConstraint[]) => void }) {
  function update(i: number, patch: Partial<HardConstraint>) {
    onChange(value.map((c, k) => (k === i ? { ...c, ...patch } : c)))
  }
  function valueText(c: HardConstraint): string {
    return Array.isArray(c.value) ? c.value.join(', ') : c.value
  }
  function setValue(i: number, text: string, op: HardConstraint['operator']) {
    update(i, { value: LIST_OPS.includes(op) ? text.split(',').map((s) => s.trim()).filter(Boolean) : text })
  }

  return (
    <div className="space-y-2">
      {value.length === 0 && <p className="text-xs text-slate-400">No hard constraints. The planner still applies the season and internship intent from the mission.</p>}
      {value.map((c, i) => (
        <div key={i} className="grid grid-cols-1 md:grid-cols-[1fr_1fr_1fr_1.5fr_auto] gap-2 items-start rounded-md border border-slate-200 bg-white p-2">
          <input value={c.label} onChange={(e) => update(i, { label: e.target.value })} placeholder="Label (shown in rejections)" className="rounded-md border border-slate-300 px-2 py-1 text-sm" />
          <input list="constraint-dimensions" value={c.dimension} onChange={(e) => update(i, { dimension: e.target.value })} placeholder="dimension" className="rounded-md border border-slate-300 px-2 py-1 text-sm font-mono" />
          <select
            value={c.operator}
            onChange={(e) => {
              const op = e.target.value as HardConstraint['operator']
              update(i, { operator: op })
              setValue(i, valueText(c), op)
            }}
            className="rounded-md border border-slate-300 px-2 py-1 text-sm"
          >
            {OPERATORS.map((o) => (
              <option key={o} value={o}>
                {o.replace('_', ' ')}
              </option>
            ))}
          </select>
          <input value={valueText(c)} onChange={(e) => setValue(i, e.target.value, c.operator)} placeholder={LIST_OPS.includes(c.operator) ? 'a, b, c' : 'value'} className="rounded-md border border-slate-300 px-2 py-1 text-sm" />
          <button type="button" onClick={() => onChange(value.filter((_, k) => k !== i))} className="text-xs text-slate-400 hover:text-rose-600 px-1 py-1" title="Remove">
            ×
          </button>
        </div>
      ))}
      <datalist id="constraint-dimensions">
        {DIMENSIONS.map((d) => (
          <option key={d} value={d} />
        ))}
      </datalist>
      <button
        type="button"
        onClick={() => onChange([...value, { label: '', dimension: 'employment_type', operator: 'equals', value: '' }])}
        className="text-xs text-indigo-600 hover:underline"
      >
        + Add constraint
      </button>
    </div>
  )
}
