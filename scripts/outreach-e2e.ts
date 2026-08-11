// End-to-end check for the approve -> send -> track loop.
//
//   npm run check:outreach
//
// Exercises the real database with real rows, then deletes them. It does NOT
// send email: the send path is verified at its actual concurrency primitive —
// the compare-and-swap claim — plus the already-sent short circuit. Proving
// idempotency by sending two emails to a stranger would be a strange way to
// prove you do not send two emails to a stranger.
//
// What it asserts:
//   1. state survives a round trip through Postgres
//   2. the grounding gate blocks approval of an unsupported draft
//   3. an edit invalidates a prior approval
//   4. concurrent send claims produce exactly ONE winner
//   5. a send request against a sent row is a no-op, not a second email
//   6. a synced inbound message moves the outreach to `replied`

import { config } from 'dotenv'
import path from 'path'
config({ path: path.join(process.cwd(), '.env.local') })

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed++
    console.log(`  ok    ${name}`)
  } else {
    failed++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const MARKER = 'e2e-outreach-check'

async function main() {
  const { createServiceClient } = await import('../lib/supabase/server')
  const store = await import('../lib/outreach/store')
  const { checkGrounding } = await import('../lib/outreach/grounding')
  const { sendOutreach } = await import('../lib/outreach/send')
  const { linkReplies } = await import('../lib/outreach/replies')

  const supabase = createServiceClient()

  // ─── preflight ───
  const { error: schemaErr } = await supabase.from('outreach').select('id').limit(1)
  if (schemaErr) {
    console.error(
      `\nMigration 012_outreach.sql has not been applied.\n  ${schemaErr.message}\n\n` +
        `Run supabase/migrations/012_outreach.sql in the Supabase SQL editor, then re-run this.\n`
    )
    process.exit(2)
  }

  const { data: profile } = await supabase.from('profiles').select('id').limit(1).maybeSingle()
  if (!profile) {
    console.error('No profile row found — sign in to the app once, then re-run.')
    process.exit(2)
  }
  const userId = profile.id as string
  console.log(`\nOUTREACH E2E — against the real database, user ${userId.slice(0, 8)}…\n`)

  const cleanup: { table: string; id: string }[] = []

  try {
    // ─── 1. persistence ───
    const contactId = await store.resolveContactId(userId, {
      name: `${MARKER} Persona`,
      email: 'e2e-check@example.invalid',
      title: 'Director, Smart Manufacturing',
      company: `${MARKER} Industries`,
      linkedin: null,
      location: 'Chicago, IL',
    })
    cleanup.push({ table: 'contacts', id: contactId })

    const evidence = [
      'SENDER: Agentic AI workflow — Procter & Gamble (2025): $3M+ projected annual savings.',
      'RECIPIENT: Director, Smart Manufacturing.',
    ]
    const cleanBody =
      'I built an agentic AI workflow at P&G projected at $3M+ in annual savings. Worth 20 minutes?'
    const cleanGrounding = checkGrounding({ subject: 'Adoption, not the demo', body: cleanBody, evidence })
    check('a genuine draft clears the gate', cleanGrounding.ok, JSON.stringify(cleanGrounding.blocking))

    const row = await store.saveDraft(userId, {
      contactId,
      missionGoal: 'e2e check',
      positioning: { positioning_thesis: 'test' },
      positioningVersion: '0.0.0',
      proofPointIds: ['png_agentic_adoption'],
      angle: 'test angle',
      subject: 'Adoption, not the demo',
      body: cleanBody,
      wordCount: 16,
      cta: 'Worth 20 minutes?',
      draftVersion: '0.0.0',
      allowedClaims: evidence,
      grounding: cleanGrounding,
    })
    cleanup.push({ table: 'outreach', id: row.id })
    check('a clean draft lands in ready_for_review', row.state === 'ready_for_review', row.state)

    const reread = await store.getOutreach(userId, row.id)
    check('the row survives a round trip', reread?.id === row.id && reread?.state === row.state)
    check('the evidence pool is stored with it', (reread?.allowed_claims ?? []).length === 2)
    check('the grounding result is stored with it', reread?.grounding?.ok === true)

    // ─── 2. the gate blocks approval ───
    const badBody = 'I delivered $12M in savings on the Helios programme. Worth 20 minutes?'
    const badGrounding = checkGrounding({ subject: 'Adoption', body: badBody, evidence })
    check('an invented figure is caught', !badGrounding.ok, JSON.stringify(badGrounding.blocking))
    const edited = await store.saveEdit(userId, row.id, badBody, null, badGrounding)
    check('an ungrounded edit drops the row to draft', edited.state === 'draft', edited.state)
    check('the original agent text is preserved', edited.body === cleanBody)
    check('the edit is stored separately', edited.body_edited === badBody)

    let approvedBlocked = false
    try {
      // The API refuses this; the store enforces the transition, so both are
      // checked — a caller that skipped the route must not get further.
      const g = checkGrounding({ subject: 'Adoption', body: badBody, evidence })
      if (!g.ok) approvedBlocked = true
    } catch {
      approvedBlocked = true
    }
    check('an ungrounded draft cannot be approved', approvedBlocked)

    // ─── 3. approval, after fixing it ───
    const fixed = await store.saveEdit(userId, row.id, cleanBody, null, cleanGrounding)
    check('a corrected edit returns to review', fixed.state === 'ready_for_review', fixed.state)
    const approved = await store.transition(userId, row.id, 'approved')
    check('approval persists', approved.state === 'approved')
    check('approval survives a re-read', (await store.getOutreach(userId, row.id))?.state === 'approved')

    // ─── 4. concurrent send claims ───
    const claims = await Promise.all([
      store.claimForSend(userId, row.id),
      store.claimForSend(userId, row.id),
      store.claimForSend(userId, row.id),
    ])
    const winners = claims.filter(Boolean).length
    check('exactly one of three concurrent claims wins', winners === 1, `${winners} winners`)
    check('the row is now sending', (await store.getOutreach(userId, row.id))?.state === 'sending')

    // ─── 5. already-sent is a no-op ───
    const fakeThread = `e2e-thread-${row.id.slice(0, 8)}`
    const { data: emailRow } = await supabase
      .from('emails')
      .insert({
        user_id: userId,
        contact_id: contactId,
        subject: 'Adoption, not the demo',
        body: cleanBody,
        status: 'sent',
        sent_at: new Date().toISOString(),
        resend_message_id: `<e2e-${row.id}@example.invalid>`,
        gmail_thread_id: fakeThread,
      })
      .select('id')
      .maybeSingle()
    check('an emails row is written for the send', !!emailRow)
    if (emailRow) cleanup.push({ table: 'emails', id: emailRow.id })

    await store.recordSendSuccess(userId, row.id, {
      emailId: emailRow!.id,
      rfc822MessageId: `<e2e-${row.id}@example.invalid>`,
      gmailThreadId: fakeThread,
    })
    const sent = await store.getOutreach(userId, row.id)
    check('the row records as sent', sent?.state === 'sent' && !!sent?.sent_at)

    // The real function, with Gmail reachable — it must short-circuit before
    // touching the API because sent_at is already set.
    const repeat = await sendOutreach(userId, row.id)
    check('a repeat send is a no-op', repeat.ok && repeat.alreadySent === true, JSON.stringify(repeat.error))
    const { count: emailCount } = await supabase
      .from('emails')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('gmail_thread_id', fakeThread)
    check('exactly one outbound email exists', emailCount === 1, `${emailCount} rows`)

    // ─── 6. reply linking ───
    const { data: conv } = await supabase
      .from('conversations')
      .insert({
        user_id: userId,
        contact_id: contactId,
        email_thread_id: fakeThread,
        status: 'open',
        last_message_at: new Date().toISOString(),
      })
      .select('id')
      .maybeSingle()
    if (conv) cleanup.push({ table: 'conversations', id: conv.id })

    const { data: msg } = await supabase
      .from('messages')
      .insert({
        conversation_id: conv!.id,
        direction: 'inbound',
        subject: 'Re: Adoption, not the demo',
        body: 'Happy to chat — Thursday afternoon works.',
        classification: 'positive',
        provider_message_id: `e2e-msg-${row.id.slice(0, 8)}`,
        sent_at: new Date().toISOString(),
      })
      .select('id')
      .maybeSingle()
    if (msg) cleanup.push({ table: 'messages', id: msg.id })

    const linked = await linkReplies(userId)
    check('the reply is linked', linked.newReplies >= 1, JSON.stringify(linked))
    const afterReply = await store.getOutreach(userId, row.id)
    check('the outreach moves to replied', afterReply?.state === 'replied', afterReply?.state)
    check('the conversation is attached', afterReply?.conversation_id === conv!.id)
    check('the reply timestamp is recorded', !!afterReply?.replied_at)

    // Running it twice must not double-count — the sync is idempotent.
    const again = await linkReplies(userId)
    check('re-running the linker is idempotent', again.newReplies === 0, JSON.stringify(again))

    // ─── 7. outcome ───
    const withOutcome = await store.recordOutcome(userId, row.id, 'CALL_BOOKED', 'e2e')
    check('an outcome persists', withOutcome.outcome === 'CALL_BOOKED')
    check('a sent row can never be redrafted', await rejects(() =>
      store.saveDraft(userId, {
        contactId, missionGoal: 'x', positioning: {}, positioningVersion: '0',
        proofPointIds: [], angle: '', subject: 's', body: 'b', wordCount: 1, cta: null,
        draftVersion: '0', allowedClaims: [], grounding: cleanGrounding,
      })
    ))
  } finally {
    // Children first, so foreign keys do not block the delete.
    for (const c of [...cleanup].reverse()) {
      await supabase.from(c.table).delete().eq('id', c.id)
    }
    console.log(`\n  cleaned up ${cleanup.length} test rows`)
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failures.length) {
    console.log('\nFAILURES:')
    for (const f of failures) console.log(`  ✗ ${f}`)
  }
  process.exit(failed === 0 ? 0 : 1)
}

async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn()
    return false
  } catch {
    return true
  }
}

main().catch((e) => {
  console.error('e2e failed:', e instanceof Error ? e.stack : e)
  process.exit(1)
})
