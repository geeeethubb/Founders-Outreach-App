// Shared Gmail read helpers — parsing message payloads and fetching threads.
// Used by reply-sync (lib/email/sync.ts) and the conversation thread view.

export interface GmailHeader { name: string; value: string }
export interface GmailPart {
  mimeType?: string
  body?: { data?: string }
  parts?: GmailPart[]
  headers?: GmailHeader[]
}
export interface GmailMessage {
  id: string
  internalDate?: string
  snippet?: string
  payload?: GmailPart
}
export interface GmailThread {
  id: string
  messages?: GmailMessage[]
}

const threadUrl = (id: string) =>
  `https://gmail.googleapis.com/gmail/v1/users/me/threads/${id}?format=full`

/** Fetch a full Gmail thread. Returns null on any API error (caller decides). */
export async function fetchThread(accessToken: string, threadId: string): Promise<GmailThread | null> {
  const res = await fetch(threadUrl(threadId), {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    console.error(`[gmail] thread ${threadId} fetch failed: ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300))
    return null
  }
  return (await res.json()) as GmailThread
}

export function headerValue(m: GmailMessage, name: string): string {
  const headers = m.payload?.headers ?? []
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

export interface ThreadTurn {
  id: string
  direction: 'inbound' | 'outbound'
  fromName: string
  fromEmail: string
  subject: string
  date: string | null
  body: string
}

export interface ThreadView {
  turns: ThreadTurn[]
  lastMessageId: string | null  // RFC822 Message-ID of the newest message (for In-Reply-To)
  lastSubject: string | null
}

/** Fetch a thread and shape it for display + reply threading. Newest turn last. */
export async function getThreadView(
  accessToken: string,
  threadId: string,
  ownEmail: string
): Promise<ThreadView | null> {
  const thread = await fetchThread(accessToken, threadId)
  if (!thread) return null

  const own = ownEmail.toLowerCase()
  const msgs = (thread.messages ?? [])
    .slice()
    .sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0))

  const turns: ThreadTurn[] = msgs.map((m) => {
    const { name, email } = parseAddress(headerValue(m, 'From'))
    return {
      id: m.id,
      direction: email && email === own ? 'outbound' : 'inbound',
      fromName: name || email,
      fromEmail: email,
      subject: headerValue(m, 'Subject'),
      date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null,
      body: extractPlainText(m),
    }
  })

  const last = msgs[msgs.length - 1]
  return {
    turns,
    lastMessageId: last ? headerValue(last, 'Message-ID') || null : null,
    lastSubject: last ? headerValue(last, 'Subject') : null,
  }
}

/** Parse a "Display Name <email>" header into its parts. */
export function parseAddress(raw: string): { name: string; email: string } {
  const match = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/)
  if (match) return { name: match[1].trim(), email: match[2].trim().toLowerCase() }
  return { name: '', email: raw.trim().toLowerCase() }
}

function decodeB64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}

/** Best plain-text rendering of a Gmail message, with the quoted reply trimmed. */
export function extractPlainText(m: GmailMessage): string {
  const payload = m.payload
  if (!payload) return m.snippet ?? ''

  const plain = findPart(payload, 'text/plain')
  if (plain?.body?.data) return stripQuoted(decodeB64Url(plain.body.data))

  const html = findPart(payload, 'text/html')
  if (html?.body?.data) return stripQuoted(htmlToText(decodeB64Url(html.body.data)))

  if (payload.body?.data) return stripQuoted(decodeB64Url(payload.body.data))
  return m.snippet ?? ''
}

function findPart(part: GmailPart, mime: string): GmailPart | null {
  if (part.mimeType === mime && part.body?.data) return part
  for (const p of part.parts ?? []) {
    const found = findPart(p, mime)
    if (found) return found
  }
  return null
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|br|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Drop the quoted "On … wrote:" history so we keep just the new reply text. */
function stripQuoted(text: string): string {
  const lines = text.split('\n')
  const kept: string[] = []
  for (const line of lines) {
    const t = line.trim()
    if (/^On .+wrote:$/.test(t)) break
    if (/^-{3,}\s*Original Message\s*-{3,}/i.test(t)) break
    if (/^From:\s.+/.test(t) && kept.some((l) => l.trim() !== '')) break
    kept.push(line)
  }
  const result = kept.join('\n').trim()
  return result || text.trim()
}
