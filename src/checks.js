// Presence checks for the free-tier SDF action (the R1 feature).
//
// Single responsibility: examining the files one pull request changed
// for six named patterns that fire on something that IS in the code —
// a credential written into the source, code built from a string and
// executed, an error handler that swallows silently, a log call
// carrying a credential- or personal-data-shaped value, a retired
// SuiteScript 1.0 API call, a blocking web call in a client script.
//
// The guarantee that shapes everything here: only findings the pull
// request INTRODUCES are reported. Each changed file is examined whole
// (a file is the smallest unit whose meaning is self-contained), in
// both its head and base versions, and the base findings are subtracted
// by fingerprint — check name plus the matched code with whitespace
// collapsed, line number deliberately excluded, so code the pull
// request merely moved subtracts out. The baseline is computed fresh
// on every run; nothing is stored anywhere.
//
// All six checks are syntax-tree checks: they walk the parsed tree,
// never the raw text, so strings, comments, and prose cannot produce
// a finding. Detection semantics for the credential patterns match the
// implemented behaviour of the corresponding paid check (its call-site
// patterns and plausibility filter), plus the plain-assignment pattern
// the product ruling added; the messages below are this surface's own.
//
// This file owns its own logic; it does not import from any private
// Strikaris package. The engine stays private by staying separate.

const acorn = require('acorn')
const walk = require('acorn-walk')
const {
  EXCLUDED_DIRS,
  extractApiVersion,
  hasSuiteScriptAnnotations,
  collectArrayBindings,
  resolveCallModules,
} = require('./suitescript')
const { guessScriptType, extractExports } = require('./analyzer')
const { extractCallDiagram } = require('./diagram')

// The six checks, fixed by name in the product ruling. The header line
// of the comment's checks section counts this list, so the number a
// reader sees is the number that ran.
const CHECK_NAMES = [
  'hardcoded-credential',
  'dynamic-code-eval',
  'empty-catch',
  'log-of-pii-or-secret',
  'ss1-deprecated-api',
  'sync-https-in-client',
]

// Caps, as named constants in the family the comment renderer keeps.
// A file beyond a cap is disclosed as not examined, never silently
// dropped and never presented as clean.
const MAX_CHECK_FILES = 100
const MAX_CHECK_FILE_BYTES = 524288 // 512 KB, per file version

// TypeScript files are never examined — the checks read JavaScript —
// but they are counted and disclosed as not examined (the v1.2.2
// honesty fix), never passed over silently: a reader must not be
// able to believe a changed file was examined when it was not read
// at all. Real TypeScript support (reading the files by converting
// them first) is a separate step and is not claimed here.
const TYPESCRIPT_SUFFIXES = ['.ts', '.tsx']

function isTypeScriptPath(p) {
  return TYPESCRIPT_SUFFIXES.some((s) => p.endsWith(s))
}

// The free surface's own one-line message per check, written for a
// developer reading a pull request. One fixed sentence per check.
const CHECK_MESSAGES = {
  'hardcoded-credential':
    'A credential is written directly in the source code — move it to a script parameter or protected storage, and rotate it.',
  'dynamic-code-eval':
    'Code is built from a string and executed at run time (eval or an equivalent) — replace it with statically defined logic.',
  'empty-catch':
    'Empty catch block — errors here are swallowed silently; log or rethrow so failures can be diagnosed.',
  'log-of-pii-or-secret':
    'A log call includes a credential- or personal-data-shaped value — redact it before logging.',
  'ss1-deprecated-api':
    'A retired SuiteScript 1.0 API (nlapi/nlobj) is used — migrate to the SuiteScript 2.x equivalent.',
  'sync-https-in-client':
    'A synchronous web call in a client script blocks the page until the server answers — use the promise-returning form.',
}

// The checks parse each changed file version themselves, with node
// locations enabled — the inventory's shared parse options do not
// request them, and the inventory's behaviour is unchanged by this.
const PARSE_OPTIONS = {
  ecmaVersion: 2022,
  sourceType: 'script',
  allowReturnOutsideFunction: true,
  allowHashBang: true,
  locations: true,
}

// ---------------------------------------------------------------------
// Shared vocabulary for the credential and log checks. Name matching is
// normalised (case, separators) but never substring-loose: a name
// matches a family when its whole normalised form is a member.
// ---------------------------------------------------------------------

// Header names treated as credential-bearing. Normalised by
// lowercasing and stripping hyphens, so 'X-API-Key' and 'XAPIKEY'
// both become 'xapikey'.
const AUTH_HEADER_NAMES = new Set([
  'authorization', 'proxyauthorization',
  'xapikey', 'apikey',
  'xauthtoken', 'xaccesstoken', 'xsecretkey', 'xsessiontoken',
])

// URL query-string parameter names that typically carry credentials.
// Normalised by lowercasing and stripping underscores and hyphens.
const AUTH_QUERY_PARAM_NAMES = new Set([
  'apikey', 'accesstoken', 'authtoken', 'token',
  'clientsecret', 'secret', 'password',
])

// Property-key and variable names that signal a credential. Normalised
// by lowercasing and stripping underscores, so consumer_secret,
// consumerSecret, and CONSUMER_SECRET all become 'consumersecret'.
const CREDENTIAL_KEY_NAMES = new Set([
  'password', 'passwd', 'pwd',
  'secret', 'apisecret', 'consumersecret', 'tokensecret', 'clientsecret',
  'consumerkey', 'tokenkey', 'apikey', 'clientid',
  'accesskey', 'accesstoken', 'authtoken', 'bearertoken',
  'privatekey',
])

// Names that signal a credential or personal data when a log call
// exposes them (the log check's set). Matched two ways, both bounded:
// the name's collapsed form (separators removed, lowercased) is a
// member, or one of its split words is — so `passwordField` matches on
// 'password' and `creditCard` on the collapsed 'creditcard', while
// `tokenize`, a single unrelated word, never matches. The bare name
// `email` is deliberately absent: email addresses are written to logs
// constantly in ordinary, legitimate scripts.
const SENSITIVE_NAMES = new Set([
  'password', 'passwd', 'pwd', 'secret', 'token', 'apikey', 'credential',
  'ssn', 'socialsecurity', 'creditcard', 'cardnumber',
  'bankaccount', 'accountnumber',
])

const HTTPS_METHODS = new Set(['get', 'post', 'put', 'delete', 'request'])
const LOG_METHODS = new Set(['debug', 'audit', 'error', 'emergency'])
const STRING_SCHEDULER_NAMES = new Set(['setTimeout', 'setInterval', 'setImmediate'])
const SS1_GLOBAL_PATTERN = /^(nlapi|nlobj)[A-Z]/

function normalizeHeaderName(name) {
  return typeof name === 'string' ? name.toLowerCase().replace(/-/g, '') : ''
}

function normalizeKeyName(name) {
  return typeof name === 'string' ? name.toLowerCase().replace(/_/g, '') : ''
}

function isCredentialKeyName(name) {
  return typeof name === 'string' && CREDENTIAL_KEY_NAMES.has(normalizeKeyName(name))
}

function splitNameWords(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
}

function isSensitiveName(name) {
  if (typeof name !== 'string' || name === '') return false
  const collapsed = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (SENSITIVE_NAMES.has(collapsed)) return true
  return splitNameWords(name).some((w) => SENSITIVE_NAMES.has(w))
}

// Placeholders and short defaults are not secrets: a developer
// scaffolding with 'your_password_here' must not earn a credential
// finding. The value must be at least 8 characters and must not begin
// with a known stand-in shape.
function isLikelyHardcodedSecret(value) {
  if (typeof value !== 'string') return false
  if (value.length < 8) return false
  if (/^(your[_-]?|<.*>|todo|tbd|placeholder|example|sample|x{3,}|\*{3,}|\.{3,}|n\/?a|null|undefined)/i.test(value)) return false
  return true
}

function isStringShapedArg(node) {
  if (!node) return false
  if (node.type === 'Literal' && typeof node.value === 'string') return true
  if (node.type === 'TemplateLiteral') return true
  return false
}

// A property's key as a string, handling identifier keys
// ({ foo: 1 }) and quoted string keys ({ 'X-API-Key': 1 }).
function getPropKeyName(prop) {
  if (!prop || prop.type !== 'Property') return null
  if (prop.key && prop.key.type === 'Identifier') return prop.key.name
  if (prop.key && prop.key.type === 'Literal' && typeof prop.key.value === 'string') return prop.key.value
  return null
}

// Inspect a literal URL string for embedded credentials: credentials
// in the userinfo part (https://user:password@host), or an
// authentication-shaped query parameter with a plausible value.
// Returns a short description of the issue, or null.
function analyzeAuthUrl(url) {
  if (typeof url !== 'string') return null
  const userinfoMatch = url.match(/^[a-z][a-z0-9+.-]*:\/\/[^/@:]+:([^/@]+)@/i)
  if (userinfoMatch && isLikelyHardcodedSecret(userinfoMatch[1])) {
    return 'credentials in URL userinfo (user:password@host)'
  }
  const queryStart = url.indexOf('?')
  if (queryStart !== -1) {
    const query = url.slice(queryStart + 1).split('#')[0]
    for (const pair of query.split('&')) {
      const eq = pair.indexOf('=')
      if (eq === -1) continue
      const rawKey = pair.slice(0, eq)
      const rawValue = pair.slice(eq + 1)
      const normKey = rawKey.toLowerCase().replace(/[_-]/g, '')
      if (!AUTH_QUERY_PARAM_NAMES.has(normKey)) continue
      let value
      try {
        value = decodeURIComponent(rawValue)
      } catch {
        value = rawValue
      }
      if (!isLikelyHardcodedSecret(value)) continue
      return `auth-shaped query parameter \`${rawKey}\` with literal value`
    }
  }
  return null
}

// ---------------------------------------------------------------------
// The alias map: which local names ARE which N/ modules in this file.
//
// SuiteScript binds modules positionally — in
// define(['N/https', 'N/log'], function (https, log) { ... }) the
// first factory parameter is N/https inside that file. Bindings are
// read from define() declarations (resolved with the same static
// readers the dependency extractor uses) and from top-level
// require('N/...') assignments. A binding that cannot be resolved
// statically — destructuring, a dynamic dependency list, one name
// bound to two different modules — leaves the alias unknown, and any
// check needing it does not fire on that receiver: silence over
// guessing, the same discipline the dependency extractor applies.
// ---------------------------------------------------------------------

function buildAliasMap(ast) {
  const bindings = collectArrayBindings(ast)
  const map = new Map()
  const ambiguous = new Set()
  const bind = (name, mod) => {
    if (!name || !mod) return
    if (ambiguous.has(name)) return
    const existing = map.get(name)
    if (existing && existing !== mod) {
      map.delete(name)
      ambiguous.add(name)
      return
    }
    map.set(name, mod)
  }

  walk.simple(ast, {
    VariableDeclarator(node) {
      if (node.id.type !== 'Identifier') return
      const mod = requireModuleOf(node.init)
      if (mod) bind(node.id.name, mod)
    },
    CallExpression(node) {
      if (node.callee.type !== 'Identifier' || node.callee.name !== 'define') return
      // A dependency list that cannot be read completely makes
      // positions after the gap unknown; binding by position would be
      // guessing, so an incomplete declaration binds nothing.
      const part = resolveCallModules(node, bindings)
      if (part.incomplete) return
      const factory = node.arguments.find(
        (a) => a && (a.type === 'FunctionExpression' || a.type === 'ArrowFunctionExpression'),
      )
      if (!factory) return
      factory.params.forEach((param, i) => {
        if (param.type === 'Identifier') bind(param.name, part.names[i])
      })
    },
  })
  return map
}

// The module a require('...') call names, or null when the call is not
// a statically readable require.
function requireModuleOf(node) {
  if (!node || node.type !== 'CallExpression') return null
  if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') return null
  const first = node.arguments && node.arguments[0]
  if (!first) return null
  if (first.type === 'Literal' && typeof first.value === 'string') return first.value
  if (first.type === 'TemplateLiteral' && first.expressions.length === 0) {
    const quasi = first.quasis[0]
    if (quasi && typeof quasi.value.cooked === 'string') return quasi.value.cooked
  }
  return null
}

// A member expression's property name: identifier form (obj.prop) or
// computed string form (obj['prop']). Null otherwise.
function memberPropertyName(member) {
  if (!member || member.type !== 'MemberExpression') return null
  if (!member.computed && member.property.type === 'Identifier') return member.property.name
  if (member.computed && member.property.type === 'Literal' && typeof member.property.value === 'string') {
    return member.property.value
  }
  return null
}

// Resolve a call's callee to { module, method } through the alias map,
// including the promise form (https.post.promise(...) resolves to
// N/https.post). Returns null when the receiver cannot be resolved.
function resolveModuleCall(callee, aliases) {
  if (!callee || callee.type !== 'MemberExpression') return null
  const propName = memberPropertyName(callee)
  if (!propName) return null
  const obj = callee.object
  if (obj.type === 'Identifier') {
    const mod = aliases.get(obj.name)
    return mod ? { module: mod, method: propName } : null
  }
  if (propName === 'promise' && obj.type === 'MemberExpression') {
    const innerProp = memberPropertyName(obj)
    if (!innerProp || obj.object.type !== 'Identifier') return null
    const mod = aliases.get(obj.object.name)
    return mod ? { module: mod, method: innerProp } : null
  }
  return null
}

// ---------------------------------------------------------------------
// The detectors. detectFindings(source) parses one file version and
// returns its findings as [{ check, line, anchor }] in source order —
// anchor is the fingerprint's matched-code component: the matched
// node's source text with whitespace collapsed — or null when the
// source does not parse (the caller decides what an unparseable
// version means; it is never treated as finding-free).
// ---------------------------------------------------------------------

function detectFindings(source) {
  let ast
  try {
    ast = acorn.parse(source, PARSE_OPTIONS)
  } catch {
    return null
  }

  const apiVersion = extractApiVersion(source)
  const scriptType = guessScriptType(source, extractExports(ast))
  const aliases = buildAliasMap(ast)
  // SuiteScript 1.0 APIs are native, not deprecated, in a file that
  // declares a 1.x API version.
  const ss1Active = !(typeof apiVersion === 'string' && /^1($|\.)/.test(apiVersion))
  // Names declared anywhere in the file. A locally declared `Function`
  // shadows the global constructor, so the plain-call form of the
  // eval check must not fire on it (the construction form is matched
  // separately, as in the reference behaviour).
  const declaredNames = new Set()
  walk.simple(ast, {
    FunctionDeclaration(node) { if (node.id) declaredNames.add(node.id.name) },
    VariableDeclarator(node) { if (node.id.type === 'Identifier') declaredNames.add(node.id.name) },
  })

  const findings = []
  const credCandidates = [] // { priority, valueStart, line, anchor }
  const slice = (node) => source.slice(node.start, node.end).replace(/\s+/g, ' ').trim()

  walk.simple(ast, {
    CallExpression(node) {
      const callee = node.callee
      const args = node.arguments || []

      // dynamic-code-eval — bare-identifier calls whose string-shaped
      // argument is compiled and executed at run time. A non-string
      // argument cannot be shown to be code text, and does not fire.
      if (callee.type === 'Identifier') {
        if (callee.name === 'eval' && isStringShapedArg(args[0])) {
          findings.push({ check: 'dynamic-code-eval', line: node.loc.start.line, anchor: `eval:${slice(args[0])}` })
        }
        if (STRING_SCHEDULER_NAMES.has(callee.name) && isStringShapedArg(args[0])) {
          findings.push({ check: 'dynamic-code-eval', line: node.loc.start.line, anchor: `${callee.name}:${slice(args[0])}` })
        }
        if (callee.name === 'Function' && !declaredNames.has('Function') && args.length > 0
          && isStringShapedArg(args[args.length - 1])) {
          findings.push({ check: 'dynamic-code-eval', line: node.loc.start.line, anchor: `Function:${slice(args[args.length - 1])}` })
        }
      }

      // hardcoded-credential, Pattern C — a credential configuration
      // object passed as an argument to any call: at least two
      // credential-named keys (the OAuth/TBA pair signal) with at
      // least one plausible literal value. One candidate per literal
      // property.
      for (const arg of args) {
        if (!arg || arg.type !== 'ObjectExpression') continue
        let credKeyCount = 0
        const literalProps = []
        for (const prop of arg.properties) {
          if (prop.type !== 'Property') continue
          const keyName = getPropKeyName(prop)
          if (!isCredentialKeyName(keyName)) continue
          credKeyCount += 1
          if (prop.value && prop.value.type === 'Literal'
            && typeof prop.value.value === 'string'
            && isLikelyHardcodedSecret(prop.value.value)) {
            literalProps.push(prop)
          }
        }
        if (credKeyCount >= 2 && literalProps.length >= 1) {
          for (const prop of literalProps) {
            credCandidates.push({ priority: 2, valueStart: prop.value.start, line: prop.loc.start.line, anchor: slice(prop) })
          }
        }
      }

      const resolved = resolveModuleCall(callee, aliases)

      // hardcoded-credential, Patterns A and B — at an N/https or
      // N/http call site: credential header literals in the options
      // object's headers, and credentials inside its literal URL.
      if (resolved && (resolved.module === 'N/https' || resolved.module === 'N/http')
        && HTTPS_METHODS.has(resolved.method)) {
        const opts = args[0]
        if (opts && opts.type === 'ObjectExpression') {
          const headersProp = opts.properties.find((p) => getPropKeyName(p) === 'headers')
          if (headersProp && headersProp.value && headersProp.value.type === 'ObjectExpression') {
            for (const hp of headersProp.value.properties) {
              if (hp.type !== 'Property') continue
              const headerName = getPropKeyName(hp)
              if (!headerName) continue
              if (!AUTH_HEADER_NAMES.has(normalizeHeaderName(headerName))) continue
              if (!hp.value || hp.value.type !== 'Literal' || typeof hp.value.value !== 'string') continue
              if (!isLikelyHardcodedSecret(hp.value.value)) continue
              credCandidates.push({ priority: 0, valueStart: hp.value.start, line: hp.loc.start.line, anchor: slice(hp) })
            }
          }
          const urlProp = opts.properties.find((p) => getPropKeyName(p) === 'url')
          if (urlProp && urlProp.value && urlProp.value.type === 'Literal'
            && typeof urlProp.value.value === 'string'
            && analyzeAuthUrl(urlProp.value.value)) {
            credCandidates.push({ priority: 1, valueStart: urlProp.value.start, line: urlProp.loc.start.line, anchor: slice(urlProp) })
          }
        }
      }

      // sync-https-in-client — a synchronous N/https call in a file
      // whose type resolves to ClientScript by the same resolution
      // the inventory publishes (annotation first, else export vote).
      if (resolved && scriptType === 'ClientScript'
        && resolved.module === 'N/https' && HTTPS_METHODS.has(resolved.method)) {
        findings.push({ check: 'sync-https-in-client', line: callee.loc.start.line, anchor: slice(callee) })
      }

      // log-of-pii-or-secret — a call through the N/log alias, or a
      // console.* call, exposing a sensitively-named value at the
      // call site.
      const isLogCall = resolved && resolved.module === 'N/log' && LOG_METHODS.has(resolved.method)
      const isConsoleCall = callee.type === 'MemberExpression'
        && callee.object.type === 'Identifier' && callee.object.name === 'console'
      if (isLogCall || isConsoleCall) {
        for (const arg of args) {
          const matched = findSensitiveName(arg, 1)
          if (matched) {
            findings.push({ check: 'log-of-pii-or-secret', line: node.loc.start.line, anchor: `${slice(callee)}:${matched}` })
            break
          }
        }
      }

      // ss1-deprecated-api — a retired 1.0 global as a call target.
      if (ss1Active && callee.type === 'Identifier' && SS1_GLOBAL_PATTERN.test(callee.name)) {
        findings.push({ check: 'ss1-deprecated-api', line: callee.loc.start.line, anchor: callee.name })
      }
    },

    NewExpression(node) {
      const callee = node.callee
      const args = node.arguments || []
      // dynamic-code-eval — new Function(body): the last argument is
      // the body; when it is string-shaped it is compiled at run time.
      if (callee.type === 'Identifier' && callee.name === 'Function'
        && args.length > 0 && isStringShapedArg(args[args.length - 1])) {
        findings.push({ check: 'dynamic-code-eval', line: node.loc.start.line, anchor: `Function:${slice(args[args.length - 1])}` })
      }
      if (ss1Active && callee.type === 'Identifier' && SS1_GLOBAL_PATTERN.test(callee.name)) {
        findings.push({ check: 'ss1-deprecated-api', line: callee.loc.start.line, anchor: callee.name })
      }
    },

    BinaryExpression(node) {
      // ss1-deprecated-api — a 1.0 type in an instanceof guard.
      if (ss1Active && node.operator === 'instanceof'
        && node.right && node.right.type === 'Identifier'
        && SS1_GLOBAL_PATTERN.test(node.right.name)) {
        findings.push({ check: 'ss1-deprecated-api', line: node.right.loc.start.line, anchor: node.right.name })
      }
    },

    CatchClause(node) {
      // empty-catch — a catch whose block holds no statements once
      // empty statements are discarded. A comment is not a statement:
      // a comment-only catch still swallows the error silently, and
      // still fires (the product ruling on this idiom).
      const statements = node.body.body.filter((s) => s.type !== 'EmptyStatement')
      if (statements.length === 0) {
        findings.push({ check: 'empty-catch', line: node.loc.start.line, anchor: slice(node) })
      }
    },

    VariableDeclarator(node) {
      // hardcoded-credential, Pattern D — a credential-named variable
      // holding a plausible literal string.
      if (node.id.type === 'Identifier' && isCredentialKeyName(node.id.name)
        && node.init && node.init.type === 'Literal' && typeof node.init.value === 'string'
        && isLikelyHardcodedSecret(node.init.value)) {
        credCandidates.push({ priority: 3, valueStart: node.init.start, line: node.loc.start.line, anchor: slice(node) })
      }
    },

    AssignmentExpression(node) {
      // hardcoded-credential, Pattern D — a credential-named target
      // (a variable, or an object's credential-named property) assigned
      // a plausible literal string.
      if (node.operator !== '=') return
      const left = node.left
      const named = (left.type === 'Identifier' && isCredentialKeyName(left.name))
        || (left.type === 'MemberExpression' && isCredentialKeyName(memberPropertyName(left)))
      if (named && node.right.type === 'Literal' && typeof node.right.value === 'string'
        && isLikelyHardcodedSecret(node.right.value)) {
        credCandidates.push({ priority: 3, valueStart: node.right.start, line: node.loc.start.line, anchor: slice(node) })
      }
    },

    Property(node) {
      // hardcoded-credential, Pattern D — a credential-named property
      // holding a plausible literal string, in any object literal.
      const keyName = getPropKeyName(node)
      if (keyName && isCredentialKeyName(keyName)
        && node.value && node.value.type === 'Literal' && typeof node.value.value === 'string'
        && isLikelyHardcodedSecret(node.value.value)) {
        credCandidates.push({ priority: 3, valueStart: node.value.start, line: node.loc.start.line, anchor: slice(node) })
      }
    },
  })

  // One literal, one finding: where several credential patterns match
  // the same literal (a header that is also a credential-named
  // property, a configuration property that also qualifies as a plain
  // assignment), the earliest pattern in A, B, C, D order owns it.
  const claimed = new Map()
  for (const c of credCandidates) {
    const existing = claimed.get(c.valueStart)
    if (!existing || c.priority < existing.priority) claimed.set(c.valueStart, c)
  }
  for (const c of claimed.values()) {
    findings.push({ check: 'hardcoded-credential', line: c.line, anchor: c.anchor })
  }

  findings.sort((a, b) => a.line - b.line
    || (a.check < b.check ? -1 : a.check > b.check ? 1 : 0)
    || (a.anchor < b.anchor ? -1 : a.anchor > b.anchor ? 1 : 0))
  return findings
}

// The first sensitively-named value exposed by one node, searching one
// hop deep: a bare name, a member path's final name, an object
// argument's keys and (within the hop) its values, a template string's
// embedded names. Logging a whole object does not fire — the check
// cannot see inside a variable, and does not pretend to.
function findSensitiveName(node, depth) {
  if (!node) return null
  switch (node.type) {
    case 'Identifier':
      return isSensitiveName(node.name) ? node.name : null
    case 'MemberExpression': {
      const pn = memberPropertyName(node)
      return pn && isSensitiveName(pn) ? pn : null
    }
    case 'TemplateLiteral': {
      for (const expr of node.expressions) {
        const hit = findSensitiveName(expr, 0)
        if (hit) return hit
      }
      return null
    }
    case 'ObjectExpression': {
      for (const prop of node.properties) {
        if (prop.type !== 'Property') continue
        const keyName = getPropKeyName(prop)
        if (keyName && isSensitiveName(keyName)) return keyName
        if (depth > 0) {
          const hit = findSensitiveName(prop.value, depth - 1)
          if (hit) return hit
        }
      }
      return null
    }
    case 'ArrayExpression': {
      for (const el of node.elements) {
        if (!el) continue
        const hit = findSensitiveName(el, depth)
        if (hit) return hit
      }
      return null
    }
    default:
      return null
  }
}

// ---------------------------------------------------------------------
// Subtraction and orchestration.
// ---------------------------------------------------------------------

// A finding's fingerprint within one file: check plus matched code.
// The line number is deliberately not part of it — lines move.
function fingerprintOf(finding) {
  return `${finding.check}|${finding.anchor}`
}

// The head findings that survive subtraction of the base findings.
// Identical fingerprints are matched by ordinal (first with first,
// second with second), so two identical defects are tracked as two
// and deleting the first of them reports nothing new.
function subtractFindings(headFindings, baseFindings) {
  const baseCounts = new Map()
  for (const f of baseFindings) {
    const fp = fingerprintOf(f)
    baseCounts.set(fp, (baseCounts.get(fp) || 0) + 1)
  }
  const seen = new Map()
  const introduced = []
  for (const f of headFindings) {
    const fp = fingerprintOf(f)
    const ordinal = (seen.get(fp) || 0) + 1
    seen.set(fp, ordinal)
    if (ordinal > (baseCounts.get(fp) || 0)) introduced.push(f)
  }
  return introduced
}

// Examine one pull request's changed script files and return the
// checks result the comment renders:
// {
//   skipped: null,
//   findings: [{ check, file, line, message, onAddedLine }],
//   changedCount, examinedCount, notCompared, notExamined,
//   notExaminedTypeScript,
//   diagrams: [{ file, participants, entryPoints, calls,
//                ambiguousCalls, overCap }],   // one per examined file,
// }                                            // plus one flagged
//                                              // record per changed
//                                              // TypeScript file
//
// changedCount counts every changed script file in scope for the
// mode, TypeScript files included: they are part of the change's
// accounting even though they are never examined, and the gap
// between changedCount and examinedCount is what the comment's
// disclosure lines explain.
//
// The diagrams ride along with the examination: the same head sources
// are already read and parsed here, and src/diagram.js reads each one
// for its direct intra-file calls. Only examined files contribute —
// a file the checks could not examine gets no diagram either.
//
// mode: the analyzer's mode for the head tree ('project' | 'loose' |
// 'empty'). projectPrefix: the project root's repository-relative
// prefix ('' or 'a/b/'). suiteRootRel: in project mode, the resolved
// SuiteScripts folder relative to the project root. changesFiles: the
// records changes.js produced. readHeadFile / readBaseFile resolve a
// repository-relative path to its text (head from the checkout, base
// from git); readBaseFile throws when the base version cannot be read.
async function runPatternChecks({
  mode,
  projectPrefix,
  suiteRootRel,
  changesFiles,
  readHeadFile,
  readBaseFile,
}) {
  // The population, in deterministic path order: changed files with a
  // head version that are script files for this mode. Deleted files
  // cannot introduce a presence finding and are excluded entirely.
  const population = []
  const typeScriptFiles = []
  const headSources = new Map()
  const live = changesFiles
    .filter((f) => f.kind !== 'deleted')
    .map((f) => ({ ...f, displayPath: displayPathOf(f.repoPath, projectPrefix) }))
    .filter((f) => f.displayPath !== null)
    .sort((a, b) => (a.displayPath < b.displayPath ? -1 : a.displayPath > b.displayPath ? 1 : 0))

  for (const f of live) {
    if (mode === 'project') {
      if (!suiteRootRel) continue
      if (f.displayPath !== suiteRootRel && !f.displayPath.startsWith(`${suiteRootRel}/`)) continue
      if (f.displayPath.endsWith('.js')) {
        population.push(f)
      } else if (isTypeScriptPath(f.displayPath)) {
        // In scope for the mode, and a script file by position — but
        // TypeScript, so counted as not examined, never read.
        typeScriptFiles.push(f.displayPath)
      }
    } else {
      const isJavaScript = f.displayPath.endsWith('.js')
      if (!isJavaScript && !isTypeScriptPath(f.displayPath)) continue
      if (f.displayPath.split('/').some((seg) => EXCLUDED_DIRS.has(seg))) continue
      // Loose mode recognises scripts by their annotations; a changed
      // file without them is not a script file and is not counted.
      // The annotation read is a text read, so it works the same for
      // a TypeScript file as for a JavaScript one.
      let source
      try {
        source = await readHeadFile(f.repoPath)
      } catch {
        continue
      }
      if (!hasSuiteScriptAnnotations(source)) continue
      if (isJavaScript) {
        headSources.set(f.repoPath, source)
        population.push(f)
      } else {
        typeScriptFiles.push(f.displayPath)
      }
    }
  }

  let examinedCount = 0
  let notCompared = 0
  let notExamined = 0
  const findings = []
  const diagrams = []

  for (const f of population) {
    if (examinedCount + notCompared + notExamined >= MAX_CHECK_FILES) {
      // Beyond the cap: counted as changed, disclosed by the header's
      // examined-of-changed arithmetic, never examined silently less.
      continue
    }

    let headSource = headSources.get(f.repoPath)
    if (headSource === undefined) {
      try {
        headSource = await readHeadFile(f.repoPath)
      } catch {
        notExamined += 1
        continue
      }
    }
    if (Buffer.byteLength(headSource, 'utf8') > MAX_CHECK_FILE_BYTES) {
      notExamined += 1
      continue
    }
    const headFindings = detectFindings(headSource)
    if (headFindings === null) {
      // Not valid JavaScript: in project mode it already carries the
      // inventory's parse warning. Counted as changed, not examinable
      // — never as checked-and-clean.
      notExamined += 1
      continue
    }

    let baseFindings
    if (f.kind === 'added') {
      baseFindings = []
    } else {
      let baseSource
      try {
        baseSource = await readBaseFile(f.prevRepoPath || f.repoPath)
      } catch {
        notCompared += 1
        continue
      }
      if (Buffer.byteLength(baseSource, 'utf8') > MAX_CHECK_FILE_BYTES) {
        notCompared += 1
        continue
      }
      baseFindings = detectFindings(baseSource)
      if (baseFindings === null) {
        notCompared += 1
        continue
      }
    }

    examinedCount += 1
    // The diagram is drawn from the head version only. Every examined
    // file contributes its record — drawn, omitted for size, or with
    // nothing to draw — so the renderer can account for each file in
    // the section (diagram audit F-C1): a file whose work runs
    // entirely through N/ modules is counted in the section's closing
    // line rather than vanishing from it. extractCallDiagram cannot
    // return null here in practice: the checks and the diagram pass
    // parse with the same options, and this file has already parsed
    // successfully above; the guard stays so a null can never crash
    // the examination.
    const diagram = extractCallDiagram(headSource)
    if (diagram) {
      diagrams.push({ file: f.displayPath, ...diagram })
    }
    for (const hit of subtractFindings(headFindings, baseFindings)) {
      findings.push({
        check: hit.check,
        file: f.displayPath,
        line: hit.line,
        message: CHECK_MESSAGES[hit.check],
        onAddedLine: f.addedLines ? f.addedLines.has(hit.line) : false,
      })
    }
  }

  findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
    || a.line - b.line
    || (a.check < b.check ? -1 : a.check > b.check ? 1 : 0))

  // One flagged record per changed TypeScript file, merged with the
  // examined files' records in path order, so the diagram section
  // accounts for each TypeScript file as not examined (its closing
  // accounting reconciles with the change, as it does for examined
  // files) instead of letting it vanish from the section entirely.
  const typeScriptRecords = typeScriptFiles.map((file) => ({
    file,
    participants: [],
    entryPoints: [],
    calls: [],
    ambiguousCalls: 0,
    overCap: false,
    notExaminedTypeScript: true,
  }))
  const allDiagrams = [...diagrams, ...typeScriptRecords]
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))

  return {
    skipped: null,
    findings,
    changedCount: population.length + typeScriptFiles.length,
    examinedCount,
    notCompared,
    notExamined,
    notExaminedTypeScript: typeScriptFiles.length,
    diagrams: allDiagrams,
  }
}

// A changed file's path relative to the project root, with forward
// slashes — or null when the file sits outside the project root.
function displayPathOf(repoPath, projectPrefix) {
  if (!projectPrefix) return repoPath
  if (!repoPath.startsWith(projectPrefix)) return null
  return repoPath.slice(projectPrefix.length)
}

module.exports = {
  CHECK_NAMES,
  CHECK_MESSAGES,
  MAX_CHECK_FILES,
  MAX_CHECK_FILE_BYTES,
  detectFindings,
  subtractFindings,
  runPatternChecks,
  // exported for tests:
  buildAliasMap,
  analyzeAuthUrl,
  isLikelyHardcodedSecret,
  isSensitiveName,
  isTypeScriptPath,
}
