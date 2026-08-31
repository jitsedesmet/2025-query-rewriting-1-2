# Agent task — implement `pullUpExtends`, phase 1

`report.md` is the design: it carries the *why*, the soundness arguments and the spec references, and
every `§n` below points into it. `task.md` is the original request. This file is the *what*, in the order
to do it.

**Ship phase 1 only.** Phases 2–4 of `report.md` §9 are listed under [Out of scope](#9-out-of-scope);
leave a `TODO` where the code touches one, do not implement it.

**The goal in one line.** `pushDownAssertions` leaves a `BIND` behind at every leaf it rewrites
(`bindAssertedTerms`); this pass floats those binds back up the plan and drops the ones nothing reads,
without changing the solution multiset or the `pVars`/`cVars` of the node each move is anchored at.

```sparql
SELECT * { { ?s ?p ?o . BIND(<ex://a> AS ?x) } { ?a ?b ?c } }
-- must become
SELECT * { ?s ?p ?o . ?a ?b ?c . BIND(<ex://a> AS ?x) }
```

## 0. Orientation — read these before writing anything

| File | What to take from it |
| --- | --- |
| `lib/transformations/pushDownAssertions.ts` | the mirror pass. Copy its shape: enter and leave through `withoutCpVars`, read licences off `CPMeta`, one `switch` over `Algebra.Types`, a file-level `@fileoverview` explaining the rules. Its `keepMetadata`/`PreOrderMappingReturn` machinery is pre-order only — you do **not** need it. |
| `lib/utils/certainlyBoundVars.ts` | `withCpVars`, `withoutCpVars`, `CPMeta { cVars, vRanges }`, `VRanges.neverBinds/canBind/rangeOf`, `termVars`. The `EXTEND` case is the definition of *certain* (§1). Note `withCpVars` **mutates** the node it is handed by caching `metadata` on it. |
| `lib/utils/expressionHelpers.ts` | `isStaticExpression` — the predicate you generalise (§2 below), plus `splitConjunction`, `booleanConstantOf`. |
| `lib/utils/partialExpressionEvaluation.ts` | `substituteInExpression(c, expr, view, cVars)` and the `AssertionView` shape you feed it (§4 below). |
| `lib/utils.ts` | `collectVariableNames(c.astTransformer, obj)`, `directExtensions`, `deleteVarExtensionsInPlace`. |
| `lib/transformations/pushUpBoundedFromUnion.ts` | the pass you **delete**; its `UNION` rule becomes one row of your table. |
| `test/pushDownAssertions.test.ts` | the test harness to mirror: `createPartialContext()`, `parseQuery`, `c.generator.generate(toAst(...)).trim()`. |

## 1. Deliverables

**New**

- `lib/utils/extendChain.ts` — peel/replant helpers (§2).
- `lib/transformations/pullUpExtends.ts` — the pass, exported as `pullUpExtends(c, op)`.
- `test/pullUpExtends.test.ts` — §8.

**Modified**

- `lib/utils/expressionHelpers.ts` — `isStaticExpression` → `isStableExpression`, plus `expressionsEqual`.
- `lib/utils.ts` — delete `deleteVarExtensionsInPlace` (its only caller is the deleted pass). Keep
  `directExtensions`: `nullifyJoinOverIncompatibleBounds` still calls it.
- `lib/transformations/index.ts` — export `pullUpExtends`, drop `pushUpBoundedFromUnion`, update the
  `@fileoverview` bullet list.
- `test/integration.test.ts` (`standardTransformations`) and `test/rewriting.bench.ts` (`withPushdown`)
  — add `pullUpExtends` in front of `removeProjections` (§7).
- `README.md` — the pipeline bullet list (~line 69) and the API table (~line 123) both name
  `pushUpBoundedFromUnion`; replace with `pullUpExtends`.

**Deleted**

- `lib/transformations/pushUpBoundedFromUnion.ts`. It is a public export, so this is a breaking change —
  `task.md` explicitly allows it.

## 2. `lib/utils/extendChain.ts`

```ts
/** One `BIND(expression AS variable)` lifted out of an EXTEND chain. */
export interface ChainBind {
  variable: RDF.Variable;
  expression: Algebra.Expression;
  /** `vars(e)`, cached: every licence reads it. */
  reads: Set<string>;
}

export interface PeeledChain { core: Algebra.Operation; binds: ChainBind[] }

/** Splits the maximal EXTEND chain at the top of `op` off its core. Binds come back in **evaluation
 * order**: `binds[0]` is the innermost one, the one closest to `core`. */
export function peelExtends(op: Algebra.Operation): PeeledChain;

/** The inverse: rebuilds `AF.createExtend` around `core`, `binds[0]` innermost. */
export function replantExtends(c: TransformContext, core: Algebra.Operation, binds: ChainBind[]): Algebra.Operation;
```

`peelExtends` stops at anything that is not `Algebra.Types.EXTEND`; `replantExtends(c, core, [])` is
`core`. Evaluation order (innermost first) is the order every ordering argument in this document is
written in — do not flip it.

**Predicates in `lib/utils/expressionHelpers.ts`:**

- `isStableExpression(c, expression): boolean` — `isStaticExpression` without its "no variables" clause.
  Same `visitOperationSub` walk, same rejections for `named`/`existence`/`aggregate`/`wildcard`, same
  operator blocklist **minus `now`**, which is stable by §17.4.5.1 (§1). Allowlist exactly one `named`:
  `EXTENSION_FUNCTION_BNODE` from `lib/consts.ts`. `isStaticExpression` has no callers today, so replace
  it rather than adding a second predicate; anything wanting the old meaning is
  `isStableExpression(c, e) && collectVariableNames(c.astTransformer, e).size === 0`.
- `expressionsEqual(a, b): boolean` — structural equality over `Algebra.Expression`, used by the merge
  and `UNION` rules. Recurse on `subType`, compare operators/names, compare terms with `.equals`, compare
  argument lists pairwise and in order. The algebra ships no such helper (`Canonicalizer` only renames
  blank nodes), so this is ours. Return `false` for `existence` rather than walking into a pattern.

Both need their own tests; every rule leans on them.

## 3. The pass — structure

```ts
export function pullUpExtends<T extends Algebra.Operation>(c: TransformContext, op: T): T {
  return withoutCpVars(algebraUtils.mapOperation<'unsafe', T>(withoutCpVars(op), {
    [Algebra.Types.JOIN]: { transform: node => hoistFromJoin(c, node) },
    ... one entry per operation of §4 ...
  }));
}
```

`mapOperation` is **post-order** — it works back up from the descendants — so by the time your callback
sees a node, each of its inputs already carries at the top of itself everything it could float. That is
the whole recursion: no custom traversal, no second pass, no fixpoint loop.

Per node, in this order:

1. **Peel.** `peelExtends` each input.
2. **Read the metadata**, off each input **as it was handed to you** (chain included), *before* rewriting
   anything: `withCpVars(input).metadata`. All licences read these. Never read metadata off a node you
   have already rebuilt.
3. **Classify** every bind of every input as *rise*, *stay* or *drop* using §4 and §5.
4. **Settle chain order** (§5, "Order"), which can only turn risers into stayers; iterate until stable.
5. **Rebuild the inputs**: `replantExtends(c, core_i, stayers_i)`.
6. **Rebuild the node** from those inputs, applying the rule's own edit — a struck `PROJECT` variable, a
   substituted `FILTER` condition, substituted `ORDER BY` expressions, a substituted `LEFT_JOIN`
   condition.
7. **Replant the risers above it**: `replantExtends(c, newNode, risers)`, risers keeping their original
   relative order; where several inputs contribute, order by input index, then by chain order; a merged
   bind (§4, `JOIN`) is emitted exactly once.
8. **Delete `metadata`** on every node you built or mutated in 5–7. Never let a stale `CPMeta` survive a
   rewrite — this is the likeliest source of a subtle bug, so give it a test (§8).

## 4. Per-bind decision

For a bind `?x := e` sitting on input `A` of node `op`, with `V = e.reads` and the other inputs `B`:

**Gate 0 — stability.** `isStableExpression(c, e)` or the bind stays. An expression holding an `EXISTS`
never floats in phase 1.

**(C1) no capture** — for every other input `B`: `B.vRanges.neverBinds(?x)`, unless `B` carries an
identical bind (merge). And `op` must not introduce `?x` itself: `GRAPH ?x`, an aggregate writing `?x`.
Read the ranges, never the key set: `?x` merely being *in scope* in `B` is fine, what the spec leaves
undefined is extending a μ that already **binds** `?x` (§2).

**(C2) same inputs** — for every `?y ∈ V`: `A.cVars.has(?y) || every other B: B.vRanges.neverBinds(?y)`.
Vacuous for a ground `e`, and vacuous for `UNION`/`MINUS`, which merge nothing.

**(C3) readers** — whatever the node reads must not see `?x`, or must have `e` substituted into it (§6).

| `Algebra.Types` | Phase-1 behaviour |
| --- | --- |
| `FILTER` | rise if the condition does not mention `?x`, or `e` is a term expression and substitutes in. A condition holding an `EXISTS` is a **barrier** — `TODO`, as in the pushdown. |
| `PROJECT` | `?x ∉ variables` → **drop**. Else rise when `V ⊆ variables`, striking `?x` from `variables` (so `pVars` at the swap is `(variables \ {?x}) ∪ {?x}` — unchanged — and the sub-`SELECT` carries no always-unbound column). |
| `GROUP` | **drop** when `?x` is neither a key, nor an aggregate's `variable`, nor read by any aggregate's `expression`. Otherwise a barrier. `aggregates` are `BoundAggregate`s: an `expression` over the input *beside* the `variable` they write — check both. |
| `DISTINCT`, `REDUCED` | rise, unconditionally. |
| `ORDER_BY` | rise; expressions must not mention `?x`, or substitute (§6). |
| `SLICE` | rise, unconditionally. |
| `FROM` | rise. |
| `GRAPH ?g` | rise when `?x ≠ ?g` and (`?g ∉ V` or `?g ∈ A.cVars`). |
| `JOIN` | rise under (C1)+(C2), **or** under the merge rule below. Cost gate applies. |
| `LEFT_JOIN` LHS | rise when `R.vRanges.neverBinds(?x)` (or `R` carries the identical bind) and (C2) holds; the condition is treated exactly like a `FILTER`. Cost gate applies. |
| `LEFT_JOIN` RHS | never. Not even a drop in phase 1. |
| `MINUS` LHS | rise when `R.vRanges.neverBinds(?x)`. (C2) is vacuous. |
| `MINUS` RHS | never rise. Drop when `L.vRanges.neverBinds(?x)`. |
| `UNION` | rise **only when every branch's chain carries the same bind**: same `?x`, `expressionsEqual` expressions, stable. Remove it from every branch and emit one above; the §5 order check has to pass in *every* branch, since the bind leaves each of those chains. No (C2) obligation. Subsumes `pushUpBoundedFromUnion`. |
| `SERVICE` | barrier. Add `// TODO(future): a non-SILENT service could release a bind` — `SILENT` turns endpoint failure into one empty solution, where a hoisted bind would still bind `?x`. |
| `EXTEND` | nothing to do: a chain is one unit and is handled by its parent. |
| `BGP`, `PATH`, `VALUES`, everything else | leaves / barriers, no callback needed. |

**Merge (`JOIN`).** Let `S` be the operands whose chain carries a structurally equal, stable
`?x := e`. If `V ⊆ O.cVars` for **every** `O ∈ S`, delete the bind from each of them and emit one above
the join; (C1) is still required of the operands *not* in `S`. At `|S| = 1` this is the ordinary hoist.
Do **not** merge when some carrier does not have all of `V` certainly bound.

**Cost gate.** Past a `JOIN` or `LEFT_JOIN`, a bind whose expression is not a term expression
(`ExpressionTypes.TERM`) rises **only** as part of a merge with `|S| ≥ 2`. A single carrier stays. Every
other row of the table is cardinality-non-increasing, so no gate there.

## 5. Order within a chain

Risers end up above the node, stayers below it, so a riser that stood **below** a stayer swaps with it.
Two binds may only swap when neither reads the other's variable:

- a **stayer** reading a riser's `?x`: substitute (§6) if `e` is a term expression, otherwise pin the
  riser (turn it into a stayer);
- a **riser** reading a stayer's `?y`: pin the riser, always. Above the node it would read `?y` bound
  where below it read it unbound.

Pinning can create new violations, so iterate until the partition is stable. It terminates: pinning only
moves binds from *rise* to *stay*.

## 6. Substituting `e` for `?x` in a reader

Only for a **term expression** `e` — never for any other stable expression, where the hoist blocks
instead (§3 of the report has the cost argument). Call:

```ts
substituteInExpression(c, condition, { resolve: acc => acc.positions.length === 0 && acc.name === x ? term : undefined,
                                       bound: certain ? new Set([ x ]) : new Set() }, cVars)
```

Two things must be decided **before** that call, not by it:

- if the reader contains `bound(?x)` and the bind is **not certain** (`?x ∉ cVars(Extend(A, ?x, e))`,
  which `withCpVars` already computes), block the hoist. The helper would otherwise emit the
  ungrammatical `bound(<ex://a>)`.
- if the reader contains an `EXISTS`/`NOT EXISTS`, block the hoist. The helper returns `EXISTENCE`
  arguments untouched, and substituting into a nested pattern is a `TODO` there too.

## 7. Wiring

The chain the tests and the benchmark run, with the new pass in front of its last step:

```
operationTransform → pushDownAssertions → transformFilterFalse
  → nullifyJoinOverIncompatibleBounds → nullifyUnbindableVars → transformFilterFalse
  → pullUpExtends → removeProjections
```

- after `transformFilterFalse`, which collapses the empty operands (C1) would otherwise trip on;
- before `removeProjections`, which deletes the `PROJECT` nodes the drop rule reads;
- before `transformExtendsToValues` wherever a caller adds it — it is not in that chain — since it turns
  `Extend(BGP([]), ?x, t)` into a `VALUES` this pass no longer recognises as a bind.

## 8. Tests — `test/pullUpExtends.test.ts`

Mirror `test/pushDownAssertions.test.ts`: a mapping-less `createPartialContext()`, `parseQuery`, compare
`c.generator.generate(toAst(pullUpExtends(c, parsed))).trim()` against an expected query string. A `GRAPH`
case needs `toAlgebra(..., { quads: false })`, as that file's `transformGraphOperation` does.

Required cases:

1. **One per row of §4**, positive.
2. **Negative**: a sibling with `?x` in scope carrying a *different* expression; a `UNION` branch that
   does not carry the bind; `BIND(RAND() AS ?x)` staying put; a `FILTER` reading a computed (non-term)
   `?x`; a `FILTER` holding an `EXISTS`; a chain whose outer bind stays and reads the inner one that
   would otherwise rise (§5); a `GROUP` whose aggregate *expression* reads the bind that is neither key
   nor target (§4); a join whose carriers share `?x` over a `?y ∈ V` that is not certain on both sides,
   which must **not** merge.
3. **Merge**, both `|S| = 1` and `|S| = 2`.
4. **Metadata/scope invariant**, as a helper run on every case: `withCpVars` of the output must have the
   same `cVars` and the same `vRanges` key set at the root as `withCpVars` of the input. This is the
   cheap version of "`pVars`/`cVars` are preserved at the anchor" and catches the stale-metadata bug.
5. **Idempotence**: `pullUpExtends(pullUpExtends(q)) === pullUpExtends(q)`.
6. **No oscillation**: `pushDownAssertions(pullUpExtends(pushDownAssertions(q)))` reaches a fixpoint on
   the queries of case 1.
7. **Evaluation**, in `test/eval.test.ts`, over `OPTIONAL`, `MINUS`, `UNION` and a sub-`SELECT`: a wrong
   `cVars` changes what `SELECT *` returns without any string comparison noticing.
8. Predicate unit tests for `isStableExpression` (`now` stable, `rand`/`uuid`/`struuid`/`bnode` not, the
   one allowlisted `named`, `existence` rejected) and `expressionsEqual`.

## 9. Out of scope

Phase 2 — the top-down `needed` analysis and general dropping (including `LEFT_JOIN`/`MINUS` RHS), the
`LEFT_JOIN` merge. Phase 3 — transfer and weak assertion into a sibling, which need an idempotence guard.
Phase 4 — the `GROUP`-over-a-constant-key hoist, a wider `NAMED` allowlist, `EXISTS` anywhere,
substituting a non-term `e`. Do not start any of them; `report.md` §5, §6 and §9 hold the designs.

## 10. Definition of done

- `yarn test` green, including the new file and the untouched existing suites.
- `yarn lint` clean (`@rubensworks/eslint-config`: TSDoc with `@param`/`@returns` on every export, and
  match the comment density of the files around you — this repo explains *why* in prose).
- `yarn build` clean; no `any` beyond the `<'unsafe', T>` pattern the other passes use.
- `pushUpBoundedFromUnion` gone from `lib/`, from `lib/transformations/index.ts`, and from `README.md`,
  with its `UNION` behaviour covered by a `pullUpExtends` test.
- The worked example at the top of this file transforms exactly as written.
