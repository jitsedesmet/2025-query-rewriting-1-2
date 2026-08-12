# Triple terms in `AssertionConjunction` — design study

```sparql
SELECT * { ?s ?p ?o FILTER(sameTerm(subject(?o), ?s)) }
-- becomes
SELECT * { ?s ?p <<( ?s ?o_p ?o_o )>> . BIND(<<( ?s ?o_p ?o_o )>> AS ?o) }
```

Verified against the installed traqula: both the pattern and the `BIND` generate and re-parse exactly,
so no parser/generator work is needed.

## 1. Design (settled)

**Conjuncts are about an *access*, not a variable.** An access is a variable read through a chain of
accessors: `?x`, `subject(?x)`, `object(subject(?x))`. `AssertionConjunct` becomes
`{ access, assertion }`, the RHS of a strong/weak assertion becomes `Access | RDF.Term`, and A/W/B/U
all keep their meaning. `U`/`B` stay restricted to accesses of length 0 (`BOUND` takes a `Var`).

**One new form: `T⟨?x⟩ ≔ isTRIPLE(?x)`** — the degenerate shape, "a triple term, nothing known about
its parts". Implies bound, has a weak form, absorbed by anything stronger.

**Groups get a pin lattice.** `TermClusterSet`'s `groupToTerm` becomes
`{kind:'term', term} | {kind:'triple', children:[groupId × 3]}`. `compareTerm` (equal / contradiction)
becomes `meetPins` (equal / contradiction / **decompose into child unifications**). That is syntactic
unification, and it gives the #30 interop for free: the shape sits on the *group*, so unifying `?o`
with `?x` makes everything known about `subject(?o)` known about `subject(?x)`.

**Unconstrained positions are anonymous groups**, not fresh variables. Keeps `size`/`names`/`order`
clean, and lets a shape be serialised without naming what it does not know.

**Serialising Θ never coins a variable.** A shape writes back as `isTRIPLE(?o)` plus one
`sameTerm(position(?o), …)` per informative position — the form it was read from, so the pass stays
idempotent. Writing `sameTerm(?o, <<( ?s ?o_p ?o_o )>>)` instead would be a wrong-answer bug: the
derived variables are unbound wherever the filter sits, so the condition would error and drop
everything.

**Variables are coined only when writing into a pattern**, named `${anchor}_${s|p|o}` against the
whole query's pre-transformation variable list, suffixed only on collision. The anchor is the
*group's* canonical name (term pin → first named member → shortest access path), memoised per group in
one pass-scoped map — so two materialisation sites of the same group agree and both operands of a join
still join on the position.

**The weak/strong line is unchanged**, restated: *a conjunct mentioning one variable has a weak form,
one mentioning two does not*. `!bound(?o) || sameTerm(subject(?o), :a)` is fine;
`sameTerm(subject(?o), ?s)` is a clique edge and travels as `T⟨?o⟩` where the edge cannot go.

**Shapes substitute into patterns, never into expressions** — an open shape in an expression would
mention unbound derived variables. `strongSubstitution()` splits into `patternSubstitution(namer)` and
`expressionSubstitution()` (ground pins and clique representatives only).

**Occurs check.** `?o ≡ <<( ?o … )>>` is unsatisfiable → empty operation. Also the termination
argument for resolving a group to a term.

**Ranges, in two places that meet in `normalisedFor`.** On the group (`groupToRange`, lifted down from
`ClusterSolver`) and on the operation (`vRanges`, a third `CPMeta` field: the term types a variable can
take, unioned over UNION branches, intersected over JOIN operands). This is what makes nesting run
only down the `object` chain, and it gives emptiness rules for the *existing* forms too
(`?s ?p ?o FILTER(sameTerm(?s, "lit"))`).

**`pVars` may grow by derived variables; metadata is cleared on the way out** (`withoutCpVars(result)`
at the end of the pass — not inside `mapOperationPreOrder`, whose `keepMetadata` is load-bearing
during the traversal). Safe to read stale-but-grown metadata mid-pass: a derived name never enters Θ,
so no licence is ever about one.

**`BIND(<<( … )>> AS ?o)` keeps `?o` in `cVars`** via `vRanges`: the construction cannot error when
every component is bound and `range(c₁) ⊆ {IRI, bnode}`, `range(c₂) ⊆ {IRI}`. Ground triple terms are
admitted outright, which also settles the `isAssertableTerm` TODO (`assertions.ts:106`).

## 2. Files

| file | change |
|---|---|
| `datastructures/TermClusterSet.ts` | pin lattice, `meetPins`, work-list merge, occurs check, `carriesInformation` must count child references (else a pin dangles) |
| `utils/assertions.ts` | `Access`; recognisers for `subject/predicate/object` equalities and `istriple`; accessor builders; `isAssertableTerm` admits ground quads |
| `utils/assertionConjunction.ts` | conjuncts over accesses, path walking in `assert`, `toExpression`, the two substitutions, `boundImpliedBy` covers named children |
| `utils/partialExpressionEvaluation.ts` | substitution argument becomes a view (`resolve`, `isTriple`); fold accessors and `istriple` — without this the filter's own residual never folds and the pass is not idempotent |
| `utils/certainlyBoundVars.ts` | `vRanges` + the EXTEND rule |
| `transformations/pushDownAssertions.ts` | pattern substitution + namer, `pruneValues`, `transferred` through triple-term/accessor BINDs, metadata strip |
| `ClusterSolver.ts` | follow-up: drop the `Quad` exclusion, resolve its TODO at line 191 |

## 3. Phasing (commits, all in this PR)

0. `vRanges` in `CPMeta` + metadata clearing — independent of triple terms, useful on its own.
1. Ground triple terms — `isAssertableTerm`, ground `sameTerm` folding. Works with existing machinery.
2. Pin lattice — data-structure level, unit-testable alone.
3. Accesses + `T⟨?x⟩` — Θ round-trips through a condition; nothing written into patterns yet.
4. Materialisation — namer, `patternSubstitution`, `bindAssertedTerms`. Target example works here.
5. Operation rules — `pruneValues`, EXTEND transfer (`BIND(<<( ?a ?b ?c )>> AS ?o)` and
   `BIND(subject(?o) AS ?x)`, the `TODO(next time)` at `pushDownAssertions.ts:455`), shape-weakening in
   `splitClique`, the GRAPH and MINUS cases.

**Evaluation harness — checked** on `n3@2` and `@comunica/query-sparql-file@5.3` (upgraded from 5.1.3
for this). Turtle `<<( :a :b :c )>>` parses to a `Quad` object; triple-term patterns with variables,
`SUBJECT(…)`, `isTRIPLE(…)` and `<<( ?s ?p ?o )>>` in a `BIND` all evaluate; an accessor on a
non-triple or unbound argument errors into `false`, so the row is dropped rather than the query
throwing, including under the weak form `!bound(?o) || sameTerm(SUBJECT(?o), :a)`; and an ill-typed
construction (`<<( ?o ?p ?s )>>` with a literal `?o`) leaves the target unbound as the spec requires —
5.1.3 built a generalised quad instead, which is why the version moved.

## 4. Decisions

**Scope: all of it, in this PR.** `vRanges` included; EXTEND transfer included (a pushdown *through*
the BIND is what lets a shape keep travelling, so leaving it out would cut the feature short); every
operation rule that is in the context of a triple-term assertion is in scope. The phases above are
commit boundaries, not PR boundaries.

**`FILTER(sameTerm(?o, <<( ?a ?b ?c )>>))` is recognised**, and written back in accessor form. The two
are equivalent as filter conjuncts (they differ only in error vs `false`, which a FILTER identifies),
so this is the same kind of non-verbatim round-trip the pass already does for the other forms.

**VALUES pruning** — prune *rows* by asserting the row into a clone of Θ (uniform over terms, cliques
and shapes: a ground triple-term value decomposes against a shape by itself); drop a *column* iff Θ can
rebuild its value from the columns that survive. That last condition is the general form of what the
code does today, and it is where the shape case differs from the strong-term case:

```sparql
VALUES (?o ?s) { (<<( :a :b :c )>> :a) (<<( :d :e :f )>> :d) }   FILTER(sameTerm(subject(?o), ?s))
```

keeps both rows, with *different* `?o` — there is no single term to re-bind, so the column stays. But

```sparql
VALUES (?o ?s ?p ?x) { … }   FILTER(sameTerm(?o, <<( ?s ?p ?x )>>))
```

does drop `?o` and re-bind it from the three surviving columns. Whether that is reached by rewriting
the per-variable `switch` or by extending it is the implementor's call — the rewrite is more uniform,
the existing evaluation tests are the thing to keep green either way.
