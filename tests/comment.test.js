// Unit tests for summary rendering and comment posting (src/comment.js).

const test = require('node:test')
const assert = require('node:assert/strict')

const { COMMENT_MARKER, PUBLISHER_LINE, MAX_COMMENT_CHARS, renderSummary, truncateToBudget, upsertComment } = require('../src/comment')

function sampleResult(overrides = {}) {
  return {
    project: { name: 'Demo Project', type: 'ACCOUNTPROJECT', frameworkVersion: '1.0', manifestPath: 'src/manifest.xml' },
    scripts: [
      { file: 'src/FileCabinet/SuiteScripts/a.js', type: 'UserEventScript', apiVersion: '2.1', dependencies: ['N/record'], exports: ['beforeSubmit'], lineCount: 10 },
      { file: 'src/FileCabinet/SuiteScripts/b.js', type: null, apiVersion: null, dependencies: [], exports: [], lineCount: 3 },
    ],
    moduleUsage: [['N/record', 1]],
    byType: [['UserEventScript', 1]],
    warnings: [],
    stats: { scriptCount: 2, dependencyCount: 1, typeCount: 1, warningCount: 0 },
    ...overrides,
  }
}

// ---------- renderSummary ----------

test('renderSummary includes the marker, counts, inventory and the publisher footer', () => {
  const md = renderSummary(sampleResult())
  assert.ok(md.startsWith(COMMENT_MARKER))
  assert.match(md, /\*\*2\*\* scripts · \*\*1\*\* unique module dependencies · \*\*0\*\* issues/)
  assert.match(md, /Demo Project \(ACCOUNTPROJECT\)/)
  assert.match(md, /`src\/FileCabinet\/SuiteScripts\/a\.js` \| UserEventScript \| 2\.1 \| 1/)
  assert.match(md, /`src\/FileCabinet\/SuiteScripts\/b\.js` \| Unknown/)
  assert.match(md, /`N\/record` \| 1/)
  assert.match(md, /No issues found\./)
  assert.ok(md.trimEnd().endsWith(PUBLISHER_LINE))
})

test('renderSummary lists warnings with paths relativized to the project root', () => {
  const result = sampleResult({
    warnings: [{ file: '/home/runner/work/proj/src/manifest.xml', message: 'No manifest.xml found — test.' }],
    stats: { scriptCount: 2, dependencyCount: 1, typeCount: 1, warningCount: 1 },
  })
  const md = renderSummary(result, { projectRoot: '/home/runner/work/proj' })
  assert.match(md, /`src\/manifest\.xml` — No manifest\.xml found/)
  assert.doesNotMatch(md, /home\/runner/)
})

// ---------- upsertComment ----------

function fakeOctokit(existingComments = []) {
  const calls = { created: [], updated: [] }
  const octokit = {
    rest: {
      issues: {
        listComments: async () => ({ data: existingComments }),
        createComment: async (args) => { calls.created.push(args); return { data: { id: 99 } } },
        updateComment: async (args) => { calls.updated.push(args); return { data: { id: args.comment_id } } },
      },
    },
  }
  return { octokit, calls }
}

const TARGET = { owner: 'o', repo: 'r', issueNumber: 7 }

test('upsertComment sticky mode updates its own earlier comment', async () => {
  const { octokit, calls } = fakeOctokit([
    { id: 5, body: `old ${COMMENT_MARKER} body` },
    { id: 6, body: 'someone else' },
  ])
  const outcome = await upsertComment(octokit, TARGET, 'new body', 'sticky')
  assert.equal(outcome, 'updated')
  assert.equal(calls.updated.length, 1)
  assert.equal(calls.updated[0].comment_id, 5)
  assert.equal(calls.created.length, 0)
})

test('upsertComment sticky mode creates when no earlier comment exists', async () => {
  const { octokit, calls } = fakeOctokit([{ id: 6, body: 'someone else' }])
  const outcome = await upsertComment(octokit, TARGET, 'body', 'sticky')
  assert.equal(outcome, 'created')
  assert.equal(calls.created.length, 1)
  assert.equal(calls.created[0].issue_number, 7)
})

test('upsertComment new mode always creates, even with an earlier comment present', async () => {
  const { octokit, calls } = fakeOctokit([{ id: 5, body: `old ${COMMENT_MARKER} body` }])
  const outcome = await upsertComment(octokit, TARGET, 'body', 'new')
  assert.equal(outcome, 'created')
  assert.equal(calls.created.length, 1)
  assert.equal(calls.updated.length, 0)
})

test('upsertComment off mode does nothing', async () => {
  const { octokit, calls } = fakeOctokit()
  const outcome = await upsertComment(octokit, TARGET, 'body', 'off')
  assert.equal(outcome, 'skipped')
  assert.equal(calls.created.length + calls.updated.length, 0)
})

// ---------- D1: the comment must always fit GitHub's size limit ----------
// Regression tests for adversarial-pass D1: row caps bound row counts,
// not characters, so long paths and an uncapped Issues section pushed
// the rendered comment past GitHub's 65,536-character limit; the
// rejected post then failed the whole run with no results at all.

function hostileResult({ scriptCount = 0, pathFor = () => 'a.js', warningCount = 0 } = {}) {
  const scripts = Array.from({ length: scriptCount }, (_, i) => ({
    file: pathFor(i),
    type: 'Restlet',
    apiVersion: '2.1',
    dependencies: ['N/https'],
    exports: [],
    lineCount: 5,
  }))
  const warnings = Array.from({ length: warningCount }, (_, i) => ({
    file: `src/FileCabinet/SuiteScripts/broken_${i}.js`,
    message: 'Script parse failed: Unexpected token, expected "," while parsing the file contents.',
  }))
  return sampleResult({
    scripts,
    moduleUsage: [['N/https', scriptCount]],
    byType: scriptCount ? [['Restlet', scriptCount]] : [],
    warnings,
    stats: { scriptCount, dependencyCount: scriptCount ? 1 : 0, typeCount: scriptCount ? 1 : 0, warningCount },
  })
}

test('D1: deep paths on many scripts render within the budget, counts exact', () => {
  // 60 scripts at directory depth 120 — the construction that rendered
  // 92,520 characters before the fix.
  const deepPath = (i) =>
    `${Array.from({ length: 120 }, (_, d) => `segment${String(d).padStart(13, '0')}`).join('/')}/script_${i}.js`
  const md = renderSummary(hostileResult({ scriptCount: 60, pathFor: deepPath }))
  assert.ok(md.length <= MAX_COMMENT_CHARS, `summary is ${md.length} chars, budget is ${MAX_COMMENT_CHARS}`)
  assert.ok(md.length < 65536)
  assert.match(md, /\*\*60\*\* scripts · \*\*1\*\* unique module dependencies · \*\*0\*\* issues/)
  assert.match(md, /larger than a pull-request comment can carry/)
  assert.ok(md.trimEnd().endsWith(PUBLISHER_LINE))
})

test('D1: hundreds of warnings render within the budget, counts exact', () => {
  // 800 unparseable scripts — the construction that rendered 71,228
  // characters (all 800 warning lines) before the fix.
  const md = renderSummary(hostileResult({ scriptCount: 5, warningCount: 800 }))
  assert.ok(md.length <= MAX_COMMENT_CHARS, `summary is ${md.length} chars, budget is ${MAX_COMMENT_CHARS}`)
  assert.match(md, /\*\*5\*\* scripts · \*\*1\*\* unique module dependencies · \*\*800\*\* issues/)
  assert.match(md, /…and 775 more issues \(only the first 25 are listed\)/)
  assert.ok(md.trimEnd().endsWith(PUBLISHER_LINE))
})

test('D1: a summary just under the budget renders untruncated', () => {
  const nearPath = (i) => `${'x'.repeat(1080)}/script_${i}.js`
  const md = renderSummary(hostileResult({ scriptCount: 50, pathFor: nearPath }))
  assert.ok(md.length > 50000, `expected a near-budget render, got ${md.length} chars`)
  assert.ok(md.length <= MAX_COMMENT_CHARS)
  assert.doesNotMatch(md, /more scripts|more issues|larger than a pull-request comment/)
  for (let i = 0; i < 50; i++) assert.ok(md.includes(`script_${i}.js`), `row for script_${i}.js is present`)
})

test('D1: truncateToBudget enforces the budget on arbitrary content', () => {
  const body = Array.from({ length: 5000 }, (_, i) => `line ${i} ${'y'.repeat(20)}`).join('\n') +
    `\n---\n${PUBLISHER_LINE}\n`
  const cut = truncateToBudget(body)
  assert.ok(cut.length <= MAX_COMMENT_CHARS, `cut body is ${cut.length} chars`)
  assert.match(cut, /larger than a pull-request comment can carry/)
  assert.ok(cut.trimEnd().endsWith(PUBLISHER_LINE))
  assert.equal(truncateToBudget('short body'), 'short body')
})

test('D1: a size rejection from GitHub retries with a shortened body', async () => {
  const bodies = []
  const octokit = {
    rest: {
      issues: {
        listComments: async () => ({ data: [] }),
        createComment: async (args) => {
          bodies.push(args.body)
          if (bodies.length === 1) {
            const err = new Error('Validation Failed: Body is too long (maximum is 65536 characters)')
            err.status = 422
            throw err
          }
          return { data: { id: 42 } }
        },
        updateComment: async () => ({ data: {} }),
      },
    },
  }
  const outcome = await upsertComment(octokit, TARGET, 'z'.repeat(70000), 'sticky')
  assert.equal(outcome, 'created')
  assert.equal(bodies.length, 2)
  assert.ok(bodies[1].length <= MAX_COMMENT_CHARS, `retried body is ${bodies[1].length} chars`)
})

test('D1: a non-size posting failure still propagates', async () => {
  const octokit = {
    rest: {
      issues: {
        listComments: async () => ({ data: [] }),
        createComment: async () => {
          const err = new Error('Forbidden')
          err.status = 403
          throw err
        },
        updateComment: async () => ({ data: {} }),
      },
    },
  }
  await assert.rejects(() => upsertComment(octokit, TARGET, 'body', 'new'), /Forbidden/)
})

// ── D4 (adversarial pass): the sticky lookup paginates ───────────────────
// The lookup used to read one page of 100 comments; on a busier pull
// request the action's own marked comment fell off the page and sticky
// mode posted a duplicate on every run.

function paginatingOctokit(allComments) {
  const calls = { created: [], updated: [], listPages: [] }
  const octokit = {
    rest: {
      issues: {
        listComments: async ({ per_page, page }) => {
          calls.listPages.push(page)
          const start = (page - 1) * per_page
          return { data: allComments.slice(start, start + per_page) }
        },
        createComment: async (args) => { calls.created.push(args); return { data: { id: 99 } } },
        updateComment: async (args) => { calls.updated.push(args); return { data: { id: args.comment_id } } },
      },
    },
  }
  return { octokit, calls }
}

test('D4: sticky mode finds its marked comment beyond the first page and updates it', async () => {
  const comments = []
  for (let i = 1; i <= 149; i++) comments.push({ id: i, body: `human comment ${i}` })
  comments.push({ id: 500, body: `old report ${COMMENT_MARKER}` })
  const { octokit, calls } = paginatingOctokit(comments)
  const outcome = await upsertComment(octokit, TARGET, 'new body', 'sticky')
  assert.equal(outcome, 'updated')
  assert.equal(calls.created.length, 0)
  assert.equal(calls.updated.length, 1)
  assert.equal(calls.updated[0].comment_id, 500)
  assert.ok(calls.listPages.includes(2), 'the lookup must request page 2')
})

test('D4: sticky mode creates exactly one comment when none is marked, however long the thread', async () => {
  const comments = []
  for (let i = 1; i <= 230; i++) comments.push({ id: i, body: `human comment ${i}` })
  const { octokit, calls } = paginatingOctokit(comments)
  const outcome = await upsertComment(octokit, TARGET, 'new body', 'sticky')
  assert.equal(outcome, 'created')
  assert.equal(calls.created.length, 1)
  assert.equal(calls.updated.length, 0)
})

// ── D7 (adversarial pass): the truncation note points nowhere false ──────
// The note once told readers to see the "summary-markdown" output, which
// carries the truncated text itself. The PR #5 rewording is pinned here:
// truncation notes state the limit and never reference that output.

test('D7: rendered truncation notes state the limit and never point at summary-markdown', () => {
  const md = renderSummary(hostileResult({ scriptCount: 60 }))
  assert.match(md, /only the first 50 are listed/)
  assert.doesNotMatch(md, /summary-markdown/)
})

// ── D12 (adversarial pass): manifest fields are sanitized before render ──
// The project name and type are author-controlled text interpolated into
// a comment posted under the github-actions identity; newlines and
// markdown control characters must not survive into it.

test('D12: a manifest name carrying markdown and a newline renders as one plain line', () => {
  const md = renderSummary(sampleResult({
    project: {
      name: 'ACME **bold** | pipe ]]>\nbreak',
      type: 'ACCOUNTCUSTOMIZATION',
      frameworkVersion: '1.0',
      manifestPath: 'src/manifest.xml',
    },
  }))
  assert.match(md, /\*\*Project:\*\* ACME bold pipe break \(ACCOUNTCUSTOMIZATION\)/)
  assert.doesNotMatch(md, /\*\*bold\*\*/)
  assert.doesNotMatch(md, /\nbreak/)
})

test('D12: an over-long manifest name is capped', () => {
  const md = renderSummary(sampleResult({
    project: {
      name: 'x'.repeat(150),
      type: null,
      frameworkVersion: '1.0',
      manifestPath: 'src/manifest.xml',
    },
  }))
  const line = md.split('\n').find((l) => l.startsWith('**Project:**'))
  assert.ok(line.length <= '**Project:** '.length + 101, `project line too long: ${line.length}`)
  assert.ok(line.endsWith('…'))
})

// ── D8 (adversarial pass): the summary names what the scan skipped ───────

test('D8: the summary notes skipped symlinked entries by name', () => {
  const md = renderSummary(sampleResult({ skippedSymlinks: ['linkdir', 'linkfile.js'] }))
  assert.match(md, /2 symlinked entries were skipped/)
  assert.match(md, /`linkdir`/)
  assert.match(md, /`linkfile\.js`/)
})

test('D8: no symlink note appears when nothing was skipped', () => {
  const md = renderSummary(sampleResult())
  assert.doesNotMatch(md, /symlinked/)
})

// ── D10 (adversarial pass): unreadable dependency declarations are marked ─

test('D10: an incompletely read declaration is marked in the inventory with its footnote', () => {
  const result = sampleResult()
  result.scripts[0].dependenciesIncomplete = true
  const md = renderSummary(result)
  assert.match(md, /\| 1 † \|/)
  assert.match(md, /lower bound/)
})

test('D10: fully read declarations carry no marker and no footnote', () => {
  const md = renderSummary(sampleResult())
  assert.doesNotMatch(md, /†/)
  assert.doesNotMatch(md, /lower bound/)
})
