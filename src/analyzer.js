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
  extractLooseDependencies,
  findSuiteScriptFiles,
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
    if (suiteRoot) {
      await walkJs(suiteRoot, projectRoot, scripts, warnings)
    } else {
      warnings.push({
        file: path.join(projectRoot, 'src', 'FileCabinet', 'SuiteScripts'),
        message: 'No SuiteScripts directory found — skipping script scan.',
      })
    }
    const outsideSuiteScripts = await scanOutsideSuiteScripts(projectRoot)
    return buildResult({ mode: 'project', project: manifest, scripts, warnings, outsideSuiteScripts })
  }

  const looseFiles = await findSuiteScriptFiles(projectRoot)
  if (looseFiles.length === 0) {
    warnings.push(...manifestWarnings, {
      file: path.join(projectRoot, 'src', 'FileCabinet', 'SuiteScripts'),
      message: 'No SuiteScripts directory found — skipping script scan.',
    })
    return buildResult({ mode: 'empty', project: manifest, scripts: [], warnings, outsideSuiteScripts: [] })
  }

  const scripts = looseFiles.map((found) => parseLooseScript(found))
  return buildResult({ mode: 'loose', project: manifest, scripts, warnings, outsideSuiteScripts: [] })
}

function buildResult({ mode, project, scripts, warnings, outsideSuiteScripts }) {
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
  const found = await findSuiteScriptFiles(projectRoot)
  return found
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
  let exports = []
  const ast = tryParse(source)
  if (ast) {
    dependencies = extractLooseDependencies(ast)
    exports = extractExports(ast)
    type = guessScriptType(source, exports) || type
  }
  return {
    file: relFile,
    type,
    apiVersion: extractApiVersion(source),
    dependencies,
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
// but unparseable still counts, because mode selection keys off the layout
// existing, not off it being valid. Warnings match readManifest's history:
// a parse failure and a missing manifest are both reported.
async function probeManifest(projectRoot, warnings) {
  // SDF projects may place manifest.xml at project root OR under src/.
  const candidates = [
    path.join(projectRoot, 'src', 'manifest.xml'),
    path.join(projectRoot, 'manifest.xml'),
  ]
  let present = false
  for (const file of candidates) {
    try {
      const raw = await fs.readFile(file, 'utf8')
      present = true
      const xml = await parseStringPromise(raw, { explicitArray: false, mergeAttrs: true })
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
    } catch (err) {
      if (err.code !== 'ENOENT') {
        present = true
        warnings.push({ file, message: `manifest.xml parse failed: ${err.message}` })
        break
      }
    }
  }
  warnings.push({
    file: path.join(projectRoot, 'src', 'manifest.xml'),
    message: 'No manifest.xml found — project may not be a valid SDF project.',
  })
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
    await walkJs(root, projectRoot, scripts, warnings)
    return scripts
  }
  warnings.push({
    file: path.join(projectRoot, 'src', 'FileCabinet', 'SuiteScripts'),
    message: 'No SuiteScripts directory found — skipping script scan.',
  })
  return scripts
}

async function walkJs(dir, projectRoot, out, warnings) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      await walkJs(full, projectRoot, out, warnings)
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

  let ast
  try {
    ast = acorn.parse(source, PARSE_OPTIONS)
  } catch (err) {
    warnings.push({ file: relFile, message: `parse failed: ${err.message}` })
    return null
  }

  const dependencies = extractDependencies(ast)
  const exports = extractExports(ast)
  const apiVersion = extractApiVersion(source)
  const type = guessScriptType(source, exports)

  return {
    file: relFile,
    type,
    apiVersion,
    dependencies,
    exports,
    lineCount: source.split('\n').length,
  }
}

// Extract N/ modules from `define(["N/record", "N/search"], function(...) {...})`.
// Only matches the top-level define() call that SuiteScript 2.x uses.
function extractDependencies(ast) {
  const deps = new Set()
  walk.simple(ast, {
    CallExpression(node) {
      if (node.callee.type === 'Identifier' && node.callee.name === 'define') {
        const arrArg = node.arguments.find((a) => a && a.type === 'ArrayExpression')
        if (!arrArg) return
        for (const el of arrArg.elements) {
          if (el && el.type === 'Literal' && typeof el.value === 'string') {
            if (el.value.startsWith('N/') || el.value.startsWith('SuiteScripts/')) {
              deps.add(el.value)
            }
          }
        }
      }
    },
  })
  return Array.from(deps).sort()
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
  readManifest, scanScripts, parseScript, parseLooseScript,
  extractDependencies, extractExports, guessScriptType,
  extractApiVersion,
}
