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
  assertUsableProjectRoot,
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

// ---------- D3: a nonexistent project-path must fail, not read as empty ----------
// Regression tests for adversarial-pass D3: before the fix, a typo in
// project-path produced a green run claiming the repository was empty.

test('D3: assertUsableProjectRoot rejects a path that does not exist, naming it', async () => {
  const missing = path.join(os.tmpdir(), 'sdf-action-no-such-dir-2026')
  await assert.rejects(
    () => assertUsableProjectRoot(missing, 'does/not/exist'),
    (err) => {
      assert.match(err.message, /project-path "does\/not\/exist" does not exist/)
      assert.ok(err.message.includes(missing), 'error names the resolved path')
      return true
    },
  )
})

test('D3: assertUsableProjectRoot rejects a file as project-path, naming it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdf-action-filepath-'))
  const file = path.join(dir, 'realfile.js')
  await fs.writeFile(file, '// not a directory\n')
  await assert.rejects(
    () => assertUsableProjectRoot(file, 'realfile.js'),
    (err) => {
      assert.match(err.message, /project-path "realfile\.js" is not a directory/)
      assert.ok(err.message.includes(file), 'error names the resolved path')
      return true
    },
  )
})

test('D3: assertUsableProjectRoot accepts an existing directory, empty or not', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdf-action-okdir-'))
  await assertUsableProjectRoot(dir, '.')
  await assertUsableProjectRoot(MINIMAL, 'tests/fixtures/minimal-sdf')
})
