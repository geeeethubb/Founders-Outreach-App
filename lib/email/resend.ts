import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)

// Note: On Resend free tier, FROM_EMAIL must be onboarding@resend.dev until you verify a domain.
// Once you verify a domain at resend.com/domains, update FROM_EMAIL in .env.local.
const FROM = `${process.env.FROM_NAME ?? 'Founders Illinois'} <${process.env.FROM_EMAIL ?? 'onboarding@resend.dev'}>`

export interface SendEmailOptions {
  to: string
  toName?: string
  subject: string
  body: string         // plain text — we'll wrap in simple HTML
  replyTo?: string
  scheduledAt?: string // ISO string for scheduled sends
}

export interface SendEmailResult {
  messageId: string
  error?: string
}

export async function sendEmail(opts: SendEmailOptions): Promise<SendEmailResult> {
  const htmlBody = plainTextToHtml(opts.body)

  const payload: Parameters<typeof resend.emails.send>[0] = {
    from: FROM,
    to: opts.toName ? `${opts.toName} <${opts.to}>` : opts.to,
    subject: opts.subject,
    text: opts.body,
    html: htmlBody,
    ...(opts.replyTo && { replyTo: opts.replyTo }),
    ...(opts.scheduledAt && { scheduledAt: opts.scheduledAt }),
  }

  const { data, error } = await resend.emails.send(payload)

  if (error || !data) {
    return { messageId: '', error: error?.message ?? 'Unknown send error' }
  }

  return { messageId: data.id }
}

/** Convert a plain-text email body to clean HTML */
function plainTextToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  const paragraphs = escaped
    .split('\n\n')
    .map((p) => `<p style="margin:0 0 16px 0;line-height:1.6">${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n')

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;color:#1a1a1a;max-width:600px;margin:0 auto;padding:32px 16px">
${paragraphs}
</body>
</html>`
}

/** Verify Resend webhook signature */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  // Resend uses svix for webhook signatures
  // For production, use the svix library: https://docs.svix.com/receiving/verifying-payloads
  // For now, a basic HMAC check
  try {
    const crypto = require('crypto') as typeof import('crypto')
    const hmac = crypto.createHmac('sha256', secret)
    hmac.update(payload)
    const expected = `v1,${hmac.digest('base64')}`
    return expected === signature
  } catch {
    return false
  }
}
