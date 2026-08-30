import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays}d ago`
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`
  return `${Math.floor(diffDays / 365)}y ago`
}

export const STATUS_COLORS: Record<string, string> = {
  discovered:  'bg-violet-100 text-violet-700',
  new:         'bg-gray-100 text-gray-700',
  researching: 'bg-yellow-100 text-yellow-700',
  researched:  'bg-blue-100 text-blue-700',
  drafted:     'bg-purple-100 text-purple-700',
  sent:        'bg-indigo-100 text-indigo-700',
  replied:     'bg-green-100 text-green-700',
  meeting:     'bg-emerald-100 text-emerald-700',
  archived:    'bg-gray-100 text-gray-400',
}

export const CATEGORY_COLORS: Record<string, string> = {
  speaker:   'bg-orange-100 text-orange-700',
  mentor:    'bg-teal-100 text-teal-700',
  recruiter: 'bg-sky-100 text-sky-700',
  investor:  'bg-violet-100 text-violet-700',
  peer:      'bg-pink-100 text-pink-700',
  partner:   'bg-amber-100 text-amber-700',
}

/** Build a follow-up subject line: "Re: <original>", avoiding "Re: Re:" stacking. */
export function followupSubject(original: string | null | undefined): string {
  const base = (original ?? '').replace(/^\s*(re:\s*)+/i, '').trim()
  return base ? `Re: ${base}` : 'Following up'
}

export function relevanceLabel(score: number): string {
  if (score >= 0.85) return 'High'
  if (score >= 0.6) return 'Medium'
  return 'Low'
}

export function relevanceColor(score: number): string {
  if (score >= 0.85) return 'text-emerald-600'
  if (score >= 0.6) return 'text-amber-600'
  return 'text-gray-400'
}
