import nodemailer from 'nodemailer'

// Mail is sent from each user's OWN Gmail via OAuth2 (XOAUTH2). The caller mints
// a short-lived access token from the user's stored refresh token (see
// lib/google/oauth.ts) and passes it in as `sender`. A transport is built per
// send because the access token and the From address are per-user.

export interface EmailSender {
  email: string       // the connected Gmail — used as the From address + SMTP user
  name?: string       // display name for the From header
  accessToken: string // fresh Google OAuth access token
}

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

export async function sendEmail(opts: SendEmailOptions, sender: EmailSender): Promise<SendEmailResult> {
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        type: 'OAuth2',
        user: sender.email,
        accessToken: sender.accessToken,
      },
    })

    const htmlBody = plainTextToHtml(opts.body)
    const toAddress = opts.toName ? `${opts.toName} <${opts.to}>` : opts.to
    const from = sender.name ? `${sender.name} <${sender.email}>` : sender.email

    const info = await transporter.sendMail({
      from,
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
