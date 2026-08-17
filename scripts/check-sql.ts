// Parse every migration with PostgreSQL's own parser.
//
//   npm run check:sql
//
// WHY THIS EXISTS
//
// Migrations here are applied BY HAND in the Supabase SQL editor (CLAUDE.md).
// There is no runner, no CI step, and no staging database — so until this
// existed, the first thing that ever parsed a migration was the founder's
// production database, and the feedback loop for a missing comma was a person
// pasting SQL and reading an error code.
//
// That is exactly how `013` shipped with `matched as (...)` followed by a
// comment and the next CTE with no comma between them:
//
//   ERROR: 42601: syntax error at or near "floored"
//
// This uses libpg-query, which is the real PostgreSQL parser compiled to wasm,
// so "it parses" means the same thing here as it does in the SQL editor.
//
// ─── THE PART THAT MATTERS ───
//
// It parses each file TWICE-over: the outer statements, and then every
// dollar-quoted `language sql` function body separately.
//
// That second pass is not thoroughness for its own sake. To the outer parser a
// function body is just a string literal, so the outer parse of the broken 013
// PASSED — while Postgres, which validates function bodies at CREATE time
// (`check_function_bodies` is on by default), rejected it. A checker without
// the second pass would have signed off on the exact file that failed.
//
// ─── WHAT IT DOES NOT CHECK ───
//
// Syntax only. It does not know whether a table exists, whether a type matches,
// whether a function is IMMUTABLE enough for a generated column, or whether an
// index references a real column. A clean run means "Postgres will parse this",
// not "Postgres will accept this".

import fs from 'fs'
import path from 'path'

interface Failure {
  file: string
  scope: string
  message: string
  line: number
  context: string
}

async function main() {
  const dir = path.join(process.cwd(), 'supabase', 'migrations')
  const only = process.argv[2]
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => !only || f.includes(only))
    .sort()

  if (files.length === 0) {
    console.error(only ? `No migration matching "${only}".` : 'No migrations found.')
    process.exit(1)
  }

  const mod = await import('libpg-query')
  const pg = mod.default ?? mod
  const loader = (pg as { loadModule?: () => Promise<void> }).loadModule
  if (typeof loader === 'function') await loader()

  // The export name has moved across major versions (`parseQuery` in 13-16,
  // `parse` in 17). Take whichever exists rather than pinning to one.
  const api = pg as {
    parse?: (s: string) => Promise<unknown>
    parseQuery?: (s: string) => Promise<unknown>
    parseSync?: (s: string) => unknown
  }
  const parseFn = api.parse ?? api.parseQuery
  const parse = parseFn
    ? (s: string) => Promise.resolve(parseFn(s))
    : api.parseSync
      ? async (s: string) => api.parseSync!(s)
      : null
  if (!parse) {
    console.error('libpg-query exposed no parser. Exports:', Object.keys(pg).join(', '))
    process.exit(1)
  }

  const failures: Failure[] = []
  let statements = 0
  let bodies = 0

  for (const file of files) {
    const full = path.join(dir, file)
    const sql = fs.readFileSync(full, 'utf8')

    const attempt = async (scope: string, text: string, offset: number) => {
      try {
        const res = (await parse(text)) as { stmts?: unknown[] }
        statements += res?.stmts?.length ?? 0
        return true
      } catch (e) {
        const err = e as { message: string; cursorPosition?: number; cursorpos?: number }
        const pos = err.cursorPosition ?? err.cursorpos ?? 0
        failures.push({
          file,
          scope,
          message: err.message,
          line: sql.slice(0, offset + pos).split('\n').length,
          context: text.slice(Math.max(0, pos - 240), pos + 160),
        })
        return false
      }
    }

    const outerOk = await attempt('outer statements', sql, 0)

    // Dollar-quoted bodies. Postgres validates these at CREATE time, so a
    // checker that skips them misses the whole class of bug this file exists
    // to catch.
    const bodyRe = /\bas\s+\$\$([\s\S]*?)\$\$/g
    let m: RegExpExecArray | null
    let n = 0
    let bodiesOk = true
    while ((m = bodyRe.exec(sql))) {
      n++
      bodies++
      // plpgsql bodies are not SQL and this parser cannot read them.
      const isPlpgsql = /language\s+plpgsql/i.test(
        sql.slice(m.index, Math.min(sql.length, m.index + m[0].length + 120))
      )
      if (isPlpgsql) continue
      const bodyOffset = m.index + m[0].indexOf('$$') + 2
      if (!(await attempt(`function body #${n}`, m[1], bodyOffset))) bodiesOk = false
    }

    const status = outerOk && bodiesOk ? 'ok  ' : 'FAIL'
    console.log(`  ${status} ${file}${n > 0 ? `  (${n} function bod${n === 1 ? 'y' : 'ies'})` : ''}`)
  }

  console.log(
    `\n${files.length} file(s), ${statements} statement(s), ${bodies} function bod(y|ies) parsed with PostgreSQL's own parser.`
  )

  if (failures.length === 0) {
    console.log('All migrations parse. (Syntax only — this does not prove Postgres will accept them.)')
    return
  }

  console.log(`\n${failures.length} failure(s):\n`)
  for (const f of failures) {
    console.log(`  ${f.file} — ${f.scope}, line ~${f.line}`)
    console.log(`  ${f.message}`)
    console.log(f.context.split('\n').map((l) => `      ${l}`).join('\n'))
    console.log('')
  }
  // Set the code rather than calling process.exit: the wasm parser holds libuv
  // handles, and exiting under it prints a spurious "Assertion failed:
  // UV_HANDLE_CLOSING" after the real error — which reads like a second,
  // scarier problem than the missing comma you actually have.
  process.exitCode = 2
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e)
  process.exitCode = 1
})
