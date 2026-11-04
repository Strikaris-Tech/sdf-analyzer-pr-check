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

// Row caps keep a huge project from producing an unreadable comment.
// They bound row counts, not characters — long paths defeat them — so a
// character budget below is the real guarantee.
const MAX_SCRIPT_ROWS = 50
const MAX_DEPENDENCY_ROWS = 25
const MAX_WARNING_ROWS = 25
const MAX_OUTSIDE_NAMED = 5

// GitHub rejects a comment body longer than 65,536 characters, and a
// rejected post used to fail the whole run, leaving no results at all
// (adversarial pass D1). The rendered summary is held to a budget with
// headroom under that limit, whatever the inputs: lists shrink in stages,
// then a final guard truncates whatever is still too long. The header
// counts are computed from the full result and stay exact at every stage.
const GITHUB_COMMENT_LIMIT = 65536
const MAX_COMMENT_CHARS = GITHUB_COMMENT_LIMIT - 4096

// List sizes tried in order until the rendered summary fits the budget:
// the standing caps first, then progressively smaller, then counts only.
const LIST_LIMIT_STAGES = [
  { scripts: MAX_SCRIPT_ROWS, modules: MAX_DEPENDENCY_ROWS, warnings: MAX_WARNING_ROWS },
  { scripts: Math.ceil(MAX_SCRIPT_ROWS / 2), modules: Math.ceil(MAX_DEPENDENCY_ROWS / 2), warnings: Math.ceil(MAX_WARNING_ROWS / 2) },
  { scripts: Math.ceil(MAX_SCRIPT_ROWS / 4), modules: Math.ceil(MAX_DEPENDENCY_ROWS / 4), warnings: Math.ceil(MAX_WARNING_ROWS / 4) },
  { scripts: 0, modules: 0, warnings: 0 },
]

const TRUNCATION_NOTE =
  '_The full results are larger than a pull-request comment can carry — ' +
  'the listings above are truncated; the counts in this summary are exact._'

// Footnote for the † marker in the inventory: a dependency declaration
// the static reader could not fully resolve (a dynamic define/require
// form) makes that file's dependency count a lower bound — the count is
// shown with its limit stated, never silently understated (D10).
const DEPS_INCOMPLETE_NOTE =
  '_† Dependency declaration could not be fully read for the marked ' +
  'file(s) — their dependency counts are a lower bound._'

// Manifest fields are project-authored text interpolated into a comment
// posted under the github-actions identity: newlines and markdown
// control characters are stripped and the value is length-capped before
// rendering, so a manifest cannot break the comment's layout or plant
// arbitrary markdown in it (adversarial pass D12).
const MAX_MANIFEST_FIELD_CHARS = 100
const MARKDOWN_CONTROL_CHARS = /[*_`[\]()<>|#]/g

function sanitizeManifestField(value) {
  if (!value) return value
  const cleaned = String(value)
    .replace(/[\r\n]+/g, ' ')
    .replace(MARKDOWN_CONTROL_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > MAX_MANIFEST_FIELD_CHARS
    ? `${cleaned.slice(0, MAX_MANIFEST_FIELD_CHARS)}…`
    : cleaned
}

function renderSummary(result, { projectRoot } = {}) {
  for (let stage = 0; stage < LIST_LIMIT_STAGES.length; stage++) {
    const body = renderWithinLimits(result, projectRoot, LIST_LIMIT_STAGES[stage], stage > 0)
    if (body.length <= MAX_COMMENT_CHARS) return body
  }
  // Even counts-and-headers rendering can overflow when a single path or
  // name is enormous; the final guard makes the budget unconditional.
  return truncateToBudget(
    renderWithinLimits(result, projectRoot, LIST_LIMIT_STAGES[LIST_LIMIT_STAGES.length - 1], true),
  )
}

function renderWithinLimits(result, projectRoot, limits, budgetTruncated) {
  const { project, scripts, moduleUsage, byType, warnings, stats } = result
  const mode = result.mode || 'project'
  const outsideSuiteScripts = result.outsideSuiteScripts || []
  const skippedSymlinks = result.skippedSymlinks || []
  const lines = []

  lines.push(COMMENT_MARKER)
  lines.push('## SDF Analyzer — PR Check')
  lines.push('')
  if (mode === 'loose') {
    lines.push(
      '_No SDF project was found in this repository — loose-file mode: ' +
      'an inventory of the SuiteScript files detected by their ' +
      '`@NApiVersion` and `@NScriptType` annotations._',
    )
    lines.push('')
  }
  if (mode === 'empty') {
    // A bare zero would read as a clean pass; say plainly what happened.
    lines.push('**No SDF project and no SuiteScript files were found in this repository.**')
    lines.push('')
  }
  if (project && project.name) {
    const type = project.type ? ` (${sanitizeManifestField(project.type)})` : ''
    lines.push(`**Project:** ${sanitizeManifestField(project.name)}${type}`)
    lines.push('')
  }
  if (mode === 'loose') {
    lines.push(
      `**${stats.scriptCount}** script${plural(stats.scriptCount)} · ` +
      `**${stats.dependencyCount}** unique module dependencies`,
    )
  } else {
    lines.push(
      `**${stats.scriptCount}** script${plural(stats.scriptCount)} · ` +
      `**${stats.dependencyCount}** unique module dependencies · ` +
      `**${stats.warningCount}** issue${plural(stats.warningCount)}`,
    )
  }
  lines.push('')
  if (outsideSuiteScripts.length > 0) {
    lines.push(outsideNote(outsideSuiteScripts))
    lines.push('')
  }
  if (skippedSymlinks.length > 0) {
    lines.push(skippedSymlinksNote(skippedSymlinks))
    lines.push('')
  }

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
    for (const s of scripts.slice(0, limits.scripts)) {
      const depCount = `${s.dependencies.length}${s.dependenciesIncomplete ? ' †' : ''}`
      lines.push(`| \`${s.file}\` | ${s.type || 'Unknown'} | ${s.apiVersion || '—'} | ${depCount} |`)
    }
    if (scripts.length > limits.scripts) {
      lines.push('')
      lines.push(`_…and ${scripts.length - limits.scripts} more scripts (only the first ${limits.scripts} are listed)._`)
    }
    if (scripts.some((s) => s.dependenciesIncomplete)) {
      lines.push('')
      lines.push(DEPS_INCOMPLETE_NOTE)
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
    for (const [mod, count] of moduleUsage.slice(0, limits.modules)) {
      lines.push(`| \`${mod}\` | ${count} |`)
    }
    if (moduleUsage.length > limits.modules) {
      lines.push('')
      lines.push(`_…and ${moduleUsage.length - limits.modules} more modules (only the first ${limits.modules} are listed)._`)
    }
  }
  lines.push('')

  // Loose mode is inventory only: no sanity section is transplanted into it.
  if (mode !== 'loose') {
    lines.push('### Issues')
    lines.push('')
    if (warnings.length === 0) {
      lines.push('No issues found.')
    } else {
      for (const w of warnings.slice(0, limits.warnings)) {
        lines.push(`- \`${displayPath(w.file, projectRoot)}\` — ${w.message}`)
      }
      if (warnings.length > limits.warnings) {
        lines.push(`- _…and ${warnings.length - limits.warnings} more issues (only the first ${limits.warnings} are listed)._`)
      }
    }
    lines.push('')
  }
  if (budgetTruncated) {
    lines.push(TRUNCATION_NOTE)
    lines.push('')
  }
  lines.push('---')
  lines.push(PUBLISHER_LINE)
  lines.push('')

  return lines.join('\n')
}

// Last-resort budget enforcement: cut the body at a line boundary and
// re-attach the truncation note and the publisher footer, so the result
// is within MAX_COMMENT_CHARS no matter what the inputs contained.
function truncateToBudget(body) {
  if (body.length <= MAX_COMMENT_CHARS) return body
  const tail = `\n---\n${PUBLISHER_LINE}\n`
  const noteLine = `${TRUNCATION_NOTE}\n`
  const keep = MAX_COMMENT_CHARS - noteLine.length - tail.length - 1
  let cut = body.lastIndexOf('\n', keep)
  if (cut <= 0) cut = keep
  return `${body.slice(0, cut)}\n${noteLine}${tail}`
}

// One line naming the symlinked entries the scan skipped: links are
// never followed (cycle-safe), but the skip is reported rather than
// silent, so a repository routing code through links is not understated
// without a trace (adversarial pass D8).
function skippedSymlinksNote(files) {
  const named = files.slice(0, MAX_OUTSIDE_NAMED).map((f) => `\`${f}\``).join(', ')
  const more = files.length > MAX_OUTSIDE_NAMED
    ? `, and ${files.length - MAX_OUTSIDE_NAMED} more`
    : ''
  const noun = files.length === 1 ? 'entry was' : 'entries were'
  return (
    `_Note: ${files.length} symlinked ${noun} skipped — ` +
    `the scan does not follow symlinks: ${named}${more}._`
  )
}

// One line in the project-mode comment for annotated SuiteScript files that
// sit outside the project's SuiteScripts folders: seen, counted, not scanned.
function outsideNote(files) {
  const named = files.slice(0, MAX_OUTSIDE_NAMED).map((f) => `\`${f}\``).join(', ')
  const more = files.length > MAX_OUTSIDE_NAMED
    ? `, and ${files.length - MAX_OUTSIDE_NAMED} more`
    : ''
  return (
    `_Note: ${files.length} annotated SuiteScript file${plural(files.length)} found ` +
    `outside the project's SuiteScripts folder — seen but not scanned: ${named}${more}._`
  )
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
// If GitHub rejects the body for its size, retry once with the body cut
// to the budget — a shortened comment beats no comment (D1). Other
// failures propagate to the caller.
async function upsertComment(octokit, target, body, mode) {
  if (mode === 'off') return 'skipped'

  const { owner, repo, issueNumber } = target
  const issues = octokit.rest.issues

  try {
    return await postOrUpdate(issues, target, body, mode)
  } catch (err) {
    if (!isSizeRejection(err)) throw err
    const shortened = truncateToBudget(body)
    if (shortened === body) throw err
    return postOrUpdate(issues, target, shortened, mode)
  }
}

async function postOrUpdate(issues, { owner, repo, issueNumber }, body, mode) {
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

// GitHub's oversized-body rejection: HTTP 422, "Body is too long
// (maximum is 65536 characters)".
function isSizeRejection(err) {
  if (!err || err.status !== 422) return false
  return /too long|65536/i.test(err.message || '')
}

// One page of the sticky-comment lookup. A busy pull request can carry
// far more comments than one page holds; the lookup walks pages until
// it finds the marked comment or a short page ends the list, so sticky
// mode updates its own comment instead of posting a duplicate
// (adversarial pass D4).
const COMMENTS_PAGE_SIZE = 100

async function findOwnComment(issues, { owner, repo, issueNumber }) {
  for (let page = 1; ; page++) {
    const { data } = await issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: COMMENTS_PAGE_SIZE,
      page,
    })
    const found = data.find(
      (c) => typeof c.body === 'string' && c.body.includes(COMMENT_MARKER),
    )
    if (found) return found
    if (data.length < COMMENTS_PAGE_SIZE) return null
  }
}

module.exports = {
  COMMENT_MARKER,
  PUBLISHER_LINE,
  MAX_COMMENT_CHARS,
  renderSummary,
  truncateToBudget,
  upsertComment,
}
