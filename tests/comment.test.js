// Unit tests for summary rendering and comment posting (src/comment.js).

const test = require('node:test')
const assert = require('node:assert/strict')

const { COMMENT_MARKER, PUBLISHER_LINE, renderSummary, upsertComment } = require('../src/comment')

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
