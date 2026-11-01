// SuiteScript file recognition for the free-tier SDF action.
//
// Single responsibility: deciding whether a `.js` file IS a SuiteScript,
// reading the facts its header annotations declare, and finding such files
// anywhere in a repository tree. Project analysis lives in analyzer.js;
// this module knows nothing about SDF projects, manifests, or warnings.

const fs = require('node:fs/promises')
const path = require('node:path')
const walk = require('acorn-walk')

// The recognition markers, in one place: a file counts as a SuiteScript
// only when its source carries BOTH SuiteScript JSDoc annotations.
const API_VERSION_PATTERN = /@NApiVersion\s+([\d.x]+)/
const SCRIPT_TYPE_PATTERN = /@NScriptType\s+(\w+)/

// Directories never descended into during a repository-tree scan: dependency
// output, build output (including this action's own bundle), and VCS data.
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.git'])

// `@NApiVersion 2.x` jsdoc tag — SuiteScript convention. Null when absent.
function extractApiVersion(source) {
  const m = source.match(API_VERSION_PATTERN)
  return m ? m[1] : null
}

// The raw `@NScriptType` tag value (e.g. "Restlet"), or null when absent.
// Validation against the known script-type set is the caller's job.
function extractScriptTypeTag(source) {
  const m = source.match(SCRIPT_TYPE_PATTERN)
  return m ? m[1] : null
}

// A file is a SuiteScript when it declares both SuiteScript annotations.
// One tag alone — a partial header, a mention in prose — is not enough.
function hasSuiteScriptAnnotations(source) {
  return API_VERSION_PATTERN.test(source) && SCRIPT_TYPE_PATTERN.test(source)
}

// Extract the `N/` modules a script declares, from `define([...])` arrays
// and from `require(...)` calls (array form, or a single string argument).
// Loose-file counterpart to the project scanner's define-only extraction:
// relative and SuiteScripts/ paths are not `N/` modules and are excluded.
function extractLooseDependencies(ast) {
  const deps = new Set()
  walk.simple(ast, {
    CallExpression(node) {
      const callee = node.callee
      if (callee.type !== 'Identifier') return
      if (callee.name !== 'define' && callee.name !== 'require') return
      for (const name of moduleNamesInCall(node)) {
        if (name.startsWith('N/')) deps.add(name)
      }
    },
  })
  return Array.from(deps).sort()
}

// The string module names passed to one define()/require() call: every
// literal in its array argument. A lone string argument counts only for
// require (`require('N/record')`); in define() a leading string is the
// module's own name, not a dependency.
function moduleNamesInCall(node) {
  const names = []
  const arrArg = node.arguments.find((a) => a && a.type === 'ArrayExpression')
  if (arrArg) {
    for (const el of arrArg.elements) {
      if (el && el.type === 'Literal' && typeof el.value === 'string') names.push(el.value)
    }
  }
  const first = node.arguments[0]
  if (
    node.callee.name === 'require' &&
    first && first.type === 'Literal' && typeof first.value === 'string'
  ) {
    names.push(first.value)
  }
  return names
}

// Find every SuiteScript file under `root`, at any depth, skipping
// EXCLUDED_DIRS. Returns [{ file, relFile, source }] sorted by relFile so
// inventories are deterministic. Unreadable files are skipped, not fatal:
// recognition is a scan, not an audit.
async function findSuiteScriptFiles(root) {
  const found = []
  await walkTree(root, root, found)
  found.sort((a, b) => a.relFile.localeCompare(b.relFile))
  return found
}

async function walkTree(dir, root, out) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!EXCLUDED_DIRS.has(e.name)) await walkTree(full, root, out)
    } else if (e.isFile() && e.name.endsWith('.js')) {
      let source
      try {
        source = await fs.readFile(full, 'utf8')
      } catch {
        continue
      }
      if (hasSuiteScriptAnnotations(source)) {
        out.push({
          file: full,
          relFile: path.relative(root, full).split(path.sep).join('/'),
          source,
        })
      }
    }
  }
}

module.exports = {
  EXCLUDED_DIRS,
  extractApiVersion,
  extractScriptTypeTag,
  hasSuiteScriptAnnotations,
  extractLooseDependencies,
  findSuiteScriptFiles,
}
