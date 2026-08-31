// The temporary-workspace abstraction. OFFLINE — no keys, no DB, no renderer.
//
//   npx tsx scripts/test-career-tmp.ts
//
// This suite exists because of one production failure: `TMP_DIR` was
// `path.join('.career-out', 'tmp')` — a RELATIVE path — so on any machine
// whose working directory is not the repo, building a package's documents
// died with `ENOENT: no such file or directory, mkdir '.career-out/tmp/pkg-…'`
// AFTER research and tailoring had been paid for.
//
// Every check below is a property of the fix: absolute, OS-owned, unique per
// build, always removed, and never able to mask the error that broke a build.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { isTempPath, makeTempDir, removeTempDir, tmpRoot, withTempDir, TMP_NAMESPACE } from '../lib/career/documents/tmp'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed++
  else {
    failed++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const CAREER_OUT = path.join('.career-out', 'tmp')

async function main(): Promise<void> {
  const originalOverride = process.env.CAREER_TMP_DIR
  delete process.env.CAREER_TMP_DIR

  // ── (a) where scratch lives ────────────────────────────────────────────────
  console.log('(a) the root')
  const root = tmpRoot()
  check('root is absolute', path.isAbsolute(root), root)
  check('root is under os.tmpdir()', root.startsWith(path.resolve(os.tmpdir())), `${root} vs ${os.tmpdir()}`)
  check('root is namespaced', path.basename(root) === TMP_NAMESPACE, root)
  check('root exists (created recursively)', fs.existsSync(root))
  check('root is NOT .career-out/tmp', !root.replace(/\\/g, '/').includes('.career-out'), root)

  const dir = makeTempDir('unit')
  check('scratch dir is absolute', path.isAbsolute(dir), dir)
  check('scratch dir is inside the root', dir.startsWith(root + path.sep), dir)
  check('scratch dir exists', fs.existsSync(dir))
  check('scratch dir carries the prefix', path.basename(dir).startsWith('unit-'), path.basename(dir))
  check('scratch dir is not under .career-out', !dir.replace(/\\/g, '/').includes('.career-out'), dir)

  // ── (b) the scratch the package build actually takes ──────────────────────
  // Not a stand-in helper: `pkg-resume` and `pkg-letter` are the exact prefixes
  // generateResumeDocuments and buildLetterDocuments pass to withTempDir, and
  // the source check below pins that they still go through it.
  console.log('(b) the package document scratch')
  let pkgDir: string | null = null
  const pkgValue = await withTempDir('pkg-resume', async (d) => {
    pkgDir = d
    fs.writeFileSync(path.join(d, 'attempt-0.pdf'), 'x')
    return 'built'
  })
  check('the package build gets a value back', pkgValue === 'built')
  check('package scratch is absolute', pkgDir !== null && path.isAbsolute(pkgDir as string), String(pkgDir))
  check('package scratch is a temp path', isTempPath(pkgDir), String(pkgDir))
  check('package scratch is NOT .career-out/tmp', !String(pkgDir).replace(/\\/g, '/').includes('.career-out'), String(pkgDir))
  check('package scratch is gone once the build ends', pkgDir !== null && !fs.existsSync(pkgDir as string), String(pkgDir))
  const resumeSrcB = fs.readFileSync(path.resolve('lib/career/package/resume.ts'), 'utf8')
  const letterSrcB = fs.readFileSync(path.resolve('lib/career/package/letter.ts'), 'utf8')
  check('generateResumeDocuments really routes its scratch through withTempDir', /withTempDir\(\s*\n?\s*'pkg-resume'/.test(resumeSrcB), 'resume.ts no longer calls withTempDir')
  check('the letter build does too', /withTempDir\(\s*\n?\s*'pkg-letter'/.test(letterSrcB), 'letter.ts no longer calls withTempDir')
  check('no unused scratch helper is left behind for a test to prove', !/export function scratchDir/.test(resumeSrcB))

  // ── (c) it works where .career-out does not exist ──────────────────────────
  // Proved by moving the process into a directory that has no .career-out —
  // never by deleting the real one, which holds the founder's CLI output.
  console.log('(c) a working directory with no .career-out')
  const cwdBefore = process.cwd()
  const elsewhere = makeTempDir('cwd')
  try {
    process.chdir(elsewhere)
    check('.career-out really is absent here', !fs.existsSync(path.join(elsewhere, '.career-out')))
    check('the OLD relative path would have failed', !fs.existsSync(path.resolve(elsewhere, CAREER_OUT)))
    let made: string | null = null
    let error: string | null = null
    try {
      made = makeTempDir('nocwd')
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    check('makeTempDir succeeds anyway', made !== null && fs.existsSync(made), error ?? '')
    check('nothing was written into the working directory', !fs.existsSync(path.join(elsewhere, '.career-out')))
    if (made) removeTempDir(made)
  } finally {
    process.chdir(cwdBefore)
    removeTempDir(elsewhere)
  }

  // ── (d) concurrency ───────────────────────────────────────────────────────
  console.log('(d) concurrent builds never collide')
  const many = await Promise.all(Array.from({ length: 8 }, () => Promise.resolve().then(() => makeTempDir('pkg'))))
  check('eight concurrent dirs are eight distinct dirs', new Set(many).size === 8, many.join(' '))
  check('all eight exist', many.every((d) => fs.existsSync(d)))
  for (const d of many) removeTempDir(d)
  check('all eight removed', many.every((d) => !fs.existsSync(d)))

  // ── (e) withTempDir always cleans up ──────────────────────────────────────
  console.log('(e) withTempDir')
  let seen: string | null = null
  const value = await withTempDir('ok', async (d) => {
    seen = d
    fs.writeFileSync(path.join(d, 'a.txt'), 'x')
    return 42
  })
  check('withTempDir returns the callback value', value === 42)
  check('withTempDir removes the directory after success', seen !== null && !fs.existsSync(seen as string), String(seen))

  let thrownDir: string | null = null
  let thrown: string | null = null
  try {
    await withTempDir('boom', async (d) => {
      thrownDir = d
      fs.writeFileSync(path.join(d, 'a.txt'), 'x')
      throw new Error('the original failure')
    })
  } catch (e) {
    thrown = e instanceof Error ? e.message : String(e)
  }
  check('the original error propagates', thrown === 'the original failure', String(thrown))
  check('withTempDir removes the directory after a throw', thrownDir !== null && !fs.existsSync(thrownDir as string), String(thrownDir))

  // ── (f) a cleanup failure never masks the real error ──────────────────────
  // Forced through the real code path: the callback moves the temp root, so
  // the directory it was handed is suddenly outside it and removeTempDir
  // refuses — exactly the shape of a cleanup that cannot complete.
  console.log('(f) cleanup failure does not mask the original error')
  const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'career-decoy-'))
  const cleanupErrors: string[] = []
  let leaked: string | null = null
  let masked: string | null = null
  try {
    await withTempDir(
      'masked',
      async (d) => {
        leaked = d
        process.env.CAREER_TMP_DIR = decoy
        throw new Error('the real reason the build failed')
      },
      (e) => cleanupErrors.push(e.message)
    )
  } catch (e) {
    masked = e instanceof Error ? e.message : String(e)
  } finally {
    delete process.env.CAREER_TMP_DIR
  }
  check('the original exception survives a failed cleanup', masked === 'the real reason the build failed', String(masked))
  check('the cleanup failure is reported as a warning', cleanupErrors.length === 1 && /refusing to remove/.test(cleanupErrors[0]), cleanupErrors.join(' | '))
  check('removeTempDir never throws for a path outside the root', removeTempDir(path.resolve(os.homedir(), 'definitely-not-ours')) instanceof Error)
  check('removeTempDir tolerates null and a missing dir', removeTempDir(null) === null && removeTempDir(path.join(root, 'never-existed')) === null)
  if (leaked) removeTempDir(leaked)
  fs.rmSync(decoy, { recursive: true, force: true })

  // ── (g) CAREER_TMP_DIR override ───────────────────────────────────────────
  console.log('(g) CAREER_TMP_DIR')
  const override = fs.mkdtempSync(path.join(os.tmpdir(), 'career-override-'))
  process.env.CAREER_TMP_DIR = override
  const inOverride = makeTempDir('ovr')
  check('the override wins', inOverride.startsWith(path.resolve(override) + path.sep), inOverride)
  check('isTempPath sees the override root', isTempPath(inOverride), inOverride)
  removeTempDir(inOverride)
  delete process.env.CAREER_TMP_DIR
  fs.rmSync(override, { recursive: true, force: true })

  // ── (h) isTempPath ────────────────────────────────────────────────────────
  console.log('(h) isTempPath')
  check('an os-temp path is a temp path', isTempPath(dir), dir)
  check('a file inside a scratch dir is a temp path', isTempPath(path.join(dir, 'attempt-0.pdf')))
  check('a "local:" storage path is not', !isTempPath('local:user-1/packages/pkg-1/v1/Zuyu_Liu_Acme_Resume.docx'))
  check('a "supabase:" storage path is not', !isTempPath('supabase:career-docs/user-1/packages/pkg-1/v1/x.docx'))
  check('a relative .career-out path is not', !isTempPath(path.join('.career-out', 'packages', 'cli', 'x.docx')))
  check('an absolute non-temp path is not', !isTempPath(path.resolve('Zuyu_Resume.docx')))
  check('null is not', !isTempPath(null) && !isTempPath(''))
  check('a "local:" path pointing INTO temp is caught', isTempPath(`local:${dir}`), dir)
  // Windows spells the same directory several ways. The guard is the only
  // thing between scratch and application_packages, so it must not be fooled
  // by capitalisation on the platform this runs on.
  if (process.platform === 'win32') {
    check('a case-differing temp path is still a temp path', isTempPath(dir.toLowerCase()) && isTempPath(dir.toUpperCase()), dir)
    check('case-insensitivity does not make a non-temp path temp', !isTempPath(path.resolve('Zuyu_Resume.docx').toLowerCase()))
  }
  // A sibling that merely starts with the root's name is not inside it.
  check('a path that only shares the root as a prefix is not a temp path', !isTempPath(`${root}-not-ours`), root)
  removeTempDir(dir)

  // ── (i) the source of the bug is gone ─────────────────────────────────────
  console.log('(i) no relative scratch path remains in the document layer')
  const pdfSrc = fs.readFileSync(path.resolve('lib/career/documents/pdf.ts'), 'utf8')
  const resumeSrc = fs.readFileSync(path.resolve('lib/career/package/resume.ts'), 'utf8')
  const letterSrc = fs.readFileSync(path.resolve('lib/career/package/letter.ts'), 'utf8')
  check('pdf.ts no longer exports TMP_DIR', !/export const TMP_DIR/.test(pdfSrc))
  check('pdf.ts writes no scratch under .career-out', !/['"]\.career-out['"]/.test(pdfSrc), 'a .career-out literal is back in pdf.ts')
  check('resume.ts writes no scratch under .career-out', !/['"]\.career-out['"]/.test(resumeSrc))
  check('letter.ts writes no scratch under .career-out', !/['"]\.career-out['"]/.test(letterSrc))

  if (originalOverride !== undefined) process.env.CAREER_TMP_DIR = originalOverride

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed) {
    for (const f of failures) console.log(`  - ${f}`)
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
