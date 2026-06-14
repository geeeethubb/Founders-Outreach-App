'use client'

import { forwardRef, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react'
import { renderEmailBody } from '@/lib/email/format'

export interface RichTextEditorHandle {
  /** Insert text at the current caret (used for AI placeholder chips). */
  insertAtCursor: (text: string) => void
}

interface Props {
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  rows?: number
  placeholder?: string
  /** Tailwind classes merged onto the textarea (font, size, etc). */
  textareaClassName?: string
}

/**
 * A Gmail-style email editor: a formatting toolbar (bold, italic, link, bullet
 * list) over a plain textarea, plus a live preview. The toolbar writes our
 * lightweight markup (**bold**, *italic*, [text](url), "- item") into the text;
 * the same renderEmailBody() that sends the email powers the preview, so what
 * you see is what the recipient gets.
 */
export const RichTextEditor = forwardRef<RichTextEditorHandle, Props>(function RichTextEditor(
  { value, onChange, onBlur, rows = 14, placeholder, textareaClassName = '' },
  ref
) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [showPreview, setShowPreview] = useState(false)

  useImperativeHandle(ref, () => ({
    insertAtCursor(text: string) {
      const ta = taRef.current
      if (!ta) return
      const { selectionStart: s, selectionEnd: e } = ta
      onChange(value.slice(0, s) + text + value.slice(e))
      queueCaret(s + text.length, s + text.length)
    },
  }), [value, onChange])

  /** Restore focus + caret after React re-renders the textarea. */
  function queueCaret(start: number, end: number) {
    setTimeout(() => {
      const ta = taRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(start, end)
    }, 0)
  }

  /** Wrap the current selection in `marker` (e.g. ** for bold). */
  function wrap(marker: string) {
    const ta = taRef.current
    if (!ta) return
    const { selectionStart: s, selectionEnd: e } = ta
    const sel = value.slice(s, e)
    onChange(value.slice(0, s) + marker + sel + marker + value.slice(e))
    if (sel) {
      queueCaret(s + marker.length, e + marker.length) // keep text selected
    } else {
      queueCaret(s + marker.length, s + marker.length) // caret between markers
    }
  }

  function insertLink() {
    const ta = taRef.current
    if (!ta) return
    const { selectionStart: s, selectionEnd: e } = ta
    const sel = value.slice(s, e)
    const url = window.prompt('Link URL', 'https://')
    if (!url) return
    const label = sel || 'link text'
    const md = `[${label}](${url})`
    onChange(value.slice(0, s) + md + value.slice(e))
    // Select the label so the user can immediately retype it if it was a default.
    queueCaret(s + 1, s + 1 + label.length)
  }

  /** Toggle bullets on the line(s) the selection touches. */
  function toggleBullets() {
    const ta = taRef.current
    if (!ta) return
    const { selectionStart: s, selectionEnd: e } = ta
    const lineStart = value.lastIndexOf('\n', s - 1) + 1
    let lineEnd = value.indexOf('\n', e)
    if (lineEnd === -1) lineEnd = value.length
    const lines = value.slice(lineStart, lineEnd).split('\n')
    const allBulleted = lines.every((l) => l.trim() === '' || /^\s*[-*]\s+/.test(l))
    const next = lines
      .map((l) => {
        if (l.trim() === '') return l
        return allBulleted ? l.replace(/^(\s*)[-*]\s+/, '$1') : `- ${l}`
      })
      .join('\n')
    onChange(value.slice(0, lineStart) + next + value.slice(lineEnd))
    queueCaret(lineStart, lineStart + next.length)
  }

  function onKeyDown(ev: KeyboardEvent<HTMLTextAreaElement>) {
    if (!(ev.metaKey || ev.ctrlKey)) return
    const key = ev.key.toLowerCase()
    if (key === 'b') { ev.preventDefault(); wrap('**') }
    else if (key === 'i') { ev.preventDefault(); wrap('*') }
    else if (key === 'k') { ev.preventDefault(); insertLink() }
  }

  const btn = 'h-8 min-w-8 px-2 flex items-center justify-center rounded text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition-colors text-sm'

  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-indigo-500">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-slate-100 bg-slate-50">
        <button type="button" onClick={() => wrap('**')} title="Bold (Ctrl/⌘+B)" className={`${btn} font-bold`}>B</button>
        <button type="button" onClick={() => wrap('*')} title="Italic (Ctrl/⌘+I)" className={`${btn} italic font-serif`}>I</button>
        <button type="button" onClick={insertLink} title="Insert link (Ctrl/⌘+K)" className={btn}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 010 5.656l-3 3a4 4 0 01-5.656-5.656l1.5-1.5m6.656-1.328a4 4 0 010-5.656l3-3a4 4 0 015.656 5.656l-1.5 1.5" />
          </svg>
        </button>
        <button type="button" onClick={toggleBullets} title="Bulleted list" className={btn}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h.01M4 12h.01M4 18h.01M8 6h12M8 12h12M8 18h12" />
          </svg>
        </button>
        <div className="ml-auto">
          <button
            type="button"
            onClick={() => setShowPreview((p) => !p)}
            className={`${btn} gap-1.5 ${showPreview ? 'bg-indigo-100 text-indigo-700 hover:bg-indigo-100' : ''}`}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
            {showPreview ? 'Edit' : 'Preview'}
          </button>
        </div>
      </div>

      {showPreview ? (
        <div
          className="px-3 py-2.5 text-sm text-slate-700 leading-relaxed min-h-[120px] email-preview"
          style={{ minHeight: `${rows * 1.4}rem` }}
          dangerouslySetInnerHTML={{ __html: renderEmailBody(value) || '<p style="color:#94a3b8">Nothing to preview yet…</p>' }}
        />
      ) : (
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
          rows={rows}
          placeholder={placeholder}
          className={`w-full px-3 py-2.5 text-sm leading-relaxed resize-none focus:outline-none ${textareaClassName}`}
        />
      )}
    </div>
  )
})
