import OpenAI from 'openai'
import type { ReplyClassification } from '@/types'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export interface ClassifyResult {
  classification: ReplyClassification
  intent: 'meeting_request' | 'more_info' | 'decline' | 'auto_reply' | 'referral' | 'other'
  next_action: 'schedule_call' | 'send_info' | 'follow_up_3d' | 'close' | 'none'
  summary: string
}

export async function classifyReply(replyBody: string): Promise<ClassifyResult> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4.1-mini', // cheap + fast for classification
    messages: [
      {
        role: 'system',
        content: `You classify email replies for a university entrepreneurship club outreach system.

Return ONLY valid JSON:
{
  "classification": "positive|negative|neutral|auto_reply|bounce",
  "intent": "meeting_request|more_info|decline|auto_reply|referral|other",
  "next_action": "schedule_call|send_info|follow_up_3d|close|none",
  "summary": "One sentence summary of the reply"
}

Classification guide:
- positive: interested, wants to meet, asks questions, agrees to help
- negative: explicit decline, not interested, too busy permanently
- neutral: acknowledges but non-committal, asks to follow up later
- auto_reply: OOO, vacation, automated response
- bounce: delivery failure`,
      },
      {
        role: 'user',
        content: `Classify this reply:\n\n${replyBody.slice(0, 1000)}`,
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
    max_tokens: 200,
  })

  try {
    return JSON.parse(response.choices[0].message.content ?? '{}') as ClassifyResult
  } catch {
    return {
      classification: 'neutral',
      intent: 'other',
      next_action: 'none',
      summary: 'Could not parse reply',
    }
  }
}
