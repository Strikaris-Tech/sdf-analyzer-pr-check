// Free-tier SDF analyzer — runs entirely on the GitHub Actions runner.
//
// Deliberately minimal: manifest parse, script scan, dependency + export
// extraction via Acorn, module-usage aggregation. When no SDF project
// layout is present it degrades to loose-file mode — an inventory of the
// annotated SuiteScript files in the tree (recognition lives in
// suitescript.js) — and never to line-level checks. Everything deeper
// (deployment-XML linkage, consequence analysis, conflict detection,
// TOGAF-aligned docs) is a paid-tier feature surfaced through Strikaris.
//
// This file owns its own logic; it does not import from any private
// Strikaris package. The engine stays private by staying separate.

const fs = require('node:fs/promises')
const path = require('node:path')
const acorn = require('acorn')
const walk = require('acorn-walk')
const { parseStringPromise } = require('xml2js')
const {
  extractApiVersion,
  extractScriptTypeTag,
  extractLooseDependenciesDetailed,
  collectArrayBindings,
  resolveCallModules,
  scanSuiteScriptTree,
  isSkippedSymlink,
} = require('./suitescript')

const SUITESCRIPT_TYPES = new Set([
  'ClientScript', 'UserEventScript', 'Suitelet', 'ScheduledScript',
  'MapReduceScript', 'WorkflowActionScript', 'Restlet', 'Portlet',
  'BundleInstallationScript', 'MassUpdateScript',
])

// SuiteScript 2.x export names → script type guess. When multiple types
// would match, fall back to Unknown (we'd rather be silent than wrong).
const EXPORT_TO_TYPE = {
  onRequest: 'Suitelet',
  execute: 'ScheduledScript',
  getInputData: 'MapReduceScript',
  onAction: 'WorkflowActionScript',
  fieldChanged: 'ClientScript',
  saveRecord: 'ClientScript',
  pageInit: 'ClientScript',
  beforeLoad: 'UserEventScript',
  beforeSubmit: 'UserEventScript',
  afterSubmit: 'UserEventScript',
  get: 'Restlet',
  post: 'Restlet',
  put: 'Restlet',
  delete: 'Restlet',
  each: 'MassUpdateScript',
}

// The SuiteScripts folders of an SDF project, in scan priority order,
// relative to the project root (forward slashes, matching relFile form).
const SUITESCRIPTS_ROOTS = [
  'src/FileCabinet/SuiteScripts',
  'FileCabinet/SuiteScripts',
]

// The one input every consumer sets is project-path; a typo there used to
// produce a green run claiming the repository was empty (adversarial
// pass D3). Verify the resolved root exists and is a directory before
// any analysis runs, and fail with a message naming the path. An
// existing directory that simply holds no project stays valid — the
// honest-empty result is a designed behavior, not an error.
async function assertUsableProjectRoot(projectRoot, displayPath) {
  const shown = displayPath || projectRoot
  let stat = null
  try {
    stat = await fs.stat(projectRoot)
  } catch {
    stat = null
  }
  if (!stat) {
    throw new Error(
      `project-path "${shown}" does not exist (resolved to ${projectRoot}). ` +
      'Check the project-path input and try again.',
    )
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `project-path "${shown}" is not a directory (resolved to ${projectRoot}). ` +
      'Point project-path at the project root directory.',
    )
  }
}

// Mode selection: an SDF project layout (a manifest, or a SuiteScripts
// folder) means project mode, exactly as this analyzer has always behaved.
// Without one, fall back to loose-file mode — an inventory of the annotated
// SuiteScript files anywhere in the tree — or, when there are none either,
// an honestly empty result that says so.
async function analyze(projectRoot) {
  const warnings = []
  // Manifest warnings are project-mode sanity output; they are gathered
  // separately so loose mode — inventory only — never inherits them.
  const manifestWarnings = []
  const { manifest, present: manifestPresent } = await probeManifest(projectRoot, manifestWarnings)
  const suiteRoot = await findSuiteScriptsRoot(projectRoot)

  if (manifestPresent || suiteRoot) {
    warnings.push(...manifestWarnings)
    const scripts = []
    const skippedSymlinks = []
    if (suiteRoot) {
      await walkJs(suiteRoot, projectRoot, scripts, warnings, skippedSymlinks)
    } else {
      warnings.push({
        file: path.join(projectRoot, 'src', 'FileCabinet', 'SuiteScripts'),
        message: 'No SuiteScripts directory found — skipping script scan.',
      })
    }
    const outsideSuiteScripts = await scanOutsideSuiteScripts(projectRoot)
    return buildResult({ mode: 'project', project: manifest, scripts, warnings, outsideSuiteScripts, skippedSymlinks })
  }

  const { files: looseFiles, skippedSymlinks } = await scanSuiteScriptTree(projectRoot)
  if (looseFiles.length === 0) {
    // Empty mode is a statement — "nothing was found here" — not an
    // issue: the manifest and directory warnings describe a project
    // that was never claimed to exist, so they are not attached, and an
    // empty repository reports has-issues=false even under the
    // fail-on-issues gate (adversarial pass D9). Warnings stay attached
    // to projects that exist but are broken, above and in loose mode's
    // sanity-free inventory alike.
    return buildResult({ mode: 'empty', project: manifest, scripts: [], warnings: [], outsideSuiteScripts: [], skippedSymlinks })
  }

  const scripts = looseFiles.map((found) => parseLooseScript(found))
  return buildResult({ mode: 'loose', project: manifest, scripts, warnings, outsideSuiteScripts: [], skippedSymlinks })
}

function buildResult({ mode, project, scripts, warnings, outsideSuiteScripts, skippedSymlinks = [] }) {
  const moduleUsage = new Map()
  const byType = new Map()

  for (const s of scripts) {
    if (s.type) byType.set(s.type, (byType.get(s.type) || 0) + 1)
    for (const dep of s.dependencies) {
      moduleUsage.set(dep, (moduleUsage.get(dep) || 0) + 1)
    }
  }

  return {
    mode,
    project,
    scripts,
    moduleUsage: sortDesc(moduleUsage),
    byType: sortDesc(byType),
    warnings,
    outsideSuiteScripts,
    skippedSymlinks,
    stats: {
      scriptCount: scripts.length,
      dependencyCount: moduleUsage.size,
      typeCount: byType.size,
      warningCount: warnings.length,
    },
  }
}

// Annotated SuiteScript files that live outside the project's SuiteScripts
// folders: project mode sees them but does not scan them, and the summary
// notes them so a stray script never passes silently.
async function scanOutsideSuiteScripts(projectRoot) {
  const { files } = await scanSuiteScriptTree(projectRoot)
  return files
    .filter(({ relFile }) => !SUITESCRIPTS_ROOTS.some(
      (root) => relFile === root || relFile.startsWith(`${root}/`),
    ))
    .map(({ relFile }) => relFile)
}

// Inventory one loose SuiteScript file. Recognition already established
// that both annotations are present, so type and API version come from the
// tags; dependencies come from the AST when the file parses. A file that
// does not parse is still a SuiteScript — it is listed with no declared
// dependencies rather than dropped or turned into a warning.
function parseLooseScript({ relFile, source }) {
  const tagType = extractScriptTypeTag(source)
  let type = SUITESCRIPT_TYPES.has(tagType) ? tagType : null
  let dependencies = []
  let dependenciesIncomplete = false
  let exports = []
  const ast = tryParse(source)
  if (ast) {
    const detailed = extractLooseDependenciesDetailed(ast)
    dependencies = detailed.dependencies
    dependenciesIncomplete = detailed.incomplete
    exports = extractExports(ast)
    type = guessScriptType(source, exports) || type
  }
  return {
    file: relFile,
    type,
    apiVersion: extractApiVersion(source),
    dependencies,
    dependenciesIncomplete,
    exports,
    lineCount: source.split('\n').length,
  }
}

const PARSE_OPTIONS = {
  ecmaVersion: 2022,
  sourceType: 'script',
  allowReturnOutsideFunction: true,
  allowHashBang: true,
}

function tryParse(source) {
  try {
    return acorn.parse(source, PARSE_OPTIONS)
  } catch {
    return null
  }
}

// Reads the manifest and reports whether one is present at all — present
// but unusable still counts, because mode selection keys off the layout
// existing, not off it being valid. Each candidate is tried in order and
// a candidate only succeeds when it parses AND its root element is
// `manifest`: a broken or wrong-shaped file earns its own warning and
// the probe falls through to the other location, so a valid root
// manifest is never shadowed by a broken src/ copy, and one real problem
// never reports as two contradictory warnings (adversarial pass D5, D13).
// The "not found" warning is reserved for the case where no candidate
// file exists at all.
async function probeManifest(projectRoot, warnings) {
  // SDF projects may place manifest.xml at project root OR under src/.
  const candidates = [
    path.join(projectRoot, 'src', 'manifest.xml'),
    path.join(projectRoot, 'manifest.xml'),
  ]
  let present = false
  for (const file of candidates) {
    let raw
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') continue
      present = true
      warnings.push({ file, message: `manifest.xml could not be read: ${err.message}` })
      continue
    }
    present = true
    let xml
    try {
      xml = await parseStringPromise(raw, { explicitArray: false, mergeAttrs: true })
    } catch (err) {
      warnings.push({ file, message: `manifest.xml parse failed: ${err.message}` })
      continue
    }
    if (!xml || typeof xml !== 'object' || !('manifest' in xml)) {
      const actualRoot = xml && typeof xml === 'object' ? Object.keys(xml)[0] : null
      warnings.push({
        file,
        message:
          'manifest.xml does not look like an SDF manifest — its root element is ' +
          `<${actualRoot || 'unknown'}>, not <manifest>.`,
      })
      continue
    }
    const m = xml.manifest || {}
    return {
      present,
      manifest: {
        name: (m.projectname || m.name || '').toString().trim() || null,
        type: (m.projecttype || m.type || '').toString().trim() || null,
        frameworkVersion: (m.frameworkversion || '').toString().trim() || null,
        manifestPath: path.relative(projectRoot, file),
      },
    }
  }
  if (!present) {
    warnings.push({
      file: path.join(projectRoot, 'src', 'manifest.xml'),
      message: 'No manifest.xml found — project may not be a valid SDF project.',
    })
  }
  return {
    present,
    manifest: { name: null, type: null, frameworkVersion: null, manifestPath: null },
  }
}

async function readManifest(projectRoot, warnings) {
  const { manifest } = await probeManifest(projectRoot, warnings)
  return manifest
}

// The first existing SuiteScripts folder, or null — without warnings, so
// mode selection can probe quietly.
async function findSuiteScriptsRoot(projectRoot) {
  for (const rel of SUITESCRIPTS_ROOTS) {
    const root = path.join(projectRoot, rel)
    if (await exists(root)) return root
  }
  return null
}

async function scanScripts(projectRoot, warnings) {
  const scripts = []
  const root = await findSuiteScriptsRoot(projectRoot)
  if (root) {
    await walkJs(root, projectRoot, scripts, warnings, [])
    return scripts
  }
  warnings.push({
    file: path.join(projectRoot, 'src', 'FileCabinet', 'SuiteScripts'),
    message: 'No SuiteScripts directory found — skipping script scan.',
  })
  return scripts
}

async function walkJs(dir, projectRoot, out, warnings, skippedSymlinks) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isSymbolicLink()) {
      // Never followed (cycle-safe by construction) but no longer
      // invisible: the skipped entry is named for the summary (D8).
      if (await isSkippedSymlink(full, e.name)) {
        skippedSymlinks.push(path.relative(projectRoot, full).split(path.sep).join('/'))
      }
    } else if (e.isDirectory()) {
      await walkJs(full, projectRoot, out, warnings, skippedSymlinks)
    } else if (e.isFile() && e.name.endsWith('.js')) {
      const script = await parseScript(full, projectRoot, warnings)
      if (script) out.push(script)
    }
  }
}

async function parseScript(file, projectRoot, warnings) {
  const relFile = path.relative(projectRoot, file).split(path.sep).join('/')
  let source
  try {
    source = await fs.readFile(file, 'utf8')
  } catch (err) {
    warnings.push({ file: relFile, message: `read failed: ${err.message}` })
    return null
  }

  if (source.trim() === '') {
    // An empty or whitespace-only file declares nothing. Counting it as
    // a script inflates the inventory with a phantom "Unknown" entry
    // (adversarial pass D6); it is skipped, silently, like loose mode
    // already skips content-free files.
    return null
  }

  let ast
  try {
    ast = acorn.parse(source, PARSE_OPTIONS)
  } catch (err) {
    warnings.push({ file: relFile, message: `parse failed: ${err.message}` })
    return null
  }

  const detailed = extractDependenciesDetailed(ast)
  const exports = extractExports(ast)
  const apiVersion = extractApiVersion(source)
  const type = guessScriptType(source, exports)

  return {
    file: relFile,
    type,
    apiVersion,
    dependencies: detailed.dependencies,
    dependenciesIncomplete: detailed.incomplete,
    exports,
    lineCount: source.split('\n').length,
  }
}

// Extract N/ modules from `define(["N/record", "N/search"], function(...) {...})`.
// Only matches the define() call that SuiteScript 2.x uses.
function extractDependencies(ast) {
  return extractDependenciesDetailed(ast).dependencies
}

// extractDependencies, with the completeness signal. The dependency list
// may be an array literal, an in-file variable bound to one, or a spread
// of either — suitescript.js's static reader resolves all of those, and
// anything it cannot read marks the declaration incomplete (adversarial
// pass D10) instead of silently undercounting.
function extractDependenciesDetailed(ast) {
  const bindings = collectArrayBindings(ast)
  const deps = new Set()
  let incomplete = false
  walk.simple(ast, {
    CallExpression(node) {
      if (node.callee.type === 'Identifier' && node.callee.name === 'define') {
        const part = resolveCallModules(node, bindings)
        for (const name of part.names) {
          if (name.startsWith('N/') || name.startsWith('SuiteScripts/')) {
            deps.add(name)
          }
        }
        incomplete = incomplete || part.incomplete
      }
    },
  })
  return { dependencies: Array.from(deps).sort(), incomplete }
}

// Extract exports from `return { onRequest: ..., beforeSubmit: ... }`
// inside the define() factory.
function extractExports(ast) {
  const names = new Set()
  walk.simple(ast, {
    CallExpression(node) {
      if (node.callee.type !== 'Identifier' || node.callee.name !== 'define') return
      const factory = node.arguments.find(
        (a) => a && (a.type === 'FunctionExpression' || a.type === 'ArrowFunctionExpression'),
      )
      if (!factory) return
      const body = factory.body.type === 'BlockStatement' ? factory.body.body : [factory.body]
      for (const stmt of body) {
        if (stmt.type === 'ReturnStatement' && stmt.argument && stmt.argument.type === 'ObjectExpression') {
          for (const prop of stmt.argument.properties) {
            if (prop.type !== 'Property' || !prop.key) continue
            const name = prop.key.type === 'Identifier' ? prop.key.name
              : (prop.key.type === 'Literal' ? prop.key.value : null)
            if (typeof name === 'string') names.add(name)
          }
        }
      }
    },
  })
  return Array.from(names).sort()
}

// Use the `@NScriptType FooScript` jsdoc tag if present (extracted by
// suitescript.js); fall back to export shape.
function guessScriptType(source, exports) {
  const tag = extractScriptTypeTag(source)
  if (tag && SUITESCRIPT_TYPES.has(tag)) return tag
  // Vote by exports — pick the most-attested type.
  const votes = new Map()
  for (const name of exports) {
    const t = EXPORT_TO_TYPE[name]
    if (t) votes.set(t, (votes.get(t) || 0) + 1)
  }
  if (votes.size === 0) return null
  return Array.from(votes.entries()).sort((a, b) => b[1] - a[1])[0][0]
}

async function exists(p) {
  try { await fs.access(p); return true } catch { return false }
}

function sortDesc(map) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
}

module.exports = {
  analyze,
  // exported for tests:
  assertUsableProjectRoot,
  readManifest, scanScripts, parseScript, parseLooseScript,
  extractDependencies, extractDependenciesDetailed, extractExports, guessScriptType,
  extractApiVersion,
  // exported for the pattern checks (src/checks.js), which examine the
  // changed files under the same resolved SuiteScripts folder the
  // inventory scans:
  findSuiteScriptsRoot,
}
