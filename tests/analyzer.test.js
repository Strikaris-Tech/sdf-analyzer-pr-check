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
  readManifest,
  parseScript,
  extractDependencies,
  extractDependenciesDetailed,
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

// D9 (adversarial pass): empty mode used to inherit the manifest and
// SuiteScripts warnings, so a repository with no project at all reported
// has-issues=true and failed under fail-on-issues. Finding nothing is a
// statement, not an issue — analyze() now attaches no warnings in empty
// mode. The probe itself still produces the warnings for callers that
// ask for them (second test); they are simply not issues of an empty
// repository.
test('D9: analyze on an empty directory reports no issues, never throws', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdf-action-empty-'))
  const result = await analyze(dir)
  assert.equal(result.mode, 'empty')
  assert.equal(result.project.name, null)
  assert.equal(result.stats.scriptCount, 0)
  assert.equal(result.stats.warningCount, 0)
  assert.deepEqual(result.warnings, [])
})

test('D9: the manifest probe still reports a missing manifest when asked directly', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdf-action-probe-'))
  const warnings = []
  const manifest = await readManifest(dir, warnings)
  assert.equal(manifest.name, null)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0].message, /No manifest\.xml found/)
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

// ── D5 + D13 (adversarial pass): one real manifest problem, one warning ──
// A malformed manifest used to produce two contradictory warnings (parse
// failure AND "not found") and shadow a valid manifest at the other
// location; a well-formed XML file with the wrong root element used to
// be accepted as a manifest with empty fields.

function parse(src) {
  return acorn.parse(src, { ecmaVersion: 2022, sourceType: 'script' })
}

const ANNOTATED_SCRIPT = `/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 */
define(['N/currentRecord'], function (currentRecord) { return {} })
`

async function tempProject(manifests) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdf-action-manifest-'))
  const suiteDir = path.join(dir, 'src', 'FileCabinet', 'SuiteScripts')
  await fs.mkdir(suiteDir, { recursive: true })
  await fs.writeFile(path.join(suiteDir, 'ok.js'), ANNOTATED_SCRIPT)
  for (const [rel, content] of Object.entries(manifests)) {
    const full = path.join(dir, rel)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content)
  }
  return dir
}

test('D5: a malformed manifest earns exactly one warning, never a contradictory pair', async () => {
  const dir = await tempProject({ 'src/manifest.xml': '<manifest><unclosed' })
  const result = await analyze(dir)
  assert.equal(result.mode, 'project')
  assert.equal(result.stats.scriptCount, 1)
  assert.equal(result.stats.warningCount, 1)
  assert.match(result.warnings[0].message, /manifest\.xml parse failed/)
  assert.ok(!result.warnings.some((w) => /No manifest\.xml found/.test(w.message)))
})

test('D5: a broken src/ manifest falls through to a valid root manifest', async () => {
  const dir = await tempProject({
    'src/manifest.xml': 'not xml at all <<<',
    'manifest.xml':
      '<manifest><projectname>Rooty</projectname><projecttype>ACCOUNTCUSTOMIZATION</projecttype></manifest>',
  })
  const result = await analyze(dir)
  assert.equal(result.mode, 'project')
  assert.equal(result.project.name, 'Rooty')
  assert.equal(result.project.type, 'ACCOUNTCUSTOMIZATION')
  assert.equal(result.project.manifestPath, 'manifest.xml')
  // The fallback is noted by the broken file's own warning — one warning.
  assert.equal(result.stats.warningCount, 1)
  assert.match(result.warnings[0].message, /manifest\.xml parse failed/)
  assert.ok(result.warnings[0].file.endsWith(path.join('src', 'manifest.xml')))
})

test('D13: a well-formed XML file with the wrong root element is not a manifest', async () => {
  const dir = await tempProject({ 'src/manifest.xml': '<configuration></configuration>' })
  const result = await analyze(dir)
  assert.equal(result.mode, 'project')
  assert.equal(result.project.name, null)
  assert.equal(result.stats.warningCount, 1)
  assert.match(result.warnings[0].message, /does not look like an SDF manifest/)
  assert.match(result.warnings[0].message, /<configuration>/)
  assert.ok(!result.warnings.some((w) => /No manifest\.xml found/.test(w.message)))
})

// ── D6 (adversarial pass): empty files are not scripts ───────────────────
// An empty or whitespace-only .js file parses to an empty program and
// used to enter the inventory as a phantom "Unknown" script.

test('D6: project mode does not count empty or whitespace-only files as scripts', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdf-action-d6-'))
  await fs.cp(MINIMAL, dir, { recursive: true })
  const suiteDir = path.join(dir, 'src', 'FileCabinet', 'SuiteScripts')
  await fs.writeFile(path.join(suiteDir, 'empty.js'), '')
  await fs.writeFile(path.join(suiteDir, 'whitespace.js'), '  \n\t \n')
  const result = await analyze(dir)
  assert.equal(result.mode, 'project')
  assert.equal(result.stats.scriptCount, 2)
  assert.ok(!result.scripts.some((s) => /empty|whitespace/.test(s.file)))
})

// ── D8 (adversarial pass): symlinks are skipped, and the skip is reported ─
// Links are never followed (a cyclic link cannot hang the scan) but a
// skipped link is recorded in the result instead of vanishing silently.

test('D8: project mode records a symlinked script as skipped, never follows it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdf-action-d8-'))
  await fs.cp(MINIMAL, dir, { recursive: true })
  const suiteDir = path.join(dir, 'src', 'FileCabinet', 'SuiteScripts')
  await fs.symlink(
    path.join(suiteDir, 'fixture_client.js'),
    path.join(suiteDir, 'linked_copy.js'),
  )
  const result = await analyze(dir)
  assert.equal(result.mode, 'project')
  assert.equal(result.stats.scriptCount, 2)
  assert.deepEqual(result.skippedSymlinks, [
    'src/FileCabinet/SuiteScripts/linked_copy.js',
  ])
})

// ── D10 (adversarial pass): dependency declarations are read statically ──
// A top-level define whose array is a variable, a spread, or otherwise
// not a bare literal used to resolve to an undercount (often zero).

test('D10: extractDependencies resolves an in-file variable binding', () => {
  const src = `
    var deps = ['N/record', 'N/search']
    define(deps, function () {})
  `
  assert.deepEqual(extractDependencies(parse(src)), ['N/record', 'N/search'])
})

test('D10: extractDependencies follows spreads of bound arrays', () => {
  const src = `
    var more = ['N/email']
    define([...more, 'N/log'], function () {})
  `
  assert.deepEqual(extractDependencies(parse(src)), ['N/email', 'N/log'])
})

test('D10: an unreadable define is marked incomplete, never guessed', () => {
  const src = 'define(chosenAtRuntime, function () {})'
  const detailed = extractDependenciesDetailed(parse(src))
  assert.deepEqual(detailed.dependencies, [])
  assert.equal(detailed.incomplete, true)
})
