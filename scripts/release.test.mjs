import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(GIT_|RELEASE_)/.test(key)),
  ),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Argus release test',
  GIT_AUTHOR_EMAIL: 'release@example.test',
  GIT_COMMITTER_NAME: 'Argus release test',
  GIT_COMMITTER_EMAIL: 'release@example.test',
  NO_COLOR: '1',
}

function run(cwd, command, args) {
  return spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 15_000 })
}

function git(cwd, ...args) {
  const result = run(cwd, 'git', args)
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function fixture(t, tags = []) {
  const temp = mkdtempSync(join(tmpdir(), 'argus-release-test-'))
  t.after(() => rmSync(temp, { force: true, recursive: true }))
  const origin = join(temp, 'remote.git')
  const checkout = join(temp, 'checkout')
  git(temp, 'init', '--bare', '--initial-branch=main', origin)
  git(temp, 'clone', origin, checkout)
  assert.equal(git(checkout, 'remote', 'get-url', 'origin'), origin)
  const files = [
    'taskfile.yml', 'core-api/taskfile.yml', 'console/taskfile.yml',
    'worker/taskfile.yml', 'scripts/release.mjs',
    'core-api/package.json', 'console/package.json',
  ]
  for (const file of files) {
    const path = join(checkout, file)
    mkdirSync(dirname(path), { recursive: true })
    copyFileSync(join(root, file), path)
  }
  git(checkout, 'add', '--', ...files)
  git(checkout, 'commit', '-m', 'feat: release fixture')
  for (const tag of tags) git(checkout, 'tag', tag)
  git(checkout, 'push', 'origin', 'main', '--tags')
  const dryRun = (...args) => run(checkout, 'task', [
    'release', 'DRY_RUN=1', 'SKIP_CHECKS=1', ...args,
  ])
  return { origin, checkout, dryRun }
}

test('chooses the semver bump from fresh tags without tagging or pushing', (t) => {
  const { checkout, origin, dryRun } = fixture(t, ['v1.2.9', 'v1.10.3'])
  const head = git(checkout, 'rev-parse', 'HEAD')
  // Simulate a tag that arrived after this clone was last fetched.
  git(origin, 'tag', 'v1.10.4-rc.1', head)
  const remoteBefore = git(origin, 'show-ref')
  for (const [expected, args] of [
    ['v1.10.5', ['--', 'patch']],
    ['v1.11.0', ['version=minor']],
    ['v2.0.0', ['VERSION=major']],
    ['v1.10.4', ['version=1.10.4']],
  ]) {
    const result = dryRun(...args)
    assert.equal(result.status, 0, result.stderr)
    assert(result.stdout.includes('git tag -a ' + expected + ' '), result.stdout)
  }
  assert.equal(git(origin, 'show-ref'), remoteBefore)
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), head)
  assert.equal(git(checkout, 'status', '--porcelain'), '')
  assert.deepEqual(git(checkout, 'tag', '--list').split('\n'), [
    'v1.10.3', 'v1.10.4-rc.1', 'v1.2.9',
  ])
})

test('requires an explicit version on a repository with no semver tag', (t) => {
  const { dryRun } = fixture(t, ['scratch'])
  const result = dryRun('--', 'patch')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /no semver tag/i)
  assert.equal(dryRun('VERSION=v1.0.0').status, 0)
})

test('refuses to derive a release version when the remote fetch fails', (t) => {
  const { checkout, origin, dryRun } = fixture(t, ['v1.0.0'])
  git(checkout, 'remote', 'set-url', 'origin', origin + '-missing')
  const result = dryRun('--', 'patch')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /git fetch .* failed/i)
})

test('rejects a release version in notes-only mode', (t) => {
  const { origin, dryRun } = fixture(t, ['v1.0.0'])
  const remoteBefore = git(origin, 'show-ref')
  const result = dryRun('version=v1.0.1', '--', '--notes-only')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /notes-only cannot be combined with a release version/i)
  assert.equal(git(origin, 'show-ref'), remoteBefore)
})

test('checks the remote release branch even if the configured fetch omits it', (t) => {
  const { checkout, origin, dryRun } = fixture(t, ['v1.0.0'])
  const old = git(checkout, 'rev-parse', 'HEAD')
  git(origin, 'branch', 'fixture', old)
  const tree = git(origin, 'rev-parse', old + '^{tree}')
  const next = git(origin, 'commit-tree', tree, '-p', old, '-m', 'feat: remote-only change')
  git(origin, 'update-ref', 'refs/heads/main', next)
  git(checkout, 'config', 'remote.origin.fetch', '+refs/heads/fixture:refs/remotes/origin/fixture')
  const result = dryRun('--', 'patch')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /HEAD diverges from `origin\/main`/)
})

test('uses the current remote default branch unless explicitly overridden', (t) => {
  const { checkout, origin, dryRun } = fixture(t, ['v1.0.0'])
  git(checkout, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  git(origin, 'branch', 'next')
  git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/next')
  const result = dryRun('--', 'patch')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /on branch `main`, expected `next`/)
  assert.equal(dryRun('BRANCH=main', '--', 'patch').status, 0)
})

function concurrentChangeFixture(t, lintCommands) {
  const { checkout, origin } = fixture(t, ['v1.0.0'])
  writeFileSync(join(checkout, 'taskfile.yml'), `version: '3'
tasks:
  release:
    cmds:
      - node scripts/release.mjs patch --dry-run
  lint:
    cmds:
${lintCommands.map((command) => '      - ' + command).join('\n')}
  test:
    cmds:
      - 'true'
`)
  git(checkout, 'add', 'taskfile.yml')
  git(checkout, 'commit', '-m', 'test: simulate a concurrent tag')
  git(checkout, 'push', 'origin', 'main')
  return { origin, result: run(checkout, 'task', ['release']) }
}

test('revalidates the tag set after the checks finish', (t) => {
  const { origin, result } = concurrentChangeFixture(t, [
    'git tag v1.0.1', 'git push origin refs/tags/v1.0.1',
  ])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /release tags changed during checks/i)
  assert.deepEqual(git(origin, 'tag', '--list').split('\n'), ['v1.0.0', 'v1.0.1'])
})

test('rejects a moved changelog base even when the newest tag name is unchanged', (t) => {
  const { result } = concurrentChangeFixture(t, [
    'git tag -f v1.0.0', 'git push --force origin refs/tags/v1.0.0',
  ])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /release tags changed during checks/i)
})


const releasePaths = ['console/package.json', 'core-api/package.json']
const packageBytes = (checkout) => releasePaths.map((path) => readFileSync(join(checkout, path), 'utf8'))
const publish = (checkout, version) => run(checkout, 'task', ['release', 'SKIP_CHECKS=1', 'version=' + version])

test('stamps only package versions and atomically publishes the branch and tag', (t) => {
  const { checkout, origin, dryRun } = fixture(t)
  const consoleFile = join(checkout, 'console/package.json')
  writeFileSync(join(checkout, '.gitattributes'), 'console/package.json text eol=crlf\n')
  git(checkout, 'add', '.gitattributes')
  git(checkout, 'commit', '-m', 'test(release): require CRLF in the worktree')
  git(checkout, 'push', 'origin', 'main')
  rmSync(consoleFile)
  git(checkout, 'checkout', '--', 'console/package.json')
  assert.match(packageBytes(checkout)[0], /\r\n/)
  assert.doesNotMatch(git(checkout, 'show', 'HEAD:console/package.json'), /\r\n/)
  git(checkout, 'config', 'push.followTags', 'true')
  git(checkout, 'config', '--add', 'remote.origin.fetch', 'refs/tags/*:refs/tags/*')
  git(checkout, 'tag', '-a', 'v99.0.0', '-m', 'unpublished local tag')
  const original = packageBytes(checkout)
  const head = git(checkout, 'rev-parse', 'HEAD')
  const planned = dryRun('version=v1.2.3')
  assert.equal(planned.status, 0, planned.stderr)
  assert.deepEqual(packageBytes(checkout), original)
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), head)

  const result = publish(checkout, 'v1.2.3')
  assert.equal(result.status, 0, result.stderr)
  const stamped = git(origin, 'rev-parse', 'refs/heads/main')
  assert.equal(git(origin, 'rev-parse', 'refs/tags/v1.2.3^{commit}'), stamped)
  assert.equal(git(checkout, 'rev-parse', 'HEAD^'), head)
  assert.deepEqual(git(checkout, 'diff', '--name-only', 'HEAD^', 'HEAD').split('\n'), releasePaths)
  assert.deepEqual(packageBytes(checkout), original.map((text) =>
    text.replace(/("version": )"[^"]+"/, '$1"1.2.3"')))
  assert.equal(git(checkout, 'status', '--porcelain'), '')
  assert.equal(git(origin, 'tag', '--list'), 'v1.2.3')
  assert.equal(git(checkout, 'tag', '--list', 'v99.0.0'), 'v99.0.0')
})

test('restores both manifests if the release commit is rejected', (t) => {
  const { checkout, origin } = fixture(t)
  const original = packageBytes(checkout)
  const head = git(checkout, 'rev-parse', 'HEAD')
  writeFileSync(join(checkout, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const result = publish(checkout, 'v1.2.3')
  assert.notEqual(result.status, 0)
  assert.deepEqual(packageBytes(checkout), original)
  assert.equal(git(checkout, 'status', '--porcelain'), '')
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), head)
  assert.equal(git(origin, 'tag', '--list'), '')
})

test('a rejected release tag leaves the remote branch unchanged and local release recoverable', (t) => {
  const { checkout, origin } = fixture(t)
  const head = git(origin, 'rev-parse', 'refs/heads/main')
  writeFileSync(join(origin, 'hooks', 'update'),
    '#!/bin/sh\ncase "$1" in refs/tags/*) exit 1;; esac\n', { mode: 0o755 })
  const result = publish(checkout, 'v1.2.3')
  assert.notEqual(result.status, 0)
  assert.equal(git(origin, 'rev-parse', 'refs/heads/main'), head)
  assert.equal(git(origin, 'tag', '--list'), '')
  assert.notEqual(git(checkout, 'rev-parse', 'HEAD'), head)
  assert.equal(git(checkout, 'rev-parse', 'refs/tags/v1.2.3^{commit}'), git(checkout, 'rev-parse', 'HEAD'))
  const retry = run(checkout, 'task', ['release', 'DRY_RUN=1', 'SKIP_CHECKS=1', 'version=v1.2.3'])
  assert.notEqual(retry.status, 0)
  assert.equal(git(checkout, 'tag', '--list'), 'v1.2.3')
})


test('does not resurrect a remote branch reset after release preflight', (t) => {
  const { checkout, origin } = fixture(t)
  const earlier = git(origin, 'rev-parse', 'refs/heads/main')
  git(checkout, 'commit', '--allow-empty', '-m', 'feat(release): newer branch tip')
  git(checkout, 'push', 'origin', 'main')
  writeFileSync(join(checkout, '.git', 'hooks', 'commit-msg'),
    '#!/bin/sh\ngit --git-dir="$(git rev-parse --show-toplevel)/../remote.git" update-ref refs/heads/main ' + earlier + '\n',
    { mode: 0o755 })
  const result = publish(checkout, 'v1.2.3')
  assert.notEqual(result.status, 0)
  assert.equal(git(origin, 'rev-parse', 'refs/heads/main'), earlier)
  assert.equal(git(origin, 'tag', '--list'), '')
  assert.equal(git(checkout, 'rev-parse', 'refs/tags/v1.2.3^{commit}'), git(checkout, 'rev-parse', 'HEAD'))
})


test('refuses tags the release workflow cannot build before changing packages', (t) => {
  const { checkout, origin } = fixture(t)
  const before = packageBytes(checkout)
  const refs = git(origin, 'show-ref')
  for (const tag of ['v1.2.3+build', 'v01.2.3', 'v1.2.3-a..b', 'v1.2.3-rc.lock', 'v1.2.3-' + 'x'.repeat(122)]) {
    const result = publish(checkout, tag)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /expected a release tag/)
  }
  assert.deepEqual(packageBytes(checkout), before)
  assert.equal(git(origin, 'show-ref'), refs)
})


test('does not publish an older release if a newer tag arrives during a hook', (t) => {
  const { checkout, origin } = fixture(t)
  const head = git(origin, 'rev-parse', 'refs/heads/main')
  writeFileSync(join(checkout, '.git', 'hooks', 'commit-msg'),
    '#!/bin/sh\ngit --git-dir="$(git rev-parse --show-toplevel)/../remote.git" tag v1.3.0\n',
    { mode: 0o755 })
  const result = publish(checkout, 'v1.2.3')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /release tags changed before publication/)
  assert.equal(git(origin, 'rev-parse', 'refs/heads/main'), head)
  assert.equal(git(origin, 'tag', '--list'), 'v1.3.0')
  assert.equal(git(checkout, 'tag', '--list'), 'v1.2.3')
})
