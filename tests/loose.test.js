// Unit tests for loose-file mode: SuiteScript recognition (src/suitescript.js),
// mode selection in analyze(), and the loose / empty / outside-note rendering.
// Run with: node --test tests/

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const acorn = require('acorn')

const {
  extractApiVersion,
  extractScriptTypeTag,
  hasSuiteScriptAnnotations,
  extractLooseDependencies,
  findSuiteScriptFiles,
} = require('../src/suitescript')
const { analyze } = require('../src/analyzer')
const { renderSummary } = require('../src/comment')

const FIXTURES = path.join(__dirname, 'fixtures')
const MINIMAL = path.join(FIXTURES, 'minimal-sdf')
const LOOSE = path.join(FIXTURES, 'loose-scripts')

function parseSnippet(source) {
  return acorn.parse(source, { ecmaVersion: 2022, sourceType: 'script' })
}

const ANNOTATED = (type, api = '2.1') =>
  `/**\n * @NApiVersion ${api}\n * @NScriptType ${type}\n */\ndefine(['N/record'], function () {})\n`

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sdf-action-loose-'))
}

async function writeFile(root, rel, content) {
  const full = path.join(root, rel)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content)
  return full
}

// ---------- annotation detection ----------

test('hasSuiteScriptAnnotations accepts a file carrying both SuiteScript tags', () => {
  assert.equal(hasSuiteScriptAnnotations(ANNOTATED('Restlet')), true)
})

test('hasSuiteScriptAnnotations rejects a file with no tags', () => {
  assert.equal(hasSuiteScriptAnnotations("define(['N/record'], function () {})"), false)
  assert.equal(hasSuiteScriptAnnotations('var x = 1'), false)
})

test('hasSuiteScriptAnnotations rejects partial annotations — one tag is not enough', () => {
  assert.equal(hasSuiteScriptAnnotations('/** @NApiVersion 2.1 */\nvar x = 1'), false)
  assert.equal(hasSuiteScriptAnnotations('/** @NScriptType Restlet */\nvar x = 1'), false)
})

test('extractApiVersion and extractScriptTypeTag read the declared values', () => {
  const source = ANNOTATED('MapReduceScript', '2.x')
  assert.equal(extractApiVersion(source), '2.x')
  assert.equal(extractScriptTypeTag(source), 'MapReduceScript')
  assert.equal(extractApiVersion('var x = 1'), null)
  assert.equal(extractScriptTypeTag('var x = 1'), null)
})

// ---------- loose dependency extraction ----------

test('extractLooseDependencies reads define() arrays, N/ modules only', () => {
  const ast = parseSnippet(
    "define(['N/record', './lib/helper', 'SuiteScripts/lib/util', 'N/log', 'N/record'], function () {})",
  )
  assert.deepEqual(extractLooseDependencies(ast), ['N/log', 'N/record'])
})

test('extractLooseDependencies reads require() arrays and lone-string require() calls', () => {
  const fromArray = parseSnippet("require(['N/ui/dialog', 'N/runtime'], function () {})")
  assert.deepEqual(extractLooseDependencies(fromArray), ['N/runtime', 'N/ui/dialog'])

  const fromString = parseSnippet("var r = require('N/record')")
  assert.deepEqual(extractLooseDependencies(fromString), ['N/record'])
})

test('extractLooseDependencies ignores a define() module name and non-N/ require() paths', () => {
  const named = parseSnippet("define('myModule', ['N/search'], function () {})")
  assert.deepEqual(extractLooseDependencies(named), ['N/search'])

  const relative = parseSnippet("require(['./local'], function () {})")
  assert.deepEqual(extractLooseDependencies(relative), [])

  assert.deepEqual(extractLooseDependencies(parseSnippet('var x = 1')), [])
})

// ---------- tree scan and exclusions ----------

test('findSuiteScriptFiles finds the annotated fixture files and ignores the plain one', async () => {
  const found = await findSuiteScriptFiles(LOOSE)
  assert.deepEqual(found.map((f) => f.relFile), [
    'client/cs_form_validation.js',
    'mr_order_export.js',
    'rl_customer_api.js',
    'ss_invoice_sync.js',
  ])
})

test('findSuiteScriptFiles never descends into node_modules, dist, or .git', async () => {
  const dir = await tempDir()
  await writeFile(dir, 'visible.js', ANNOTATED('Suitelet'))
  await writeFile(dir, 'node_modules/pkg/hidden.js', ANNOTATED('Restlet'))
  await writeFile(dir, 'dist/bundle.js', ANNOTATED('Restlet'))
  await writeFile(dir, '.git/hooks/hook.js', ANNOTATED('Restlet'))
  const found = await findSuiteScriptFiles(dir)
  assert.deepEqual(found.map((f) => f.relFile), ['visible.js'])
})

// ---------- mode selection ----------

test('analyze selects project mode for the minimal SDF fixture, unchanged', async () => {
  const result = await analyze(MINIMAL)
  assert.equal(result.mode, 'project')
  assert.equal(result.stats.scriptCount, 2)
  assert.equal(result.stats.dependencyCount, 3)
  assert.equal(result.stats.warningCount, 0)
  assert.deepEqual(result.outsideSuiteScripts, [])
})

test('analyze selects loose mode for a folder of SuiteScripts with no project', async () => {
  const result = await analyze(LOOSE)
  assert.equal(result.mode, 'loose')
  assert.equal(result.stats.scriptCount, 4)
  assert.equal(result.stats.dependencyCount, 7)
  assert.deepEqual(result.warnings, [])

  assert.deepEqual(
    new Map(result.byType),
    new Map([['ClientScript', 1], ['MapReduceScript', 1], ['Restlet', 1], ['ScheduledScript', 1]]),
  )
  assert.deepEqual(result.moduleUsage, [
    ['N/record', 3], ['N/search', 2], ['N/error', 1], ['N/log', 1],
    ['N/runtime', 1], ['N/task', 1], ['N/ui/dialog', 1],
  ])

  const restlet = result.scripts.find((s) => s.file === 'rl_customer_api.js')
  assert.equal(restlet.type, 'Restlet')
  assert.equal(restlet.apiVersion, '2.1')
  assert.deepEqual(restlet.dependencies, ['N/error', 'N/log', 'N/record'])

  const client = result.scripts.find((s) => s.file === 'client/cs_form_validation.js')
  assert.equal(client.type, 'ClientScript')
  assert.deepEqual(client.dependencies, ['N/runtime', 'N/ui/dialog'])

  const mapReduce = result.scripts.find((s) => s.file === 'mr_order_export.js')
  assert.equal(mapReduce.type, 'MapReduceScript')
  assert.equal(mapReduce.apiVersion, '2.x')
})

test('analyze selects empty mode when there is no project and no SuiteScript', async () => {
  const dir = await tempDir()
  const result = await analyze(dir)
  assert.equal(result.mode, 'empty')
  assert.equal(result.stats.scriptCount, 0)
  assert.equal(result.stats.warningCount, 2)
})

test('analyze lists a loose SuiteScript that fails to parse, with no dependencies', async () => {
  const dir = await tempDir()
  await writeFile(dir, 'broken_loose.js', `${ANNOTATED('UserEventScript')}var total =\n`)
  const result = await analyze(dir)
  assert.equal(result.mode, 'loose')
  assert.equal(result.stats.scriptCount, 1)
  assert.equal(result.scripts[0].type, 'UserEventScript')
  assert.equal(result.scripts[0].apiVersion, '2.1')
  assert.deepEqual(result.scripts[0].dependencies, [])
  assert.deepEqual(result.warnings, [])
})

test('project mode reports annotated files outside the SuiteScripts folder as seen-not-scanned', async () => {
  const dir = await tempDir()
  await fs.cp(MINIMAL, dir, { recursive: true })
  await writeFile(dir, 'tools/stray_restlet.js', ANNOTATED('Restlet'))
  const result = await analyze(dir)
  assert.equal(result.mode, 'project')
  assert.equal(result.stats.scriptCount, 2)
  assert.equal(result.stats.warningCount, 0)
  assert.deepEqual(result.outsideSuiteScripts, ['tools/stray_restlet.js'])
})

// ---------- rendering ----------

test('renderSummary in loose mode shows the inventory with no Issues section', async () => {
  const md = renderSummary(await analyze(LOOSE))
  assert.match(md, /loose-file mode/)
  assert.match(md, /\*\*4\*\* scripts · \*\*7\*\* unique module dependencies/)
  assert.match(md, /`rl_customer_api\.js` \| Restlet \| 2\.1 \| 3/)
  assert.match(md, /`client\/cs_form_validation\.js` \| ClientScript/)
  assert.match(md, /### Scripts by type/)
  assert.doesNotMatch(md, /### Issues/)
  assert.doesNotMatch(md, /issues/)
})

test('renderSummary in empty mode states plainly that nothing was found', async () => {
  const dir = await tempDir()
  const md = renderSummary(await analyze(dir))
  assert.match(md, /No SDF project and no SuiteScript files were found in this repository\./)
})

test('renderSummary notes outside files in project mode and stays silent without them', async () => {
  const dir = await tempDir()
  await fs.cp(MINIMAL, dir, { recursive: true })
  await writeFile(dir, 'tools/stray_restlet.js', ANNOTATED('Restlet'))
  const withStray = renderSummary(await analyze(dir))
  assert.match(withStray, /seen but not scanned: `tools\/stray_restlet\.js`/)

  const clean = renderSummary(await analyze(MINIMAL))
  assert.doesNotMatch(clean, /seen but not scanned/)
  // Project-mode format is otherwise the pre-loose-mode format.
  assert.match(clean, /\*\*2\*\* scripts · \*\*3\*\* unique module dependencies · \*\*0\*\* issues/)
  assert.match(clean, /### Issues\n\nNo issues found\./)
})
