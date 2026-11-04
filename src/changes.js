// Pull-request change acquisition for the free-tier SDF action.
//
// Single responsibility: learning what one pull request changed — which
// files, at which previous paths, and which head lines are new — from
// the checkout's own git history. The event payload names the exact
// base commit; the checked-out tree is the head. Nothing here knows
// about SuiteScripts, detectors, or comments: it hands byte streams and
// path facts to checks.js in exactly the shape the existing tests use.
//
// Git is present on every GitHub runner (the checkout step requires
// it), and the only credential involved is the one the checkout step
// already stored for this repository — this module adds none of its
// own. When the base cannot be obtained, the result says so plainly
// and the caller degrades: no findings, a printed reason, no failure.

const { execFile } = require('node:child_process')

// One diff over the largest pull request the checks accept (100 files,
// both versions near the byte cap) is a few megabytes; git show of one
// capped file version is under a megabyte. 64 MB of buffer holds either
// with room to spare, without letting a hostile diff grow unboundedly.
const MAX_GIT_BUFFER_BYTES = 64 * 1024 * 1024

// A git runner bound to one repository root. Injectable so tests can
// substitute or wrap it; the default shells out to the real git.
function makeGitRunner(repoRoot) {
  return function runGit(args, { binary = false } = {}) {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        args,
        { cwd: repoRoot, maxBuffer: MAX_GIT_BUFFER_BYTES, encoding: binary ? 'buffer' : 'utf8' },
        (err, stdout) => {
          if (err) reject(err)
          else resolve(stdout)
        },
      )
    })
  }
}

// Learn the change set of one pull request.
//
// baseSha: the exact base commit the event payload names.
// Returns { ok: true, headSha, files } where each file is
// { repoPath, prevRepoPath, kind, addedLines } — repoPath and
// prevRepoPath are repository-relative with forward slashes,
// prevRepoPath is null for an added file and equals repoPath unless
// the file was renamed, kind is 'added' | 'modified' | 'deleted' |
// 'renamed', and addedLines is the Set of head line numbers the pull
// request added. Returns { ok: false, reason } when the baseline route
// fails; reason is a plain-words fragment for the comment's skipped
// line, without a trailing period.
async function getPullRequestChanges({ repoRoot, baseSha, runGit = makeGitRunner(repoRoot) }) {
  if (typeof baseSha !== 'string' || !/^[0-9a-f]{40}$/i.test(baseSha)) {
    return { ok: false, reason: 'the base version of the changed files could not be obtained' }
  }

  let headSha
  try {
    headSha = (await runGit(['rev-parse', 'HEAD'])).trim()
  } catch {
    return { ok: false, reason: 'the repository history could not be read' }
  }

  if (!(await hasCommit(runGit, baseSha))) {
    // A default checkout is shallow — it fetches only the newest
    // commit — so the base commit is usually absent. Fetch just that
    // commit, with the checkout's own stored credential.
    try {
      await runGit(['fetch', '--depth=1', 'origin', baseSha])
    } catch {
      // Tolerated: the re-check below decides, and its failure is the
      // honest baseline failure the caller degrades on.
    }
    if (!(await hasCommit(runGit, baseSha))) {
      return { ok: false, reason: 'the base version of the changed files could not be obtained' }
    }
  }

  let diffText
  try {
    diffText = await runGit(['diff', '--unified=0', '--find-renames', baseSha, headSha])
  } catch {
    return { ok: false, reason: 'the changes in this pull request could not be read' }
  }

  return { ok: true, headSha, files: parseDiff(diffText) }
}

async function hasCommit(runGit, sha) {
  try {
    await runGit(['cat-file', '-e', `${sha}^{commit}`])
    return true
  } catch {
    return false
  }
}

// One changed file's base version, as text. Throws when the object
// cannot be read — the caller treats that as a per-file comparison
// failure, suppresses the file's findings, and discloses the count.
async function readBaseVersion({ repoRoot, baseSha, repoPath, runGit = makeGitRunner(repoRoot) }) {
  const buf = await runGit(['show', `${baseSha}:${repoPath}`], { binary: true })
  return buf.toString('utf8')
}

// Parse `git diff --unified=0 --find-renames` output into per-file
// change records. File status comes from the extended headers (new /
// deleted / rename from / rename to), falling back to the --- / +++
// path lines; added head lines come from the hunks. With zero context
// lines, every '+' line in a hunk is a line the pull request added.
function parseDiff(diffText) {
  const files = []
  let current = null
  let inHunks = false
  let headLine = 0

  const flush = () => {
    if (!current) return
    if (current.kind === 'modified' && current.prevPath == null) {
      current.prevPath = current.path
    }
    if (current.path != null || current.prevPath != null) files.push(current)
    current = null
  }

  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush()
      current = { path: null, prevPath: null, kind: 'modified', addedLines: new Set() }
      inHunks = false
      headLine = 0
      continue
    }
    if (!current) continue

    if (!inHunks) {
      if (line.startsWith('new file mode')) { current.kind = 'added'; continue }
      if (line.startsWith('deleted file mode')) { current.kind = 'deleted'; continue }
      if (line.startsWith('rename from ')) {
        current.kind = 'renamed'
        current.prevPath = unquoteGitPath(line.slice('rename from '.length))
        continue
      }
      if (line.startsWith('rename to ')) {
        current.kind = 'renamed'
        current.path = unquoteGitPath(line.slice('rename to '.length))
        continue
      }
      if (line.startsWith('--- ')) {
        const p = line.slice(4)
        if (p === '/dev/null') current.kind = 'added'
        else if (current.kind !== 'renamed') current.prevPath = unquoteGitPath(p.replace(/^a\//, ''))
        continue
      }
      if (line.startsWith('+++ ')) {
        const p = line.slice(4)
        if (p === '/dev/null') current.kind = 'deleted'
        else current.path = unquoteGitPath(p.replace(/^b\//, ''))
        continue
      }
    }

    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      inHunks = true
      headLine = Number.parseInt(hunk[1], 10)
      continue
    }
    if (inHunks) {
      if (line.startsWith('+')) {
        current.addedLines.add(headLine)
        headLine += 1
      } else if (line.startsWith(' ')) {
        // A context line occupies a head line. --unified=0 emits
        // none, but the counter stays correct if any appear.
        headLine += 1
      }
      // '-' lines consume base lines only; '\\' marks a missing
      // trailing newline. Neither advances the head counter.
    }
  }
  flush()

  // Emit the documented field names: repoPath is the head path (for a
  // deleted file, which has no head version, its base path — so
  // callers can still name it), prevRepoPath the base path, null for
  // an added file.
  return files.map((f) => ({
    repoPath: f.path != null ? f.path : f.prevPath,
    prevRepoPath: f.kind === 'added' ? null : f.prevPath,
    kind: f.kind,
    addedLines: f.addedLines,
  }))
}

// Git quotes paths containing special characters in C style
// ("a\303\251b.js"). Plain paths pass through unchanged.
function unquoteGitPath(p) {
  if (!p.startsWith('"') || !p.endsWith('"') || p.length < 2) return p
  const inner = p.slice(1, -1)
  const bytes = []
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (ch === '\\' && i + 1 < inner.length) {
      const next = inner[i + 1]
      if (next >= '0' && next <= '7') {
        let oct = next
        let j = i + 2
        while (j < inner.length && oct.length < 3 && inner[j] >= '0' && inner[j] <= '7') {
          oct += inner[j]
          j += 1
        }
        bytes.push(Number.parseInt(oct, 8))
        i = j - 1
        continue
      }
      const escapes = { n: 10, t: 9, r: 13, '\\': 92, '"': 34 }
      bytes.push(escapes[next] != null ? escapes[next] : next.charCodeAt(0))
      i += 1
      continue
    }
    for (const b of Buffer.from(ch, 'utf8')) bytes.push(b)
  }
  return Buffer.from(bytes).toString('utf8')
}

module.exports = {
  MAX_GIT_BUFFER_BYTES,
  makeGitRunner,
  getPullRequestChanges,
  readBaseVersion,
  parseDiff,
}
