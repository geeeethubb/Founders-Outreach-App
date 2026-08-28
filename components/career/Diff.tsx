'use client'

import type { ReactNode } from 'react'

/**
 * Renders `**bold**` spans as <strong>. Bullets in the Evidence Bank carry
 * emphasis this way (ResumeBullet.text), and the tailor proposes text in the
 * same notation, so the diff must show exactly what the document will bold.
 * Deterministic and dependency-free: no markdown library for one marker.
 */
export function Bold({ text }: { text: string | null | undefined }) {
  if (!text) return null
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('**') && p.endsWith('**') && p.length > 4 ? (
          <strong key={i} className="font-semibold text-slate-900">
            {p.slice(2, -2)}
          </strong>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  )
}

/** Side-by-side original / proposed. Either side may be absent (a new bullet has no original; a removal no proposal). */
export default function Diff({
  original,
  proposed,
  originalLabel = 'Original',
  proposedLabel = 'Proposed',
}: {
  original: string | null | undefined
  proposed: string | null | undefined
  originalLabel?: string
  proposedLabel?: string
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <Side label={originalLabel} tone="slate">
        {original ? <Bold text={original} /> : <em className="text-slate-400">(none — new bullet)</em>}
      </Side>
      <Side label={proposedLabel} tone="indigo">
        {proposed ? <Bold text={proposed} /> : <em className="text-slate-400">(removed)</em>}
      </Side>
    </div>
  )
}

function Side({ label, tone, children }: { label: string; tone: 'slate' | 'indigo'; children: ReactNode }) {
  const cls = tone === 'indigo' ? 'border-indigo-200 bg-indigo-50/40' : 'border-slate-200 bg-slate-50'
  return (
    <div className={`rounded-md border px-3 py-2 ${cls}`}>
      <div className="text-[10px] uppercase tracking-wide font-semibold text-slate-500 mb-1">{label}</div>
      <p className="text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">{children}</p>
    </div>
  )
}
