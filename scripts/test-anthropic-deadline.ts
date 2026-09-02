// The retry deadline: two shapes, and why it is not one.
//
// A single slot broke two concurrent packages — whichever finished first
// cleared the other's deadline. Turning it into a set fixed that and broke
// something worse: a scout run that exits without clearing leaks its deadline
// for ever, `pastRunDeadline` takes the earliest, and every LATER run in the
// process fails instantly with "run deadline passed during retry". That cost
// five consecutive live scout runs, all of which discovered nothing.
//
// So: replace semantics for the long-lived single-owner slot, a set for scoped
// entries that cannot leak because they are removed in a `finally`.
//
//   npx tsx scripts/test-anthropic-deadline.ts

import { setAnthropicDeadline, withAnthropicDeadline, resetAnthropicDeadlines, __pastRunDeadlineForTests } from '../lib/providers/anthropic/client'

let passed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failures.push(`${name} — ${detail}`); console.log(`  FAIL ${name} — ${detail}`) }
}

const past = () => Date.now() - 60_000
const future = () => Date.now() + 60_000

async function main(): Promise<void> {
  console.log('the legacy slot REPLACES, so a leaked deadline self-heals')
  {
    resetAnthropicDeadlines()
    check('no deadline means never past one', !__pastRunDeadlineForTests())

    // Run 1 arms a deadline and dies without clearing it — the planner threw.
    setAnthropicDeadline(past())
    check('the leaked deadline is past', __pastRunDeadlineForTests())

    // Run 2 starts. THE REGRESSION: with a set, run 1's stale entry stayed and
    // run 2 was past its deadline before doing any work.
    setAnthropicDeadline(future())
    check('a NEW run is not poisoned by the previous run\u2019s leak', !__pastRunDeadlineForTests(), 'this is the five-dead-runs regression')

    setAnthropicDeadline(null)
    check('clearing works', !__pastRunDeadlineForTests())
  }

  console.log('\nscoped deadlines cannot leak, and do not clobber each other')
  {
    resetAnthropicDeadlines()
    let innerSaw = false
    await withAnthropicDeadline(future(), async () => {
      check('inside a live scope nothing is past', !__pastRunDeadlineForTests())
      // A second, concurrent scope finishing must not disarm the first.
      await withAnthropicDeadline(future(), async () => undefined)
      innerSaw = !__pastRunDeadlineForTests()
    })
    check('an inner scope finishing leaves the outer one armed', innerSaw, 'the two-concurrent-packages bug')
    check('and the scope removes itself on the way out', !__pastRunDeadlineForTests())
  }
  {
    resetAnthropicDeadlines()
    // A throwing body must still remove its entry, or it leaks like the slot did.
    await withAnthropicDeadline(past(), async () => { throw new Error('boom') }).catch(() => undefined)
    check('a scope that throws still cleans up', !__pastRunDeadlineForTests())
  }
  {
    resetAnthropicDeadlines()
    setAnthropicDeadline(future())
    await withAnthropicDeadline(past(), async () => {
      check('the EARLIEST of the two shapes wins', __pastRunDeadlineForTests(), 'conservative: stop sooner, never later')
    })
    check('and once the scope ends the slot decides again', !__pastRunDeadlineForTests())
    resetAnthropicDeadlines()
  }

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exitCode = 1 }
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
