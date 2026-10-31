// Unit tests for the free-tier engine (src/analyzer.js).
// Run with: node --test tests/

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const acorn = require('acorn')

const {
  analyze,
  parseScript,
  extractDependencies,
  extractExports,
  guessScriptType,
} = require('../src/analyzer')

const FIXTURES = path.join(__dirname, 'fixtures')
const MINIMAL = path.join(FIXTURES, 'minimal-sdf')
const BROKEN = path.join(FIXTURES, 'broken-sdf')

function parseSnippet(source) {
  return acorn.parse(source, { ecmaVersion: 2022, sourceType: 'script' })
}

// ---------- extractDependencies ----------

test('extractDependencies collects N/ and SuiteScripts/ modules, sorted and de-duplicated', () => {
  const ast = parseSnippet(
    "define(['N/record', 'N/log', 'SuiteScripts/lib/util', 'N/record', 'plain'], function () {})",
  )
  assert.deepEqual(extractDependencies(ast), ['N/log', 'N/record', 'SuiteScripts/lib/util'])
})

test('extractDependencies returns [] when there is no define() call', () => {
  assert.deepEqual(extractDependencies(parseSnippet('var x = 1')), [])
})

// ---------- extractExports ----------

test('extractExports reads the object returned by the define() factory', () => {
  const ast = parseSnippet(
    'define([], function () { return { beforeLoad: a, afterSubmit: b } })',
  )
  assert.deepEqual(extractExports(ast), ['afterSubmit', 'beforeLoad'])
})

test('extractExports returns [] when the factory returns nothing', () => {
  const ast = parseSnippet('define([], function () { var x = 1 })')
  assert.deepEqual(extractExports(ast), [])
})

// ---------- guessScriptType ----------

test('guessScriptType prefers the @NScriptType tag over export shape', () => {
  assert.equal(guessScriptType('/** @NScriptType Restlet */', ['onRequest']), 'Restlet')
})

test('guessScriptType infers from exports when no tag is present', () => {
  assert.equal(guessScriptType('', ['beforeLoad', 'beforeSubmit', 'afterSubmit']), 'UserEventScript')
  assert.equal(guessScriptType('', ['getInputData']), 'MapReduceScript')
})

test('guessScriptType returns null when nothing is attested', () => {
  assert.equal(guessScriptType('', []), null)
  assert.equal(guessScriptType('', ['summarize']), null)
})

// ---------- parseScript ----------

test('parseScript reports type, API version and dependencies for a tagged script', async () => {
  const file = path.join(MINIMAL, 'src', 'FileCabinet', 'SuiteScripts', 'fixture_user_event.js')
  const script = await parseScript(file, MINIMAL, [])
  assert.equal(script.type, 'UserEventScript')
  assert.equal(script.apiVersion, '2.1')
  assert.deepEqual(script.dependencies, ['N/record', 'N/search'])
  assert.deepEqual(script.exports, ['afterSubmit', 'beforeSubmit'])
  assert.equal(script.file, 'src/FileCabinet/SuiteScripts/fixture_user_event.js')
})

test('parseScript returns null and records a warning for unparseable source', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdf-action-test-'))
  const file = path.join(dir, 'bad.js')
  await fs.writeFile(file, 'define([, function () {')
  const warnings = []
  const script = await parseScript(file, dir, warnings)
  assert.equal(script, null)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0].message, /parse failed/)
})

// ---------- analyze: full-project behaviour ----------

test('analyze on the minimal fixture produces the expected inventory', async () => {
  const result = await analyze(MINIMAL)

  assert.equal(result.project.name, 'Minimal SDF Fixture')
  assert.equal(result.project.type, 'ACCOUNTPROJECT')
  assert.equal(result.project.frameworkVersion, '1.0')
  assert.equal(result.project.manifestPath, path.join('src', 'manifest.xml'))

  assert.equal(result.stats.scriptCount, 2)
  assert.equal(result.stats.dependencyCount, 3)
  assert.equal(result.stats.warningCount, 0)
  assert.deepEqual(result.warnings, [])

  // N/record is used by both scripts; the rest by one each.
  assert.deepEqual(result.moduleUsage, [['N/record', 2], ['N/search', 1], ['N/ui/message', 1]])
  assert.deepEqual(new Map(result.byType), new Map([['ClientScript', 1], ['UserEventScript', 1]]))
})

test('analyze on the broken fixture excludes the bad script and warns once', async () => {
  const result = await analyze(BROKEN)
  assert.equal(result.project.name, 'Broken SDF Fixture')
  assert.equal(result.stats.scriptCount, 0)
  assert.equal(result.stats.warningCount, 1)
  assert.match(result.warnings[0].message, /parse failed/)
  assert.equal(result.warnings[0].file, 'src/FileCabinet/SuiteScripts/broken.js')
})

test('analyze on an empty directory warns about manifest and SuiteScripts, never throws', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdf-action-empty-'))
  const result = await analyze(dir)
  assert.equal(result.project.name, null)
  assert.equal(result.stats.scriptCount, 0)
  assert.equal(result.stats.warningCount, 2)
  assert.ok(result.warnings.some((w) => /manifest\.xml/.test(w.message)))
  assert.ok(result.warnings.some((w) => /SuiteScripts/.test(w.message)))
})
