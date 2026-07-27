# Review — branch `refactor-to-one-mapping`

Reviewed `main...HEAD` (12 commits, base `5a70911`) plus the uncommitted working tree.
26 files changed, ~3.8k insertions / ~3.3k deletions.

**What the branch does.** It drops the bespoke "template" term model (`TemplateIri`,
`TemplateLiteral`, `TemplateBlank`, `TemplateQuad` in `lib/types.ts`) and makes a mapping head a
plain algebra `Pattern` whose object may nest a triple term. Everything a template used to express
is now ordinary SPARQL algebra: positional accessors (`SUBJECT`/`PREDICATE`/`OBJECT`) as expressions,
`sameTerm` filters for unification, and BINDs for construction. `ClusterSolver` was split so the
union–find part lives in `datastructures/ClusterSet.ts`, and two new passes were added
(`pushDownRestrictors`, `joinValuesToFilter`) with their own test files.

The direction is good: the pure-algebra representation removes a whole parallel term language, and
the two new passes are the best-documented code in the repo (each equivalence is tied to a numbered
rule from Schmidt et al.). The concerns below are mostly about the rewriting core, where the
simplification lost a correctness step, and about repository hygiene.

**Baseline state when I started:** `yarn test` 66 passed / 1 skipped, `yarn lint` clean,
`yarn build:ts` clean.

---

## 1. Blocking

### 1.1 A triple-term pattern matches plain triples — pattern variables come back unbound *(fixed)*

`rewriteSinglePattern` binds every variable inside a user-query triple term through a positional
accessor over a mapping variable, e.g. `BIND(SUBJECT(?m_o) AS ?uq_a)`. In SPARQL a BIND whose
expression *errors* leaves the target variable unbound but **keeps the solution**. `SUBJECT(x)` errors
whenever `x` is not a triple term, so a mapping that yields no triple term at all still produced a
match. This is exactly step 2.5 of the README ("`B' = FILTER(B')` assert the triple term vars are
assigned"), which was not implemented anywhere in `lib/`.

Reproduction (before the fix), mapping `CONSTRUCT WHERE { ?s ?p ?o }`, query
`SELECT * { ?x ?p1 <<( ?a ?b ?d )>> }`:

```sparql
SELECT ( SUBJECT( ?p0_mi_o ) AS ?uq_a ) ( PREDICATE( ?p0_mi_o ) AS ?uq_b )
       ( OBJECT( ?p0_mi_o ) AS ?uq_d ) ( ?p0_mi_s AS ?uq_x )
WHERE { ?p0_mi_s ?p0_mi_p ?p0_mi_o . }
```

Executed over `test/statics/multipleRdfReifiedTriples.ttl` (RDF 1.1, no triple terms) this returns
**21 rows** with `?a ?b ?d` unbound; the correct answer is **0 rows**. In a BGP those unbound
variables then join with anything.

The existing tests missed it because every triple-term test fixes the predicate to `rdf:reifies`,
which the pass-through mapping can never satisfy — the erroring branch is filtered out by accident.

**Fix applied** (`lib/transformations/rewriteSinglePattern.ts`): `bindEvaluationGuards` derives, for
each pattern bind, the condition under which it evaluates to a term, and adds it as a FILTER —
`FILTER(ISTRIPLE(?m_o))`, recursively for nested triple terms. Duplicates are removed (one mapping
variable feeds several binds) and the guard argument is copied so it does not alias the bind
expression. `ISTRIPLE` also rejects an unbound argument (it errors, so the FILTER is false), so no
separate `BOUND` check is emitted.

**Placement matters** — see 1.2. The guards are added *below* the BINDs, over the mapping body.

Regression test added in `test/integration.test.ts`: "a triple term pattern with a variable predicate
does not match plain triples" (evaluation-based, compares rewriter output against the same query run
on the RDF 1.2-mapped store). It fails on the pre-fix code and passes after.

### 1.2 `removeProjections` turns a FILTER inside an OPTIONAL into a LEFT JOIN condition

Discovered while placing the guard above; it is a pre-existing property of `removeProjections`, not
caused by 1.1.

Per SPARQL §18.2.2.2, translating `OPTIONAL { P FILTER(F) }` lifts `F` into the LEFT JOIN condition:
`LeftJoin(G, P, F)`. While each rewritten pattern is wrapped in a subselect that barrier does not
exist, but `removeProjections` strips exactly that barrier. My first attempt at 1.1 put
`FILTER(BOUND(?uq_x))` *above* the BINDs; with `removeProjections` in the pipeline the StarBench
S-category test went from 3 rows to 9 (the OPTIONAL degenerated into a cross product — comunica
stops joining on `?uq_t` once the left join carries a condition). The two forms are equivalent on
paper here, so this is an engine-level discrepancy, but the rewriting should not depend on that.

Not fixed, worth a follow-up: **any** FILTER that ends up at the top of a rewritten pattern is
exposed to this once projections are removed. The invariant to keep (and ideally to assert in
`removeProjections`) is that a rewritten pattern's root stays an EXTEND.

### 1.3 `removeProjections` threw on a subquery with DISTINCT / REDUCED *(fixed)*

```text
queryTransform(c, 'SELECT * WHERE { { SELECT DISTINCT ?s WHERE { ?s ?p ?o } } }', [ removeProjections ])
// Error: Unknown Operation type bgp   (thrown from toAst)
```

A sub-`SELECT DISTINCT` is `Distinct(Project(...))`. Removing the Project leaves `Distinct(bgp)`,
which `toAst` cannot serialise — and even if it could, the DISTINCT would now deduplicate over the
anonymised variables, changing the result. The aggregate case (`Project(Extend(Group(...)))`) is
fine; I verified it round-trips and evaluates identically.

**Fix applied**: a projection directly below a DISTINCT or REDUCED is kept as is. `mapOperation`
rewrites bottom-up, so the parent is not known when the projection is transformed; a `preVisitor` on
the DISTINCT / REDUCED node records its projected input (top-down, on the *original* node) and the
PROJECT transform returns untouched what that set contains.

New `test/removeProjections.test.ts` covers it: sub-`SELECT DISTINCT` and sub-`SELECT REDUCED` keep
their projection, hidden variables of an ordinary subselect are still anonymised, and three
evaluation tests assert the transformed query returns the same bindings as the original. The three
DISTINCT/REDUCED tests fail on the pre-fix code (two with `Error: Unknown Operation type bgp`).

---

## 2. Should fix

### 2.1 Pattern unification used `=` instead of `sameTerm` *(fixed)*

`collectTriplePatternBinds` emitted `AF.createOperatorExpression('=', ...)` when a pattern variable
was already bound and picked up a second constraint, while every other unification constraint in the
file uses `sameTerm`. Triple pattern matching is term equality: `"1"^^xsd:integer` and
`"1.0"^^xsd:decimal` are `=` but never match the same pattern, so `=` admits false matches. Changed
to `sameTerm`, which also matches the branch's own direction (commit `e069c38` "all is filter
sameTerm"). One expectation updated (`test/rewriting.test.ts:51`).

### 2.2 `ClusterSolver.mergeGroups` dropped the merged group's expressions *(fixed)*

```text
this.groupToRange[newGroup] = ...;   // ranges merged
if (oldTerm) { this.registerTermToGroup(newGroup, oldTerm); }   // term merged
// groupToExpressions[oldGroup] silently discarded, and no `return res`
```

`groupToExpressions[oldGroup]` was never carried over, so any expression constraint on the absorbed
group became unreachable (`getExpressions` looks up by the variable's current group). The declared
return value `{ oldGroup, newGroup } | undefined` was also never returned on the merge path, so a
caller could not distinguish "merged" from "already in the same group".

I traced the traversal order in `iterateMappingHead` and believe the drop is currently
**unreachable** — expressions are only registered in the object position, which is processed last at
every level, so no merge follows. It is one traversal-order change away from being a live bug, so I
fixed it (merge expressions, delete the stale group entries, return `res`) rather than documenting
it.

### 2.3 `freshVarGenerator` produced double-underscore names on collision *(fixed)*

```text
let name = `${prefix}${index}`;
while (taken.has(name)) { index += 1; name = `${prefix}_${index}`; }   // note the extra `_`
```

With the default prefix `v_` a collision yielded `v__1`, not the documented `v_1`. Names stayed
unique, so only the naming (and the doc example) was wrong. Fixed to use `${prefix}${index}`.

### 2.4 `traqula/` is an untracked vendored monorepo that `package.json` now depends on

The branch adds

```text
"workspaces": [ "traqula/engines/*", "traqula/packages/*" ]
```

but `traqula/` is neither committed nor in `.gitignore`. Two consequences:

* A clone of this branch has a `workspaces` config pointing at directories that do not exist.
* Where the directory *does* exist, the next `yarn install` links those workspace packages over the
  published `@traqula/*` dependencies (`traqula/packages/algebra-transformations-1-1` is `1.1.8`,
  which satisfies the `^1.0.4` range), so local results silently diverge from CI. Right now
  `node_modules/@traqula/*` are still the published copies — the install predates the change — so
  this has not bitten yet.
* `traqula/` is not ignored, so `git add -A` would commit an entire second monorepo *including its
  `node_modules`*.

Decide one way: ignore it and drop the `workspaces` field (local dev via `yarn link`/`resolutions`),
or add it as a git submodule. I did not change this — which of the two you want is your call.
I confirmed the branch does **not** need unreleased traqula code: `certainlyBoundVariables`'s
`extendBinds` option, which `joinValuesToFilter` relies on, exists in the published `1.0.4`.

### 2.5 Public entry point does not match the documented API

`lib/index.ts` only re-exports `./transformations/index.js`. Everything the README's "API Reference"
table lists — `transformContextFromConstructs`, `queryTransform`, `operationTransform`,
`rewriteNonRecursivePaths`, `internalBnodeAsSpecialLiteral`, `internalBnodeAsSpecialIri` — is
unreachable from the package entry point, including the example inside `lib/index.ts`'s own docblock.
The tests import from `../lib/transformBgp.js` directly, so nothing catches this. The README also
still describes `collapseDuplicateExtends` and `rewriteToSingleVar` (step 3), which no longer exist.

---

## 3. Observations, no change made

* **`rewriteSinglePattern` is only safe when the caller renames.** It reuses `mapping.body.input`
  by reference and coins fixed internal names (`m_s`, `mi_*`, `mExists`). Only
  `rewritePatternWithUniqueScope` makes those per-pattern unique, and only `renameVariables` (via
  `astTransformer.transformObject`, which copies every node) breaks the aliasing with the shared
  mapping body. Yet `rewriteSinglePattern` is the one rewriting function exported from
  `transformations/index.ts`. Calling it twice directly yields two subtrees that alias the mapping
  body, and later passes mutate algebra in place. Either export the safe wrapper instead, or copy
  the body inside `rewriteSinglePattern`.
* **`iterateMappingHead` mutates its inputs.** `headTerm.range = ...` / `patternTerm.range = ...`
  write a non-standard `range` property onto the mapping head's and user query's variable objects,
  and `collectMappingHeadBindsAndFilters` then puts those same objects into generated expressions.
  It is harmless today (positions are stable, and the renaming pass replaces them with clean
  `DF.variable`s), but a ranged variable leaking into output algebra is a sharp edge.
* **Head variables in the pattern-quad branch never enter `mHVars`.** In the
  `isRdfQuad(patternTerm) && isRdfVar(headTerm)` branch the head variable is neither recorded nor
  ranged, unlike every other branch. No constraint is lost today (the missing one was 1.1, now
  guarded), but the asymmetry is worth a comment.
* **Prefix-string coupling.** Three conventions are load-bearing and only enforced by string
  literals: `uq_` (user query), `mi_`/`m_` (mapping), `p{i}_` (per pattern).
  `collectMappingHeadBindsAndFilters` filters with `startsWith('uq')` (not `'uq_'`), and
  `sortClusters` relies on `localeCompare` putting `m…` before `uq…` while its comment claims to
  sort mapping variables first explicitly. A single `isMappingVar`/`isUserVar` helper would make the
  invariant checkable.
* **`pushDownRestrictors`:** `distributeJoinOverUnion` is exponential by construction (a JOIN of *k*
  UNIONs of *n* branches yields *n^k* branches) — fine for the small joins the rewriter produces, but
  worth a guard before running on user BGPs. Also, after a conjunct is pushed into a JOIN operand,
  `pushFilterThroughJoin` does not recurse into that operand, so a filter never sinks past the first
  join it enters. *(Fixed here: the duplicated `remaining.length === conjuncts.length` branch, which
  was identical to the fall-through.)*
* **`joinValuesToFilter`** reads correctly, including the tricky parts (only certainly-bound columns
  extracted, residual VALUES preserving row multiplicity, contradicting VALUES collapsing to
  `FILTER(FALSE)`). A zero-row VALUES (an empty result) is not recognised as `FILTER(FALSE)` — minor.
* **`test/boundVariables.test.ts` tests a dependency**, `algebraUtils.certainlyBoundVariables`, not
  this repo's code. Useful as a characterisation of the assumption `joinValuesToFilter` leans on, but
  it belongs upstream in traqula.
* **Dead code from the template removal:** `AlgebraTemplateFactory` is now an empty subclass of
  `AlgebraFactory`; `optimizeTemplateArray`, `toRangeVar`, `isTyped`, `isRdfDefaultGraph` (all in
  `lib/utils.ts`) have no callers; `serviceCallMerge.ts` has none either;
  `transformations/pruneRestrictions.ts` is a comment-only stub. Left in place — some of it is
  clearly a design note for the next step.
* **Coverage reports 0% for everything** (pre-existing): `vitest.config.ts` includes `lib/**/*.js`
  while the sources are `.ts`.
* **`.devcontainer/` was deleted** on this branch with no mention in a commit message — intentional?
* **Hygiene before merge:** the history is 12 WIP commits ("WIP: I dont even know enymore"), and the
  working tree carried an uncommitted change (adding `removeProjections` to the integration
  pipeline). Squash, and fix a few typos in comments carried over into the new code: "varalues",
  "aacount", "cluter" (`rewriteSinglePattern.ts`), "behavioir" (`pruneRestrictions.ts`), "amound"
  (README).

---

## 4. Changes applied

| File | Change |
|---|---|
| `lib/transformations/rewriteSinglePattern.ts` | `bindEvaluationGuards` + `ISTRIPLE` guards (1.1); `=` → `sameTerm` (2.1) |
| `lib/transformations/removeProjections.ts` | keep the projection below a DISTINCT / REDUCED (1.3) |
| `lib/ClusterSolver.ts` | merge `groupToExpressions`, drop stale group entries, return the merge result (2.2) |
| `lib/utils.ts` | `freshVarGenerator` collision naming (2.3) |
| `lib/transformations/pushDownRestrictors.ts` | removed the duplicated residual-filter branch |
| `test/integration.test.ts` | regression test for 1.1 |
| `test/removeProjections.test.ts` | new — DISTINCT / REDUCED handling plus evaluation equivalence (1.3) |
| `test/queryConsts.ts`, `test/rewriting.test.ts` | expectations updated — the only semantic deltas are one added `FILTER ( ISTRIPLE( ?p0_m_o ) )` per expectation and one `=` → `SAMETERM` |

Verified after the changes: `yarn test` 73 passed / 1 skipped, no type errors; `yarn lint` clean;
`yarn build:ts` clean. Both new test groups were confirmed to fail against the pre-fix code.
