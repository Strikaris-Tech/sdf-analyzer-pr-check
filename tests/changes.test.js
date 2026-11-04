// Tests for pull-request change acquisition (src/changes.js). The
// honest way to test diff parsing is against real git: each test
// builds a temporary repository, commits a base, commits a change,
// and reads the change set back through the module.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const { getPullRequestChanges, readBaseVersion, parseDiff } = require('../src/changes')

const exec = promisify(execFile)

async function git(cwd, ...args) {
  const { stdout } = await exec('git', args, { cwd })
  return stdout.trim()
}

async function makeRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-check-changes-'))
  await git(dir, 'init', '-b', 'main')
  await git(dir, 'config', 'user.email', 'test@example.com')
  await git(dir, 'config', 'user.name', 'PR Check Tests')
  return dir
}

async function commitAll(dir, message) {
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '-m', message)
  return git(dir, 'rev-parse', 'HEAD')
}

test('changes: a modified file reports its kind and its added head lines', async () => {
  const dir = await makeRepo()
  await fs.writeFile(path.join(dir, 'a.js'), 'one\ntwo\nthree\nfour\nfive\n')
  const base = await commitAll(dir, 'base')
  // Insert two lines at the top and append one: head lines 1, 2 and 8.
  await fs.writeFile(path.join(dir, 'a.js'), 'new1\nnew2\none\ntwo\nthree\nfour\nfive\nsix\n')
  await commitAll(dir, 'change')

  const result = await getPullRequestChanges({ repoRoot: dir, baseSha: base })
  assert.equal(result.ok, true)
  assert.equal(result.files.length, 1)
  const [f] = result.files
  assert.equal(f.repoPath, 'a.js')
  assert.equal(f.prevRepoPath, 'a.js')
  assert.equal(f.kind, 'modified')
  assert.deepEqual([...f.addedLines].sort((x, y) => x - y), [1, 2, 8])
})

test('changes: added and deleted files carry their kinds', async () => {
  const dir = await makeRepo()
  await fs.writeFile(path.join(dir, 'del.js'), 'gone\n')
  await fs.writeFile(path.join(dir, 'keep.js'), 'keep\n')
  const base = await commitAll(dir, 'base')
  await fs.unlink(path.join(dir, 'del.js'))
  await fs.writeFile(path.join(dir, 'new.js'), 'fresh\n')
  await commitAll(dir, 'change')

  const result = await getPullRequestChanges({ repoRoot: dir, baseSha: base })
  assert.equal(result.ok, true)
  const byPath = new Map(result.files.map((f) => [f.repoPath, f]))
  assert.equal(byPath.get('new.js').kind, 'added')
  assert.equal(byPath.get('new.js').prevRepoPath, null)
  assert.equal(byPath.get('del.js').kind, 'deleted')
  assert.equal(byPath.has('keep.js'), false)
})

test('changes: a rename reports the previous path, and the base reads there', async () => {
  const dir = await makeRepo()
  const original = 'alpha\nbeta\ngamma\n'
  await fs.writeFile(path.join(dir, 'old.js'), original)
  const base = await commitAll(dir, 'base')
  await git(dir, 'mv', 'old.js', 'new.js')
  await fs.writeFile(path.join(dir, 'new.js'), 'alpha\nbeta\ngamma\ndelta\n')
  await commitAll(dir, 'rename')

  const result = await getPullRequestChanges({ repoRoot: dir, baseSha: base })
  assert.equal(result.ok, true)
  const [f] = result.files
  assert.equal(f.kind, 'renamed')
  assert.equal(f.repoPath, 'new.js')
  assert.equal(f.prevRepoPath, 'old.js')
  const baseText = await readBaseVersion({ repoRoot: dir, baseSha: base, repoPath: f.prevRepoPath })
  assert.equal(baseText, original)
})

test('changes: a pure move shows the moved lines as added in the diff', async () => {
  const dir = await makeRepo()
  await fs.writeFile(path.join(dir, 'm.js'), 'aaa\nbbb\nccc\nddd\n')
  const base = await commitAll(dir, 'base')
  await fs.writeFile(path.join(dir, 'm.js'), 'ccc\nddd\naaa\nbbb\n')
  await commitAll(dir, 'move')

  const result = await getPullRequestChanges({ repoRoot: dir, baseSha: base })
  assert.equal(result.ok, true)
  const [f] = result.files
  assert.equal(f.kind, 'modified')
  // The diff itself cannot tell a move from a delete-plus-insert; the
  // subtraction in checks.js is what keeps moved code from reporting.
  assert.ok(f.addedLines.size > 0)
})

test('changes: a shallow clone fetches the named base commit from its remote', async () => {
  const remote = await makeRepo()
  await fs.writeFile(path.join(remote, 's.js'), 'v1\n')
  const base = await commitAll(remote, 'first')
  await fs.writeFile(path.join(remote, 's.js'), 'v1\nv2\n')
  await commitAll(remote, 'second')
  // GitHub permits fetching a reachable commit by its identifier; the
  // local file remote needs the same allowance switched on.
  await git(remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true')

  const cloneDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-check-clone-'))
  await git(cloneDir, 'clone', '--depth', '1', `file://${remote}`, '.')
  // The base commit is genuinely absent from the shallow clone.
  await assert.rejects(() => git(cloneDir, 'cat-file', '-e', `${base}^{commit}`))

  const result = await getPullRequestChanges({ repoRoot: cloneDir, baseSha: base })
  assert.equal(result.ok, true)
  const [f] = result.files
  assert.equal(f.repoPath, 's.js')
  assert.deepEqual([...f.addedLines], [2])
})

test('changes: an unreachable base degrades to a plain reason, never a throw', async () => {
  const dir = await makeRepo()
  await fs.writeFile(path.join(dir, 'a.js'), 'one\n')
  await commitAll(dir, 'base')
  const missing = '0123456789abcdef0123456789abcdef01234567'
  const result = await getPullRequestChanges({ repoRoot: dir, baseSha: missing })
  assert.equal(result.ok, false)
  assert.match(result.reason, /base version/)
})

test('changes: outside a git repository the history failure is a reason, not a throw', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-check-nogit-'))
  const result = await getPullRequestChanges({ repoRoot: dir, baseSha: 'a'.repeat(40) })
  assert.equal(result.ok, false)
  assert.match(result.reason, /history/)
})

test('changes: readBaseVersion throws for a path the base does not hold', async () => {
  const dir = await makeRepo()
  await fs.writeFile(path.join(dir, 'a.js'), 'one\n')
  const base = await commitAll(dir, 'base')
  await assert.rejects(() => readBaseVersion({ repoRoot: dir, baseSha: base, repoPath: 'nope.js' }))
})

test('parseDiff: rename headers and hunks parse from synthetic output', () => {
  const diff = [
    'diff --git a/old.js b/new.js',
    'similarity index 90%',
    'rename from old.js',
    'rename to new.js',
    '--- a/old.js',
    '+++ b/new.js',
    '@@ -1,2 +1,3 @@',
    ' keep',
    '+added',
    ' keep2',
    '',
  ].join('\n')
  const files = parseDiff(diff)
  assert.equal(files.length, 1)
  assert.equal(files[0].kind, 'renamed')
  assert.equal(files[0].repoPath, 'new.js')
  assert.equal(files[0].prevRepoPath, 'old.js')
  assert.deepEqual([...files[0].addedLines], [2])
})
