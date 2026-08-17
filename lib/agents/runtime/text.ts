// Normalization for strings that came out of a model.
//
// Models occasionally emit the LITERAL text `—` instead of an em dash,
// because their output is JSON-shaped and the escape survives one decoding too
// few. It is harmless in a log and embarrassing in an email or a UI panel, and
// it showed up verbatim in the first network-retrieval eval report.
//
// Decoding is deliberately narrow: only well-formed \uXXXX sequences, and only
// into printable characters. It is not a general unescaper.

const ESCAPE = /\\u([0-9a-fA-F]{4})/g

export function normalizeModelText(value: unknown): string {
  const s = String(value ?? '')
  if (!s.includes('\\u')) return s.trim()
  return s
    .replace(ESCAPE, (match, hex: string) => {
      const code = parseInt(hex, 16)
      // Control characters stay escaped — turning one into a real control char
      // is how a stray newline ends up inside a subject line.
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return match
      return String.fromCharCode(code)
    })
    .trim()
}
