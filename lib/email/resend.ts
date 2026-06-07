import nodemailer from 'nodemailer'

// Gmail SMTP via App Password
// Required env vars:
//   GMAIL_USER        — e.g. zuyu.alex06@gmail.com
//   GMAIL_APP_PASSWORD — 16-char app password from myaccount.google.com/apppasswords
//   FROM_NAME         — display name (optional, defaults to 'Founders Illinois')

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
})

const FROM_NAME = process.env.FROM_NAME ?? 'Founders Illinois'
const FROM_EMAIL = process.env.GMAIL_USER ?? ''
const FROM = `${FROM_NAME} <${FROM_EMAIL}>`

export interface SendEmailOptions {
  to: string
  toName?: string
  subject: string
  body: string        // plain text — wrapped in HTML for sending
  replyTo?: string
  scheduledAt?: string // ISO string — not natively supported by SMTP; ignored here
  inReplyTo?: string  // Message-ID of the email this is a reply to (Gmail threading)
  references?: string // Message-ID chain — usually the same as inReplyTo for a single-level thread
}

export interface SendEmailResult {
  messageId: string
  error?: string
}

export async function sendEmail(opts: SendEmailOptions): Promise<SendEmailResult> {
  try {
    const htmlBody = plainTextToHtml(opts.body)
    const toAddress = opts.toName ? `${opts.toName} <${opts.to}>` : opts.to

    const info = await transporter.sendMail({
      from: FROM,
      to: toAddress,
      subject: opts.subject,
      text: opts.body,
      html: htmlBody,
      ...(opts.replyTo && { replyTo: opts.replyTo }),
      ...(opts.inReplyTo && { inReplyTo: opts.inReplyTo }),
      ...(opts.references && { references: opts.references }),
    })

    return { messageId: info.messageId }
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
      html: `<a href="${url}" style="color:#4f46e5;text-decoration:none">${linkText}</a>`,
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

  const paragraphs = processedText
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

/** Stub — only needed if you use Resend webhooks. Safe to ignore with Gmail. */
export function verifyWebhookSignature(
  _payload: string,
  _signature: string,
  _secret: string
): boolean {
  return false
}
