// Tests for the reduced call diagram (src/diagram.js extraction,
// src/comment.js rendering, and the runPatternChecks wiring in
// src/checks.js), including the adversarial pass series: Mermaid
// injection, parse hostility, shape edge cases, budget pressure, and
// scale. Fixture sources are inline or generated; expectations were
// derived from the reduced form's scope — direct calls between
// functions within one file, nothing else.

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  MAX_DIAGRAM_PARTICIPANTS,
  MAX_DIAGRAM_CALLS,
  extractCallDiagram,
} = require('../src/diagram')
const {
  MAX_COMMENT_CHARS,
  DIAGRAM_SCOPE_NOTE,
  renderSummary,
  renderDiagramSection,
  sanitizeDiagramLabel,
  truncateToBudget,
} = require('../src/comment')
const { runPatternChecks } = require('../src/checks')

const HEADER = '/**\n * @NApiVersion 2.1\n * @NScriptType UserEventScript\n */\n'

// ---------- Extraction: the standard shapes ----------

const SRC_BASIC = HEADER + `define(['N/record'], function (record) {
  function beforeSubmit(context) {
    var rec = loadRecord(context);
    validate(rec);
    validate(rec);
  }
  function loadRecord(context) {
    return record.load({ type: 'salesorder', id: 1 });
  }
  function validate(rec) {
    helper(rec);
  }
  function helper(rec) {
    return rec;
  }
  return { beforeSubmit: beforeSubmit };
});
`

test('diagram: entry point, helper chain, source order, duplicates collapsed', () => {
  const d = extractCallDiagram(SRC_BASIC)
  assert.ok(d)
  assert.deepEqual(d.participants, ['beforeSubmit', 'loadRecord', 'validate', 'helper'])
  assert.deepEqual(d.entryPoints, ['beforeSubmit'])
  assert.deepEqual(d.calls, [
    { from: 'beforeSubmit', to: 'loadRecord' },
    { from: 'beforeSubmit', to: 'validate' },
    { from: 'validate', to: 'helper' },
  ])
  assert.equal(d.ambiguousCalls, 0)
  assert.equal(d.overCap, false)
})

test('diagram: module member calls are not intra-file calls', () => {
  const d = extractCallDiagram(SRC_BASIC)
  assert.ok(!d.calls.some((c) => c.to === 'load' || c.from === 'record'))
  assert.ok(!d.participants.includes('record'))
})

test('diagram: inline entry-point function in the returned object', () => {
  const src = HEADER + `define([], function () {
  function audit(x) { return x; }
  return {
    onRequest: function (context) { audit(context); },
  };
});
`
  const d = extractCallDiagram(src)
  assert.deepEqual(d.calls, [{ from: 'onRequest', to: 'audit' }])
  assert.deepEqual(d.entryPoints, ['onRequest'])
  assert.ok(d.participants.includes('onRequest'))
  assert.ok(d.participants.includes('audit'))
})

test('diagram: variable-bound and arrow functions are definitions', () => {
  const src = HEADER + `define([], function () {
  const compute = (x) => { return format(x); };
  const format = function (x) { return String(x); };
  function onRequest(context) { compute(1); }
  return { onRequest: onRequest };
});
`
  const d = extractCallDiagram(src)
  assert.deepEqual(d.calls, [
    { from: 'compute', to: 'format' },
    { from: 'onRequest', to: 'compute' },
  ])
  assert.deepEqual(d.entryPoints, ['onRequest'])
})

test('diagram: a function defined after its caller still resolves', () => {
  const src = HEADER + `define([], function () {
  function first() { second(); }
  function second() { return 1; }
  return { execute: first };
});
`
  const d = extractCallDiagram(src)
  assert.deepEqual(d.calls, [{ from: 'first', to: 'second' }])
})

test('diagram: nested functions are participants; anonymous callbacks attribute outward', () => {
  const src = HEADER + `define([], function () {
  function outer() {
    function inner() { leaf(); }
    var items = [1].map(function (x) { inner(); return x; });
    inner();
  }
  function leaf() { return 0; }
  return { execute: outer };
});
`
  const d = extractCallDiagram(src)
  assert.deepEqual(d.calls, [
    { from: 'inner', to: 'leaf' },
    { from: 'outer', to: 'inner' },
  ])
  assert.deepEqual(d.entryPoints, ['outer'])
})

test('diagram: an entry point that calls nothing yields no calls', () => {
  const src = HEADER + `define([], function () {
  function onRequest() { return 1; }
  return { onRequest: onRequest };
});
`
  const d = extractCallDiagram(src)
  assert.deepEqual(d.calls, [])
  assert.deepEqual(d.participants, ['onRequest'])
  assert.deepEqual(d.entryPoints, ['onRequest'])
})

test('diagram: class methods count as definitions', () => {
  const src = HEADER + `define([], function () {
  class Runner {
    start() { this.step(); }
    step() { finish(); }
  }
  function finish() { return 1; }
  function onRequest() { return 1; }
  return { onRequest: onRequest };
});
`
  const d = extractCallDiagram(src)
  assert.deepEqual(d.calls, [{ from: 'step', to: 'finish' }])
})

// ---------- Adversarial: parse hostility ----------

test('adversarial: an unparseable file yields null, never a partial diagram', () => {
  assert.equal(extractCallDiagram('define([), function () {'), null)
  assert.equal(extractCallDiagram('function broken( { return ;;'), null)
  // An empty file parses — to an empty program — and yields an empty
  // diagram, which the wiring treats as nothing to draw.
  assert.deepEqual(extractCallDiagram('').calls, [])
})

test('adversarial: call-shaped text in strings, templates and comments is not a call', () => {
  const src = HEADER + `define([], function () {
  function onRequest() {
    var s = "helper()";
    var t = \`helper() and more\`;
    // helper()
    /* helper() */
    return s + t;
  }
  function helper() { return 1; }
  return { onRequest: onRequest };
});
`
  const d = extractCallDiagram(src)
  assert.deepEqual(d.calls, [])
})

test('adversarial: member, computed, dynamic and new calls are excluded without crashing', () => {
  const src = HEADER + `define([], function () {
  function onRequest(ctx) {
    var obj = { run: function () { return 1; } };
    obj.run();
    obj['run']();
    this.run();
    new Thing();
    var f = pick();
    f();
  }
  function pick() { return null; }
  function Thing() { return 1; }
  return { onRequest: onRequest };
});
`
  const d = extractCallDiagram(src)
  assert.deepEqual(d.calls, [{ from: 'onRequest', to: 'pick' }])
})

// ---------- Adversarial: shape edge cases ----------

test('adversarial: recursion renders as a self-call', () => {
  const src = HEADER + `define([], function () {
  function walk(n) { if (n > 0) walk(n - 1); }
  return { execute: walk };
});
`
  const d = extractCallDiagram(src)
  assert.deepEqual(d.calls, [{ from: 'walk', to: 'walk' }])
})

test('adversarial: a mutual cycle terminates with both edges', () => {
  const src = HEADER + `define([], function () {
  function a() { b(); }
  function b() { a(); }
  return { execute: a };
});
`
  const d = extractCallDiagram(src)
  assert.deepEqual(d.calls, [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'a' },
  ])
})

test('adversarial: a duplicated callee name is omitted and counted, never guessed', () => {
  const src = HEADER + `define([], function () {
  function helper() { return 1; }
  function caller() { return helper(); }
  function helper() { return 2; }
  return { execute: caller };
});
`
  const d = extractCallDiagram(src)
  assert.deepEqual(d.calls, [])
  assert.equal(d.ambiguousCalls, 1)
})

test('adversarial: a duplicated caller name is omitted and counted, never guessed', () => {
  const src = HEADER + `define([], function () {
  function main() { leaf(); }
  function main() { leaf(); }
  function leaf() { return 1; }
  return { execute: main };
});
`
  const d = extractCallDiagram(src)
  assert.deepEqual(d.calls, [])
  assert.equal(d.ambiguousCalls, 2)
  assert.deepEqual(d.participants, [])
})

// ---------- Adversarial: extraction caps ----------

function chainSource(helperCount) {
  const helpers = []
  const calls = []
  for (let i = 0; i < helperCount; i++) {
    helpers.push(`  function h${i}() { return ${i}; }`)
    calls.push(`h${i}();`)
  }
  return HEADER + `define([], function () {
  function entry() { ${calls.join(' ')} }
${helpers.join('\n')}
  return { execute: entry };
});
`
}

test('adversarial: exactly at the caps is drawn; one past either cap is overCap', () => {
  const atCalls = extractCallDiagram(chainSource(MAX_DIAGRAM_CALLS))
  assert.equal(atCalls.calls.length, MAX_DIAGRAM_CALLS)
  assert.equal(atCalls.overCap, true) // participants exceed their cap first
  const overCalls = extractCallDiagram(chainSource(MAX_DIAGRAM_CALLS + 1))
  assert.equal(overCalls.overCap, true)

  // A wide-but-shallow file that stays inside both caps.
  const inside = extractCallDiagram(chainSource(MAX_DIAGRAM_PARTICIPANTS - 1))
  assert.equal(inside.participants.length, MAX_DIAGRAM_PARTICIPANTS)
  assert.equal(inside.overCap, false)
  const overParticipants = extractCallDiagram(chainSource(MAX_DIAGRAM_PARTICIPANTS))
  assert.equal(overParticipants.participants.length, MAX_DIAGRAM_PARTICIPANTS + 1)
  assert.equal(overParticipants.overCap, true)
})

// ---------- Rendering ----------

function sampleDiagram(overrides = {}) {
  return {
    file: 'src/FileCabinet/SuiteScripts/a.js',
    participants: ['beforeSubmit', 'loadRecord', 'validate'],
    entryPoints: ['beforeSubmit'],
    calls: [
      { from: 'beforeSubmit', to: 'loadRecord' },
      { from: 'beforeSubmit', to: 'validate' },
    ],
    ambiguousCalls: 0,
    overCap: false,
    ...overrides,
  }
}

test('render: a diagram section renders a fenced Mermaid block with generated ids', () => {
  const lines = renderDiagramSection([sampleDiagram()])
  const text = lines.join('\n')
  assert.match(text, /### Call diagrams for changed files/)
  assert.match(text, /```mermaid\nsequenceDiagram/)
  assert.match(text, /participant P1 as beforeSubmit/)
  assert.match(text, /Note over P1: entry point/)
  assert.match(text, /P1->>P2: loadRecord/)
  assert.ok(text.includes(DIAGRAM_SCOPE_NOTE))
  assert.equal((text.match(/```/g) || []).length, 2)
})

test('render: no diagrams, no calls, or a null list renders no section', () => {
  assert.deepEqual(renderDiagramSection(null), [])
  assert.deepEqual(renderDiagramSection([]), [])
  assert.deepEqual(renderDiagramSection([sampleDiagram({ calls: [] })]), [])
})

test('render: an over-cap file is omitted by name, not drawn partially', () => {
  const lines = renderDiagramSection([sampleDiagram({ overCap: true })])
  const text = lines.join('\n')
  assert.match(text, /its call diagram is omitted/)
  assert.ok(!text.includes('```mermaid'))
  assert.ok(text.includes(DIAGRAM_SCOPE_NOTE))
})

test('render: the file cap draws five diagrams and names the omitted rest', () => {
  const diagrams = []
  for (let i = 0; i < 7; i++) {
    diagrams.push(sampleDiagram({ file: `src/FileCabinet/SuiteScripts/f${i}.js` }))
  }
  const text = renderDiagramSection(diagrams).join('\n')
  assert.equal((text.match(/```mermaid/g) || []).length, 5)
  assert.match(text, /Call diagrams for 2 more changed files are omitted\./)
})

test('render: omitted mode prints the budget note and the scope note, no block', () => {
  const text = renderDiagramSection([sampleDiagram()], 'omitted').join('\n')
  assert.match(text, /Call diagrams are omitted from this comment/)
  assert.ok(text.includes(DIAGRAM_SCOPE_NOTE))
  assert.ok(!text.includes('```mermaid'))
})

test('render: a self-call renders as a message from a participant to itself', () => {
  const d = sampleDiagram({
    participants: ['walk'],
    entryPoints: ['walk'],
    calls: [{ from: 'walk', to: 'walk' }],
  })
  const text = renderDiagramSection([d]).join('\n')
  assert.match(text, /P1->>P1: walk/)
})

// ---------- Adversarial: Mermaid injection ----------

test('adversarial: labels are reduced to a safe character set', () => {
  assert.equal(sanitizeDiagramLabel('beforeSubmit'), 'beforeSubmit')
  assert.equal(sanitizeDiagramLabel('end'), 'end') // safe as a label; ids are generated
  assert.ok(!/[\[\]();<>"'`\n\r%]/.test(sanitizeDiagramLabel('x]; --> P9 %% hacked')))
  assert.ok(!sanitizeDiagramLabel('evil\nsequenceDiagram').includes('\n'))
  assert.equal(sanitizeDiagramLabel(''), 'function')
  assert.equal(sanitizeDiagramLabel('überFunktion'), 'überFunktion')
  const long = sanitizeDiagramLabel('a'.repeat(200))
  assert.ok(long.length <= 41)
})

test('adversarial: hostile names cannot break the block structure', () => {
  const hostile = sampleDiagram({
    participants: ['end', 'x --> P9: pwned', 'sequenceDiagram', 'a;b', 'quote"name', 'back`tick'],
    entryPoints: ['end'],
    calls: [
      { from: 'end', to: 'x --> P9: pwned' },
      { from: 'x --> P9: pwned', to: 'sequenceDiagram' },
    ],
  })
  const text = renderDiagramSection([hostile]).join('\n')
  assert.equal((text.match(/```/g) || []).length, 2)
  const block = text.split('```mermaid\n')[1].split('\n```')[0]
  for (const line of block.split('\n')) {
    assert.match(
      line,
      /^(sequenceDiagram|    participant P\d+ as .+|    Note over P\d+: entry point|    P\d+->>P\d+: .+)$/,
      `unexpected line in diagram block: ${line}`,
    )
  }
  assert.ok(!/--> P9/.test(block))
})

test('adversarial: a hostile export name from source reaches the diagram only sanitised', () => {
  const src = HEADER + `define([], function () {
  function leaf() { return 1; }
  return {
    'evil]; participant P9 as hacked': function () { leaf(); },
  };
});
`
  const d = extractCallDiagram(src)
  assert.ok(d)
  const text = renderDiagramSection([{ file: 'x.js', ...d }]).join('\n')
  assert.equal((text.match(/```/g) || []).length, 2)
  // The hostile text survives, if at all, only as inert label text —
  // never as a Mermaid statement of its own.
  assert.ok(!/^\s+participant P9 /m.test(text))
})

test('adversarial: a backtick in a file path cannot break the section heading', () => {
  const d = sampleDiagram({ file: 'src/FileCabinet/SuiteScripts/we`ird.js' })
  const text = renderDiagramSection([d]).join('\n')
  assert.ok(!text.includes('we`ird'))
  assert.match(text, /weird\.js/)
})

// ---------- Adversarial: budget and truncation ----------

function bigResult() {
  const longPath = (i) => `src/FileCabinet/SuiteScripts/${'x'.repeat(400)}${i}.js`
  const scripts = []
  for (let i = 0; i < 50; i++) {
    scripts.push({
      file: longPath(i), type: 'UserEventScript', apiVersion: '2.1',
      dependencies: ['N/record'], exports: [], lineCount: 10,
    })
  }
  const moduleUsage = []
  for (let i = 0; i < 25; i++) moduleUsage.push([`N/${'m'.repeat(360)}${i}`, 1])
  const warnings = []
  for (let i = 0; i < 25; i++) {
    warnings.push({ file: longPath(i), message: `warning number ${i} ${'w'.repeat(200)}` })
  }
  const findings = []
  for (let i = 0; i < 25; i++) {
    findings.push({
      check: 'empty-catch',
      file: `src/FileCabinet/SuiteScripts/${'f'.repeat(150)}${i}.js`,
      line: 12,
      message: `finding number ${i} ${'g'.repeat(110)}`,
    })
  }
  const diagrams = []
  for (let f = 0; f < 5; f++) {
    const participants = []
    const calls = []
    for (let i = 0; i < MAX_DIAGRAM_PARTICIPANTS; i++) {
      participants.push(`${'p'.repeat(38)}${f}x${i}`)
    }
    for (let i = 0; i < MAX_DIAGRAM_CALLS; i++) {
      calls.push({
        from: participants[i % MAX_DIAGRAM_PARTICIPANTS],
        to: participants[(i + 1) % MAX_DIAGRAM_PARTICIPANTS],
      })
    }
    diagrams.push({
      file: `src/FileCabinet/SuiteScripts/d${f}.js`,
      participants, entryPoints: [participants[0]], calls,
      ambiguousCalls: 0, overCap: false,
    })
  }
  return {
    project: { name: 'Demo', type: 'ACCOUNTPROJECT', frameworkVersion: '1.0', manifestPath: 'src/manifest.xml' },
    scripts,
    moduleUsage,
    byType: [['UserEventScript', 50]],
    warnings,
    stats: { scriptCount: 50, dependencyCount: 25, typeCount: 1, warningCount: 25 },
    checks: {
      skipped: null, findings, changedCount: 5, examinedCount: 5,
      notCompared: 0, notExamined: 0, diagrams,
    },
  }
}

test('adversarial: under budget pressure the diagram drops before any list shrinks', () => {
  const md = renderSummary(bigResult())
  assert.ok(md.length <= MAX_COMMENT_CHARS, `length ${md.length}`)
  // The diagram went, with the omission stated and the scope note kept.
  assert.match(md, /Call diagrams are omitted from this comment/)
  assert.ok(md.includes(DIAGRAM_SCOPE_NOTE))
  assert.ok(!md.includes('```mermaid'))
  // Everything else is still whole: all 50 script rows, all 25
  // findings, no staged-shrinkage ellipsis anywhere.
  assert.ok(md.includes(`${'x'.repeat(400)}49.js`))
  assert.ok(md.includes('finding number 24'))
  assert.ok(md.includes('warning number 24'))
  assert.ok(!md.includes('more scripts (only the first'))
  assert.ok(!md.includes('more findings (only the first'))
})

test('adversarial: truncateToBudget closes a fence it cuts through', () => {
  const body = '```mermaid\nsequenceDiagram\n' + `${'y'.repeat(200)}\n`.repeat(600)
  const out = truncateToBudget(body)
  assert.ok(out.length <= MAX_COMMENT_CHARS)
  assert.equal((out.match(/```/g) || []).length % 2, 0)
  assert.ok(out.trimEnd().endsWith('_Posted by SDF Analyzer — PR Check, by Strikaris._'))
})

test('render: renderSummary shows the section after the pattern checks', () => {
  const result = {
    project: { name: 'Demo', type: 'ACCOUNTPROJECT', frameworkVersion: '1.0', manifestPath: 'src/manifest.xml' },
    scripts: [],
    moduleUsage: [],
    byType: [],
    warnings: [],
    stats: { scriptCount: 0, dependencyCount: 0, typeCount: 0, warningCount: 0 },
    checks: {
      skipped: null, findings: [], changedCount: 1, examinedCount: 1,
      notCompared: 0, notExamined: 0, diagrams: [sampleDiagram()],
    },
  }
  const md = renderSummary(result)
  const checksAt = md.indexOf('### Pattern checks on this pull request')
  const diagramAt = md.indexOf('### Call diagrams for changed files')
  assert.ok(checksAt !== -1 && diagramAt > checksAt)
  assert.ok(md.includes('```mermaid'))
})

test('render: skipped checks render no diagram section even with diagram data present', () => {
  const result = {
    project: null,
    scripts: [],
    moduleUsage: [],
    byType: [],
    warnings: [],
    stats: { scriptCount: 0, dependencyCount: 0, typeCount: 0, warningCount: 0 },
    checks: { skipped: 'no baseline', diagrams: [sampleDiagram()] },
  }
  const md = renderSummary(result)
  assert.ok(!md.includes('### Call diagrams'))
})

// ---------- Integration: runPatternChecks ----------

const PROJECT = {
  mode: 'project',
  projectPrefix: '',
  suiteRootRel: 'src/FileCabinet/SuiteScripts',
}

function projectChange(repoPath, overrides = {}) {
  return {
    repoPath,
    prevRepoPath: repoPath,
    kind: 'modified',
    addedLines: new Set(),
    ...overrides,
  }
}

test('integration: an examined file with direct calls contributes its diagram', async () => {
  const repoPath = 'src/FileCabinet/SuiteScripts/a.js'
  const result = await runPatternChecks({
    ...PROJECT,
    changesFiles: [projectChange(repoPath, { kind: 'added', prevRepoPath: null })],
    readHeadFile: async () => SRC_BASIC,
    readBaseFile: async () => { throw new Error('must not be called for an added file') },
  })
  assert.equal(result.diagrams.length, 1)
  assert.equal(result.diagrams[0].file, repoPath)
  assert.deepEqual(result.diagrams[0].calls, [
    { from: 'beforeSubmit', to: 'loadRecord' },
    { from: 'beforeSubmit', to: 'validate' },
    { from: 'validate', to: 'helper' },
  ])
})

test('integration: a file with no direct calls contributes no diagram', async () => {
  const repoPath = 'src/FileCabinet/SuiteScripts/b.js'
  const src = HEADER + `define([], function () {
  function onRequest() { return 1; }
  return { onRequest: onRequest };
});
`
  const result = await runPatternChecks({
    ...PROJECT,
    changesFiles: [projectChange(repoPath, { kind: 'added', prevRepoPath: null })],
    readHeadFile: async () => src,
    readBaseFile: async () => { throw new Error('must not be called') },
  })
  assert.equal(result.examinedCount, 1)
  assert.deepEqual(result.diagrams, [])
})

test('integration: an unparseable file is not examined and contributes no diagram', async () => {
  const repoPath = 'src/FileCabinet/SuiteScripts/c.js'
  const result = await runPatternChecks({
    ...PROJECT,
    changesFiles: [projectChange(repoPath, { kind: 'added', prevRepoPath: null })],
    readHeadFile: async () => 'define([), function () {',
    readBaseFile: async () => { throw new Error('must not be called') },
  })
  assert.equal(result.notExamined, 1)
  assert.deepEqual(result.diagrams, [])
})
