// SuiteScript file recognition for the free-tier SDF action.
//
// Single responsibility: deciding whether a `.js` file IS a SuiteScript,
// reading the facts its header annotations declare, and finding such files
// anywhere in a repository tree. Project analysis lives in analyzer.js;
// this module knows nothing about SDF projects, manifests, or warnings.

const fs = require('node:fs/promises')
const path = require('node:path')
const acorn = require('acorn')
const walk = require('acorn-walk')

// The recognition markers. A file counts as a SuiteScript only when ONE
// block comment — its JSDoc header — carries BOTH SuiteScript
// annotations. Tag-shaped text anywhere else (a string constant, a
// template literal, a line comment, prose) is a mention, not a
// declaration; trusting it inventoried phantom scripts, including this
// action's own test files, which embed sample headers (adversarial
// pass D2).
const API_VERSION_PATTERN = /@NApiVersion\s+(\S+)/
const SCRIPT_TYPE_PATTERN = /@NScriptType\s+(\w+)/

// Directories never descended into during a repository-tree scan: dependency
// output, build output (including this action's own bundle), and VCS data.
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.git'])

// The text of the source's block comments, in order of appearance.
// Comments are located with acorn's tokenizer rather than a text search,
// so strings and template literals are lexed as code, never as comments.
// Collection stops once both annotation tags have been seen — a header
// lives at the top of its file — and a tokenize failure partway through
// a hostile file leaves the comments gathered so far standing.
function blockCommentTexts(source) {
  const texts = []
  if (!source.includes('@NApiVersion') && !source.includes('@NScriptType')) return texts
  const onComment = (isBlock, text) => {
    if (isBlock) texts.push(text)
  }
  try {
    const tokenizer = acorn.tokenizer(source, {
      ecmaVersion: 2022,
      sourceType: 'script',
      allowHashBang: true,
      onComment,
    })
    for (const token of tokenizer) {
      void token
      if (annotationTagsSeen(texts)) break
    }
  } catch {
    // A file that fails to tokenize can still carry a readable header;
    // recognition works with whatever comments were gathered first.
  }
  return texts
}

function annotationTagsSeen(commentTexts) {
  const hasApi = commentTexts.some((t) => API_VERSION_PATTERN.test(t))
  const hasType = commentTexts.some((t) => SCRIPT_TYPE_PATTERN.test(t))
  return hasApi && hasType
}

// `@NApiVersion 2.x` jsdoc tag — SuiteScript convention. Null when absent.
// The value is the raw token the header declares, reported truthfully: a
// value like `2.1-beta` renders as written, never truncated to `2.1` by
// a narrow capture class. A token with no digit at all (`x`) is not a
// version — it neither satisfies recognition nor renders (D11).
function extractApiVersion(source) {
  for (const text of blockCommentTexts(source)) {
    const m = text.match(API_VERSION_PATTERN)
    if (!m) continue
    return /\d/.test(m[1]) ? m[1] : null
  }
  return null
}

// The raw `@NScriptType` tag value (e.g. "Restlet"), or null when absent.
// Validation against the known script-type set is the caller's job. The
// first tag in the file's block comments wins (recorded behavior).
function extractScriptTypeTag(source) {
  for (const text of blockCommentTexts(source)) {
    const m = text.match(SCRIPT_TYPE_PATTERN)
    if (m) return m[1]
  }
  return null
}

// A file is a SuiteScript when one block comment declares both SuiteScript
// annotations and the declared API version is a version (contains a
// digit). One tag alone — a partial header, a mention in prose — is not
// enough.
function hasSuiteScriptAnnotations(source) {
  return blockCommentTexts(source).some((text) => {
    const api = text.match(API_VERSION_PATTERN)
    return api !== null && /\d/.test(api[1]) && SCRIPT_TYPE_PATTERN.test(text)
  })
}

// In-file array bindings — `var deps = ['N/record', 'N/search']` and its
// const/let equivalents — resolved to the module names they carry, so a
// define() that references its dependency array by name can still be
// read. A binding whose elements cannot all be read statically is
// recorded with `incomplete: true` rather than silently dropped
// (adversarial pass D10).
function collectArrayBindings(ast) {
  const bindings = new Map()
  walk.simple(ast, {
    VariableDeclarator(node) {
      if (node.id.type !== 'Identifier') return
      if (!node.init || node.init.type !== 'ArrayExpression') return
      bindings.set(node.id.name, resolveArrayElements(node.init.elements, bindings))
    },
  })
  return bindings
}

// The module names in one array literal's elements, following identifier
// elements and spreads into the bindings map. Anything that cannot be
// read statically — a dynamic element, a template literal carrying
// substitutions, an unbound identifier — sets `incomplete` instead of
// being guessed at.
function resolveArrayElements(elements, bindings) {
  const names = []
  let incomplete = false
  const absorb = (part) => {
    names.push(...part.names)
    incomplete = incomplete || part.incomplete
  }
  for (const el of elements) {
    if (el === null) continue // an array hole declares nothing
    if (el.type === 'Literal' && typeof el.value === 'string') {
      names.push(el.value)
    } else if (el.type === 'TemplateLiteral') {
      const value = templateLiteralValue(el)
      if (value === null) incomplete = true
      else names.push(value)
    } else if (el.type === 'Identifier') {
      const bound = bindings.get(el.name)
      if (bound) absorb(bound)
      else incomplete = true
    } else if (el.type === 'SpreadElement') {
      if (el.argument.type === 'ArrayExpression') {
        absorb(resolveArrayElements(el.argument.elements, bindings))
      } else if (el.argument.type === 'Identifier') {
        const bound = bindings.get(el.argument.name)
        if (bound) absorb(bound)
        else incomplete = true
      } else {
        incomplete = true
      }
    } else {
      incomplete = true
    }
  }
  return { names, incomplete }
}

// A template literal with no substitutions is a plain string; with
// substitutions its value is computed at run time and unreadable here.
function templateLiteralValue(node) {
  if (node.expressions.length > 0) return null
  const quasi = node.quasis[0]
  return quasi && typeof quasi.value.cooked === 'string' ? quasi.value.cooked : null
}

// The module names one define()/require() call declares, read with the
// same static rules as resolveArrayElements. In define() a leading string
// argument is the module's own name, not a dependency; the dependency
// list may be an array literal or an identifier bound to one in this
// file. In require() a lone string or substitution-free template
// argument is the module; a lone identifier resolves through the
// bindings map when it names an array declared in this file, and is
// dynamic — marked incomplete, never guessed — when it does not.
function resolveCallModules(node, bindings) {
  const names = []
  let incomplete = false
  const absorb = (part) => {
    names.push(...part.names)
    incomplete = incomplete || part.incomplete
  }
  const args = node.arguments
  const arrArg = args.find((a) => a && a.type === 'ArrayExpression')
  if (arrArg) {
    absorb(resolveArrayElements(arrArg.elements, bindings))
    return { names, incomplete }
  }

  if (node.callee.name === 'require') {
    const first = args[0]
    if (!first) return { names, incomplete }
    if (first.type === 'Literal' && typeof first.value === 'string') {
      names.push(first.value)
    } else if (first.type === 'TemplateLiteral') {
      const value = templateLiteralValue(first)
      if (value === null) incomplete = true
      else names.push(value)
    } else if (first.type === 'Identifier') {
      const bound = bindings.get(first.name)
      if (bound) absorb(bound)
      else incomplete = true
    } else {
      incomplete = true
    }
    return { names, incomplete }
  }

  // define() without an array literal: the dependency list, when one is
  // declared, is an identifier in first position (define(deps, factory))
  // or second (define('name', deps, factory)). A lone identifier is the
  // factory itself — define(factory) declares no dependencies.
  const depIndex = args[0] && args[0].type === 'Literal' ? 1 : 0
  const depArg = args[depIndex]
  if (depArg && depArg.type === 'Identifier' && args.length > depIndex + 1) {
    const bound = bindings.get(depArg.name)
    if (bound) absorb(bound)
    else incomplete = true
  }
  return { names, incomplete }
}

// Extract the `N/` modules a script declares, from `define([...])` arrays
// and from `require(...)` calls (array form, or a single string argument).
// Loose-file counterpart to the project scanner's define-only extraction:
// relative and SuiteScripts/ paths are not `N/` modules and are excluded.
function extractLooseDependencies(ast) {
  return extractLooseDependenciesDetailed(ast).dependencies
}

// extractLooseDependencies, with the completeness signal: `incomplete`
// is true when some dependency declaration in the file could not be read
// statically, so the returned list is a lower bound, not the whole truth.
function extractLooseDependenciesDetailed(ast) {
  const bindings = collectArrayBindings(ast)
  const deps = new Set()
  let incomplete = false
  walk.simple(ast, {
    CallExpression(node) {
      const callee = node.callee
      if (callee.type !== 'Identifier') return
      if (callee.name !== 'define' && callee.name !== 'require') return
      const part = resolveCallModules(node, bindings)
      for (const name of part.names) {
        if (name.startsWith('N/')) deps.add(name)
      }
      incomplete = incomplete || part.incomplete
    },
  })
  return { dependencies: Array.from(deps).sort(), incomplete }
}

// Find every SuiteScript file under `root`, at any depth, skipping
// EXCLUDED_DIRS. Returns [{ file, relFile, source }] sorted by relFile so
// inventories are deterministic. Unreadable files are skipped, not fatal:
// recognition is a scan, not an audit.
async function findSuiteScriptFiles(root) {
  return (await scanSuiteScriptTree(root)).files
}

// The full tree scan behind findSuiteScriptFiles, also reporting the
// symlinked entries it skipped. Symlinks are never followed — that is
// what makes symlink cycles harmless by construction — but skipping them
// silently under-reports repositories that route real code through links
// (monorepos especially), so the skipped entries are collected for the
// summary to name instead (adversarial pass D8).
async function scanSuiteScriptTree(root) {
  const files = []
  const skippedSymlinks = []
  await walkTree(root, root, files, skippedSymlinks)
  files.sort((a, b) => a.relFile.localeCompare(b.relFile))
  skippedSymlinks.sort()
  return { files, skippedSymlinks }
}

async function walkTree(dir, root, out, skippedSymlinks) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    const relFile = path.relative(root, full).split(path.sep).join('/')
    if (e.isSymbolicLink()) {
      if (await isSkippedSymlink(full, e.name)) skippedSymlinks.push(relFile)
    } else if (e.isDirectory()) {
      if (!EXCLUDED_DIRS.has(e.name)) await walkTree(full, root, out, skippedSymlinks)
    } else if (e.isFile() && e.name.endsWith('.js')) {
      let source
      try {
        source = await fs.readFile(full, 'utf8')
      } catch {
        continue
      }
      if (hasSuiteScriptAnnotations(source)) {
        out.push({ file: full, relFile, source })
      }
    }
  }
}

// A symlink counts as skipped scan content when it resolves to a
// directory (a subtree the scan would have walked) or to a `.js` file.
// Broken links and links to other file kinds are not scan content and
// pass unrecorded.
async function isSkippedSymlink(full, name) {
  try {
    const stat = await fs.stat(full)
    return stat.isDirectory() || (stat.isFile() && name.endsWith('.js'))
  } catch {
    return false
  }
}

module.exports = {
  EXCLUDED_DIRS,
  extractApiVersion,
  extractScriptTypeTag,
  hasSuiteScriptAnnotations,
  extractLooseDependencies,
  extractLooseDependenciesDetailed,
  collectArrayBindings,
  resolveCallModules,
  findSuiteScriptFiles,
  scanSuiteScriptTree,
  isSkippedSymlink,
}
