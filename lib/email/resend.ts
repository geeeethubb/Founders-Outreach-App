import crypto from 'crypto'
import MailComposer from 'nodemailer/lib/mail-composer'

// Mail is sent from each user's OWN Gmail via the Gmail API (users.messages.send)
// using their OAuth2 access token. We deliberately use the API rather than SMTP:
// SMTP/XOAUTH2 requires the full https://mail.google.com/ mailbox scope, whereas
// the Gmail API send endpoint works with the minimal `gmail.send` scope we
// request — matching the "we only send, never read your inbox" promise.
// The caller mints a short-lived access token from the user's stored refresh
// token (see lib/google/oauth.ts) and passes it in as `sender`.

const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'

export interface EmailSender {
  email: string       // the connected Gmail — used as the From address
  name?: string       // display name for the From header
  accessToken: string // fresh Google OAuth access token
}

export interface SendEmailOptions {
  to: string
  toName?: string
  subject: string
  body: string        // plain text — wrapped in HTML for sending
  replyTo?: string
  scheduledAt?: string // ISO string — not natively supported here; ignored
  inReplyTo?: string  // Message-ID of the email this is a reply to (Gmail threading)
  references?: string // Message-ID chain — usually the same as inReplyTo for a single-level thread
  threadId?: string   // Gmail thread id — keeps the sent message in that exact thread
}

export interface SendEmailResult {
  messageId: string
  threadId?: string        // Gmail-assigned thread id — used to sync replies later
  error?: string
}

export async function sendEmail(opts: SendEmailOptions, sender: EmailSender): Promise<SendEmailResult> {
  try {
    const htmlBody = plainTextToHtml(opts.body)
    const toAddress = opts.toName ? `${opts.toName} <${opts.to}>` : opts.to
    const from = sender.name ? `${sender.name} <${sender.email}>` : sender.email

    // Set our own Message-ID so we can store it and thread follow-ups off it.
    const domain = sender.email.split('@')[1] || 'mail.gmail.com'
    const messageId = `<${crypto.randomBytes(16).toString('hex')}.${Date.now()}@${domain}>`

    // Build a proper MIME message (multipart text+html, headers) without sending.
    const mail = new MailComposer({
      from,
      to: toAddress,
      subject: opts.subject,
      text: opts.body,
      html: htmlBody,
      messageId,
      ...(opts.replyTo && { replyTo: opts.replyTo }),
      ...(opts.inReplyTo && { inReplyTo: opts.inReplyTo }),
      ...(opts.references && { references: opts.references }),
    })

    const raw: Buffer = await new Promise((resolve, reject) => {
      mail.compile().build((err, message) => (err ? reject(err) : resolve(message)))
    })

    // Gmail API wants the raw RFC 822 message base64url-encoded.
    const encoded = raw
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

    const res = await fetch(GMAIL_SEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sender.accessToken}`,
        'Content-Type': 'application/json',
      },
      // Passing threadId keeps a reply inside the original Gmail thread (the
      // In-Reply-To/References headers must also point at a message in it).
      body: JSON.stringify({ raw: encoded, ...(opts.threadId && { threadId: opts.threadId }) }),
    })

    if (!res.ok) {
      const detail = await res.text()
      return { messageId: '', error: `Gmail API error (${res.status}): ${detail.slice(0, 300)}` }
    }

    // Gmail returns the created message: { id, threadId, ... }. We keep the
    // threadId so reply-sync can list this conversation's later messages.
    const sent = (await res.json().catch(() => ({}))) as { threadId?: string }
    return { messageId, threadId: sent.threadId }
  } catch (e) {
    return {
      messageId: '',
      error: e instanceof Error ? e.message : 'Unknown send error',
    }
  }
}

/** Convert a plain-text email body to clean HTML, with markdown link support */
function plainTextToHtml(text: string): string {
  // Extract markdown links before escaping so we can restore them as <a> tags
  const linkPlaceholders: Array<{ placeholder: string; html: string }> = []
  let processedText = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, linkText, url) => {
    const placeholder = `\x00LINK${linkPlaceholders.length}\x00`
    linkPlaceholders.push({
      placeholder,
      html: `<a href="${url}" style="color:#1a73e8;text-decoration:underline">${linkText}</a>`,
    })
    return placeholder
  })

  // Escape HTML special chars
  processedText = processedText
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // Restore link placeholders as real <a> tags
  for (const { placeholder, html } of linkPlaceholders) {
    processedText = processedText.replace(placeholder, html)
  }

  // Render like a normal, hand-written Gmail message: left-aligned, no centered
  // page container, no large padding. Just paragraphs in a plain text block.
  const paragraphs = processedText
    .split('\n\n')
    .map((p) => `<p style="margin:0 0 14px 0">${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n')

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0">
<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222">
${paragraphs}
</div>
</body>
</html>`
}

/** Stub — only needed if you use Resend webhooks. Safe to ignore with Gmail. */
export function verifyWebhookSignature(
  _payload: string,
  _signature: string,
  _secret: string
): boolean {
  return false
}
