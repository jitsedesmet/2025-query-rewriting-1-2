# Implementation task: triple term assertions in the pushdown

## Goal

`pushDownAssertions` currently moves assertions about a variable's *value* (`sameTerm(?x, c)`,
`sameTerm(?x, ?y)`, `bound`, `!bound`). Extend it to assertions about a triple term's *structure*, so
that

```sparql
SELECT * { ?s ?p ?o FILTER(sameTerm(subject(?o), ?s)) }
```

is rewritten to

```sparql
SELECT * { ?s ?p <<( ?s ?o_p ?o_o )>> . BIND(<<( ?s ?o_p ?o_o )>> AS ?o) }
```

and interoperates with the existing term assertions and variable cliques: asserting a structure on one
member of a clique must assert it on all of them.

`report.md` is the design study this comes from — read it first, it is short. This file is the
implementation contract: everything below is decided, not up for re-litigation, except where it says
"your call".

## Orientation (read before writing code)

| file | why |
|---|---|
| `lib/utils/assertionConjunction.ts` | Θ, the conjunction that travels. Its file comment states the invariants you must preserve. |
| `lib/utils/assertions.ts` | the four assertion forms, their recognisers and builders, substitution into terms/patterns |
| `lib/datastructures/ClusterSet.ts`, `TermClusterSet.ts` | the union-find Θ is built on |
| `lib/transformations/pushDownAssertions.ts` | the pass; its file comment explains the rules per operation |
| `lib/utils/certainlyBoundVars.ts` | `cVars`/`pVars` metadata, computed by dynamic programming |
| `lib/utils/partialExpressionEvaluation.ts` | substitution into expressions + constant folding |
| `lib/RangeSet.ts`, `lib/ClusterSolver.ts` | positional term-type ranges, already used by the rewriting side |

The codebase documents *why* rather than *what*, in dense prose, with the rule names of Schmidt et al.
Match that: every new rule you add needs the argument for its soundness written next to it.

## Design (decided)

### D1 — conjuncts are about an *access*, not a variable

```
export type TriplePosition = 'subject' | 'predicate' | 'object';
/** A variable read through a chain of accessors: `?x`, `subject(?x)`, `object(subject(?x))`. */
export interface Access { name: string; positions: readonly TriplePosition[] }
export function accessId(a: Access): string { return [ a.name, ...a.positions ].join('.'); }
```

* `AssertionConjunct` becomes `{ access, assertion }`; today's `{ name, assertion }` is
  `positions: []`.
* The RHS of a strong/weak assertion becomes `Access | RDF.Term`. Normalise a *variable* RHS to the
  zero-length `Access` so there is only one spelling; `conjunctVars` and `splitClique` currently match
  on `term.termType === 'Variable'`.
* `bound` / `unbound` stay restricted to `positions.length === 0` — `BOUND` takes a `Var` by grammar,
  and the subject of a triple term is always bound.
* `conjunctVars(conjunct)` returns the **root names** of both sides. Everything downstream
  (`weakenedConjunct`, `split`, the join/left-join licences) already reads only that and must keep
  doing so.

### D2 — one new form, `T⟨?x⟩ ≔ isTRIPLE(?x)`

The degenerate shape: "a triple term, nothing known about its parts". It **implies bound** (so it joins
`strong` and `bound` in `impliesBound`, and triggers (FBndII) and the OPTIONAL→JOIN collapse), it
**has a weak form** (`!bound(?x) || isTRIPLE(?x)`), it is absorbed by anything stronger, and it
contradicts `U⟨?x⟩` and any pin to a non-quad term.

### D3 — groups are pinned to a shape, not a term

In `TermClusterSet`, generalise `groupToTerm`:

```
type Pin = { kind: 'term'; term: RDF.Term } | { kind: 'triple'; children: [ number, number, number ] };
```

Children are **group ids**, so a position nobody named is an *anonymous group*: it exists, unifies, and
contributes nothing to `size` / `names` / `conjuncts` until a named variable joins it.

* `compareTerm: (a, b) => boolean` becomes `meetPins: (a, b) => { pin, pending: [number, number][] } | false`
  — equal / contradiction / **decompose**. `ClusterSolver` passes
  `(a, b) => a.equals(b) ? { pin: a, pending: [] } : false` and is otherwise unaffected.
* Drain `pending` through a **work list**, never recursion: merging children can merge further
  children, and re-entering `mergeGroups` from inside `migrateGroupData` corrupts the caller's state.
* `carriesInformation(group)` must also be true when the group **is a child of a live pin**. Otherwise
  `remove()` drops a group a pin still points at and the child id dangles. This is the sharpest trap in
  the change.
* **Occurs check**: pinning `g` to a shape reachable from `g`, or a merge that closes a cycle in the
  child DAG, is a contradiction (`false`). Without it, resolving a group to a term does not terminate.

### D4 — anchors and derived variable names

Each group has one canonical **anchor**, memoised per group:

```
anchor(g) = its term pin, else its lexicographically first named member,
            else the lexicographically first access path reaching it from a named group
```

Use it for *everything*: the accessor form written into a condition, the representative a clique
substitutes to, and the name of a materialised position. A group reachable two ways (`?x` and
`object(?o)`; an anonymous child of two shapes) must render identically everywhere.

A materialised position is named `${anchor}_${s|p|o}`, with a numeric suffix **only** on collision
(`?x_s`, then `?x_s0`). The taken set is collected **once from the whole query before the pass runs**
(`collectVariableNames` in `lib/utils.ts`, as `removeProjections` does). Keep the memo in one
pass-scoped map keyed by `${anchor(g)}_${p}`, threaded as a per-pass context so
`assertionConjunction.ts` stays context-free — `patternSubstitution(namer)` takes it as an argument.

Two materialisation sites of the same group **must** produce the same name: that is how the LHS and RHS
of a join keep joining on a position after both were substituted. It is sound because the position is
functionally determined by the variable they already joined on. Do **not** use `freshVarGenerator` —
its sequential naming depends on call order. Add a `derivedVarNamer(existing)` sibling in
`lib/utils.ts`.

### D5 — `vRanges`, a third `CPMeta` field

`withCpVars` also computes `vRanges: Map<string, RangeSet>` — the term types each variable can take —
with a missing entry meaning "any type" (`objectRange` is the top of the lattice).

| operation | rule |
|---|---|
| PATTERN | per position, intersected over every occurrence, recursing into triple terms with the nested positions; a graph variable is an IRI |
| BGP | intersect per variable over patterns |
| PATH | endpoints `objectRange` (a path may start at a literal), graph as above |
| JOIN | **intersect** per variable over the operands that possibly bind it |
| UNION | **union** per variable over the branches |
| LEFT JOIN | left's range for what the left binds; right's for right-only variables |
| MINUS | left's |
| VALUES | the term types actually present in the column |
| EXTEND | input's, plus the target: a term expression gives its own type, a triple-term construction `{Quad}`, anything else top |
| FILTER, PROJECT, DISTINCT, REDUCED, SLICE, ORDER BY, FROM | pass through |
| GRAPH | input's, plus `?g` → IRI |
| SERVICE, GROUP aggregates | top |

Note the inversion against `cVars`: **UNION unions where `cVars` intersects, JOIN intersects where
`cVars` unions.** Easy to get backwards; write the reason down.

This buys three things:

1. `BIND(<<( c₁ c₂ c₃ )>> AS ?o)` is certainly bound when every `cᵢ` is bound and
   `range(c₁) ⊆ {NamedNode, BlankNode}`, `range(c₂) ⊆ {NamedNode}` — i.e. the construction cannot
   error. Without this the re-binding the pass emits drops `?o` out of `cVars` and degrades every later
   assertion about it. A *ground* well-formed triple term is admitted outright, which also settles the
   TODO at `assertions.ts:106`.
2. `normalisedFor(cVars, pVars, vRanges)` intersects the plan range into each group's range and returns
   `undefined` when a group empties or no longer admits its pin. New emptiness rule for the *existing*
   forms too: `?s ?p ?o FILTER(sameTerm(?s, "lit"))` is empty, today only noticed at the BGP.
3. Together with the group-level range (lift `groupToRange` down from `ClusterSolver.ts:43` into the
   shared base), it confines nesting to the `object` chain: a `triple` pin on a subject or predicate
   child is an immediate contradiction.

### D6 — metadata

* `pVars` may grow by derived variables. That is fine: a licence is always about a name in Θ, Θ only
  ever holds query variables, and a derived name is never written into a condition, so no licence is
  ever about one.
* **Clear metadata on the way out**: `return withoutCpVars(result)` at the end of `pushDownAssertions`,
  mirroring the `withoutCpVars(op)` on the way in. Do **not** drop metadata inside
  `mapOperationPreOrder` — `keepMetadata` (`pushDownAssertions.ts:102`) is how `assertionFilter` hands
  a conjunction to the `pushFilter` that meets it, and how `reTransform: true` keeps its work.

## Soundness rules you must not break

**S1 — the accessor form is a filter conjunct, not an expression.** `sameTerm(subject(?o), ?s)` and
`sameTerm(?o, TRIPLE(?s, ?p, ?q))` differ for a bound non-triple `?o`: the first errors, the second is
`false`. They agree *as conjuncts of a FILTER*, which identifies error with `false` — the same
identification the pass already makes. So Θ may only ever be placed as a filter condition (or as a
disjunct under `!bound(root) ||`, where `false || error = error` still drops the row).

**S2 — never serialise a shape as `sameTerm(?o, <<( … )>>)`.** The derived variables are unbound
wherever the filter sits, so the condition would error and drop every row. `toExpression` emits, per
shape-pinned group: `isTRIPLE(anchor)` when no position is informative, otherwise one
`sameTerm(position(anchor), …)` per informative position (which already entails `isTRIPLE`).

**S3 — never substitute an open shape into an expression.** Split `strongSubstitution()` into
`patternSubstitution(namer)` (materialises shapes, used by BGP/PATH/re-binding) and
`expressionSubstitution()` (ground pins and clique representatives only, used by `collectAssertions`,
`pushIntoExtend`, `pushIntoLeftJoin`). A fully ground shape may substitute anywhere.

**S4 — a conjunct weakens iff it mentions exactly one variable.** `!bound(?o) || sameTerm(subject(?o), :a)`
and `!bound(?o) || isTRIPLE(?o)` are fine; `sameTerm(subject(?o), ?s)` is a clique edge and does not
weaken. `weakenedConjunct` keeps its current shape, reading `conjunctVars(conjunct).length === 1`.
Same generalisation for `weakenedTerms` (the MINUS RHS): its argument turns on the two sides agreeing
on the value, and equal values have equal subjects, so any *unary* predicate on the value is admissible.

**S5 — a strong shape implies `bound` of its root and of every named child**, transitively.
`boundImpliedBy` must reflect that; it is what collapses an OPTIONAL over a structurally asserted
variable into a join.

**S6 — a shape that cannot travel whole may travel weakened down the pin lattice.** A target licensed
for `?o` but not for `?s` still gets `T⟨?o⟩`. This is the shape analogue of `splitClique` giving a
target `B⟨?x⟩` when it cannot take an edge.

**S7 — the accessor folds are what make the pass idempotent.** In
`partialExpressionEvaluation.ts`, fold `subject/predicate/object` against a known shape and against a
literal quad term expression, fold `istriple`, fold `triple(a,b,c)` of three constants. Without them,
the residual of the very filter that produced the assertion never folds to `true` and re-running the
pass stacks a second copy. The substitution argument becomes a view (`resolve(access)`,
`isTriple(access)`) rather than a bare `Map`.

## Per-operation work in `pushDownAssertions.ts`

| operation | change |
|---|---|
| BGP / PATH | `patternSubstitution`; `bindAssertedTerms` gains the quad case. `canOccupy` already refuses a quad outside object position. |
| VALUES | prune *rows* by asserting the row into a clone of Θ (a ground triple-term value decomposes against a shape by itself); drop a *column* iff Θ can rebuild its value from the columns that survive. Worked examples in `report.md` §4. Whether you rewrite the per-variable `switch` or extend it is **your call** — keep the existing evaluation tests green. |
| UNION, PROJECT, DISTINCT, REDUCED, ORDER BY, FROM, FILTER, GROUP | nothing beyond D1 |
| GRAPH | a shape pin on `?g` is a contradiction (graph names are IRIs) |
| JOIN / LEFT JOIN | licences already read `conjunctVars`; generalise `splitClique` to groups and add S6 |
| MINUS | `weakenedTerms` per S4 |
| EXTEND | `transferred` gains: `BIND(<<( ?a ?b ?c )>> AS ?o)` under a shape on `?o` transfers onto `?a ?b ?c`; `BIND(subject(?o) AS ?x)` transfers onto the access. This is the `TODO(next time)` at `pushDownAssertions.ts:455`. |

Also recognise `FILTER(sameTerm(?o, <<( ?a ?b ?c )>>))` and `FILTER(isTRIPLE(?o))` as assertions. The
first is written back in accessor form, so it does not round-trip verbatim — that is accepted (S1).

## Work plan (one commit each, one PR)

0. `vRanges` in `CPMeta` + the metadata clearing of D6. Independent of triple terms; testable alone.
1. Ground triple terms: `isAssertableTerm` admits ground quads, `sameTerm` folds between two of them,
   `withCpVars` calls a ground triple-term BIND certain. Works with the existing machinery.
2. The pin lattice (D3). Unit-testable at the data-structure level.
3. Accesses and `T⟨?x⟩` (D1, D2), recognisers, `toExpression`, the folds of S7. At the end of this
   commit Θ round-trips through a condition; nothing is written into patterns yet.
4. Materialisation: D4, `patternSubstitution`, `bindAssertedTerms`. The target example works here.
5. The operation rules in the table above.
6. Follow-up, optional: `ClusterSolver` drops the `Quad` exclusion from `RawBasicTerm` and resolves its
   TODO at line 191 — the mapping head `?t rdf:reifies <<( ?s ?p ?o )>>` against a pattern binding a
   triple term is the same unification problem.

## Tests

Extend the three layers that already exist; keep every current test green (204 passing today).

* `test/assertionConjunction.test.ts` — decomposition (`?o ≡ <<( ?a ?b ?c )>>` asserted twice),
  congruence (unify `?o` with `?x`, then read a child of `?x`), ground-meets-shape, the occurs check,
  `T⟨?x⟩` absorption, and `conditionOf` round-trips for every new form. The existing `conditionOf`
  helper serialises Θ through the generator, which is exactly the check that S2 holds.
* `test/pushDownAssertions.test.ts` — the target example; the chained case
  (`sameTerm(?x, object(?o)) && sameTerm(?s, predicate(?x))`, see `report.md` §4); and the two
  meta-tests that already exist and must keep passing: *"applying the transformation twice yields the
  same result as once"* and *"leaves the input tree untouched"*.
* the `semantic equivalence (evaluation)` block — the real safety net. Add triple-term data to
  `test/statics/assertionPushdown.ttl` and cover: a shape pushed weakly into a join operand that never
  binds the variable; a shape over a VALUES with an UNDEF column; a shape on the RHS of a MINUS; a
  shape under an OPTIONAL that the implied `bound` collapses into a join; and a query where the
  asserted variable is bound to something that is *not* a triple term, which must return nothing rather
  than erroring.

### Environment facts (verified, do not re-derive)

* traqula generates **and re-parses** both `?s ?p <<( ?s ?o_p ?o_o )>>` and
  `BIND(<<( ?s ?o_p ?o_o )>> AS ?o)`; `SUBJECT(…)` round-trips as the `subject` operator. No
  parser/generator work is needed.
* On `@comunica/query-sparql-file@5.3` (upgraded for this) and `n3@2`: Turtle `<<( … )>>` parses to a
  `Quad`; triple-term patterns, `SUBJECT`, `isTRIPLE` and `<<( ?s ?p ?o )>>` in a `BIND` all evaluate;
  an accessor on a non-triple or unbound argument errors into `false` so the row is dropped; an
  ill-typed construction leaves its target unbound as the spec requires.

## Out of scope

* Propagating assertions into the pattern of an `EXISTS` (pre-existing TODO).
* Pushing into `SERVICE` (deliberate barrier) or through `SLICE`.
* Generalising `sameTerm` recognition to `=` — see the warning at `asStrongAssertion`.
* Any depth cap on nesting. Chains are bounded by the number of groups and the occurs check handles the
  rest.

## Conventions

* `yarn` (v1). The pre-commit hook runs build + `eslint .` + the full suite; all three must pass.
* Never weaken an existing invariant silently. If a rewrite you add cannot preserve `pVars` exactly or
  cannot avoid shrinking `cVars`, say so in the commit message and in the doc comment.
* If you find that a decision in this file is wrong, stop and report it rather than working around it —
  most of them are load-bearing for soundness, not style.
