# The R1 equivalence corpus

These fixture files are the shared corpus for the six presence checks
(`hardcoded-credential`, `dynamic-code-eval`, `empty-catch`,
`log-of-pii-or-secret`, `ss1-deprecated-api`, `sync-https-in-client`):
small SuiteScript-shaped samples whose expected findings — by check
and line — are pinned in `tests/checks.test.js`.

Under the product line's equivalence contract, the same corpus is the
specification the paid analyzer's implementations of these six checks
must agree with. The free side asserts it now. The paid side's
matching assertion lands with the build that gives the paid
`hardcoded-credential` check its plain-assignment pattern (Pattern D);
until then the cross-suite assertion is queued, not faked.

Corpus scope notes — shapes the corpus deliberately pins, and seams it
deliberately does not:

- `hardcoded-credential` pins Patterns A (credential headers at a web
  call site), B (credentials in a literal URL), C (a credential
  configuration object passed to a call), and D (plain assignments of
  plausible literals to credential-named variables, properties, and
  assignment targets). Shapes the check must not fire on are pinned
  too: values sourced from a variable or a script parameter,
  placeholders, and values under the length floor.
- `dynamic-code-eval` pins the plain `Function('...')()` call form as
  firing (a design-specified shape), and a locally shadowed `Function`
  declaration is out of corpus scope.
- `sync-https-in-client` pins the `N/https` module only, including its
  promise form. The `N/http` module is excluded from this check by
  design ruling, so no corpus shape exercises it.
- `log-of-pii-or-secret` pins the design's call-site shapes: a bare
  sensitive name, a member path ending in one, an object argument's
  sensitive keys or `details` value, and a template string embedding
  one — plus the deliberate exclusions (the bare name `email`, a whole
  logged object, the unrelated word `tokenize`).

The sample credential values in these files are invented strings,
chosen to pass the check's plausibility filter (length, no placeholder
prefix) so the firing shapes actually fire.
