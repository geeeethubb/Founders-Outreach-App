// THE RECALL EVAL — "scout feels better" is not an evaluation.
//
//   npm run eval:career-recall
//   npx tsx scripts/career-eval-recall.ts [--platforms greenhouse,workday,phenom]
//                                         [--max-pages N] [--json] [--quiet]
//
// Offline and free: no network, no API key, no database, no model call. It runs
// the product's own discovery stages over a checked-in corpus recorded live
// from public ATS endpoints on 2026-08-31, and exits non-zero when a target is
// missed.
//
// Targets. The first two are the founder's; the three after them exist to stop
// the first two from being satisfied by shrinking what they are measured over.
//   · recall >= 90% OF THE BENCHMARK ENTRIES A CONFIGURED SOURCE CAN REACH.
//     The qualifier is printed with the number every time. Entries whose only
//     surface has no adapter are excluded from the denominator and listed by
//     name, so the suite never claims coverage of listings nothing can see.
//   · >= 20 unique companies in the top 50, when the corpus supports it.
//   · the reachable set is >= 90% of the corpus — a gated ratio with no floor
//     under its denominator is a dial, not a target: drop 'workday' and 34 of
//     44 entries leave the denominator while the headline reads 100%.
//   · the eval's platform list matches the adapters the product actually ships.
//   · the corpus itself has not been gutted.
//
// Results land in .career-out/eval/recall/results.json (gitignored).

import fs from 'fs'
import path from 'path'

import { formatTable } from '../evals/career/metrics'
import {
  canonicalUrlRate,
  configuredPlatformDrift,
  duplicateRate,
  loadRecallCorpus,
  measurePrecision,
  measureRecall,
  pct,
  recallRegistry,
  roleFamilyDiversity,
  runDiversityRegression,
  runRecallDiscovery,
  sourceDiversity,
  staleRate,
  toMeasured,
  uniqueCompanies,
  urlKey,
  MIN_BENCHMARK_ENTRIES,
  MIN_REACHABLE_SHARE,
  MIN_TOP50_COMPANIES,
  RECALL_CONFIGURED_PLATFORMS,
  UNADAPTED_REASONS,
} from '../evals/career/recall'

/** The headline target. Not negotiable inside this file — a failing run reports the number. */
const RECALL_TARGET = 0.9

const OUT_DIR = path.resolve('.career-out', 'eval', 'recall')

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null
}

const quiet = process.argv.includes('--quiet')
const jsonOnly = process.argv.includes('--json')
const log = (line = ''): void => {
  if (!quiet && !jsonOnly) console.log(line)
}

interface Target {
  name: string
  observed: string
  target: string
  pass: boolean
  note: string
}

async function main(): Promise<void> {
  const started = Date.now()
  const corpus = loadRecallCorpus()
  const platforms = arg('platforms')?.split(',').map((s) => s.trim()).filter(Boolean) ?? [...RECALL_CONFIGURED_PLATFORMS]
  const maxPages = Number(arg('max-pages') ?? '') || undefined

  const built = recallRegistry({ platforms })
  const drift = configuredPlatformDrift()
  const shippedList = [...RECALL_CONFIGURED_PLATFORMS].sort().join(',')
  const whatIf = [...platforms].sort().join(',') !== shippedList

  log(`\nRECALL EVAL — offline, over ${corpus.benchmark.entries.length} benchmark entries and ${corpus.boards.boards.length} recorded boards\n`)
  if (whatIf) {
    log(
      `  WHAT-IF RUN — --platforms overrode the shipped configuration.\n` +
        `  measuring: ${platforms.join(', ') || '(none)'}\n` +
        `  shipping:  ${[...RECALL_CONFIGURED_PLATFORMS].join(', ')}\n` +
        `  Every number below describes that hypothetical, not the product.\n`
    )
  }
  log('sources:')
  for (const line of built.registry.describe()) log(`  ${line}`)
  log('')
  log(
    `  adapters the product ships (lib/career/sources/registry.ts): ${drift.shipped.join(', ') || '(none)'}` +
      (drift.disabledByEnv.length ? `\n  switched off in this environment by CAREER_DISABLE_*: ${drift.disabledByEnv.join(', ')}` : '') +
      (drift.inSync
        ? '  — in sync with this eval'
        : `\n  DRIFT — shipped but unscored here: ${drift.missingFromEval.join(', ') || 'none'}` +
          ` · claimed here but gone from the product: ${drift.missingFromProduct.join(', ') || 'none'}`)
  )

  const result = await runRecallDiscovery({ registry: built, maxPagesPerSource: maxPages })

  // ─── Coverage ────────────────────────────────────────────────────────────
  log('── coverage: what each surface was asked, and what it gave ──')
  log(
    formatTable(
      ['source', 'type', 'seen', 'unique', 'pages', 'exhausted', 'errors'],
      result.coverage.rows.map((r) => [r.sourceId, r.sourceType, r.seen, r.unique, r.pages, r.exhausted ? 'yes' : 'no', r.errors.length])
    )
  )
  const t = result.coverage.totals
  log(
    `\n  ${t.seen} seen · ${t.unique} unique across sources · ${t.crossSourceDuplicates} found by more than one · ` +
      `${t.sourcesAsked}/${t.sources} asked · ${t.sourcesCompleted} completed`
  )
  log(
    `  read "seen" carefully on the simplify row: that source reports the WHOLE matching set on every page\n` +
      `  (lib/career/sources/simplify.ts, \`seen: matching.length\`) while the ledger sums \`seen\` across pages\n` +
      `  (lib/career/discovery/coverage.ts), so its total is multiplied by its page count. The ats: rows report\n` +
      `  per call, which is what discovery-types.ts defines. Fixing that is the simplify owner's change, not this\n` +
      `  eval's — recorded here so the number is not read as cross-source overlap that never happened.`
  )
  if (result.unconfigured.length) {
    log('\n  not configured (skipped and named, never silently absent):')
    for (const u of result.unconfigured) log(`    ${u.id} — ${u.reason}`)
  }

  // ─── Recall ──────────────────────────────────────────────────────────────
  const configuredFamilies = new Set<string>()
  for (const p of platforms) configuredFamilies.add(p)
  configuredFamilies.add('simplify')
  const measured = result.jobs.map(toMeasured)
  const recall = measureRecall(corpus.benchmark.entries, measured, {
    configuredFamilies,
    reasons: UNADAPTED_REASONS,
  })

  log('\n── recall: of the benchmark, what did discovery find ──')
  log(
    formatTable(
      ['area', 'entries', 'found', 'reachable', 'reachable found', 'reachable recall'],
      Object.entries(recall.byArea)
        .sort((a, b) => b[1].total - a[1].total)
        .map(([area, r]) => [area, r.total, r.found, r.reachable, r.reachableFound, r.reachable ? pct(r.reachableFound / r.reachable) : '—'])
    )
  )
  log(
    `\n  ${recall.reachableFound}/${recall.reachable} reachable entries found = ${pct(recall.reachableRecall)}` +
      `  ·  ${recall.found}/${recall.total} of the whole corpus = ${pct(recall.recall)}`
  )
  log(`  matched by canonical URL: ${recall.matchedByUrl} · by company+title: ${recall.matchedByCompanyTitle}`)
  log(`  of the found entries, ${recall.retained} survived the mission's own hard constraints`)
  if (recall.dropped.length) {
    log(
      `\n  FOUND, then dropped by a hard constraint (the mission keeps the shipped defaults —\n` +
        `  internships only, not a different season, US; see evals/career/recall/bank.ts):`
    )
    for (const m of recall.dropped) {
      log(`    ${m.entry.company} — ${m.entry.title} [${m.entry.role_area}] : ${m.droppedBy.join(', ') || '(no label)'}`)
    }
  }
  if (recall.unreachable.length) {
    log(`\n  NOT REACHABLE by any configured source — excluded from the target, listed so nothing is hidden:`)
    for (const m of recall.unreachable) log(`    ${m.entry.company} — ${m.entry.title} [${m.entry.platform}] : ${m.unreachableReason}`)
  }
  if (recall.misses.length) {
    log('\n  MISSED, and a configured source could see them:')
    for (const m of recall.misses) log(`    ${m.entry.company} — ${m.entry.title} [${m.entry.source}] ${m.entry.url}`)
  }
  for (const gap of corpus.benchmark.coverage_gaps) {
    log(`  coverage gap: ${gap.company} reported ${gap.board_total_reported ?? '?'} postings on ${gap.platform}, which no configured source reads`)
  }

  // ─── Quality of what was accepted ────────────────────────────────────────
  const acceptedMeasured = result.accepted.map(toMeasured)
  const precision = measurePrecision(acceptedMeasured, corpus.labels.labels, measured)

  // THE SECOND DRAIN, and the reason for it: in the shipped configuration every
  // adapter runs `internshipLike` on the title before handing anything over
  // (lib/career/sources/fetch.ts), so most of the 107 hand-labelled negatives
  // never reach `buildNormalizedJob` at all. Precision measured on that pool is
  // real, but it is precision of the source filter PLUS the pipeline, and it
  // has a ceiling set by whatever the filter already removed. So the boards are
  // drained a second time WHOLE — `internshipsOnly: false` — and precision is
  // reported again over the pool where every labelled negative had to be
  // rejected by the product's own classifier and constraints. That is the
  // number that can catch a classifier defect; the first is the number the
  // founder actually sees in the app. Both are printed.
  const unfilteredRun = await runRecallDiscovery({
    registry: recallRegistry({ platforms }),
    maxPagesPerSource: maxPages,
    internshipsOnly: false,
  })
  const unfilteredPrecision = measurePrecision(
    unfilteredRun.accepted.map(toMeasured),
    corpus.labels.labels,
    unfilteredRun.jobs.map(toMeasured)
  )
  const closed = new Set<string>()
  for (const row of corpus.simplify) {
    if (row.active === true && row.is_visible !== false) continue
    const k = urlKey(row.url)
    if (k) closed.add(k)
  }
  const stale = staleRate(acceptedMeasured, closed)
  const dupes = duplicateRate(measured)
  const canonical = canonicalUrlRate(acceptedMeasured)
  const families = roleFamilyDiversity(result.top50.map(toMeasured))
  const sources = sourceDiversity(result.top50.map(toMeasured))

  log('\n── what discovery accepted ──')
  log(
    formatTable(
      ['metric', 'value', 'detail'],
      [
        ['raw postings', result.rawCount, 'before normalization'],
        ['opportunities', result.jobs.length, 'after cross-source clustering'],
        ['accepted', result.accepted.length, "passed the mission's hard constraints"],
        [
          'precision (as shipped)',
          pct(precision.precision),
          `${precision.legitimate}/${precision.labelled} labelled; ${precision.unlabelled} accepted rows carry no label; ` +
            `${precision.negativesFilteredBeforeScoring} of ${precision.labelledNegatives} labelled negatives were removed by the source's own internshipsOnly pre-filter before scoring`,
        ],
        [
          'precision (boards drained whole)',
          pct(unfilteredPrecision.precision),
          `${unfilteredPrecision.legitimate}/${unfilteredPrecision.labelled} labelled; ` +
            `${unfilteredPrecision.negativesReached} of ${unfilteredPrecision.labelledNegatives} negatives reached normalize + hard constraints — this is the pipeline's own classifier`,
        ],
        ['duplicate rate', pct(dupes), 'share of postings that were a copy of another'],
        ['stale/closed rate', pct(stale.rate), `${stale.stale} of ${stale.shown} shown open are closed in the corpus`],
        ['unique companies', uniqueCompanies(acceptedMeasured), 'across everything accepted'],
        ['canonical-URL rate', pct(canonical.rate), `${canonical.firstParty}/${canonical.total} point at the employer or its ATS`],
        ['source diversity (top 50)', sources.sources, Object.entries(sources.perSource).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'],
        ['role-family diversity (top 50)', families.families, Object.entries(families.perFamily).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`).join(', ')],
      ]
    )
  )
  if (precision.falsePositives.length) {
    log('\n  accepted in the shipped configuration, but a person labelled it NOT an internship:')
    for (const fp of precision.falsePositives.slice(0, 10)) log(`    ${fp.company} — ${fp.title}${fp.note ? ` (${fp.note})` : ''}`)
  }
  if (unfilteredPrecision.falsePositives.length) {
    log(
      `\n  with the boards drained whole, ${unfilteredPrecision.falsePositives.length} labelled non-internship(s) still reached the inbox —\n` +
        '  each one is a defect in the product\'s own classification, not in the fixture:'
    )
    for (const fp of unfilteredPrecision.falsePositives.slice(0, 12)) log(`    ${fp.company} — ${fp.title}${fp.note ? ` (${fp.note})` : ''}`)
  }
  if (stale.examples.length) for (const e of stale.examples) log(`  stale: ${e}`)

  // ─── Diversity regression ────────────────────────────────────────────────
  const diversity = runDiversityRegression(result, corpus.benchmark.entries)
  log('\n── diversity regression (the founder\'s test) ──')
  log(
    formatTable(
      ['assertion', 'observed', 'expected', 'result', 'detail'],
      diversity.assertions.map((a) => [a.name, a.observed, a.expected, a.pass ? 'PASS' : 'FAIL', a.detail])
    )
  )
  log('\n  top 50 by relevance:')
  log(
    formatTable(
      ['#', 'company', 'title', 'family', 'band', 'score', 'source'],
      result.top50
        .slice(0, 50)
        .map((r, i) => [i + 1, r.job.company_name.slice(0, 26), r.job.title.slice(0, 52), r.job.role_family, r.relevance.band, r.relevance.score.toFixed(2), r.sourceIds.join('+')])
    )
  )
  if (result.diversityTop50.concentrationWarning) log(`\n  ${result.diversityTop50.concentrationWarning}`)

  // ─── Targets ─────────────────────────────────────────────────────────────
  const targets: Target[] = [
    {
      name: 'recall (reachable corpus)',
      observed: pct(recall.reachableRecall),
      target: `>= ${pct(RECALL_TARGET, 0)}`,
      pass: recall.reachableRecall >= RECALL_TARGET,
      note: `${recall.reachableFound}/${recall.reachable} entries a configured source can reach; ${recall.unreachable.length} entries excluded and named`,
    },
    // The floor under the target above. A ratio whose denominator the same file
    // controls is a dial: `--platforms greenhouse` (or deleting a line from
    // RECALL_CONFIGURED_PLATFORMS) takes 34 of 44 entries out of the reachable
    // set, and reachable recall stays at 100% while the product's coverage has
    // collapsed. This is the target that fires in that case.
    {
      name: 'benchmark the configured sources can reach',
      observed: `${recall.reachable}/${recall.total} (${pct(recall.total ? recall.reachable / recall.total : 0)})`,
      target: `>= ${pct(MIN_REACHABLE_SHARE, 0)} of the corpus`,
      pass: recall.total > 0 && recall.reachable / recall.total >= MIN_REACHABLE_SHARE,
      note:
        recall.total > 0 && recall.reachable / recall.total >= MIN_REACHABLE_SHARE
          ? 'the gated recall number above is computed over a denominator that still covers the corpus'
          : `only ${recall.reachable} of ${recall.total} entries are reachable — the recall figure above describes a fraction of the benchmark, not the benchmark`,
    },
    // The mirror of registry.ts, checked rather than trusted. Fails in both
    // directions: an adapter that vanishes from the product, and an adapter
    // that ships without its platform joining the eval.
    {
      name: 'eval platforms match the shipped adapters',
      observed: drift.inSync ? `${drift.shipped.length} adapters, in sync` : `shipped-but-unscored: ${drift.missingFromEval.join(', ') || 'none'}; claimed-but-gone: ${drift.missingFromProduct.join(', ') || 'none'}`,
      target: "RECALL_CONFIGURED_PLATFORMS == discoveryRegistry()'s ats sources",
      pass: drift.inSync,
      note: drift.inSync
        ? `lib/career/sources/registry.ts ships: ${drift.shipped.join(', ')}`
        : 'update RECALL_CONFIGURED_PLATFORMS in evals/career/recall/sources.ts and record fixtures for any new platform',
    },
    {
      name: 'benchmark corpus size',
      observed: `${corpus.benchmark.entries.length} entries, ${new Set(corpus.benchmark.entries.map((e) => e.company)).size} companies`,
      target: `>= ${MIN_BENCHMARK_ENTRIES} entries`,
      pass: corpus.benchmark.entries.length >= MIN_BENCHMARK_ENTRIES,
      note: 'the corpus may not be trimmed to make the two ratios above easier',
    },
    {
      name: 'unique companies in the top 50',
      observed: String(diversity.uniqueCompanies),
      target: `>= ${MIN_TOP50_COMPANIES}`,
      pass: diversity.assertions[0].pass,
      note: diversity.assertions[0].detail,
    },
    ...diversity.assertions.slice(1).map((a) => ({ name: a.name, observed: a.observed, target: a.expected, pass: a.pass, note: a.detail })),
    {
      name: 'closed postings shown as open',
      observed: `${stale.stale}`,
      target: '== 0',
      pass: stale.stale === 0,
      note: 'the Simplify sample carries 40 closed Summer 2027 rows on purpose',
    },
  ]

  log('\n── targets ──')
  log(formatTable(['target', 'observed', 'required', 'result', 'note'], targets.map((x) => [x.name, x.observed, x.target, x.pass ? 'PASS' : 'FAIL', x.note])))
  // The caveat is COMPUTED, never asserted. This sentence used to name "3 Oracle
  // boards" in prose with only the number interpolated, so when the oracle-orc
  // adapter shipped and read all three, the report kept citing them as
  // unreachable while printing a total of 0. A caveat that cannot go out of date
  // is worth more than a vivid one.
  const gaps = corpus.benchmark.coverage_gaps
  const gapPostings = gaps.reduce((n, g) => n + (g.board_total_reported ?? 0), 0)
  const gapLine =
    gaps.length === 0
      ? '  detector. Every board this corpus once recorded as unreadable is now read by a shipped adapter.'
      : `  detector — ${gaps.length} ${gaps.length === 1 ? 'board' : 'boards'} (${[...new Set(gaps.map((g) => g.platform))].join(', ')}) reported ${gapPostings} postings that no configured source can read.`
  log(
    '\n  What this number is and is not: recall here is measured against a corpus one person assembled\n' +
      '  from public endpoints on 2026-08-31. It is a FLOOR on what discovery finds and a regression\n' +
      `${gapLine}\n` +
      '  Coverage cannot be proven complete; it can only be measured against something written down.'
  )

  const elapsed = Date.now() - started
  const payload = {
    ran_at: new Date().toISOString(),
    elapsed_ms: elapsed,
    benchmark_version: corpus.benchmark.version,
    benchmark_method: corpus.benchmark.method,
    limitation:
      'Coverage cannot be proven complete. This is recall against a corpus one person assembled from public endpoints on 2026-08-31 — a floor on what discovery finds, never a ceiling on what exists.',
    platforms_configured: platforms,
    what_if_run: whatIf,
    platform_drift: drift,
    sources: built.registry.describe(),
    unconfigured: result.unconfigured,
    unadapted_platforms: result.unadaptedPlatforms,
    coverage: result.coverage,
    recall: {
      ...recall,
      misses: recall.misses.map((m) => ({ id: m.entry.id, company: m.entry.company, title: m.entry.title, url: m.entry.url, source: m.entry.source })),
      unreachable: recall.unreachable.map((m) => ({ id: m.entry.id, company: m.entry.company, title: m.entry.title, platform: m.entry.platform, reason: m.unreachableReason })),
      dropped: recall.dropped.map((m) => ({ id: m.entry.id, company: m.entry.company, title: m.entry.title, role_area: m.entry.role_area, dropped_by: m.droppedBy })),
    },
    quality: {
      precision,
      precision_boards_drained_whole: unfilteredPrecision,
      precision_note:
        `In the shipped configuration the adapters' own internshipsOnly pre-filter (lib/career/sources/fetch.ts internshipLike) removed ` +
        `${precision.negativesFilteredBeforeScoring} of ${precision.labelledNegatives} labelled negatives before the pipeline saw them. ` +
        `precision_boards_drained_whole re-runs the same corpus with that filter off, so every negative has to be rejected by ` +
        `buildNormalizedJob + applyHardConstraints — that is the number that measures the product's own classifier.`,
      duplicate_rate: dupes,
      stale,
      canonical_url: canonical,
      role_families: families,
      sources,
    },
    diversity: { regression: diversity, top50: result.diversityTop50, all_accepted: result.diversityAll },
    top50: result.top50.map((r, i) => ({
      rank: i + 1,
      company: r.job.company_name,
      title: r.job.title,
      role_family: r.job.role_family,
      location_raw: r.job.location_raw,
      band: r.relevance.band,
      score: r.relevance.score,
      canonical_url: r.job.canonical_url,
      sources: r.sourceIds,
    })),
    errors: result.errors,
    targets,
  }
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const file = path.join(OUT_DIR, 'results.json')
  fs.writeFileSync(file, JSON.stringify(payload, null, 2))
  if (jsonOnly) console.log(JSON.stringify({ targets, recall: recall.reachableRecall, companies: diversity.uniqueCompanies }, null, 2))
  log(`\nwrote ${file} · ${elapsed} ms · no network, no spend`)

  const failed = targets.filter((x) => !x.pass)
  if (failed.length) {
    console.error(`\nFAILED ${failed.length} target(s): ${failed.map((f) => `${f.name} (${f.observed}, wanted ${f.target})`).join('; ')}`)
    process.exitCode = 1
  } else if (whatIf) {
    log(
      '\nall targets met FOR THE HYPOTHETICAL CONFIGURATION PASSED TO --platforms.\n' +
        'This run says nothing about the product as it ships; re-run without --platforms for that.'
    )
  } else {
    // Worded to carry through `scripts/test-career-all.ts`'s summary filter,
    // which keeps the last lines matching /passed|failed|FAIL/.
    log(`\nall ${targets.length} targets passed`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
