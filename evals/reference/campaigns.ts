// Reference-email fixtures: four campaigns, four genuinely different voices.
//
// The point of the eval is that the SAME infrastructure produces four different
// voices because the reference changed, and nothing else did. So these are
// chosen to disagree with each other on every axis the style analysis names —
// length, warmth, directness, how credentials appear, how the ask is made.
//
// Two of them deliberately violate the old house style. `mentor` is 190 words
// where the house rule said 60-120, and `sponsorship` stacks two asks where the
// house rule said exactly one. If the system still compresses them to a punchy
// 90-word single-ask email, the reference is decorative and the feature does
// not work.

export interface ReferenceCampaignFixture {
  key: string
  name: string
  goal: string
  targetAudience: string
  notes: string | null
  subject: string | null
  body: string
  /** What a human would say this voice is. Used only in the report, never in a prompt. */
  expected: string
}

export const REFERENCE_CAMPAIGNS: ReferenceCampaignFixture[] = [
  {
    key: 'recruiting',
    name: 'Summer 2027 recruiting',
    goal: 'Land conversations that could lead to a summer 2027 engineering or consulting role',
    targetAudience: 'Directors and senior managers who own manufacturing, operations or applied-AI work',
    notes: 'Professional but not stiff. I want to sound like someone who has actually been on a plant floor.',
    subject: 'Controlled state work at Tabler Station',
    body: `Hi Priya,

I spent last summer at P&G's Tabler Station site building a controlled-state system for one of the packing lines — mostly the unglamorous part, which was getting operators to trust it enough to actually use it.

The thing I did not expect was how much of the work was social. The model was fine. Getting a shift lead to change a habit that had worked for eleven years was the hard bit, and I think that is the part most people skip when they talk about digital manufacturing.

I am starting to look at summer 2027 and would like to understand how a team like yours thinks about that gap between a working pilot and something the floor actually adopts.

Would you have twenty minutes in the next few weeks?

Thanks,
Zuyu`,
    expected: 'measured, concrete, one specific story, credential shown through work not claim, single soft ask',
  },
  {
    key: 'founders',
    name: 'Industrial startup founders',
    goal: 'Get in front of founders building for industry, for a project or an internship',
    targetAudience: 'Seed and Series A founders building software for industrial operations',
    notes: 'Short and casual. These people read email on their phone between meetings.',
    subject: 'the adoption problem, not the model problem',
    body: `Marcus —

Saw what you are building. The reason I care: I spent a summer trying to get plant operators to use an AI tool at P&G and learned that the model was never the bottleneck.

I am a chemE undergrad who can actually talk to the people on the floor, which seems to be the thing most industrial software teams are missing.

Any chance you need someone on a short project this winter? Happy to just be useful for a few weeks and see where it goes.

Zuyu`,
    expected: 'clipped, low formality, em-dash greeting, direct offer, minimal hedging, no signoff formula',
  },
  {
    key: 'mentor',
    name: 'Mentor conversations',
    goal: 'Build relationships with senior operators who can give career advice',
    targetAudience: 'VPs and directors who moved from engineering into operations leadership',
    notes: 'Warmer. No ask for a job. I genuinely want to learn how they made the jump.',
    subject: 'a question about the jump from engineering to operations',
    body: `Hi David,

I hope you do not mind a cold note — I have been trying to figure out something and you seem like one of the few people who has actually lived it.

I am an undergraduate in chemical engineering, and everyone around me is optimising for the next internship. What I am actually curious about is longer-term: how people go from being the person who understands the process to the person who is responsible for the plant. Those look like very different jobs to me, and nobody in a lecture hall can explain what changes.

I spent this past summer at a P&G site working on quality systems, and the most useful thing I learned had nothing to do with engineering. It was watching how the plant leadership decided what was worth changing and what was not.

I am not looking for a job or a referral. I would just like to hear how you thought about that transition, and what you would tell someone twenty years behind you.

Would you be open to half an hour, whenever suits you? Happy to work around your schedule entirely.

Warmly,
Zuyu`,
    expected: 'long, warm, personal, explicitly disclaims any job ask, deferential close, ~190 words',
  },
  {
    key: 'sponsorship',
    name: 'Founders sponsorship',
    goal: 'Bring companies in as sponsors or speakers for the Illinois Entrepreneurs club',
    targetAudience: 'Heads of innovation, university relations, and startup programme leads',
    notes: 'Partnership tone. Concrete about what we can offer them, not just what we want.',
    subject: 'Illinois Entrepreneurs — spring speaker series',
    body: `Hi Rachel,

I help run Founders: Illinois Entrepreneurs at UIUC. We put roughly 300 engineering and business students in a room every semester, and most of them are trying to work out what to do with a technical degree that is not a rotational programme.

We are putting together the spring speaker series and I think your team would land well with this group — partly because the students here skew industrial and technical, and partly because they are at exactly the point where they are deciding whether a company like yours is a place they could build something.

Two things I would like to explore: whether someone on your side would speak in February, and whether there is a sponsorship shape that makes sense for you — we have done everything from a single-event sponsor to a semester partnership with recruiting access.

Would it be worth a short call to see if either fits?

Best,
Zuyu`,
    expected: 'partnership framing, offers value before asking, two asks stacked deliberately, semi-formal',
  },
]
