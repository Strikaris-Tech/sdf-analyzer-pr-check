// Tests for the R1 presence checks (src/checks.js): the detector
// corpus, the introduced-only subtraction, and the examination
// orchestration. Fixture expectations were verified against the
// design's per-check semantics before being pinned here.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  CHECK_NAMES,
  MAX_CHECK_FILES,
  MAX_CHECK_FILE_BYTES,
  detectFindings,
  subtractFindings,
  runPatternChecks,
  isTypeScriptPath,
} = require('../src/checks')

const HEADER = '/**\n * @NApiVersion 2.1\n * @NScriptType UserEventScript\n */\n'

// ---------- The equivalence corpus (tests/fixtures/checks) ----------
// Each fixture's expected findings, by check and line. The corpus is
// the shared specification for these six checks; see the README in
// tests/fixtures/checks/ for its scope and the queued paid-side
// assertion.

const CORPUS = {
  'hardcoded-credential/pattern-a-and-b.js': [
    ['hardcoded-credential', 8], ['hardcoded-credential', 9],
  ],
  'hardcoded-credential/pattern-c-config.js': [
    ['hardcoded-credential', 9], ['hardcoded-credential', 10],
    ['hardcoded-credential', 11], ['hardcoded-credential', 12],
  ],
  'hardcoded-credential/pattern-d-assignments.js': [
    ['hardcoded-credential', 6], ['hardcoded-credential', 7], ['hardcoded-credential', 9],
  ],
  'hardcoded-credential/no-fire-runtime-value.js': [],
  'hardcoded-credential/no-fire-short.js': [],
  'dynamic-code-eval/eval-forms.js': [
    ['dynamic-code-eval', 8], ['dynamic-code-eval', 9],
  ],
  'dynamic-code-eval/timers-and-function.js': [
    ['dynamic-code-eval', 7], ['dynamic-code-eval', 8], ['dynamic-code-eval', 9],
  ],
  'dynamic-code-eval/function-call-form.js': [['dynamic-code-eval', 7]],
  'dynamic-code-eval/no-fire-eval.js': [],
  'empty-catch/empty-and-comment.js': [
    ['empty-catch', 9], ['empty-catch', 13],
  ],
  'empty-catch/empty-statement-and-optional.js': [
    ['empty-catch', 9], ['empty-catch', 14],
  ],
  'empty-catch/no-fire-handled.js': [],
  'log-of-pii-or-secret/details-forms.js': [
    ['log-of-pii-or-secret', 8], ['log-of-pii-or-secret', 9],
  ],
  'log-of-pii-or-secret/object-and-template.js': [
    ['log-of-pii-or-secret', 7], ['log-of-pii-or-secret', 8],
  ],
  'log-of-pii-or-secret/no-fire-log.js': [],
  'ss1-deprecated-api/calls-and-construction.js': [
    ['ss1-deprecated-api', 7], ['ss1-deprecated-api', 8],
  ],
  'ss1-deprecated-api/instanceof-and-call.js': [
    ['ss1-deprecated-api', 7], ['ss1-deprecated-api', 8],
  ],
  'ss1-deprecated-api/no-fire-lookalikes.js': [],
  'ss1-deprecated-api/version-1-no-fire.js': [],
  'sync-https-in-client/client-sync.js': [
    ['sync-https-in-client', 7], ['sync-https-in-client', 10],
  ],
  'sync-https-in-client/client-request.js': [['sync-https-in-client', 7]],
  'sync-https-in-client/no-fire-async.js': [],
  'sync-https-in-client/no-fire-server.js': [],
  'sync-https-in-client/no-fire-unknown-type.js': [],
}

for (const [rel, expected] of Object.entries(CORPUS)) {
  test(`corpus: ${rel}`, () => {
    const source = fs.readFileSync(path.join(__dirname, 'fixtures', 'checks', rel), 'utf8')
    const findings = detectFindings(source)
    assert.ok(findings !== null, 'fixture must parse')
    assert.deepEqual(
      findings.map((f) => [f.check, f.line]),
      expected,
      `findings for ${rel}`,
    )
    for (const f of findings) assert.ok(CHECK_NAMES.includes(f.check))
  })
}

// ---------- Detector shapes beyond the corpus ----------

test('credential: a lowercase x-api-key header name fires (normalization)', () => {
  const src = HEADER + `define(['N/https'], function (https) {
  function afterSubmit() {
    https.get({ url: 'https://api.example.com/x', headers: { 'x-api-key': 'zzqzx7w9k2m4p8a1b3' } });
  }
  return { afterSubmit: afterSubmit };
});
`
  const findings = detectFindings(src).filter((f) => f.check === 'hardcoded-credential')
  assert.equal(findings.length, 1)
})

test('credential: credentials in URL userinfo fire (Pattern B)', () => {
  const src = HEADER + `define(['N/https'], function (https) {
  function afterSubmit() {
    https.get({ url: 'https://acct:longSecretPass@api.example.com/v1/data' });
  }
  return { afterSubmit: afterSubmit };
});
`
  const findings = detectFindings(src).filter((f) => f.check === 'hardcoded-credential')
  assert.equal(findings.length, 1)
})

test('credential: a single credential key with a non-literal value does not fire', () => {
  const src = HEADER + `define([], function () {
  function build(cfg) { return cfg; }
  function afterSubmit(runtime) {
    return build({ consumerSecret: runtime.token });
  }
  return { afterSubmit: afterSubmit };
});
`
  assert.deepEqual(detectFindings(src).filter((f) => f.check === 'hardcoded-credential'), [])
})

test('credential: Pattern D fires on a member assignment to a credential-named property', () => {
  const src = HEADER + `define([], function () {
  function afterSubmit(store) {
    store.apiKey = 'zzqzx7w9k2m4p8a1b3';
    store.label = 'zzqzx7w9k2m4p8a1b3';
    return store;
  }
  return { afterSubmit: afterSubmit };
});
`
  const findings = detectFindings(src).filter((f) => f.check === 'hardcoded-credential')
  assert.equal(findings.length, 1)
})

test('credential: placeholder-shaped values never fire, even on credential names', () => {
  const src = HEADER + `define([], function () {
  var password = 'your_password_here';
  var apiKey = 'xxxxxxxxxxxx';
  function afterSubmit() { return password.length + apiKey.length; }
  return { afterSubmit: afterSubmit };
});
`
  assert.deepEqual(detectFindings(src).filter((f) => f.check === 'hardcoded-credential'), [])
})

test('eval: setImmediate with a string argument fires', () => {
  const src = HEADER + `define([], function () {
  function afterSubmit() { setImmediate('handle()'); }
  return { afterSubmit: afterSubmit };
});
`
  assert.equal(detectFindings(src).filter((f) => f.check === 'dynamic-code-eval').length, 1)
})

test('eval: a locally declared Function shadows the global for the plain-call form', () => {
  const src = HEADER + `define([], function () {
  function Function(name) { return name; }
  function afterSubmit() { return Function('x'); }
  return { afterSubmit: afterSubmit };
});
`
  assert.deepEqual(detectFindings(src).filter((f) => f.check === 'dynamic-code-eval'), [])
})

test('ss1: a name without a capitalised continuation does not fire', () => {
  const src = HEADER + `define([], function () {
  function afterSubmit() { return nlapiload('x'); }
  return { afterSubmit: afterSubmit };
});
`
  assert.deepEqual(detectFindings(src).filter((f) => f.check === 'ss1-deprecated-api'), [])
})

test('sync-https: the require() binding form resolves the alias', () => {
  const src = '/**\n * @NApiVersion 2.1\n * @NScriptType ClientScript\n */\n' + `var https = require('N/https');
function pageInit() {
  https.get({ url: 'https://api.example.com/health' });
}
`
  assert.equal(detectFindings(src).filter((f) => f.check === 'sync-https-in-client').length, 1)
})

test('sync-https: a renamed alias still resolves', () => {
  const src = '/**\n * @NApiVersion 2.1\n * @NScriptType ClientScript\n */\n' + `define(['N/https'], function (web) {
  function pageInit() { web.post({ url: 'https://api.example.com/x', body: '{}' }); }
  return { pageInit: pageInit };
});
`
  assert.equal(detectFindings(src).filter((f) => f.check === 'sync-https-in-client').length, 1)
})

test('sync-https: a destructured module parameter does not resolve, and does not fire', () => {
  const src = '/**\n * @NApiVersion 2.1\n * @NScriptType ClientScript\n */\n' + `define(['N/https'], function ({ get }) {
  function pageInit() { get({ url: 'https://api.example.com/health' }); }
  return { pageInit: pageInit };
});
`
  assert.deepEqual(detectFindings(src).filter((f) => f.check === 'sync-https-in-client'), [])
})

test('log: a console call exposing a sensitive member fires', () => {
  const src = HEADER + `define([], function () {
  function afterSubmit(user) { console.log(user.ssn); }
  return { afterSubmit: afterSubmit };
});
`
  assert.equal(detectFindings(src).filter((f) => f.check === 'log-of-pii-or-secret').length, 1)
})

test('log: tokenCount matches on the word token (the accepted cost of a name-based check)', () => {
  const src = HEADER + `define(['N/log'], function (log) {
  function afterSubmit(stats) { log.debug({ title: 't', details: stats.tokenCount }); }
  return { afterSubmit: afterSubmit };
});
`
  assert.equal(detectFindings(src).filter((f) => f.check === 'log-of-pii-or-secret').length, 1)
})

test('detectFindings returns null for unparseable source, never an empty list', () => {
  assert.equal(detectFindings('define([ broken'), null)
})

// ---------- Subtraction: "introduced by this pull request" ----------

const F = (check, line, anchor) => ({ check, line, anchor })

test('subtract: a finding present in both versions is not introduced', () => {
  const head = [F('empty-catch', 20, 'catch (e) {}')]
  const base = [F('empty-catch', 9, 'catch (e) {}')]
  assert.deepEqual(subtractFindings(head, base), [])
})

test('subtract: a merely moved finding (same code, new line) is not introduced', () => {
  const head = [F('dynamic-code-eval', 40, "eval:'var x = 1;'")]
  const base = [F('dynamic-code-eval', 12, "eval:'var x = 1;'")]
  assert.deepEqual(subtractFindings(head, base), [])
})

test('subtract: an edited defective line is introduced, once', () => {
  const head = [F('hardcoded-credential', 7, "var password = 'aaaaaaaa1'")]
  const base = [F('hardcoded-credential', 7, "var password = 'bbbbbbbb2'")]
  const out = subtractFindings(head, base)
  assert.equal(out.length, 1)
  assert.equal(out[0].line, 7)
})

test('subtract: duplicate fingerprints match by ordinal', () => {
  const head = [F('empty-catch', 5, 'catch (e) {}'), F('empty-catch', 15, 'catch (e) {}'), F('empty-catch', 25, 'catch (e) {}')]
  const base = [F('empty-catch', 3, 'catch (e) {}'), F('empty-catch', 30, 'catch (e) {}')]
  const out = subtractFindings(head, base)
  assert.equal(out.length, 1)
  assert.equal(out[0].line, 25)
})

test('subtract: deleting the first of two identical defects reports nothing new', () => {
  const head = [F('empty-catch', 30, 'catch (e) {}')]
  const base = [F('empty-catch', 3, 'catch (e) {}'), F('empty-catch', 28, 'catch (e) {}')]
  assert.deepEqual(subtractFindings(head, base), [])
})

test('subtract: an added file (empty base) introduces everything it contains', () => {
  const head = [F('ss1-deprecated-api', 7, 'nlapiLoadRecord'), F('empty-catch', 9, 'catch (e) {}')]
  assert.equal(subtractFindings(head, []).length, 2)
})

// ---------- Orchestration: runPatternChecks over fabricated changes --

const CATCH_FILE = (id) => HEADER + `define([], function () {
  function afterSubmit() {
    try { risky${id}(); } catch (e) {
    }
  }
  function risky${id}() { return ${id}; }
  return { afterSubmit: afterSubmit };
});
`

function projectChange(repoPath, overrides = {}) {
  return {
    repoPath,
    prevRepoPath: repoPath,
    kind: 'modified',
    addedLines: new Set(),
    ...overrides,
  }
}

const PROJECT = {
  mode: 'project',
  projectPrefix: '',
  suiteRootRel: 'src/FileCabinet/SuiteScripts',
}

test('orchestration: a pre-existing finding in a touched file is not reported', async () => {
  const repoPath = 'src/FileCabinet/SuiteScripts/a.js'
  const source = CATCH_FILE(1)
  const result = await runPatternChecks({
    ...PROJECT,
    changesFiles: [projectChange(repoPath, { addedLines: new Set([2]) })],
    readHeadFile: async () => source,
    readBaseFile: async () => source,
  })
  assert.equal(result.findings.length, 0)
  assert.equal(result.examinedCount, 1)
  assert.equal(result.changedCount, 1)
})

test('orchestration: a context flip (header change only) introduces the finding, off the added lines', async () => {
  const repoPath = 'src/FileCabinet/SuiteScripts/cs.js'
  const body = (type) => `/**\n * @NApiVersion 2.1\n * @NScriptType ${type}\n */\ndefine(['N/https'], function (https) {
  function pageInit() { https.get({ url: 'https://api.example.com/health' }); }
  return { pageInit: pageInit };
});
`
  const result = await runPatternChecks({
    ...PROJECT,
    changesFiles: [projectChange(repoPath, { addedLines: new Set([3]) })],
    readHeadFile: async () => body('ClientScript'),
    readBaseFile: async () => body('UserEventScript'),
  })
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].check, 'sync-https-in-client')
  assert.equal(result.findings[0].onAddedLine, false)
})

test('orchestration: an added file introduces its findings, on its added lines', async () => {
  const repoPath = 'src/FileCabinet/SuiteScripts/new.js'
  const source = CATCH_FILE(2)
  const catchLine = source.split('\n').findIndex((l) => l.includes('catch')) + 1
  const result = await runPatternChecks({
    ...PROJECT,
    changesFiles: [projectChange(repoPath, { kind: 'added', prevRepoPath: null, addedLines: new Set([catchLine]) })],
    readHeadFile: async () => source,
    readBaseFile: async () => { throw new Error('must not be called for an added file') },
  })
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].check, 'empty-catch')
  assert.equal(result.findings[0].onAddedLine, true)
})

test('orchestration: a rename reads the base at the previous path and subtracts', async () => {
  const source = CATCH_FILE(3)
  const seen = []
  const result = await runPatternChecks({
    ...PROJECT,
    changesFiles: [projectChange('src/FileCabinet/SuiteScripts/renamed.js', {
      kind: 'renamed',
      prevRepoPath: 'src/FileCabinet/SuiteScripts/original.js',
    })],
    readHeadFile: async () => source,
    readBaseFile: async (p) => { seen.push(p); return source },
  })
  assert.deepEqual(seen, ['src/FileCabinet/SuiteScripts/original.js'])
  assert.equal(result.findings.length, 0)
})

test('orchestration: an unreadable base suppresses only that file and discloses it', async () => {
  const a = 'src/FileCabinet/SuiteScripts/a.js'
  const b = 'src/FileCabinet/SuiteScripts/b.js'
  const result = await runPatternChecks({
    ...PROJECT,
    changesFiles: [projectChange(a), projectChange(b, { kind: 'added', prevRepoPath: null })],
    readHeadFile: async (p) => (p === a ? CATCH_FILE(4) : CATCH_FILE(5)),
    readBaseFile: async () => { throw new Error('object missing') },
  })
  assert.equal(result.notCompared, 1)
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].file, b)
})

test('orchestration: an unparseable head counts as changed but not examinable', async () => {
  const repoPath = 'src/FileCabinet/SuiteScripts/broken.js'
  const result = await runPatternChecks({
    ...PROJECT,
    changesFiles: [projectChange(repoPath)],
    readHeadFile: async () => 'define([ broken',
    readBaseFile: async () => CATCH_FILE(6),
  })
  assert.equal(result.notExamined, 1)
  assert.equal(result.examinedCount, 0)
  assert.equal(result.findings.length, 0)
})

test('orchestration: a head version over the byte cap is not examined', async () => {
  const repoPath = 'src/FileCabinet/SuiteScripts/huge.js'
  const source = `// ${'x'.repeat(MAX_CHECK_FILE_BYTES)}\n` + CATCH_FILE(7)
  const result = await runPatternChecks({
    ...PROJECT,
    changesFiles: [projectChange(repoPath)],
    readHeadFile: async () => source,
    readBaseFile: async () => CATCH_FILE(7),
  })
  assert.equal(result.notExamined, 1)
  assert.equal(result.findings.length, 0)
})

test('orchestration: the file cap examines the first MAX_CHECK_FILES in path order', async () => {
  const changesFiles = []
  for (let i = 0; i < MAX_CHECK_FILES + 1; i++) {
    const name = `f${String(i).padStart(3, '0')}.js`
    changesFiles.push(projectChange(`src/FileCabinet/SuiteScripts/${name}`, { kind: 'added', prevRepoPath: null }))
  }
  const result = await runPatternChecks({
    ...PROJECT,
    changesFiles,
    readHeadFile: async () => CATCH_FILE(8),
    readBaseFile: async () => { throw new Error('unused') },
  })
  assert.equal(result.changedCount, MAX_CHECK_FILES + 1)
  assert.equal(result.examinedCount, MAX_CHECK_FILES)
})

test('orchestration: project mode ignores changed files outside the SuiteScripts root', async () => {
  const result = await runPatternChecks({
    ...PROJECT,
    changesFiles: [projectChange('tools/build.js', { kind: 'added', prevRepoPath: null })],
    readHeadFile: async () => CATCH_FILE(9),
    readBaseFile: async () => { throw new Error('unused') },
  })
  assert.equal(result.changedCount, 0)
  assert.equal(result.findings.length, 0)
})

test('orchestration: loose mode counts only annotated changed files', async () => {
  const annotated = CATCH_FILE(10)
  const plain = 'function helper() { return 1; }\n'
  const result = await runPatternChecks({
    mode: 'loose',
    projectPrefix: '',
    suiteRootRel: null,
    changesFiles: [
      projectChange('scripts/one.js', { kind: 'added', prevRepoPath: null }),
      projectChange('scripts/two.js', { kind: 'added', prevRepoPath: null }),
      projectChange('README.md', { kind: 'added', prevRepoPath: null }),
    ],
    readHeadFile: async (p) => (p.endsWith('one.js') ? annotated : plain),
    readBaseFile: async () => { throw new Error('unused') },
  })
  assert.equal(result.changedCount, 1)
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].file, 'scripts/one.js')
})

test('orchestration: a deleted file is never in the population', async () => {
  const result = await runPatternChecks({
    ...PROJECT,
    changesFiles: [projectChange('src/FileCabinet/SuiteScripts/gone.js', { kind: 'deleted' })],
    readHeadFile: async () => { throw new Error('no head version exists') },
    readBaseFile: async () => CATCH_FILE(11),
  })
  assert.equal(result.changedCount, 0)
})

// ---------- TypeScript files: counted, disclosed, never examined -----
// The v1.2.2 honesty fix. Before it, a changed TypeScript file never
// entered the accounting at all — a mixed pull request read as fully
// examined and a TypeScript-only one as an empty, finding-free pass.

const TS_FILE = HEADER + `define(['N/log'], function (log) {
  function afterSubmit(context: any): void {
    try { risky(); } catch (e) {
    }
  }
  function risky(): number { return 1; }
  return { afterSubmit: afterSubmit };
});
`

test('typescript: the suffix test admits .ts and .tsx and nothing else', () => {
  assert.equal(isTypeScriptPath('a/b.ts'), true)
  assert.equal(isTypeScriptPath('a/b.tsx'), true)
  assert.equal(isTypeScriptPath('a/b.d.ts'), true)
  assert.equal(isTypeScriptPath('a/b.js'), false)
  assert.equal(isTypeScriptPath('a/b.ts.json'), false)
  assert.equal(isTypeScriptPath('a/xts'), false)
})

test('typescript: a changed TypeScript file is counted as not examined and yields no findings', async () => {
  const repoPath = 'src/FileCabinet/SuiteScripts/ue_order.ts'
  const result = await runPatternChecks({
    ...PROJECT,
    changesFiles: [projectChange(repoPath, { kind: 'added', prevRepoPath: null })],
    readHeadFile: async () => TS_FILE,
    readBaseFile: async () => { throw new Error('must not be called for an added file') },
  })
  // The file carries an empty catch: examined, it would report one.
  // It is TypeScript, so it is counted and disclosed — not examined.
  assert.equal(result.findings.length, 0)
  assert.equal(result.examinedCount, 0)
  assert.equal(result.notExaminedTypeScript, 1)
  assert.equal(result.changedCount, 1)
  assert.equal(result.diagrams.length, 1)
  assert.equal(result.diagrams[0].file, repoPath)
  assert.equal(result.diagrams[0].notExaminedTypeScript, true)
  assert.deepEqual(result.diagrams[0].calls, [])
})

test('typescript: a mixed change examines the JavaScript and counts the TypeScript beside it', async () => {
  const jsPath = 'src/FileCabinet/SuiteScripts/a.js'
  const tsPath = 'src/FileCabinet/SuiteScripts/b.ts'
  const tsxPath = 'src/FileCabinet/SuiteScripts/c.tsx'
  const result = await runPatternChecks({
    ...PROJECT,
    changesFiles: [
      projectChange(tsxPath, { kind: 'added', prevRepoPath: null }),
      projectChange(jsPath, { kind: 'added', prevRepoPath: null }),
      projectChange(tsPath, { kind: 'added', prevRepoPath: null }),
    ],
    readHeadFile: async (p) => (p === jsPath ? CATCH_FILE(12) : TS_FILE),
    readBaseFile: async () => { throw new Error('unused') },
  })
  assert.equal(result.examinedCount, 1)
  assert.equal(result.notExaminedTypeScript, 2)
  assert.equal(result.changedCount, 3)
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].file, jsPath)
  // The diagram records reconcile with the change, in path order:
  // the examined file's record, then one flagged record per
  // TypeScript file.
  assert.deepEqual(
    result.diagrams.map((d) => [d.file, d.notExaminedTypeScript === true]),
    [[jsPath, false], [tsPath, true], [tsxPath, true]],
  )
})

test('typescript: files outside the SuiteScripts root, and deleted ones, are not counted', async () => {
  const result = await runPatternChecks({
    ...PROJECT,
    changesFiles: [
      projectChange('tools/build.ts', { kind: 'added', prevRepoPath: null }),
      projectChange('src/FileCabinet/SuiteScripts/gone.ts', { kind: 'deleted' }),
    ],
    readHeadFile: async () => TS_FILE,
    readBaseFile: async () => TS_FILE,
  })
  assert.equal(result.notExaminedTypeScript, 0)
  assert.equal(result.changedCount, 0)
  assert.deepEqual(result.diagrams, [])
})

test('typescript: loose mode counts an annotated TypeScript file, and only an annotated one', async () => {
  const plainTs = 'export function helper(): number { return 1; }\n'
  const result = await runPatternChecks({
    mode: 'loose',
    projectPrefix: '',
    suiteRootRel: null,
    changesFiles: [
      projectChange('scripts/annotated.ts', { kind: 'added', prevRepoPath: null }),
      projectChange('scripts/plain.ts', { kind: 'added', prevRepoPath: null }),
    ],
    readHeadFile: async (p) => (p.endsWith('annotated.ts') ? TS_FILE : plainTs),
    readBaseFile: async () => { throw new Error('unused') },
  })
  assert.equal(result.notExaminedTypeScript, 1)
  assert.equal(result.changedCount, 1)
  assert.equal(result.examinedCount, 0)
  assert.equal(result.diagrams.length, 1)
  assert.equal(result.diagrams[0].file, 'scripts/annotated.ts')
  assert.equal(result.diagrams[0].notExaminedTypeScript, true)
})
