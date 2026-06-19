import OpenAI from 'openai'
import type { Campaign, CampaignStats, CampaignFeedback, Profile } from '@/types'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export interface CampaignFeedbackInput {
  campaign: Pick<Campaign, 'name' | 'goal'>
  stats: CampaignStats
  // A sample of the actual emails sent in this campaign — the model critiques
  // these specifically, so feedback is grounded in what was really sent.
  emailSamples: { subject: string | null; body: string | null }[]
  // Snippets of how recipients actually replied, with their sentiment, so the
  // model can connect copy choices to real reactions for THIS campaign.
  replyExamples: { snippet: string; classification: string | null }[]
  profile?: Profile | null
}

/**
 * Produce specific, actionable coaching for a single campaign, grounded in that
 * campaign's own sent emails and its real response rate. Returns structured
 * feedback so the UI can render it cleanly.
 */
export async function generateCampaignFeedback(
  input: CampaignFeedbackInput
): Promise<CampaignFeedback> {
  const { campaign, stats, emailSamples, replyExamples, profile } = input

  const systemPrompt = `
You are a sharp cold-email coach reviewing ONE outreach campaign for "Founders: Illinois Entrepreneurs", a student entrepreneurship club at UIUC.

You are given a single campaign's goal, its real performance numbers, a sample of the actual emails that were sent in it, and snippets of how recipients replied. Your job is to give feedback that is SPECIFIC TO THIS CAMPAIGN — not generic cold-email tips.

How to think:
- Anchor everything to this campaign's reply rate and goal. A 0% reply rate on a speaker ask needs different advice than a 25% rate that isn't converting to meetings.
- Quote or paraphrase concrete things from the sample emails when praising or critiquing (e.g. "the opening line about X", "the ask in paragraph 2"). Vague advice is useless.
- If reply snippets are provided, connect the copy to the reactions you actually see.
- Be honest but constructive. If the sample is too small to be conclusive, say so and frame advice as hypotheses to test.
- Keep each point tight and immediately actionable. No filler, no "I hope this helps".

Return ONLY valid JSON with this exact shape:
{
  "headline": "<one punchy sentence summarizing how this campaign is doing>",
  "assessment": "<2-3 sentences interpreting the reply rate in the context of this campaign's goal>",
  "strengths": ["<specific thing working in these emails>", ...],
  "improvements": ["<specific, actionable change to try>", ...],
  "next_experiment": "<one concrete experiment to run next on this campaign>"
}
Use 1-4 items each for strengths and improvements.`.trim()

  const userPrompt = buildUserPrompt({ campaign, stats, emailSamples, replyExamples, profile })

  const response = await openai.chat.completions.create({
    model: 'gpt-5.4',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.6,
    max_completion_tokens: 900,
  })

  const raw = response.choices[0].message.content ?? '{}'
  try {
    const parsed = JSON.parse(raw) as Partial<CampaignFeedback>
    if (!parsed.headline || !parsed.assessment) throw new Error('incomplete')
    return {
      headline: parsed.headline.trim(),
      assessment: parsed.assessment.trim(),
      strengths: (parsed.strengths ?? []).map((s) => s.trim()).filter(Boolean),
      improvements: (parsed.improvements ?? []).map((s) => s.trim()).filter(Boolean),
      next_experiment: (parsed.next_experiment ?? '').trim(),
    }
  } catch {
    throw new Error('Failed to generate campaign feedback')
  }
}

function buildUserPrompt(input: CampaignFeedbackInput): string {
  const { campaign, stats, emailSamples, replyExamples, profile } = input
  const parts: string[] = []

  parts.push(`=== CAMPAIGN ===`)
  parts.push(`Name: ${campaign.name}`)
  if (campaign.goal) parts.push(`Goal: ${campaign.goal}`)

  parts.push('', `=== PERFORMANCE ===`)
  parts.push(`Contacts in campaign: ${stats.total_contacts}`)
  parts.push(`Emails sent: ${stats.emails_sent} (to ${stats.contacts_emailed} distinct contacts)`)
  parts.push(`Replies: ${stats.replies} (${stats.positive_replies} positive)`)
  parts.push(`Reply rate: ${stats.reply_rate}% of contacts emailed`)
  parts.push(`Meetings booked: ${stats.meetings}`)

  if (profile?.name) {
    parts.push('', `=== SENDER ===`)
    parts.push(`Name: ${profile.name}`)
    if (profile.role) parts.push(`Role: ${profile.role}`)
  }

  parts.push('', `=== SAMPLE EMAILS SENT IN THIS CAMPAIGN ===`)
  if (emailSamples.length === 0) {
    parts.push('(none captured)')
  } else {
    emailSamples.forEach((e, i) => {
      parts.push(`--- Email ${i + 1} ---`)
      parts.push(`Subject: ${e.subject ?? '(no subject)'}`)
      parts.push((e.body ?? '').slice(0, 1500))
      parts.push('')
    })
  }

  if (replyExamples.length > 0) {
    parts.push('', `=== HOW RECIPIENTS REPLIED ===`)
    replyExamples.forEach((r) => {
      parts.push(`[${r.classification ?? 'unclassified'}] ${r.snippet.slice(0, 400)}`)
    })
  }

  parts.push('', `=== TASK ===`)
  parts.push(
    `Give feedback specific to THIS campaign and its ${stats.reply_rate}% reply rate. Ground every point in the sample emails above. Return the JSON described.`
  )

  return parts.join('\n')
}
