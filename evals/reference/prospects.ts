// Prospect fixtures for the reference-writing eval.
//
// Three recipients, each carrying research in exactly the shape the pipeline
// produces — bullet lines under VERIFIED FACTS, because lib/outreach/evidence.ts
// builds the writer's pool and the grounding gate's pool by reading those
// bullets. A fixture in a different format would make every draft fail the gate
// for reasons that have nothing to do with the writing.
//
// Kept deliberately modest in evidence: two or three real facts each. That is
// what a genuine prospect looks like after research, and an eval run on
// unusually rich fixtures measures a pipeline nobody has.

export interface ProspectFixture {
  key: string
  name: string
  firstName: string
  title: string
  company: string
  location: string
  companyContext: string
  personContext: string
  /** The positioning brief, already rendered — the writer never re-decides it. */
  positioning: string
  /** Background item ids the brief rests on. Must exist in evals/phase3/user-profile. */
  proofPointIds: string[]
  relationshipNote: string | null
}

export const PROSPECT_FIXTURES: ProspectFixture[] = [
  {
    key: 'operations_director',
    name: 'Priya Raghavan',
    firstName: 'Priya',
    title: 'Director of Manufacturing Technology',
    company: 'Eastman',
    location: 'Kingsport, Tennessee, United States',
    companyContext: `WHAT THEY DO: Eastman is a specialty materials company producing plastics, chemicals and fibers from its Kingsport, Tennessee complex and other global sites.
INDUSTRY: specialty chemicals
SIZE: ~14000 employees
VERIFIED FACTS:
  • Eastman operates a large integrated manufacturing complex in Kingsport, Tennessee.
  • Eastman has publicly described molecular recycling as a strategic growth platform.`,
    personContext: `SOURCE: already in your database — this person was researched for an earlier mission.
FUNCTION: leads manufacturing technology across sites
VERIFIED FACTS:
  • Priya Raghavan is Director of Manufacturing Technology at Eastman.
  • Her remit covers process control and plant data systems across Eastman sites.
NOTE: public record on this individual is thin.`,
    positioning: `POSITIONING THESIS: A student who has already run the unglamorous half of an industrial AI rollout — operator adoption — is unusually useful to someone whose job is making plant data systems actually get used.

RECIPIENT PRIORITIES:
  - Getting plant data systems adopted rather than merely deployed
  - Process control consistency across sites

WHY ME: The candidate built a controlled-state system on a live packing line and an AI agent for validation document approvals, and the hard part in both was operator and reviewer adoption rather than the technology.

WHY NOW: Summer 2027 planning starts early for technical internships.

RECOMMENDED ASK: A 20-30 minute conversation about how her team handles adoption after a pilot works.

DO NOT MENTION: nothing specific.`,
    proofPointIds: ['png_controlled_state', 'png_ai_agent_validation'],
    relationshipNote: null,
  },
  {
    key: 'startup_founder',
    name: 'Marcus Feld',
    firstName: 'Marcus',
    title: 'Co-Founder and CEO',
    company: 'Tractian',
    location: 'Atlanta, Georgia, United States',
    companyContext: `WHAT THEY DO: Tractian builds condition-monitoring hardware and software for industrial maintenance teams, combining vibration sensors with a maintenance management platform.
INDUSTRY: industrial IoT software
SIZE: ~400 employees
VERIFIED FACTS:
  • Tractian sells vibration-based condition monitoring to industrial maintenance teams.
  • Tractian's platform combines sensor hardware with maintenance workflow software.`,
    personContext: `SOURCE: already in your database — this person was researched for an earlier mission.
FUNCTION: co-founder and chief executive
VERIFIED FACTS:
  • Marcus Feld is a co-founder and CEO of Tractian.
  • He has spoken publicly about maintenance teams' resistance to new tooling.`,
    positioning: `POSITIONING THESIS: A founder selling into maintenance teams cares about adoption friction more than about model quality, and the candidate has direct plant-floor experience of exactly that friction.

RECIPIENT PRIORITIES:
  - Getting maintenance technicians to actually use the platform
  - Shortening time-to-value at new industrial accounts

WHY ME: The candidate designed an agentic AI workflow for floor-level managers at P&G specifically so adoption could come bottom-up rather than being mandated.

WHY NOW: Winter project window.

RECOMMENDED ASK: A short winter project, or a conversation about where adoption breaks for their customers.

DO NOT MENTION: nothing specific.`,
    proofPointIds: ['png_agentic_adoption', 'png_controlled_state'],
    relationshipNote: null,
  },
  {
    key: 'warm_vp',
    name: 'David Ortega',
    firstName: 'David',
    title: 'Vice President of Operations',
    company: 'Kraft Heinz',
    location: 'Chicago, Illinois, United States',
    companyContext: `WHAT THEY DO: Kraft Heinz manufactures packaged food products across a large network of North American plants.
INDUSTRY: consumer packaged goods
SIZE: ~36000 employees
VERIFIED FACTS:
  • Kraft Heinz operates a large network of North American manufacturing plants.`,
    personContext: `SOURCE: already in your database — this person was researched for an earlier mission.
FUNCTION: owns plant operations across a region
VERIFIED FACTS:
  • David Ortega is Vice President of Operations at Kraft Heinz.
  • He began his career as a process engineer before moving into operations leadership.
RELATIONSHIP: Replied positively before (last touch 2026-03-14). Reference the earlier exchange rather than introducing yourself.`,
    positioning: `POSITIONING THESIS: Someone who moved from process engineering into operations leadership is the right person to ask what actually changes in that transition, and the candidate is at the start of the same path.

RECIPIENT PRIORITIES:
  - Plant performance across a region
  - Developing technical people into operational leaders

WHY ME: The candidate spent a summer inside plant quality systems and came away more interested in how leadership decides what is worth changing than in the engineering itself.

WHY NOW: No urgency — this is a relationship, not a transaction.

RECOMMENDED ASK: Half an hour of career advice.

DO NOT MENTION: do not ask for a job or a referral.`,
    proofPointIds: ['png_quality_risk', 'png_controlled_state'],
    relationshipNote:
      'Replied positively before (last touch 2026-03-14). Reference the earlier exchange rather than introducing yourself.',
  },
]

/**
 * Which campaign each prospect is evaluated under.
 *
 * Every prospect is run against EVERY campaign, not only its natural one. The
 * interesting measurement is whether the same recipient produces four
 * recognisably different emails — if the voice does not move when the reference
 * moves, the reference is not doing anything.
 */
export const PAIRINGS: { campaign: string; prospect: string }[] = REFERENCE_PAIRS()

function REFERENCE_PAIRS(): { campaign: string; prospect: string }[] {
  const campaigns = ['recruiting', 'founders', 'mentor', 'sponsorship']
  const prospects = ['operations_director', 'startup_founder', 'warm_vp']
  const out: { campaign: string; prospect: string }[] = []
  for (const campaign of campaigns) {
    for (const prospect of prospects) out.push({ campaign, prospect })
  }
  return out
}
