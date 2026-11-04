// Summary rendering and pull-request comment management for the free-tier
// SDF action. Rendering is pure (no I/O) so it is unit-testable; comment
// posting takes an octokit-shaped client so tests can substitute a fake.

const path = require('node:path')
const { MAX_DIAGRAM_PARTICIPANTS, MAX_DIAGRAM_CALLS } = require('./diagram')

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
const MAX_FINDING_ROWS = 25
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
  { scripts: MAX_SCRIPT_ROWS, modules: MAX_DEPENDENCY_ROWS, warnings: MAX_WARNING_ROWS, findings: MAX_FINDING_ROWS },
  { scripts: Math.ceil(MAX_SCRIPT_ROWS / 2), modules: Math.ceil(MAX_DEPENDENCY_ROWS / 2), warnings: Math.ceil(MAX_WARNING_ROWS / 2), findings: Math.ceil(MAX_FINDING_ROWS / 2) },
  { scripts: Math.ceil(MAX_SCRIPT_ROWS / 4), modules: Math.ceil(MAX_DEPENDENCY_ROWS / 4), warnings: Math.ceil(MAX_WARNING_ROWS / 4), findings: Math.ceil(MAX_FINDING_ROWS / 4) },
  { scripts: 0, modules: 0, warnings: 0, findings: 0 },
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

// The pattern-checks section closes with this scope sentence in every
// rendering, so "no findings shown" can never masquerade as "everything
// examined": the reader is told exactly what the checks did and did not
// look at. The Marketplace listing and the README carry the same claim.
const FINDINGS_SCOPE_SENTENCE =
  '_Pattern checks examine only the files this pull request changed, ' +
  'for the six patterns above. They are not an audit: the rest of the ' +
  'project, data flow within and between files, deployments, roles, ' +
  'and configuration are not examined._'

// The call-diagram section (the reduced Mermaid sequence diagrams,
// v1.2.0): one diagram per changed file, drawn from the direct calls
// within that file (src/diagram.js). File caps here bound how many
// diagrams one comment carries; the per-file caps on functions and
// calls live in src/diagram.js. The section is the comment's garnish,
// never its substance: the render attempts in renderSummary sacrifice
// it — reduced, then omitted with a printed note — before any
// inventory, issues, or findings content shrinks.
const MAX_DIAGRAM_FILES = 5
const MAX_DIAGRAM_FILES_REDUCED = 1
const MAX_DIAGRAM_LABEL_CHARS = 40

// The diagram section's scope sentence, printed in every rendering
// that mentions diagrams — including the budget-omitted one — so an
// absent or partial diagram can never read as a complete call graph.
// It names only what is genuinely excluded: calls into other files,
// and calls made through a variable (a callee that is not a bare
// function name). Calls made inside a callback are NOT excluded —
// they are drawn as the containing function's calls — so the note
// must not claim otherwise (diagram audit F-A2); the key below
// carries that disclosure.
const DIAGRAM_SCOPE_NOTE =
  '_Diagrams show direct calls between functions within each changed ' +
  'file only — calls into other files, or through variables, are ' +
  'not shown._'

// The diagram section's key (diagram audit F-F1), printed once under
// the heading whenever a diagram is drawn. The first line decodes
// what the drawing shows: a box is a function defined in the file,
// an arrow is a direct call, a note marks an entry point. The second
// states the reduced semantics the drawing flattens (F-A2): messages
// run in call order from each entry point; one arrow stands for a
// pair of functions however many call sites exist; a call inside a
// condition or a loop is drawn the same as a call that always runs;
// a call inside a callback is drawn as a call of the function that
// contains the callback; and calls are shown without returns (F-F4).
// One standard text in configuration, so it can never drift between
// renderings. Static text — no author content reaches it.
const DIAGRAM_KEY =
  '_Key: each box is a function defined in this file, and an arrow ' +
  'is a direct call to the function named on the arrow. A note ' +
  'marks an entry point — a function NetSuite calls directly._'

const DIAGRAM_KEY_SEMANTICS =
  '_Messages run in call order from each entry point, following ' +
  'each call into the function it reaches. One arrow stands for a ' +
  'pair of functions, however many times the call appears in the ' +
  'code. A call inside a condition or a loop is drawn the same as ' +
  'a call that always runs, and a call inside a callback is drawn ' +
  'as a call of the function that contains the callback. Calls are ' +
  'shown without returns._'

// Printed in place of the diagrams when the comment has no room to
// print them whole: an omitted diagram is stated, never implied.
const DIAGRAM_BUDGET_NOTE =
  '_Call diagrams are omitted from this comment — there is not room ' +
  'to print them whole._'

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

// Render attempts, in order: full lists with the diagrams whole,
// then the diagrams reduced, then the diagrams omitted — and only
// after that do the lists themselves shrink. The diagram is
// decoration; the findings are the product, so the diagram is always
// the first thing the budget takes. When a result carries no
// diagrams, every diagram mode renders identically and the sequence
// is exactly the historical list-stage progression.
const RENDER_ATTEMPTS = [
  { stage: 0, diagram: 'full' },
  { stage: 0, diagram: 'reduced' },
  { stage: 0, diagram: 'omitted' },
  ...LIST_LIMIT_STAGES.slice(1).map((_, i) => ({ stage: i + 1, diagram: 'omitted' })),
]

function renderSummary(result, { projectRoot } = {}) {
  for (const attempt of RENDER_ATTEMPTS) {
    const body = renderWithinLimits(
      result, projectRoot, LIST_LIMIT_STAGES[attempt.stage], attempt.stage > 0, attempt.diagram,
    )
    if (body.length <= MAX_COMMENT_CHARS) return body
  }
  // Even counts-and-headers rendering can overflow when a single path or
  // name is enormous; the final guard makes the budget unconditional.
  return truncateToBudget(
    renderWithinLimits(result, projectRoot, LIST_LIMIT_STAGES[LIST_LIMIT_STAGES.length - 1], true, 'omitted'),
  )
}

function renderWithinLimits(result, projectRoot, limits, budgetTruncated, diagramMode = 'full') {
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
  // The pattern-checks section (R1) sits after Issues in project mode
  // and after Module dependencies in loose mode. It renders only when
  // the run carried checks data — pull-request runs; a non-pull-request
  // run has no section at all, exactly as before.
  if (result.checks) {
    lines.push(...renderChecksSection(result.checks, limits.findings))
    // The diagram section follows the pattern checks. It renders only
    // on pull-request runs whose examination produced diagram data;
    // skipped checks and non-pull-request runs have no section.
    lines.push(...renderDiagramSection(
      result.checks.skipped ? null : result.checks.diagrams, diagramMode,
    ))
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

// The pattern-checks section: its own section, never blended into
// Issues (whose count drives has-issues and fail-on-issues — a second
// kind of item there would corrupt both meanings). Its header always
// enumerates what ran; degradation is printed, not implied; the scope
// sentence closes every rendering.
function renderChecksSection(checks, findingRowLimit) {
  const lines = []
  lines.push('### Pattern checks on this pull request')
  lines.push('')
  if (checks.skipped) {
    lines.push(`Pattern checks were not run on this pull request: ${checks.skipped}.`)
    lines.push('')
    lines.push(FINDINGS_SCOPE_SENTENCE)
    lines.push('')
    return lines
  }

  const findings = checks.findings || []
  const examined = checks.examinedCount || 0
  const changed = checks.changedCount || 0
  const filePhrase = examined === changed
    ? `**${changed}** changed script file${plural(changed)}`
    : `**${examined}** of **${changed}** changed script files`
  const outcome = findings.length === 0
    ? 'no new findings'
    : `**${findings.length}** new finding${plural(findings.length)}`
  lines.push(`**6 pattern checks** ran on ${filePhrase}: ${outcome}.`)
  lines.push('')
  for (const f of findings.slice(0, findingRowLimit)) {
    lines.push(`- \`${f.file}:${f.line}\` — \`${f.check}\` — ${f.message}`)
  }
  if (findings.length > findingRowLimit) {
    lines.push(`- _…and ${findings.length - findingRowLimit} more findings (only the first ${findingRowLimit} are listed)._`)
  }
  if (findings.length > 0) lines.push('')
  if (checks.notCompared > 0) {
    lines.push(
      `_${checks.notCompared} changed file${plural(checks.notCompared)} could not be compared ` +
      `with the base version; ${checks.notCompared === 1 ? 'its findings are' : 'their findings are'} not shown._`,
    )
    lines.push('')
  }
  if (checks.notExamined > 0) {
    lines.push(
      `_${checks.notExamined} changed file${plural(checks.notExamined)} could not be examined ` +
      `(too large, or not valid JavaScript) and ${checks.notExamined === 1 ? 'was' : 'were'} not checked._`,
    )
    lines.push('')
  }
  lines.push(FINDINGS_SCOPE_SENTENCE)
  lines.push('')
  return lines
}

// The call-diagram section: one Mermaid sequence diagram per changed
// file, in the examination's deterministic path order. Mode 'full'
// draws up to MAX_DIAGRAM_FILES files; 'reduced' draws one; 'omitted'
// prints the budget note instead of any block. A file whose diagram
// exceeded the extraction caps is named with its omission stated —
// never drawn partially, because a partial diagram would assert a
// call picture that is not the file's. Every examined file is
// accounted for (diagram audit F-A3/F-C1): named here when it is
// drawn, omitted for size, or carrying calls omitted for ambiguity —
// and otherwise counted in the closing line for files with no direct
// intra-file calls. The scope note closes every rendering, including
// the omitted one.
function renderDiagramSection(diagrams, diagramMode = 'full') {
  const records = (diagrams || []).filter((d) => d && typeof d === 'object')
  if (records.length === 0) return []

  const named = records.filter((d) => isNamedDiagramRecord(d))
  const uncalled = records.filter((d) => !isNamedDiagramRecord(d))

  const lines = []
  lines.push('### Call diagrams for changed files')
  lines.push('')
  if (diagramMode === 'omitted') {
    if (named.length > 0) {
      lines.push(DIAGRAM_BUDGET_NOTE)
      lines.push('')
    }
    if (uncalled.length > 0) {
      lines.push(noDiagramLine(uncalled.length, named.length > 0))
      lines.push('')
    }
    lines.push(DIAGRAM_SCOPE_NOTE)
    lines.push('')
    return lines
  }

  const fileLimit = diagramMode === 'reduced' ? MAX_DIAGRAM_FILES_REDUCED : MAX_DIAGRAM_FILES
  const shown = named.slice(0, fileLimit)
  if (shown.some((d) => !d.overCap && d.calls && d.calls.length > 0)) {
    lines.push(DIAGRAM_KEY)
    lines.push('')
    lines.push(DIAGRAM_KEY_SEMANTICS)
    lines.push('')
  }
  for (const d of shown) lines.push(...renderFileDiagram(d))
  if (named.length > shown.length) {
    const rest = named.length - shown.length
    lines.push(`_Call diagrams for ${rest} more changed file${plural(rest)} are omitted._`)
    lines.push('')
  }
  if (uncalled.length > 0) {
    lines.push(noDiagramLine(uncalled.length, named.length > 0))
    lines.push('')
  }
  lines.push(DIAGRAM_SCOPE_NOTE)
  lines.push('')
  return lines
}

// A record earns a per-file entry in the section when it carries
// something the reader must not miss: a drawable diagram, a size
// omission to state, or calls omitted for ambiguity. A record with
// none of those was examined and found to make no direct intra-file
// calls; the closing line counts it instead.
function isNamedDiagramRecord(d) {
  return !!((d.calls && d.calls.length > 0) || d.overCap || d.ambiguousCalls > 0)
}

// The closing accounting line for examined files with no diagram:
// their work runs through N/ modules — the commonest SuiteScript
// shape — and the section says so with a count, so its contents
// reconcile with the pull request's changed files (F-C1).
function noDiagramLine(count, anyNamed) {
  return (
    `_No diagram for ${count} ${anyNamed ? 'other ' : ''}changed ` +
    `file${plural(count)}: ${count === 1 ? 'it makes' : 'they make'} ` +
    'no direct calls between functions within the file._'
  )
}

// One file's entry in the section: its diagram — or, when the file
// exceeded the extraction caps, its omission line — followed by the
// ambiguity line when the extractor omitted calls for that file.
// Participant identifiers are generated here (P1, P2, ...), never
// taken from the source, so no author-chosen name can collide with
// Mermaid's grammar; source names appear only as labels, which
// diagramLabels reduces to a safe, collision-free set. Call messages
// are emitted in the extraction's call order from the entry points;
// a self-call renders as a message from a participant to itself,
// which Mermaid draws as a loop.
function renderFileDiagram(d) {
  const lines = []
  const shownPath = String(d.file).replace(/[`\r\n]/g, '')
  if (d.overCap) {
    lines.push(
      `_\`${shownPath}\` — its call diagram is omitted: the file has more ` +
      `than ${MAX_DIAGRAM_PARTICIPANTS} functions or ${MAX_DIAGRAM_CALLS} ` +
      'direct calls in its diagram, the printed cap._',
    )
    lines.push('')
    if (d.ambiguousCalls > 0) lines.push(...diagramAmbiguityLines(d))
    return lines
  }
  if (!d.calls || d.calls.length === 0) {
    // Nothing drawable: the only fact to state is the ambiguity
    // loss, when there is one. (A record with neither is counted by
    // the section's closing line and never reaches this function.)
    if (d.ambiguousCalls > 0) lines.push(...diagramAmbiguityLines(d))
    return lines
  }

  const labels = diagramLabels(d)
  const alias = new Map()
  lines.push(`**\`${shownPath}\`**`)
  lines.push('')
  lines.push('```mermaid')
  lines.push('sequenceDiagram')
  d.participants.forEach((name, i) => {
    const id = `P${i + 1}`
    alias.set(name, id)
    lines.push(`    participant ${id} as ${labels.get(name)}`)
  })
  for (const name of d.entryPoints || []) {
    if (alias.has(name)) lines.push(`    Note over ${alias.get(name)}: entry point`)
  }
  for (const call of d.calls) {
    lines.push(
      `    ${alias.get(call.from)}->>${alias.get(call.to)}: ${labels.get(call.to)}`,
    )
  }
  lines.push('```')
  lines.push('')
  if (d.ambiguousCalls > 0) lines.push(...diagramAmbiguityLines(d))
  return lines
}

// The line that keeps an ambiguity omission visible (diagram audit
// F-A3): the extractor counted the calls it could not draw — a call
// touching a function name defined more than once in the file is
// omitted, never guessed — and the section prints that count for the
// file instead of letting the calls vanish silently.
function diagramAmbiguityLines(d) {
  const shownPath = String(d.file).replace(/[`\r\n]/g, '')
  const n = d.ambiguousCalls
  return [
    `_\`${shownPath}\` — ${n} direct call${plural(n)} ${n === 1 ? 'is' : 'are'} not shown — ` +
      'a function name is defined more than once in this file, so ' +
      `${n === 1 ? 'that call' : 'those calls'} cannot be drawn unambiguously._`,
    '',
  ]
}

// The label each participant is drawn under in one file's diagram.
// Labels come from sanitizeDiagramLabel; when two functions in the
// same file would render with the SAME label — a shared prefix at
// the 40-character cap, or names that differ only in a character the
// sanitiser maps to an underscore — the drawing could not tell them
// apart (diagram audit F-A4), so each colliding label gains its
// participant number. A sanitised label can never contain the
// suffix's parentheses (the sanitiser maps them to underscores) and
// the number is unique within the diagram, so a suffixed label
// cannot collide with any other label in the file. Message labels
// use the same map, so an arrow names its target exactly as the
// target's box does.
function diagramLabels(d) {
  const base = new Map()
  for (const name of d.participants) base.set(name, sanitizeDiagramLabel(name))
  const counts = new Map()
  for (const label of base.values()) counts.set(label, (counts.get(label) || 0) + 1)
  const labels = new Map()
  d.participants.forEach((name, i) => {
    const label = base.get(name)
    labels.set(name, counts.get(label) > 1 ? `${label} (P${i + 1})` : label)
  })
  return labels
}

// The only author-controlled text that reaches the Mermaid block is a
// function or export name, used as a participant or message label.
// Labels are reduced to letters, digits, spaces and a few inert
// characters; everything else — brackets, quotes, arrows, semicolons,
// newlines, Mermaid's own comment marker — becomes an underscore, so
// an odd or hostile name can neither break the diagram's syntax nor
// inject a statement into it. Over-long labels are capped.
const DIAGRAM_LABEL_DISALLOWED = /[^\p{L}\p{N} _.\-$]/gu

function sanitizeDiagramLabel(value) {
  const cleaned = String(value)
    .replace(DIAGRAM_LABEL_DISALLOWED, '_')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return 'function'
  return cleaned.length > MAX_DIAGRAM_LABEL_CHARS
    ? `${cleaned.slice(0, MAX_DIAGRAM_LABEL_CHARS)}…`
    : cleaned
}

// Last-resort budget enforcement: cut the body at a line boundary and
// re-attach the truncation note and the publisher footer, so the result
// is within MAX_COMMENT_CHARS no matter what the inputs contained.
function truncateToBudget(body) {
  if (body.length <= MAX_COMMENT_CHARS) return body
  const tail = `\n---\n${PUBLISHER_LINE}\n`
  const noteLine = `${TRUNCATION_NOTE}\n`
  const fenceClose = '\n```'
  const keep = MAX_COMMENT_CHARS - noteLine.length - tail.length - fenceClose.length - 1
  let cut = body.lastIndexOf('\n', keep)
  if (cut <= 0) cut = keep
  let kept = body.slice(0, cut)
  // A cut landing inside a fenced block (the Mermaid diagram) would
  // leave the fence open and swallow the note and the footer into the
  // block; close the fence so what remains still renders as written.
  const fences = (kept.match(/```/g) || []).length
  if (fences % 2 === 1) kept += fenceClose
  return `${kept}\n${noteLine}${tail}`
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
  MAX_FINDING_ROWS,
  MAX_DIAGRAM_FILES,
  FINDINGS_SCOPE_SENTENCE,
  DIAGRAM_SCOPE_NOTE,
  DIAGRAM_KEY,
  DIAGRAM_KEY_SEMANTICS,
  renderSummary,
  renderChecksSection,
  renderDiagramSection,
  sanitizeDiagramLabel,
  truncateToBudget,
  upsertComment,
}
