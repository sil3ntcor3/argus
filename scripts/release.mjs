#!/usr/bin/env node
//
// Stamp package versions, tag the release commit and hand it to CI.
//
//   node scripts/release.mjs v0.9.0
//   node scripts/release.mjs 0.9.0            # the `v` prefix is added for you
//   node scripts/release.mjs v0.9.0 --dry-run
//   node scripts/release.mjs v0.9.0 --skip-checks
//
// Everything CI needs is derived from the tag: build-release.yml triggers on
// `push: tags: ['v*']`, and the changelog action resolves its own from-tag from
// the semver sequence. The release commit and tag are pushed together. The
// workflow builds the binaries, images and draft release from that tag. The draft stays a draft: publishing it is a deliberate human
// click in the UI, because `release: types: [published]` is not wired up.
//
// The pre-flight exists because nothing else guards the tag: pre-commit is
// inert in this repo, and a published tag is already a release input.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// --- terminal ---------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code) => (s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : String(s))
const bold = paint('1')
const dim = paint('2')
const red = paint('31')
const green = paint('32')
const yellow = paint('33')
const cyan = paint('36')

// --- git --------------------------------------------------------------------

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (err) {
    if (allowFail) return null
    fail(`git ${args.join(' ')} failed:\n${(err.stderr || err.message).toString().trim()}`)
  }
}

function currentTags() {
  return (git(['tag', '--list'], { allowFail: true }) || '').split('\n').filter(Boolean)
}

function remoteDefaultBranch() {
  const output = git(['ls-remote', '--symref', 'origin', 'HEAD'])
  return /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(output)?.[1] || null
}

// --- output -----------------------------------------------------------------

const problems = []
const notes = []

function fail(message) {
  console.error(`\n${red('✗ ' + message)}\n`)
  process.exit(1)
}

function heading(text) {
  console.log(`\n${bold(text)}`)
}

function ok(text) {
  console.log(`  ${green('✓')} ${text}`)
}

function warn(text) {
  notes.push(text)
  console.log(`  ${yellow('!')} ${text}`)
}

function detail(text) {
  console.log(`    ${dim(text)}`)
}

function usage() {
  console.log(`
${bold('Usage')}  task release -- v0.9.0 [options]
       task release version=v0.9.0 [options]  (VERSION= works too)

  The \`--\` is required by go-task: it treats a bare \`task release v0.9.0\` as a
  request for a task literally named \`v0.9.0\`. Both the \`--\` form and the
  \`version=\` form work; the latter is the one to use for a message with spaces.

  v0.9.0               Release version. \`v\` is added when missing: 0.9.0 -> v0.9.0
  patch|minor|major    Bump the newest semver tag fetched from origin
                       (increments its numeric version; name a version to promote a prerelease)
  --dry-run            Run every check and show the release plan without writing it
  --skip-checks        Do not run \`task lint\` / \`task test\` first
  --branch NAME        Branch the release must be cut from (default: remote HEAD)
  --all                Include bot bumps and the ci/style types
  --notes-only         Just render the notes for a range, then exit. No
                       pre-flight, no checks, no tag, no push. This is what CI
                       uses to fill in the release body.
  --from REF           Start of the range (default: newest tag older than --to)
  --to REF             End of the range (default: HEAD)
  --notes-file PATH    Also write the notes to PATH

  Equivalent task variables, for values that contain spaces:
  DRY_RUN=1  SKIP_CHECKS=1  BRANCH=main  MESSAGE="Release v0.9.0"  ALL=1
`)
}

// --- semver -----------------------------------------------------------------

// Enough of semver to order this repo's own tags: major.minor.patch, an
// optional -prerelease, and optional +build metadata (ignored, as semver says).
function parseVersion(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(tag)
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null }
}

function comparePrerelease(a, b) {
  if (a === b) return 0
  if (a === null) return 1 // a release outranks any prerelease
  if (b === null) return -1
  const as = a.split('.')
  const bs = b.split('.')
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i]
    const y = bs[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      if (+x !== +y) return +x < +y ? -1 : 1
      continue
    }
    if (xn !== yn) return xn ? -1 : 1 // numeric identifiers rank below alphanumeric
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

function compareVersions(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  return comparePrerelease(a.pre, b.pre)
}

function bumpVersion(from, kind) {
  const { major, minor, patch } = parseVersion(from)
  if (kind === 'major') return `v${major + 1}.0.0`
  if (kind === 'minor') return `v${major}.${minor + 1}.0`
  return `v${major}.${minor}.${patch + 1}`
}

// Keep publication tags compatible with build-release.yml.
function validReleaseTag(tag) {
  return tag.length <= 128 &&
    /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$/.test(tag) &&
    [parseVersion(tag).major, parseVersion(tag).minor, parseVersion(tag).patch].every(Number.isSafeInteger)
}

function newestSemver(tags) {
  return tags.filter(validReleaseTag).sort((a, b) =>
    compareVersions(parseVersion(b), parseVersion(a)),
  )[0] || null
}

// --- package metadata -------------------------------------------------------

function planPackages(version) {
  return ['console/package.json', 'core-api/package.json'].flatMap((path) => {
    try {
      const file = resolve(ROOT, path)
      const before = readFileSync(file, 'utf8')
      const { version: originalVersion, ...fields } = JSON.parse(before)
      const pattern = /(^[ \t]*"version"[ \t]*:[ \t]*)"(?:[^"\\\r\n]|\\.)*"/gm
      if (typeof originalVersion !== 'string' || [...before.matchAll(pattern)].length !== 1) {
        throw new Error('expected one version field on its own line')
      }
      const after = before.replace(pattern, (_line, prefix) => prefix + JSON.stringify(version))
      const { version: stampedVersion, ...stampedFields } = JSON.parse(after)
      if (stampedVersion !== version || JSON.stringify(stampedFields) !== JSON.stringify(fields)) {
        throw new Error('could not update only the package version')
      }
      return before === after ? [] : [{ path, file, before, after }]
    } catch (error) {
      fail('cannot stamp ' + path + ': ' + error.message)
    }
  })
}

function commitPackages(packages, head, tag) {
  if (!packages.length) return head
  const paths = packages.map(({ path }) => path)
  const written = []
  try {
    // Git filters can normalize the working copy (for example CRLF to LF).
    // Compute all planned blobs before touching either manifest.
    const planned = packages.map((item) => ({
      ...item,
      blob: execFileSync('git', ['hash-object', '--path=' + item.path, '--stdin'],
        { cwd: ROOT, encoding: 'utf8', input: item.after }).trim(),
    }))
    for (const item of planned) {
      if (readFileSync(item.file, 'utf8') !== item.before) {
        throw new Error(item.path + ' changed since planning')
      }
      writeFileSync(item.file, item.after)
      written.push(item)
    }
    execFileSync('git', ['commit', '--only', '-m', 'chore(release): stamp ' + tag, '--', ...paths],
      { cwd: ROOT, stdio: 'inherit' })
  } catch (error) {
    // Don't overwrite a concurrent edit or unwind a commit made by a hook.
    if (git(['rev-parse', 'HEAD']) === head) {
      for (const item of written) {
        if (existsSync(item.file) && readFileSync(item.file, 'utf8') === item.after) writeFileSync(item.file, item.before)
      }
    }
    fail('package version commit failed; no release tag was created: ' + error.message)
  }
  const commit = git(['rev-parse', 'HEAD'])
  if (git(['rev-parse', commit + '^']) !== head ||
      git(['diff', '--name-only', head, commit]).split('\n').sort().join('\n') !== paths.join('\n') ||
      written.some(({ path, file, after, blob }) =>
        git(['rev-parse', commit + ':' + path]) !== blob || readFileSync(file, 'utf8') !== after) ||
      git(['status', '--porcelain'])) {
    fail('release commit did not match the package plan; inspect it before tagging')
  }
  return commit
}

// --- release notes ----------------------------------------------------------

// Section order, titles and grouping follow gin-gonic/gin's release notes, which
// is the clearest conventional-commits rendering in the wild: a fixed set of
// headings, the commit subject left exactly as written, and anything
// unrecognised collected under "Others".
const CATEGORIES = [
  { types: ['feat'], title: 'Features' },
  { types: ['fix', 'hot-fix'], title: 'Bug fixes' },
  { types: ['chore'], title: 'Enhancements' },
  { types: ['refactor'], title: 'Refactor' },
  { types: ['ci'], title: 'Build process updates' },
  { types: ['docs'], title: 'Documentation updates' },
  { types: ['perf', 'test'], title: 'Others' },
]

// Hidden by default. Bot bumps are dependency churn rather than a change
// anyone reads a release for, and these two types are noise in a changelog.
// `task release --all` opts back in.
const BOT_AUTHOR = /^(dependabot|github-actions|renovate)(\[bot\])?$/
const HIDDEN_TYPES = new Set(['ci', 'style'])

const SUBJECT = /^([a-zA-Z][a-zA-Z-]*)?(\([^)]*\))?(!)?:\s*([\s\S]+)$/

// GitHub autolinks a bare 40-char sha to /commit/<sha> (displaying 7 chars) and
// a bare @login to the profile, which is why gin's stored body needs no explicit
// links. That only works for the login, not the display name, so the login is
// recovered from the noreply address when there is one.
function authorLogin(name, email) {
  const noreply = /^[0-9]+\+([A-Za-z0-9._-]+)@users\.noreply\.github\.com$/.exec(email || '')
  if (noreply) return noreply[1]
  if (name && /^[A-Za-z0-9._-]+(\[bot\])?$/.test(name)) return name
  return null
}

function commitType(subject) {
  const m = SUBJECT.exec(subject)
  return m && m[1] ? m[1].toLowerCase() : null
}

function formatLine({ sha, name, email, subject }) {
  const login = authorLogin(name, email)
  // The PR reference is already in the subject: GitHub's squash merge appends
  // "(#1234)", so it only needs to survive into the body to become a link.
  return `* ${sha}: ${subject}${login ? ` (@${login})` : ''}`
}

function renderNotes(from, to, { includeBots = false } = {}) {
  const range = from ? `${from}..${to}` : to
  const raw = git(['log', '--no-merges', '--reverse', '--format=%H%x1f%an%x1f%ae%x1f%s%x1e', range], { allowFail: true })

  const commits = (raw || '')
    .split('\x1e')
    .map((c) => c.replace(/^[\s\x1f]+/, '').replace(/[\s\x1f]+$/, ''))
    .filter(Boolean)
    .map((chunk) => {
      const [sha, name, email, subject = ''] = chunk.split('\x1f')
      return { sha, name, email, subject: subject.trim() }
    })

  const buckets = CATEGORIES.map((c) => ({ title: c.title, types: c.types, items: [] }))
  const others = buckets[buckets.length - 1] // "Others" is the catch-all
  const hidden = { bots: 0, types: 0 }

  for (const commit of commits) {
    const type = commitType(commit.subject)
    const login = authorLogin(commit.name, commit.email)
    if (!includeBots && (BOT_AUTHOR.test(commit.name) || BOT_AUTHOR.test(login || ''))) {
      hidden.bots++
      continue
    }
    if (!includeBots && (HIDDEN_TYPES.has(type) || commit.subject.startsWith('chore(release): stamp v'))) {
      hidden.types++
      continue
    }
    const bucket = (type && buckets.find((b) => b.types.includes(type))) || others
    bucket.items.push(formatLine(commit))
  }

  const sections = buckets.filter((b) => b.items.length > 0)
  if (sections.length === 0) {
    return { text: '## Changelog\n\n_No user-facing changes in this release._\n', shown: 0, hidden }
  }

  const lines = ['## Changelog']
  for (const section of sections) {
    lines.push('', `### ${section.title}`, '', ...section.items)
  }
  return { text: lines.join('\n') + '\n', shown: commits.length - hidden.bots - hidden.types, hidden }
}

// The highest semver tag strictly older than `to`. In CI the tag that triggered
// the run is already present in the checkout, so "the newest tag" would be the
// release itself and the range would be empty.
function resolveFrom(to) {
  const ceiling = parseVersion(to)
  const candidates = (git(['tag', '--list'], { allowFail: true }) || '').split('\n').filter((t) => {
    const v = parseVersion(t)
    return v && (!ceiling || compareVersions(v, ceiling) < 0)
  })
  if (candidates.length === 0) return null
  return candidates.sort((a, b) => compareVersions(parseVersion(b), parseVersion(a)))[0]
}

function revParse(ref) {
  return git(['rev-parse', '--verify', '--quiet', ref + '^{commit}'], { allowFail: true })
}

// A ref that does not resolve makes `git log` fail, and that failure is swallowed
// further down — which surfaces as an empty release rather than an error. A
// version that is not tagged yet is a legitimate preview request, so it falls
// back to HEAD; anything else is a typo and has to stop the run.
function resolveTo(ref) {
  if (!ref) return 'HEAD'
  if (revParse(ref)) return ref
  if (parseVersion(ref)) {
    console.error(dim("'" + ref + "' is not a tag yet — previewing against HEAD instead"))
    return 'HEAD'
  }
  fail("--to '" + ref + "' does not resolve to a commit")
}

// --- arguments --------------------------------------------------------------

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  usage()
  process.exit(0)
}

const flags = new Set(argv.filter((a) => a.startsWith('--')))
let message = null
let branchOverride = null
let fromRef = null
let toRef = null
let notesFile = null
const positional = []
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '--message') message = argv[++i]
  else if (arg === '--branch') branchOverride = argv[++i]
  else if (arg === '--from') fromRef = argv[++i]
  else if (arg === '--to') toRef = argv[++i]
  else if (arg === '--notes-file') notesFile = argv[++i]
  else if (!arg.startsWith('--')) positional.push(arg)
}

// go-task variables are single strings, so they are read as a word list and
// merged with the argv that `task release -- ...` forwards. The env form wins:
// it is the only one that survives a value with spaces.
const env = (name) => (process.env[name] || '').trim()
const envWords = (name) => env(name).split(/\s+/).filter(Boolean)
const truthy = (name) => env(name) && /^(1|true|yes|on)$/i.test(env(name))

if (message === null && env('RELEASE_MESSAGE')) message = env('RELEASE_MESSAGE')
if (branchOverride === null && env('RELEASE_BRANCH')) branchOverride = env('RELEASE_BRANCH')
if (fromRef === null && env('RELEASE_FROM')) fromRef = env('RELEASE_FROM')
if (toRef === null && env('RELEASE_TO')) toRef = env('RELEASE_TO')
if (notesFile === null && env('RELEASE_NOTES_FILE')) notesFile = env('RELEASE_NOTES_FILE')
if (truthy('RELEASE_DRY_RUN')) flags.add('--dry-run')
if (truthy('RELEASE_SKIP_CHECKS')) flags.add('--skip-checks')
if (truthy('RELEASE_ALL')) flags.add('--all')
if (env('RELEASE_VERSION')) positional.unshift(env('RELEASE_VERSION'))
for (const word of envWords('RELEASE_ARGS')) {
  if (word.startsWith('--')) flags.add(word)
  else positional.push(word)
}

const dryRun = flags.has('--dry-run')
const skipChecks = flags.has('--skip-checks')
const notesOnly = flags.has('--notes-only')
const includeBots = flags.has('--all')

// --- notes-only -------------------------------------------------------------
// The path CI takes: no pre-flight, nothing is written to git, just the markdown
// that becomes the release body. Never fall through into release creation.
if (notesOnly) {
  if (positional.length) fail('--notes-only cannot be combined with a release version; use --to REF')
  const to = resolveTo(toRef)
  const from = fromRef || resolveFrom(to)
  if (from && !revParse(from)) fail("--from '" + from + "' does not resolve to a commit")
  const { text, shown, hidden } = renderNotes(from, to, { includeBots })
  if (hidden.bots || hidden.types) {
    console.error(dim(`hidden ${hidden.bots} bot commit(s), ${hidden.types} maintenance commit(s) — pass --all to include`))
  }
  process.stdout.write(text)
  if (notesFile) {
    writeFileSync(resolve(ROOT, notesFile), text)
    console.error(dim(`wrote ${notesFile} (${shown} entries)`))
  }
  process.exit(0)
}

if (positional.length === 0) {
  usage()
  fail('VERSION is required: task release -- v0.9.0')
}
if (positional.length > 1) fail(`expected one VERSION, got: ${positional.join(', ')}`)

const requested = positional[0]
const bump = ['patch', 'minor', 'major'].includes(requested)
let tag = bump ? null : (requested.startsWith('v') ? requested : 'v' + requested)
if (tag && tag !== requested) {
  console.log(`${dim(`normalising ${requested} -> ${tag}`)}`)
}

if (tag && !validReleaseTag(tag)) {
  fail('expected a release tag vMAJOR.MINOR.PATCH[-PRERELEASE] up to 128 characters, without build metadata or leading zeros')
}

// --- pre-flight -------------------------------------------------------------

heading('Pre-flight')

if (!existsSync(resolve(ROOT, '.git'))) fail('not a git repository')
if (!git(['remote', 'get-url', 'origin'], { allowFail: true })) fail('no `origin` remote configured')

// Fetch release history without deleting local recovery tags. Select the
// version from origin's refs so local-only tags cannot change a version bump.
git(['fetch', 'origin', '--tags', '--no-prune', '--no-prune-tags', '--quiet'])
const existingTags = new Set(currentTags())
const remoteTags = new Map(
  git(['ls-remote', '--refs', 'origin', 'refs/tags/*']).split('\n').filter(Boolean).map((line) => {
    const [oid, ref] = line.split('\t')
    return [ref.slice('refs/tags/'.length), oid]
  }),
)

const branch = branchOverride || remoteDefaultBranch()
if (!branch) fail('origin did not advertise its default branch; use --branch NAME')

const dirty = git(['status', '--porcelain'], { allowFail: true })
if (dirty) {
  console.error(`\n${red('✗ working tree is not clean')}\n`)
  console.error(dirty.split('\n').slice(0, 20).map((l) => '    ' + l).join('\n'))
  const more = dirty.split('\n').length
  if (more > 20) console.error(dim(`    ... and ${more - 20} more`))
  console.error(`\n  ${dim('Commit or stash these first. A tag has to point at a commit that exists everywhere.')}\n`)
  process.exit(1)
}

const currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true })
if (currentBranch !== branch) {
  problems.push(`on branch \`${currentBranch}\`, expected \`${branch}\``)
} else {
  ok(`on \`${branch}\``)
}

const head = git(['rev-parse', 'HEAD'], { allowFail: true })
const releaseBranchRef = `refs/heads/${branch}`
const upstream = git(['ls-remote', '--refs', 'origin', releaseBranchRef]).split('\t')[0] || null
if (upstream === null) {
  problems.push(`\`origin/${branch}\` does not exist — has it been pushed?`)
} else if (head !== upstream) {
  const ahead = +(git(['rev-list', '--count', `${upstream}..HEAD`], { allowFail: true }) || 0)
  const behind = +(git(['rev-list', '--count', `HEAD..${upstream}`], { allowFail: true }) || 0)
  problems.push(
    `HEAD diverges from \`origin/${branch}\`` + (ahead ? ` (${ahead} unpushed commit(s))` : '') + (behind ? ` (${behind} commit(s) behind)` : '')
  )
} else {
  ok(`HEAD matches \`origin/${branch}\``)
}

const newest = newestSemver([...remoteTags.keys()])
if (bump) {
  if (!newest) fail('no semver tag on origin; specify the first release version explicitly')
  tag = bumpVersion(newest, requested)
  ok(`${requested} bump: ${newest} -> ${tag}`)
}
if (!validReleaseTag(tag)) fail('the version bump cannot produce a valid release tag')
if (git(['check-ref-format', 'refs/tags/' + tag], { allowFail: true }) === null) {
  fail('expected a release tag usable as a Git reference')
}
const target = parseVersion(tag)
if (existingTags.has(tag)) problems.push(`tag \`${tag}\` already exists locally`)
if (remoteTags.has(tag)) problems.push(`tag \`${tag}\` already exists on the remote`)

// `--from` overrides which tag the notes start at, for a re-release of an
// older range. Otherwise the range is "everything since the newest tag".
const latest = fromRef || newest
const latestTagRef = latest ? `refs/tags/${latest}` : null
const latestTagOid = latest ? remoteTags.get(latest) : null
if (latestTagOid && git(['rev-parse', '--verify', latestTagRef], { allowFail: true }) !== latestTagOid) {
  fail('release tags changed after fetch; retry from current origin tags')
}
if (fromRef) {
  if (!remoteTags.has(fromRef)) problems.push(`--from \`${fromRef}\` is not a tag on origin`)
  else ok(`notes start at ${fromRef}`)
} else if (newest) {
  if (compareVersions(target, parseVersion(newest)) <= 0) {
    problems.push(`\`${tag}\` is not newer than the latest tag \`${newest}\``)
  } else {
    ok(`${tag} is newer than ${newest}`)
  }
} else {
  warn('no semver tag found in this clone — this will be the first')
}

if (problems.length > 0) {
  console.error(`\n${red('✗ cannot release yet')}\n`)
  for (const p of problems) console.error(`  ${red('•')} ${p}`)
  console.error('')
  process.exit(1)
}

// --- checks -----------------------------------------------------------------

if (!skipChecks) {
  heading('Checks')
  // `task lint` runs eslint with --fix, so it can dirty the tree. That is why
  // it runs before the cleanliness re-check below rather than after the tag.
  for (const t of ['lint', 'test']) {
    detail(`task ${t}`)
    const res = spawnSync('task', [t], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
    if (res.status !== 0) fail(`\`task ${t}\` failed — release aborted before anything was tagged or pushed`)
  }

  // Re-check: lint's --fix may have rewritten files, and tagging now would
  // release a commit that is missing those changes while the tree still holds
  // them.
  const after = git(['status', '--porcelain'], { allowFail: true })
  if (after) {
    fail(
      'the checks modified the working tree — review and commit the changes, then run the release again:\n' +
        after.split('\n').map((l) => '    ' + l).join('\n')
    )
  }
  ok('tree still clean after lint + test')
} else {
  heading('Checks')
  warn('skipped via --skip-checks — the release is unverified')
}

// Checks and commit hooks may take long enough for origin to change.
function assertReleaseRefsUnchanged(when) {
  const refs = new Map(
    git(['ls-remote', '--refs', 'origin', releaseBranchRef, 'refs/tags/*'])
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, ref] = line.split('\t')
        return [ref, sha]
      }),
  )
  if (refs.get(releaseBranchRef) !== head || (!branchOverride && remoteDefaultBranch() !== branch)) {
    fail('release branch changed ' + when + '; inspect origin before retrying')
  }
  const originTags = [...refs.keys()].filter((ref) => ref.startsWith('refs/tags/'))
    .map((ref) => ref.slice('refs/tags/'.length))
  if (originTags.includes(tag) || newestSemver(originTags) !== newest ||
      (latestTagRef && (refs.get(latestTagRef) !== latestTagOid ||
        git(['rev-parse', '--verify', latestTagRef], { allowFail: true }) !== latestTagOid))) {
    fail('release tags changed ' + when + '; inspect origin before retrying')
  }
}

if (git(['rev-parse', 'HEAD']) !== head || git(['rev-parse', '--abbrev-ref', 'HEAD']) !== branch) {
  fail('release branch changed during checks; sync with origin and retry')
}
assertReleaseRefsUnchanged('during checks')

// --- the notes --------------------------------------------------------------

// The range ends at the commit being tagged, not at the tag: the tag does not
// exist yet at this point, so `v0.8.1..v0.9.0` fails to resolve and silently
// reports an empty release.
const changelog = renderNotes(latest, resolveTo(toRef || head), { includeBots })
const commitCount = +(git(['rev-list', '--count', latest ? `${latest}..${toRef || head}` : head], { allowFail: true }) || 0)

// The tag message is the changelog itself, so `git show v0.9.0` carries the same
// notes as the release page. CI feeds the identical text to the release body via
// --notes-only, which keeps one implementation and no way for the two to drift.
let tagMessage = message
if (!tagMessage) tagMessage = changelog.text

if (changelog.hidden.bots || changelog.hidden.types) {
  warn(`hidden ${changelog.hidden.bots} bot commit(s) and ${changelog.hidden.types} ci/style commit(s) — \`--all\` includes them`)
}

heading('Release')
ok(`${tag}  ${dim(`${commitCount} commit(s) since ${latest ?? 'the beginning'}`)}`)
console.log(`\n${dim(changelog.text)}`)

const slug = (git(['config', '--get', 'remote.origin.url'], { allowFail: true }) || '').match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?$/)
const runUrl = slug ? `https://github.com/${slug[1]}/${slug[2]}/actions/workflows/build-release.yml` : null

const packages = planPackages(tag.slice(1))
const tagRef = 'refs/tags/' + tag
// The commit is verified as a direct child of head (or head itself). The
// exact lease rejects a branch reset or deletion after the last read.
const branchLease = '--force-with-lease=' + releaseBranchRef + ':' + head
if (dryRun) {
  heading('Dry run')
  if (packages.length) {
    detail('stamp ' + packages.map(({ path }) => path).join(' and '))
    detail('commit only the stamped manifests')
  }
  detail('git tag -a ' + tag + ' --cleanup=whitespace -F <msg> ' +
    (packages.length ? '<release-commit>' : head.slice(0, 7)))
  detail('git push --atomic --no-follow-tags ' + branchLease + ' origin <release-commit>:' + releaseBranchRef + ' <tag-object>:' + tagRef)
  console.log(`\n${yellow('nothing was tagged or pushed')}`)
  if (runUrl) console.log(`${dim('CI will run at')} ${runUrl}\n`)
  process.exit(0)
}

heading('Publish')
if (git(['status', '--porcelain']) || git(['rev-parse', 'HEAD']) !== head ||
    git(['rev-parse', '--abbrev-ref', 'HEAD']) !== branch) {
  fail('worktree changed before stamping packages; inspect it and retry')
}
const releaseCommit = commitPackages(packages, head, tag)
if (packages.length) ok('committed package versions at ' + releaseCommit.slice(0, 7))

// `--cleanup=whitespace` is load-bearing. `git tag -m/-F` defaults to
// `--cleanup=strip`, which deletes every line starting with `#` — that silently
// eats the `## Changelog` and `### Features` headings and leaves a tag message
// of bare bullets. The message also goes through a file rather than `-m`: a
// long release would otherwise run into the OS argument-length limit, and
// execFileSync has no shell to expand or quote through.
const msgDir = mkdtempSync(resolve(tmpdir(), 'argus-release-'))
const msgFile = resolve(msgDir, 'message.md')
detail('git tag -a ' + tag + ' --cleanup=whitespace -F <msg> ' + releaseCommit.slice(0, 7))
let tagResult
try {
  writeFileSync(msgFile, tagMessage)
  tagResult = spawnSync('git', ['tag', '-a', tag, '--cleanup=whitespace', '-F', msgFile, releaseCommit],
    { cwd: ROOT, stdio: 'inherit' })
} finally {
  rmSync(msgDir, { recursive: true, force: true })
}
if (tagResult.status !== 0) fail('could not tag the local release commit ' + releaseCommit)
ok('tagged ' + tag + ' at ' + releaseCommit.slice(0, 7))

const tagObject = git(['rev-parse', '--verify', tagRef + '^{tag}'])
if (git(['rev-parse', tagObject + '^{commit}']) !== releaseCommit) {
  fail('local release tag does not point at the verified release commit')
}
assertReleaseRefsUnchanged('before publication')
const pushArgs = ['push', '--atomic', '--no-follow-tags', branchLease, 'origin',
  releaseCommit + ':' + releaseBranchRef, tagObject + ':' + tagRef]
detail('git ' + pushArgs.join(' '))
try {
  execFileSync('git', pushArgs, { cwd: ROOT, stdio: 'inherit' })
} catch {
  fail('atomic release push failed; the local commit and tag are intact. To retry: git ' + pushArgs.join(' '))
}
ok('pushed ' + branch + ' and ' + tag + ' together')

console.log(`\n${bold('Next')}`)
console.log(`  1. CI is building now ${runUrl ? dim('(' + runUrl + ')') : ''}`)
console.log(`     ${dim('worker binaries + draft release + 3 multi-arch images')}`)
console.log(`  2. Review the draft release: ${dim('releases → ' + tag)}`)
console.log(`  3. Publish it ${dim('(the workflow deliberately leaves it as a draft)')}`)
if (notes.length > 0) {
  console.log('')
  for (const n of notes) console.log(`  ${yellow('!')} ${n}`)
}
console.log('')
