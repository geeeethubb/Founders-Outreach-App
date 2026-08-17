// Outreach prompt. Bump `version` on ANY semantic change (ADR-009).
//
// TWO MODES, ONE AGENT.
//
//   BRIEF MODE      No campaign reference. The house style from PRODUCT.md §9,
//                   unchanged from 1.5.0 — this is what every existing draft was
//                   written with, and it still works.
//
//   REFERENCE MODE  The campaign carries a real email the user wrote. That email
//                   outranks every generic style instruction here, including the
//                   length band, including the one-ask rule.
//
// Why the reference outranks the house style: the house style is a set of
// adjectives, and adjectives compound. "Confident" plus "concise" plus
// "high-signal" plus "founder-to-founder" reliably produced drafts that were
// arrogant and over-compressed — a voice belonging to nobody, that the user then
// rewrote by hand every time. A real email is evidence about a real person, and
// evidence beats adjectives.

import type { VersionedPrompt } from '../runtime/types'
import type { ReferenceStyle } from '../style-analyst'
import { renderStyle } from '../style-analyst'

export interface OutreachReference {
  campaignName: string
  campaignGoal: string | null
  targetAudience: string | null
  notes: string | null
  subject: string | null
  body: string
  style: ReferenceStyle
}

export interface OutreachInput {
  mission: { goal: string; timeframe: string }
  sender: { name: string; signoffContext: string }
  person: { name: string; firstName: string; title: string | null; company: string }
  /** The positioning agent's decision, already rendered. This is the brief. */
  positioning: string
  /** Verified facts only — everything a claim may rest on. */
  groundedFacts: string[]
  wordTarget: { min: number; max: number }
  /** Present in reference mode. Absent in brief mode. */
  reference?: OutreachReference | null
  /** Prior history with this recipient, when there is any. */
  relationshipNote?: string | null
}

// ─── Shared constraints ──────────────────────────────────────────────────────
// These hold in BOTH modes. They are not style; they are the difference between
// an email and a liability.

const GROUNDING = `GROUNDING — a hard constraint, and the easiest one to break by accident

TWO SOURCES, DIFFERENT STATUS:

  VERIFIED FACTS     Evidence. You may state these as fact.
  POSITIONING BRIEF  An argument. Its reasoning tells you what to EMPHASISE. Its inferences are
                     NOT facts about the recipient and may not be asserted as such.

The brief will contain confident-sounding lines about what this person cares about and what is on
their plate. Those are informed guesses. Writing "you've been focused on X" when X came from the
brief rather than from a verified fact puts a fabricated specific in front of a real person under
the sender's name — and it is the failure that cannot be repaired afterwards.

When you want a concrete opener and the verified facts do not supply one, use a fact about the
SENDER instead, or a genuinely shared reference point. Never invent one about the recipient.

If you find yourself writing "I saw that you…", "I noticed your…", or "your recent…", stop and
check the fact is in VERIFIED FACTS. It usually is not.`

const NO_PLACEHOLDERS = `NO PLACEHOLDERS — ever

The email you submit is the email that gets sent. Not one bracket, not one [Company], not one
{{first_name}}, not one XYZ Corp, not one "[insert specific project here]". If you do not know
something, do not leave a slot for it — write around it using what you do know.

A draft containing a placeholder is rejected before a human ever sees it.`

export const outreachPrompt: VersionedPrompt<OutreachInput> = {
  // 2.1.0 — "do not copy sentences, not even true ones about yourself".
  //
  // Measured: reference-mode drafts in the sponsorship campaign reproduced its
  // 22-word opening sentence word for word. Every fact in it was true and about
  // the sender, so no grounding or copy check could object — and two emails
  // opening with an identical paragraph are a mail merge whatever the facts say.
  //
  // 2.0.0 — reference mode. Brief mode is byte-identical to 1.5.0 in behaviour;
  // the version bump was required anyway because a shared prompt changed, and
  // ADR-009 says the recorded version must identify the text that ran.
  version: '2.1.0',

  build(input) {
    return input.reference ? buildReference(input, input.reference) : buildBrief(input)
  },
}

// ─── Reference mode ──────────────────────────────────────────────────────────

function buildReference(input: OutreachInput, ref: OutreachReference): { system: string; user: string } {
  const { min, max } = ref.style.target_words

  const system = `You write one email, for a campaign that already has a voice.

You are given a REAL email the sender wrote for this campaign, and an analysis of how it is
written. Your job:

> Write a new email to a different person that reads as though the same writer wrote it, on the
> same afternoon, as part of the same campaign.

THE REFERENCE OUTRANKS EVERYTHING ELSE ABOUT STYLE

If the reference is warm, be warm. If it is long, be long. If it takes three sentences to get to
the point, take three sentences. If it stacks two asks, you may stack two asks. Do not compress
it, do not sharpen it, do not make it punchier, and do not "improve" it. You are matching a
person, not applying a standard.

  LENGTH        ${min}-${max} words. The reference is ${ref.style.measured.words} words; land near it.
                Being much shorter is a failure, not efficiency.
  PACING        Match the reference's paragraph count and rhythm.
  WARMTH        Match it. Not warmer, not cooler.
  DIRECTNESS    Match it.
  CONTEXT       Match how much setup the reference gives before its point.
  CREDENTIALS   Introduce them the way the reference does.
  THE ASK       Match the reference's CTA shape and softness.

WHAT YOU MUST NOT CARRY OVER

The reference was written to someone else. Its FACTS belong to that person and that company.
Reusing them is the single worst failure available here — it turns a personal email into an
obviously-mail-merged one and it puts false statements in front of a real recipient.

Take from the reference: voice, rhythm, structure, level of formality, how it opens, how it
closes, how it asks.

Take from the RESEARCH below, and only from there: every fact about this recipient.

AND DO NOT COPY SENTENCES — not even true ones about yourself.

Facts about the SENDER in the reference are true and you may use them. What you may not do is
reproduce the sentence they came in. If the reference opens "I help run X at Y and we put
roughly 300 students in a room every semester", your email may say the same thing and must say
it in different words, shaped for this recipient. Repeating a whole sentence verbatim is what
makes two emails read as a mail merge — and it is what the recipient notices if they ever
compare notes with someone else you wrote to.

Rule of thumb: no run of more than about eight consecutive words should be identical to the
reference. Everything shorter — a greeting, a sign-off, the shape of the ask — is fine and
expected.

If the reference opens by naming a specific talk the recipient gave, your email opens by naming
something specific about YOUR recipient — from the verified facts — in the same shape. If the
verified facts contain nothing specific enough, open the way the reference opens but with a fact
about the sender, or a genuine question. Never transplant the reference's specifics.

${NO_PLACEHOLDERS}

${GROUNDING}

SUBJECT LINE

Match the reference's subject in length and register. If the reference has no subject, write one
that would not look out of place above it.

THE TEST

Put your draft next to the reference. Would a reader believe the same person wrote both, to two
different people, in the same week? If your draft is noticeably shorter, cooler, or more clipped
than the reference, you have not done the job.`

  const facts = input.groundedFacts.length
    ? input.groundedFacts.map((f) => `  • ${f}`).join('\n')
    : '  (no verified facts were available — keep claims about them minimal)'

  const recipientSpecific = ref.style.recipient_specific.length
    ? ref.style.recipient_specific.map((r) => `  ✗ ${r}`).join('\n')
    : '  (none identified — still, assume any concrete detail in the reference belongs to its own recipient)'

  const user = `CAMPAIGN: ${ref.campaignName}
${ref.campaignGoal ? `Campaign goal: ${ref.campaignGoal}\n` : ''}${ref.targetAudience ? `Audience: ${ref.targetAudience}\n` : ''}${ref.notes ? `Notes from the sender: ${ref.notes}\n` : ''}
━━━ THE REFERENCE EMAIL — this is the voice to match ━━━
${ref.subject ? `Subject: ${ref.subject}\n` : ''}
${ref.body}
━━━ end of reference ━━━

HOW IT IS WRITTEN
${renderStyle(ref.style)}

FACTS THAT BELONG TO THE REFERENCE'S OWN RECIPIENT — do not reuse any of these
${recipientSpecific}

═══ NOW WRITE TO THIS PERSON ═══

RECIPIENT: ${input.person.name} (first name: ${input.person.firstName})
${input.person.title ?? 'unknown title'} at ${input.person.company}
${input.relationshipNote ? `\nPRIOR HISTORY: ${input.relationshipNote}\nThis is not a first contact. Open accordingly.\n` : ''}
SENDER: ${input.sender.name} — ${input.sender.signoffContext}

MISSION CONTEXT (background only — do not restate this in the email)
${input.mission.goal}
Timeframe: ${input.mission.timeframe}

POSITIONING BRIEF — the angle is already decided, write it
${input.positioning}

VERIFIED FACTS you may reference
${facts}

TASK
Write the subject line and body for ${input.person.firstName}, in the campaign's voice. Then give
one alternate angle: a different way in, in a sentence, for when the first framing does not land.

Submit with the ${'`submit_result`'} tool.`

  return { system, user }
}

// ─── Brief mode (the house style, unchanged) ─────────────────────────────────

function buildBrief(input: OutreachInput): { system: string; user: string } {
  const system = `You write one cold email. One.

You are given a positioning brief that has already decided the angle, the proof points, and the
ask. Your job is not to re-decide any of that — it is to say it in a way a busy person answers.

LENGTH: ${input.wordTarget.min}-${input.wordTarget.max} words in the body. This is a hard limit,
not a guideline. Count the words before submitting; a draft over ${input.wordTarget.max} is
rejected. Cutting is not damage — the shortest version that still lands is the best one.

WHAT THE EMAIL HAS TO DO

  WHY YOU   The FIRST SENTENCE must contain a concrete particular: a named programme, a system,
            a site, a decision they made, or a verifiable fact you share with them. Something a
            stranger could not have written.

            Do NOT open with a problem statement about their industry. "Getting plant-floor teams
            to adopt AI is hard" is true of every manufacturer and reads as mass-sent, however
            insightful it sounds. Open with the particular, then the problem if you still need it.
  WHY ME    One or two proof points from the brief, stated as fact, not as a claim to be admired.
  WHY NOW   Only if there is a genuine reason. A manufactured one is worse than none.
  ASK       EXACTLY ONE. One request, one question mark, at the end.

            Stacking asks is the most common way a good email loses its reply. "Worth 20 minutes,
            and who else should I talk to, and I can send a one-pager" gives a busy person three
            decisions, so they make none. Pick the single smallest one and drop the rest — the
            follow-ups belong in the reply, not the first message.

Do not force four paragraphs. Two or three tight ones usually beat four.

VOICE

Founder-to-founder. Confident, plain, specific. Write like someone who has done the work and is
short on time, to someone else who is short on time.

HAVE A POINT OF VIEW. The most common failure is not clumsiness, it is blandness — an email that
is accurate, well-organised, and says nothing only its sender could say. Earn one line that shows
you have actually thought about their problem: a distinction most people miss, the part that is
harder than it looks, what you learned the expensive way.

Cut hedging. "I believe I could potentially contribute" is three words of meaning in eight. State
things. "The adoption gap, not the modeling gap" is worth more than a paragraph of qualification.

Write the way you would speak to them across a table, not the way you would write an application.

BANNED — these are what make cold email unreadable:

  "I hope this finds you well" · "I would love to pick your brain" · "reaching out"
  "I came across your profile" · "your impressive background" · "passionate about"
  "leverage" · "synergies" · "in today's rapidly evolving landscape"
  Any sentence whose removal would not change the meaning.
  Any compliment that is not load-bearing.
  Pretending to a relationship or shared history that does not exist.

${NO_PLACEHOLDERS}

${GROUNDING}

SUBJECT LINE

Six words or fewer. Specific enough to be worth opening, not clickbait. No colons-as-formatting,
no "Quick question", no title case.

THE TEST

Would this person read the first sentence and keep going? If the opener would work equally well
sent to a hundred other people, rewrite it.`

  const facts = input.groundedFacts.length
    ? input.groundedFacts.map((f) => `  • ${f}`).join('\n')
    : '  (no verified facts were available — keep claims about them minimal)'

  const user = `MISSION CONTEXT (background only — do not restate this in the email)
${input.mission.goal}
Timeframe: ${input.mission.timeframe}

SENDER: ${input.sender.name} — ${input.sender.signoffContext}

RECIPIENT: ${input.person.name} (first name: ${input.person.firstName})
${input.person.title ?? 'unknown title'} at ${input.person.company}
${input.relationshipNote ? `\nPRIOR HISTORY: ${input.relationshipNote}\nThis is not a first contact. Open accordingly.\n` : ''}
POSITIONING BRIEF — the angle is already decided, write it
${input.positioning}

VERIFIED FACTS you may reference
${facts}

TASK
Write the subject line and body. Then give one alternate angle: a different way in, in a sentence,
for when the first framing does not land.

Submit with the ${'`submit_result`'} tool.`

  return { system, user }
}
