// Call-diagram extraction for the free-tier SDF action (the reduced
// Mermaid sequence diagram in the pull-request comment).
//
// Single responsibility: reading ONE changed file's source and
// returning the facts the diagram is drawn from — the file's function
// definitions, the binding from each entry-point export to the
// function that implements it, and the literal direct calls between
// those functions inside the same file, ordered as a call sequence
// starting from the file's entry points.
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
//
// The values are set from rendered size, not budget arithmetic
// (diagram audit F-F2, v1.2.1). Measured with Mermaid 10.9.3 — the
// version GitHub renders with — under real font metrics, through
// this extractor and renderer, on synthetic files with realistic
// SuiteScript names: the natural width grows about 200 px per
// participant (8 participants render 1,650 px wide; 9 render
// 1,850 px) against a readability budget of two ~860 px comment
// columns (1,720 px); the height grows about 48 px per call (at 8
// participants, 36 calls render 1,902 px tall; 40 render 2,094 px).
// The previous caps (24 participants, 40 calls) rendered 4,860 px
// wide — about four of twenty-four participants visible at once in
// the comment column. The calibration is on realistic names, as the
// audit's measurement was; names at the 40-character label cap widen
// a box past it.
const MAX_DIAGRAM_PARTICIPANTS = 8
const MAX_DIAGRAM_CALLS = 36

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
//   participants: [name, ...],       // drawn functions: entry points first,
//                                     // then first-reached order
//   entryPoints: [name, ...],        // participants that implement an export
//   calls: [{ from, to }, ...],      // distinct direct calls, in call order
//                                     // from the entry points (F-A1)
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

  // De-duplicated edges, grouped per caller in body order: the sites
  // are offset-sorted first, so each caller's list is the order its
  // calls appear in its own body.
  sites.sort((a, b) => a.start - b.start)
  const adjacency = new Map()
  for (const site of sites) {
    if (!adjacency.has(site.from)) adjacency.set(site.from, [])
    const outs = adjacency.get(site.from)
    if (!outs.includes(site.to)) outs.push(site.to)
  }
  const edges = []
  for (const [from, outs] of adjacency) {
    for (const to of outs) edges.push({ from, to })
  }

  // The drawn participants: every function an edge touches, plus the
  // entry-point functions.
  const drawn = new Set()
  for (const edge of edges) {
    drawn.add(edge.from)
    drawn.add(edge.to)
  }
  for (const name of entryNames) {
    if (byName.has(name) && byName.get(name).length === 1) drawn.add(name)
  }
  const entryPoints = definitions
    .filter((def) => drawn.has(def.name) && entryNames.has(def.name))
    .map((def) => def.name)

  // Message order (diagram audit F-A1): the messages are ordered as
  // a call sequence, not by file offset — start from each entry
  // point, emit its calls in body order, and expand each callee's own
  // calls immediately after the call that reaches it, so no
  // function's internal call is drawn before the call that invokes
  // it. Functions no entry point reaches are traversed afterwards,
  // in definition order, so every extracted edge is still drawn
  // exactly once. The traversal works only on the edge set above:
  // no call is resolved, inferred, or added.
  const { calls, reachOrder } = orderCallsByTraversal(
    adjacency, entryPoints, definitions.map((def) => def.name),
  )

  // Participant order (F-F3): entry points first, then the remaining
  // functions in the order the traversal first reaches them — the
  // reader starts where execution starts.
  const participants = []
  const placed = new Set()
  for (const name of [...entryPoints, ...reachOrder]) {
    if (drawn.has(name) && !placed.has(name)) {
      placed.add(name)
      participants.push(name)
    }
  }

  return {
    participants,
    entryPoints,
    calls,
    ambiguousCalls,
    overCap: participants.length > MAX_DIAGRAM_PARTICIPANTS
      || calls.length > MAX_DIAGRAM_CALLS,
  }
}

// Order the distinct edges as a call sequence: an iterative
// depth-first walk (an explicit stack, so a pathologically deep call
// chain cannot overflow the call stack). Each edge is emitted once;
// a callee's edges are emitted immediately after the edge that
// reaches it, before the caller's next edge — the nesting an
// execution would have. Cycles terminate: an emitted edge is never
// emitted again, and a frame is pushed only when an edge is emitted,
// so the walk is bounded by the edge count. Returns the ordered
// calls and the order in which functions are first reached.
function orderCallsByTraversal(adjacency, roots, callerOrder) {
  const emitted = new Set()
  const calls = []
  const reachOrder = []
  const reached = new Set()
  const reach = (name) => {
    if (!reached.has(name)) {
      reached.add(name)
      reachOrder.push(name)
    }
  }
  const visit = (root) => {
    const stack = [[root, 0]]
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      const outs = adjacency.get(frame[0]) || []
      if (frame[1] >= outs.length) {
        stack.pop()
        continue
      }
      const to = outs[frame[1]]
      frame[1] += 1
      const key = `${frame[0]}\0${to}`
      if (emitted.has(key)) continue
      emitted.add(key)
      calls.push({ from: frame[0], to })
      reach(frame[0])
      reach(to)
      stack.push([to, 0])
    }
  }
  for (const root of roots) visit(root)
  for (const caller of callerOrder) {
    const outs = adjacency.get(caller) || []
    if (outs.some((to) => !emitted.has(`${caller}\0${to}`))) visit(caller)
  }
  return { calls, reachOrder }
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
