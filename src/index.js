// Entrypoint for the free-tier SDF GitHub Action.
//
// Reads the inputs declared in action.yml, runs the standalone
// free-tier engine (src/analyzer.js), and — on pull-request events —
// the pattern checks over the changed files (src/changes.js learns
// what changed from the checkout's git history; src/checks.js examines
// it). Sets the declared outputs, writes the summary to the job
// summary, posts/updates the pull-request comment, and fails the run
// when an opt-in gate is on and its condition fired: fail-on-issues
// for analyzer warnings, fail-on-findings for pattern findings. The
// two gates and their outputs keep separate meanings, always.
//
// This file only wires the engine to GitHub; all analysis lives in
// src/analyzer.js and src/checks.js, and all rendering in
// src/comment.js.

const fs = require('node:fs/promises')
const path = require('node:path')
const core = require('@actions/core')
const github = require('@actions/github')
const { analyze, assertUsableProjectRoot, findSuiteScriptsRoot } = require('./analyzer')
const { getPullRequestChanges, readBaseVersion } = require('./changes')
const { runPatternChecks } = require('./checks')
const { renderSummary, upsertComment } = require('./comment')

const COMMENT_MODES = new Set(['sticky', 'new', 'off'])

async function run() {
  try {
    const projectPathInput = core.getInput('project-path') || '.'
    const token = core.getInput('github-token')
    const failOnIssues = core.getBooleanInput('fail-on-issues')
    const failOnFindings = core.getBooleanInput('fail-on-findings')
    const commentMode = resolveCommentMode(core.getInput('comment-mode'))

    const workspace = process.env.GITHUB_WORKSPACE || process.cwd()
    const projectRoot = path.resolve(workspace, projectPathInput)

    // A mistyped project-path must fail loudly here; without this check
    // it was indistinguishable from an honestly empty repository (D3).
    await assertUsableProjectRoot(projectRoot, projectPathInput)

    const result = await analyze(projectRoot)
    result.checks = await computeChecks({ result, projectRoot, workspace })
    const summary = renderSummary(result, { projectRoot })

    const findingsCount = result.checks && !result.checks.skipped
      ? result.checks.findings.length
      : 0

    core.setOutput('script-count', result.stats.scriptCount)
    core.setOutput('dependency-count', result.stats.dependencyCount)
    core.setOutput('has-issues', result.stats.warningCount > 0 ? 'true' : 'false')
    core.setOutput('findings-count', findingsCount)
    core.setOutput('has-findings', findingsCount > 0 ? 'true' : 'false')
    core.setOutput('summary-markdown', summary)

    await core.summary.addRaw(summary).write()

    if (commentMode !== 'off') {
      await postComment(token, summary, commentMode)
    }

    const failures = []
    if (failOnIssues && result.stats.warningCount > 0) {
      failures.push(
        `Analyzer reported ${result.stats.warningCount} warning(s) and fail-on-issues is true.`,
      )
    }
    if (failOnFindings && findingsCount > 0) {
      failures.push(
        `Pattern checks reported ${findingsCount} new finding(s) and fail-on-findings is true.`,
      )
    }
    if (failures.length > 0) core.setFailed(failures.join(' '))
  } catch (err) {
    core.setFailed(err && err.message ? err.message : String(err))
  }
}

// The pattern checks run on pull_request events only: the payload must
// name a base commit, and the event must be pull_request itself —
// pull_request_target is excluded deliberately, because that event
// runs with a write-capable token in the base repository's context and
// examining pull-request code under it is a known credential-exposure
// pattern. Any other event returns null and the summary simply has no
// checks section, exactly as before R1.
//
// The checks are fail-soft, like the comment posting: a baseline that
// cannot be obtained yields a printed skipped line, never a failed
// run, and an unexpected checks failure degrades the same way rather
// than taking the inventory results down with it.
async function computeChecks({ result, projectRoot, workspace }) {
  const payload = github.context.payload || {}
  const pr = payload.pull_request
  if (github.context.eventName !== 'pull_request' || !pr || !pr.base
    || typeof pr.base.sha !== 'string') {
    return null
  }
  const baseSha = pr.base.sha
  try {
    const changes = await getPullRequestChanges({ repoRoot: workspace, baseSha })
    if (!changes.ok) {
      core.warning(`Pattern checks were not run: ${changes.reason}.`)
      return { skipped: changes.reason }
    }
    let suiteRootRel = null
    if (result.mode === 'project') {
      const suiteRoot = await findSuiteScriptsRoot(projectRoot)
      if (suiteRoot) {
        suiteRootRel = path.relative(projectRoot, suiteRoot).split(path.sep).join('/')
      }
    }
    return await runPatternChecks({
      mode: result.mode,
      projectPrefix: relativePrefix(workspace, projectRoot),
      suiteRootRel,
      changesFiles: changes.files,
      readHeadFile: (repoPath) => fs.readFile(path.join(workspace, repoPath), 'utf8'),
      readBaseFile: (repoPath) => readBaseVersion({ repoRoot: workspace, baseSha, repoPath }),
    })
  } catch (err) {
    core.warning(
      `Pattern checks could not be completed: ${err && err.message ? err.message : String(err)}`,
    )
    return { skipped: 'the pattern checks could not be completed' }
  }
}

// The project root's repository-relative prefix ('' at the root, else
// 'a/b/'), used to relativise git's repository-relative paths.
function relativePrefix(workspace, projectRoot) {
  const rel = path.relative(workspace, projectRoot).split(path.sep).join('/')
  return rel ? `${rel}/` : ''
}

function resolveCommentMode(raw) {
  const mode = (raw || 'sticky').trim().toLowerCase()
  if (COMMENT_MODES.has(mode)) return mode
  core.warning(`Unknown comment-mode "${raw}" — falling back to "sticky".`)
  return 'sticky'
}

async function postComment(token, summary, mode) {
  const payload = github.context.payload || {}
  const subject = payload.pull_request || payload.issue
  if (!subject || !Number.isInteger(subject.number)) {
    core.info('No pull request on this event — skipping the PR comment.')
    return
  }
  if (!token) {
    core.warning('No github-token available — skipping the PR comment.')
    return
  }
  const octokit = github.getOctokit(token)
  // The results already live in the outputs and the job summary; a
  // comment that cannot be posted must not fail the whole run and take
  // them down with it (D1) — warn instead.
  try {
    const outcome = await upsertComment(
      octokit,
      {
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        issueNumber: subject.number,
      },
      summary,
      mode,
    )
    core.info(`Pull-request comment ${outcome}.`)
  } catch (err) {
    core.warning(
      `Could not post the pull-request comment: ${err && err.message ? err.message : String(err)}`,
    )
  }
}

run()
