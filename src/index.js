// Entrypoint for the free-tier SDF GitHub Action.
//
// Reads the four inputs declared in action.yml, runs the standalone
// free-tier engine (src/analyzer.js), sets the four declared outputs,
// writes the summary to the job summary, posts/updates the pull-request
// comment, and — when fail-on-issues is true — fails the run if the
// analyzer reported warnings, so the action can act as a merge gate.
//
// This file only wires the engine to GitHub; all analysis lives in
// src/analyzer.js and all rendering in src/comment.js.

const path = require('node:path')
const core = require('@actions/core')
const github = require('@actions/github')
const { analyze, assertUsableProjectRoot } = require('./analyzer')
const { renderSummary, upsertComment } = require('./comment')

const COMMENT_MODES = new Set(['sticky', 'new', 'off'])

async function run() {
  try {
    const projectPathInput = core.getInput('project-path') || '.'
    const token = core.getInput('github-token')
    const failOnIssues = core.getBooleanInput('fail-on-issues')
    const commentMode = resolveCommentMode(core.getInput('comment-mode'))

    const workspace = process.env.GITHUB_WORKSPACE || process.cwd()
    const projectRoot = path.resolve(workspace, projectPathInput)

    // A mistyped project-path must fail loudly here; without this check
    // it was indistinguishable from an honestly empty repository (D3).
    await assertUsableProjectRoot(projectRoot, projectPathInput)

    const result = await analyze(projectRoot)
    const summary = renderSummary(result, { projectRoot })

    core.setOutput('script-count', result.stats.scriptCount)
    core.setOutput('dependency-count', result.stats.dependencyCount)
    core.setOutput('has-issues', result.stats.warningCount > 0 ? 'true' : 'false')
    core.setOutput('summary-markdown', summary)

    await core.summary.addRaw(summary).write()

    if (commentMode !== 'off') {
      await postComment(token, summary, commentMode)
    }

    if (failOnIssues && result.stats.warningCount > 0) {
      core.setFailed(
        `Analyzer reported ${result.stats.warningCount} warning(s) and fail-on-issues is true.`,
      )
    }
  } catch (err) {
    core.setFailed(err && err.message ? err.message : String(err))
  }
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
