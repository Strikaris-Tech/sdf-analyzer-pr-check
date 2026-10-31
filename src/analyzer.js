// Free-tier SDF analyzer — runs entirely on the GitHub Actions runner.
//
// Deliberately minimal: manifest parse, script scan, dependency + export
// extraction via Acorn, module-usage aggregation. Everything deeper
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

async function analyze(projectRoot) {
  const warnings = []
  const manifest = await readManifest(projectRoot, warnings)
  const scripts = await scanScripts(projectRoot, warnings)

  const moduleUsage = new Map()
  const byType = new Map()

  for (const s of scripts) {
    if (s.type) byType.set(s.type, (byType.get(s.type) || 0) + 1)
    for (const dep of s.dependencies) {
      moduleUsage.set(dep, (moduleUsage.get(dep) || 0) + 1)
    }
  }

  return {
    project: manifest,
    scripts,
    moduleUsage: sortDesc(moduleUsage),
    byType: sortDesc(byType),
    warnings,
    stats: {
      scriptCount: scripts.length,
      dependencyCount: moduleUsage.size,
      typeCount: byType.size,
      warningCount: warnings.length,
    },
  }
}

async function readManifest(projectRoot, warnings) {
  // SDF projects may place manifest.xml at project root OR under src/.
  const candidates = [
    path.join(projectRoot, 'src', 'manifest.xml'),
    path.join(projectRoot, 'manifest.xml'),
  ]
  for (const file of candidates) {
    try {
      const raw = await fs.readFile(file, 'utf8')
      const xml = await parseStringPromise(raw, { explicitArray: false, mergeAttrs: true })
      const m = xml.manifest || {}
      return {
        name: (m.projectname || m.name || '').toString().trim() || null,
        type: (m.projecttype || m.type || '').toString().trim() || null,
        frameworkVersion: (m.frameworkversion || '').toString().trim() || null,
        manifestPath: path.relative(projectRoot, file),
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        warnings.push({ file, message: `manifest.xml parse failed: ${err.message}` })
        break
      }
    }
  }
  warnings.push({
    file: path.join(projectRoot, 'src', 'manifest.xml'),
    message: 'No manifest.xml found — project may not be a valid SDF project.',
  })
  return { name: null, type: null, frameworkVersion: null, manifestPath: null }
}

async function scanScripts(projectRoot, warnings) {
  const roots = [
    path.join(projectRoot, 'src', 'FileCabinet', 'SuiteScripts'),
    path.join(projectRoot, 'FileCabinet', 'SuiteScripts'),
  ]
  const scripts = []
  for (const root of roots) {
    if (await exists(root)) {
      await walkJs(root, projectRoot, scripts, warnings)
      return scripts
    }
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
    ast = acorn.parse(source, {
      ecmaVersion: 2022,
      sourceType: 'script',
      allowReturnOutsideFunction: true,
      allowHashBang: true,
    })
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

// `@NApiVersion 2.x` jsdoc tag — SuiteScript convention.
function extractApiVersion(source) {
  const m = source.match(/@NApiVersion\s+([\d.x]+)/)
  return m ? m[1] : null
}

// Use `@NScriptType FooScript` jsdoc if present; fall back to export shape.
function guessScriptType(source, exports) {
  const tag = source.match(/@NScriptType\s+(\w+)/)
  if (tag && SUITESCRIPT_TYPES.has(tag[1])) return tag[1]
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
  readManifest, scanScripts, parseScript,
  extractDependencies, extractExports, guessScriptType,
}
