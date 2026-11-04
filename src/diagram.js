// Call-diagram extraction for the free-tier SDF action (the reduced
// Mermaid sequence diagram in the pull-request comment).
//
// Single responsibility: reading ONE changed file's source and
// returning the facts the diagram is drawn from — the file's function
// definitions, the binding from each entry-point export to the
// function that implements it, and the literal direct calls between
// those functions inside the same file, in source order.
//
// The reduced form is deliberate, and the boundary is the product
// decision recorded for this feature: direct calls only. A call counts
// when its callee is a bare identifier naming a function defined in
// the same file. Calls through member expressions (`record.load(...)`),
// through variables or callbacks, and into other files are NOT
// resolved — that resolution is the paid analyzer's call-graph
// machinery, and it stays out of this repository. A callee name that
// is defined more than once in the file is ambiguous at this syntactic
// level, so calls to it are omitted and counted, never guessed.
//
// Everything here is a syntax-tree read (Acorn, the engine's parser):
// call-shaped text inside strings, template literals, and comments is
// never seen, because it is never a call node (the D2 lesson).
//
// This file owns its own logic; it does not import from any private
// Strikaris package. The engine stays private by staying separate.

const acorn = require('acorn')
const walk = require('acorn-walk')

// Caps, as named constants in the family the checks and the comment
// renderer keep. A file whose drawn diagram would exceed either cap
// is not drawn at all — the renderer omits it and says so — because a
// diagram cut off mid-way would assert calls that were never the
// whole picture. The caps bound what is DRAWN (functions appearing in
// a call, plus entry-point functions), not what a file may contain.
const MAX_DIAGRAM_PARTICIPANTS = 24
const MAX_DIAGRAM_CALLS = 40

// The diagram pass parses each examined head file itself, with the
// same options family as the pattern checks. Locations are not
// needed; node offsets (start/end) are always present and give the
// source order the diagram is drawn in.
const PARSE_OPTIONS = {
  ecmaVersion: 2022,
  sourceType: 'script',
  allowReturnOutsideFunction: true,
  allowHashBang: true,
}

// Extract the diagram facts for one file's source. Returns null when
// the source does not parse (the caller already counts such a file as
// not examinable for the pattern checks; a diagram must never be
// drawn from a partial read). Otherwise returns:
// {
//   participants: [name, ...],       // drawn functions, in definition order
//   entryPoints: [name, ...],        // participants that implement an export
//   calls: [{ from, to }, ...],      // distinct direct calls, source order
//   ambiguousCalls: n,               // direct calls omitted as ambiguous
//   overCap: bool,                   // drawn size would exceed a cap
// }
function extractCallDiagram(source) {
  let ast
  try {
    ast = acorn.parse(source, PARSE_OPTIONS)
  } catch {
    return null
  }

  const definitions = collectDefinitions(ast)
  const byName = new Map()
  for (const def of definitions) {
    if (!byName.has(def.name)) byName.set(def.name, [])
    byName.get(def.name).push(def)
  }

  const entryNames = collectEntryPointNames(ast, byName)

  // Every call site whose callee is a bare identifier, attributed to
  // the innermost function definition whose body contains it. A call
  // outside every function (factory top level) has no caller to draw
  // and is not a function-to-function call, so it is not counted.
  const sites = []
  let ambiguousCalls = 0
  walk.simple(ast, {
    CallExpression(node) {
      if (!node.callee || node.callee.type !== 'Identifier') return
      const calleeName = node.callee.name
      const targets = byName.get(calleeName)
      if (!targets) return
      const caller = innermostDefinition(definitions, node)
      if (!caller) return
      if (targets.length !== 1 || byName.get(caller.name).length !== 1) {
        // Either end of the edge is a name defined more than once in
        // this file: the edge cannot be asserted honestly, so it is
        // omitted and counted rather than guessed.
        ambiguousCalls += 1
        return
      }
      sites.push({ from: caller.name, to: calleeName, start: node.start })
    },
  })

  // Source order, then de-duplicated: the diagram shows which
  // functions call which, in the order the calls first appear.
  sites.sort((a, b) => a.start - b.start)
  const seen = new Set()
  const calls = []
  for (const site of sites) {
    const key = `${site.from}\0${site.to}`
    if (seen.has(key)) continue
    seen.add(key)
    calls.push({ from: site.from, to: site.to })
  }

  // The drawn participants: every function an edge touches, plus the
  // entry-point functions, in definition order.
  const drawn = new Set()
  for (const call of calls) {
    drawn.add(call.from)
    drawn.add(call.to)
  }
  for (const name of entryNames) {
    if (byName.has(name) && byName.get(name).length === 1) drawn.add(name)
  }
  const participants = definitions
    .filter((def) => drawn.has(def.name) && byName.get(def.name).length === 1)
    .map((def) => def.name)

  return {
    participants,
    entryPoints: participants.filter((name) => entryNames.has(name)),
    calls,
    ambiguousCalls,
    overCap: participants.length > MAX_DIAGRAM_PARTICIPANTS
      || calls.length > MAX_DIAGRAM_CALLS,
  }
}

// One definition record per named function the file declares, in
// source order: function declarations, variables bound to a function
// or arrow expression, object properties whose value is a function
// (the entry-point object's shape among them), and class methods.
// Anonymous functions acquire a name only from one of these bindings;
// a bare callback passed to a call is not a definition the diagram
// can name, so it contributes no participant — calls inside it are
// attributed to the enclosing named function, if any.
function collectDefinitions(ast) {
  const definitions = []
  const add = (name, node) => {
    if (typeof name === 'string' && name && node) {
      definitions.push({ name, node })
    }
  }
  walk.simple(ast, {
    FunctionDeclaration(node) {
      if (node.id) add(node.id.name, node)
    },
    VariableDeclarator(node) {
      if (node.id && node.id.type === 'Identifier'
        && isFunctionNode(node.init)) {
        add(node.id.name, node.init)
      }
    },
    Property(node) {
      if (isFunctionNode(node.value)) add(propertyKeyName(node.key), node.value)
    },
    MethodDefinition(node) {
      if (isFunctionNode(node.value)) add(propertyKeyName(node.key), node.value)
    },
  })
  definitions.sort((a, b) => a.node.start - b.node.start)
  return definitions
}

// The entry-point names a file exports, resolved to function names:
// `onRequest: onRequest` binds the export to the named function;
// `onRequest: function (...) {...}` defines the function under the
// export's own name (collectDefinitions records it under the property
// key). An export bound to anything else is not a function entry
// point. This mirrors extractExports' traversal (analyzer.js) and
// keeps the value it discards.
function collectEntryPointNames(ast, byName) {
  const names = new Set()
  walk.simple(ast, {
    CallExpression(node) {
      if (node.callee.type !== 'Identifier' || node.callee.name !== 'define') return
      const factory = node.arguments.find((a) => a && isFunctionNode(a))
      if (!factory) return
      const body = factory.body.type === 'BlockStatement' ? factory.body.body : [factory.body]
      for (const stmt of body) {
        if (stmt.type !== 'ReturnStatement' || !stmt.argument
          || stmt.argument.type !== 'ObjectExpression') continue
        for (const prop of stmt.argument.properties) {
          if (prop.type !== 'Property' || !prop.key) continue
          const exportName = propertyKeyName(prop.key)
          if (!exportName) continue
          if (prop.value.type === 'Identifier') {
            if (byName.has(prop.value.name)) names.add(prop.value.name)
          } else if (isFunctionNode(prop.value)) {
            names.add(exportName)
          }
        }
      }
    },
  })
  return names
}

// The innermost definition whose node contains the given node, or
// null when the node sits outside every definition. Definition nodes
// nest (a function declared inside another), so the containing
// definition with the greatest start offset is the innermost.
function innermostDefinition(definitions, node) {
  let best = null
  for (const def of definitions) {
    if (def.node.start <= node.start && node.end <= def.node.end) {
      if (!best || def.node.start > best.node.start) best = def
    }
  }
  return best
}

function isFunctionNode(node) {
  return !!node && (node.type === 'FunctionExpression'
    || node.type === 'ArrowFunctionExpression')
}

function propertyKeyName(key) {
  if (!key) return null
  if (key.type === 'Identifier') return key.name
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value
  return null
}

module.exports = {
  MAX_DIAGRAM_PARTICIPANTS,
  MAX_DIAGRAM_CALLS,
  extractCallDiagram,
}
