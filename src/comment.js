// Summary rendering and pull-request comment management for the free-tier
// SDF action. Rendering is pure (no I/O) so it is unit-testable; comment
// posting takes an octokit-shaped client so tests can substitute a fake.

const path = require('node:path')

// Hidden marker embedded in every comment this action posts, so sticky mode
// can find (and update) its own previous comment on a pull request.
const COMMENT_MARKER = '<!-- strikaris-sdf-analyzer-pr-check -->'

// Required by the product decision recorded for this action: the comment
// names its publisher in one footer line and carries no sales wording.
const PUBLISHER_LINE = '_Posted by SDF Analyzer — PR Check, by Strikaris._'

// Caps keep a huge project from producing an unreadable comment; the full
// machine-readable result stays available through the action outputs.
const MAX_SCRIPT_ROWS = 50
const MAX_DEPENDENCY_ROWS = 25

function renderSummary(result, { projectRoot } = {}) {
  const { project, scripts, moduleUsage, byType, warnings, stats } = result
  const lines = []

  lines.push(COMMENT_MARKER)
  lines.push('## SDF Analyzer — PR Check')
  lines.push('')
  if (project && project.name) {
    lines.push(`**Project:** ${project.name}${project.type ? ` (${project.type})` : ''}`)
    lines.push('')
  }
  lines.push(
    `**${stats.scriptCount}** script${plural(stats.scriptCount)} · ` +
    `**${stats.dependencyCount}** unique module dependencies · ` +
    `**${stats.warningCount}** issue${plural(stats.warningCount)}`,
  )
  lines.push('')

  lines.push('### Scripts by type')
  lines.push('')
  if (byType.length === 0) {
    lines.push('No SuiteScripts found.')
  } else {
    lines.push('| Type | Count |')
    lines.push('| --- | ---: |')
    for (const [type, count] of byType) lines.push(`| ${type} | ${count} |`)
  }
  lines.push('')

  lines.push('### Script inventory')
  lines.push('')
  if (scripts.length === 0) {
    lines.push('No scripts to list.')
  } else {
    lines.push('| File | Type | API | Dependencies |')
    lines.push('| --- | --- | --- | ---: |')
    for (const s of scripts.slice(0, MAX_SCRIPT_ROWS)) {
      lines.push(`| \`${s.file}\` | ${s.type || 'Unknown'} | ${s.apiVersion || '—'} | ${s.dependencies.length} |`)
    }
    if (scripts.length > MAX_SCRIPT_ROWS) {
      lines.push('')
      lines.push(`_…and ${scripts.length - MAX_SCRIPT_ROWS} more scripts (see the \`summary-markdown\` output for tooling use)._`)
    }
  }
  lines.push('')

  lines.push('### Module dependencies')
  lines.push('')
  if (moduleUsage.length === 0) {
    lines.push('No `N/` module dependencies detected.')
  } else {
    lines.push('| Module | Used by (scripts) |')
    lines.push('| --- | ---: |')
    for (const [mod, count] of moduleUsage.slice(0, MAX_DEPENDENCY_ROWS)) {
      lines.push(`| \`${mod}\` | ${count} |`)
    }
    if (moduleUsage.length > MAX_DEPENDENCY_ROWS) {
      lines.push('')
      lines.push(`_…and ${moduleUsage.length - MAX_DEPENDENCY_ROWS} more modules._`)
    }
  }
  lines.push('')

  lines.push('### Issues')
  lines.push('')
  if (warnings.length === 0) {
    lines.push('No issues found.')
  } else {
    for (const w of warnings) {
      lines.push(`- \`${displayPath(w.file, projectRoot)}\` — ${w.message}`)
    }
  }
  lines.push('')
  lines.push('---')
  lines.push(PUBLISHER_LINE)
  lines.push('')

  return lines.join('\n')
}

function plural(n) {
  return n === 1 ? '' : 's'
}

// Warning paths are recorded against the runner's absolute project root;
// relativize them so the comment stays readable and machine-independent.
function displayPath(file, projectRoot) {
  if (!file) return '(project)'
  if (projectRoot && path.isAbsolute(file)) {
    const rel = path.relative(projectRoot, file)
    if (rel && !rel.startsWith('..')) return rel.split(path.sep).join('/')
  }
  return file
}

// Post or update the summary comment according to the comment mode.
// mode: 'sticky' | 'new' | 'off'. Returns 'created' | 'updated' | 'skipped'.
async function upsertComment(octokit, target, body, mode) {
  if (mode === 'off') return 'skipped'

  const { owner, repo, issueNumber } = target
  const issues = octokit.rest.issues

  if (mode === 'sticky') {
    const existing = await findOwnComment(issues, { owner, repo, issueNumber })
    if (existing) {
      await issues.updateComment({ owner, repo, comment_id: existing.id, body })
      return 'updated'
    }
  }

  await issues.createComment({ owner, repo, issue_number: issueNumber, body })
  return 'created'
}

async function findOwnComment(issues, { owner, repo, issueNumber }) {
  const { data } = await issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  })
  return data.find((c) => typeof c.body === 'string' && c.body.includes(COMMENT_MARKER)) || null
}

module.exports = {
  COMMENT_MARKER,
  PUBLISHER_LINE,
  renderSummary,
  upsertComment,
}
