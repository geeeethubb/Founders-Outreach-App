// The mission's stated direction, sanitized. Pure — no database import — so the
// Jobs page (a client component) can share the cap with the store.

/** Direction text is free prose; it is trimmed, single-spaced and capped, never rewritten. */
export const MAX_DIRECTION_CHARS = 1500

/**
 * Trim, collapse whitespace, cap at MAX_DIRECTION_CHARS *code points* (a
 * UTF-16 slice can split a surrogate pair and store a lone surrogate, which
 * is not well-formed JSON for Postgres), null when empty or not a string.
 */
export function sanitizeDirection(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const collapsed = v.replace(/\s+/g, ' ').trim()
  const text = Array.from(collapsed).slice(0, MAX_DIRECTION_CHARS).join('').trim()
  return text.length ? text : null
}
