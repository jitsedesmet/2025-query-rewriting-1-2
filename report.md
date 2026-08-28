# Pulling assignments up — design report

```sparql
SELECT * { { ?s ?p ?o . BIND(:a AS ?x) } { ?a ?b ?c } }
-- becomes
SELECT * { ?s ?p ?o . ?a ?b ?c . BIND(:a AS ?x) }
```

`pushDownAssertions` leaves an `EXTEND` behind at *every* leaf it substitutes into
(`bindAssertedTerms`), because that is the only way it can preserve `pVars`/`cVars` exactly without
knowing what is above it. This pass is the other half: once the whole plan is visible, most of those
re-bindings are not needed where they stand, and each one that rises turns a per-solution assignment on
a scan into one assignment on a smaller intermediate result — or disappears.

One new pass, `lib/transformations/pullUpExtends.ts`, exported as `pullUpExtends(c, op)`.

## 1. What floats

A **floatable bind** is an `Extend(A, ?x, e)` whose expression `e` is **stable**: a pure function of the
variables it reads, giving the same answer every time it is asked about the same values. Write
`V = vars(e)`. Stability, not simplicity, is what the rules need — nothing below cares how big `e` is.

- **Term expressions** (`ExpressionTypes.TERM`) — a ground term, a variable, or a triple term with
  variables in it. Exactly what `bindAssertedTerms` and the clique substitution emit (`BIND(:a AS ?x)`,
  `BIND(?o AS ?s)`, `BIND(<<( ?s ?o_p ?o_o )>> AS ?o)`), so they are the pass's bread and butter, and
  free to re-evaluate anywhere — which is what makes their pull-up unconditionally a win (§4, *cost*)
  and makes them the only ones worth substituting back for `?x` (§3).
- **Stable operator expressions** (`ExpressionTypes.OPERATOR`) — `BIND(CONCAT(?a, "x") AS ?y)`,
  `BIND(STR(?s) AS ?x)`, anything built from deterministic builtins. Same licences, different cost.

A bind is **certain** when it cannot leave `?x` unbound. `withCpVars`' `EXTEND` case already decides it:
`?x ∈ cVars(Extend(A, ?x, e))` iff `e` is a term expression, `V ⊆ cVars(A)`, and — for a triple-term
construction, which *can* raise an evaluation error when a component does not fit its position — the
ranges of the components rule that error out (`constructionCannotFail`). Certainty has exactly one job
here, the `bound(?x)` fold of §3; nothing else needs it.

**Never stable**, so never floats: `RAND`, `UUID`, `STRUUID`, `BNODE` (the spec fixes a blank node per
solution mapping, not per argument value). `NOW` *is* stable — fixed for the whole query execution —
worth writing down next to the blocklist so nobody re-adds it. `ExpressionTypes.NAMED` is opaque and
unstable unless allowlisted; this repo's `bnodeConsistent` is deliberately stable ("same inputs = same
identity") and is the first entry. `ExpressionTypes.EXISTENCE` is stable but reads `vars(P)` of its
nested pattern rather than anything visible in the expression tree, so that reads-set has to be computed
before (C2) applies to it. `AGGREGATE` and `WILDCARD` cannot occur in a `BIND`.

**The unit is the chain, not the node.** Peel the maximal `EXTEND` chain at the top of a subtree into an
ordered list of binds and decide them together, the way a conjunction of filters is decided together.
Each is tested on its own: the ones that rise go above in their original relative order, the ones that
stay are re-planted below in theirs. A bind that stays does **not** block the ones above it — it still
binds its variable below the operation, so a later bind depending on it simply carries an ordinary (C2)
obligation on that variable. That falls out of the rules rather than needing one of its own.

## 2. The invariant, and the three side conditions

**The invariant is local, and there is no global target.** Every rewrite is one swap,
`Op1(Op2(…))` ⟶ `Op2(Op1(…))`, preserving the solution multiset, `pVars` and `cVars` **at the node the
swap is anchored at**. Below that node nothing is preserved and nothing needs to be: `Op1` without the
bind has a smaller `pVars`, which is the point. Reaching the outer `PROJECT` is an outcome, not a goal.

Hoisting `op(…, Extend(A, ?x, e), …)` into `Extend(op(…, A, …), ?x, e)` needs:

- **(C1) No capture.** No solution reaching the re-planted `EXTEND` may already bind `?x`: every *other*
  input `B` must satisfy `B.vRanges.neverBinds(?x)` unless it carries the identical bind (§4, *merge*),
  and `op` must not introduce `?x` itself — a `GRAPH ?x`, a grouping key, an aggregate target. A
  `PROJECT` listing `?x` is not a blocker: strike it from the list and rise (§4).

  This is an evaluation-time condition, not a syntactic one. `Extend(A, ?x, e)` is *undefined* by the
  spec when `?x ∈ dom(μ)` for an input mapping μ, which this codebase reads as "must not happen, the
  engine crashes". Nothing forbids `?x` being merely *in scope* in `A`, so `neverBinds` — out of scope,
  or in scope with an empty range — is the right reading, and an all-`UNDEF` `VALUES` column is a
  legitimate hoist target rather than a hazard.

  One deliberate relaxation makes `neverBinds` see more: `withCpVars` does not bottom the ranges under a
  `FILTER(FALSE)`, so an empty operand still reports `?x` as bindable and blocks. An input with *no
  solutions* may first be collapsed to the scope-free empty operation, `pVars(Empty_S) := S`
  notwithstanding — nothing observable changes when the solution set is empty either way, and this pass
  does not owe `pVars` identity below the anchor. `transformFilterFalse` runs before it and has already
  done most of this.

  One caveat that belongs to *generation* rather than to the rules: SPARQL's grammar does forbid a
  `BIND` whose variable is in use in the immediately preceding `TriplesBlock` of the same group graph
  pattern. It is narrow, and the empty-operand collapse above removes the case in this pipeline that
  would produce it, but it is where to look if the generator ever rejects this pass's output.

- **(C2) Same inputs — read on the ranges.** Every `?y ∈ V` must take the same value above `op` as it
  did in `A`; `e` being stable then makes it produce the same value, bound or errored. This is about
  values, not legality, so it is the pushdown's `licensed` predicate read the other way round:
  `?y ∈ A.cVars ∨ ∀ other inputs B: B.vRanges.neverBinds(?y)`. Ground `e` satisfies it vacuously;
  `V = {?s}` with `?s ∈ cVars(A)` is the interesting case, and is why `BIND(f(?s) AS ?x)` is licensed to
  rise out of a join on `?s`.
- **(C3) Row correspondence.** `op` must produce solutions in 1-1 multiset correspondence whether the
  bind is applied below or above, and must not *read* `?x` — or `?x` must be substituted away first.

All three are decided from the `CPMeta` of the inputs *before* any rewriting, and all three read the
ranges rather than the key set — `neverBinds` throughout, never `has`.

## 3. Substituting `e` back for `?x`

**Sound almost everywhere.** If `e` errors, the original leaves `?x` unbound and the reader evaluates an
unbound variable — a type error; the substituted version evaluates `e` and raises the *same* type error.
SPARQL does not distinguish them, and the special forms that handle errors specially (`COALESCE`, `IF`,
`||`, `&&`) treat unbound and errored alike. Two exceptions:

- **`bound(?x)`** reads unboundness instead of propagating it, and takes a bare `Var`, so `bound(e)` is
  not grammatical. It folds to `true` only for a **certain** bind (§1); otherwise the hoist blocks.
- **`EXISTS` / `NOT EXISTS` reading `?x`** blocks outright: `μ` is substituted into the nested *pattern*,
  where an unbound `?x` stays a variable and matches anything, and where an expression cannot go.

**Wanted only when free.** Substitution is the price of hoisting past a reader, not a bonus. With `k`
occurrences of `?x` in the reader, one evaluation of `e` per row becomes `k+1` — `k` in the reader plus
one in the hoisted bind. So: **term expression → always substitute** (free, and `substituteInExpression`
constant-folds on top); **any other stable expression → never substitute, block the hoist**. Little is
lost, since a bind that cannot pass its reader gets re-planted directly above it, where it already was.

This lands on the existing API rather than fighting it: `AssertionView.resolve` returns an `RDF.Term`,
so `substituteInExpression` expresses exactly the term case and nothing else. Feed it `resolve: ?x ↦ e`,
and `bound: {?x}` only for a certain bind. A general substitute-an-expression-for-a-variable helper is
one we never write.

## 4. Per-operation rules

| Operation | Bind may rise | Licence, beyond (C1)+(C2) |
| --- | --- | --- |
| `FILTER` | yes | condition must not mention `?x`, or `e` is a term expression and substitutes in (§3). **`EXISTS` reading `?x` blocks outright.** |
| `EXTEND` | — | not a swap: the chain is one unit, see §1. |
| `PROJECT` | **drop** if `?x ∉ variables`; else yes | to rise, `V ⊆ variables`, and `?x` is struck from `variables` — not for (C1), which the projection satisfies either way, but so the sub-`SELECT` does not carry an always-unbound column and the metadata stays honest. `pVars` at the swap is unchanged: `(variables \ {?x}) ∪ {?x}`. Pointless at the root, where there is nothing above to rise to. The main drop site. |
| `GROUP` | **drop** if `?x` is neither a key nor an aggregate target; else barrier | second drop site. A refinement for a constant key is deferred to phase 4. |
| `DISTINCT` / `REDUCED` | yes | unconditional: `e` is a deterministic function of the row, so the extra column never refines the equivalence classes. |
| `ORDER_BY` | yes | expressions must not mention `?x` (or substitute, §3). `EXTEND` maps element-wise and preserves the sequence. |
| `SLICE` | yes | unconditional — `EXTEND` is a bijection on rows and preserves order. One of the few places the pull-up goes where the pushdown may not. |
| `FROM` | yes | congruent. |
| `JOIN` | yes | (C1)/(C2) over the siblings, *or* a sibling carries the identical bind (**merge**, below). Cardinality-increasing, so subject to the cost gate below. |
| `LEFT_JOIN`, from the **LHS** | yes | `R.vRanges.neverBinds(?x)`, or `R` carries the identical bind; the condition is treated like a `FILTER`. Cost gate applies. |
| `LEFT_JOIN`, from the **RHS** | no | hoisting would bind `?x` on the unmatched left rows, where it must stay unbound. Drop-only (§5). |
| `MINUS`, from the **LHS** | yes | `R.vRanges.neverBinds(?x)` — an `R` that binds `?x` changes both the compatibility and the domain-disjointness test, though `pVars(Minus) = pVars(L)` means it never reaches the re-planted bind. |
| `MINUS`, from the **RHS** | no | RHS bindings are out of scope above. Droppable when `L.vRanges.neverBinds(?x)`: then `?x` is in neither test. |
| `UNION` | only when **every** branch floats the same bind | same `?x`, `e` structurally equal and stable — and no (C2) condition, since a union merges nothing: the solution above *is* the branch solution, so `e` is asked about the same μ either way. Hoisting from one branch alone would bind `?x` in the others' solutions; adding it to the others instead would *grow* `cVars(union)`, a wrong answer rather than a conservative one. Subsumes `pushUpBoundedFromUnion`. |
| `GRAPH ?g` | yes | `?x ≠ ?g`, and `?g ∉ V` unless `?g ∈ A.cVars` — `?g` is bound by the join *outside* the pattern. |
| `SERVICE` | no | barrier, as in the pushdown: `SILENT` turns endpoint failure into one empty solution, where the hoisted bind would still bind `?x`. Carries a `TODO(future)` in the code, as `pushIntoGraph` does — letting a non-`SILENT` service release a bind is sound and reduces what is shipped to the endpoint. |
| `BGP`, `PATH`, `VALUES` | — | leaves. |

**Merge: when a sibling carries the bind too.** (C1) would block

```sparql
{ ?s :p ?o . BIND(f(?s) AS ?x) } { ?s :p2 ?a . BIND(f(?s) AS ?x) }
```

but the join is only enforcing an equality that already holds. Let `S` be the operands carrying a
structurally equal, stable `BIND(e AS ?x)`. If **`V ⊆ O.cVars` for every `O ∈ S`**, join compatibility
forces every `?y ∈ V` to one value across the merge, `e` is stable, so every carrier computed the same
`?x`: that component of the compatibility test is a tautology and the copies collapse into one.

```
Join(Extend(A, ?x, e), Extend(B, ?x, e))  ≡  Extend(Join(A, B), ?x, e)
```

with (C1) still required of the operands not in `S`. Multiplicity is untouched — no pair of rows was
being rejected on `?x` — and the hoisted `EXTEND` is certain iff `V ⊆ cVars(Join)`, which the condition
gives. This is one rule with the single-carrier hoist, not a second one: at `|S| = 1` it reduces to
(C2)'s first disjunct. It extends to `LEFT_JOIN` under `V ⊆ cVars(L) ∩ cVars(R)`, where the anti-join
half computes `e` on `μ_L` either way, but that half always deserves a second look — phase 2.

**The cost gate.** A term expression is free to re-evaluate, so its pull-up is a pure win everywhere. A
`f(?s)` is not: `JOIN` and `LEFT_JOIN` may *increase* cardinality, so a hoisted bind can be evaluated
more often than the original. Every other operation in the table is cardinality-non-increasing (a
`GRAPH ?g` evaluates its pattern once per graph either way), so the gate is narrow:

> Past a `JOIN` or `LEFT_JOIN`, a non-term expression rises only under the **merge** rule, which deletes
> an evaluation outright. A single carrier stays put.

That is the conservative half of the trade, and it is worth being explicit that it is a trade: with real
cardinality estimates a single-carrier rise is often the better plan — `{ ?s :p ?o BIND(f(?s) AS ?x) }
{ ?s :p2 ?a }` is a win whenever the join is selective and a loss whenever it fans out, and nothing in
the algebra tells us which. Revisit if cardinality information ever reaches this pass.

**`pVars`/`cVars` discipline.** Every hoist is a swap in the sense of §2: `?x` leaves the
`vRanges`/`cVars` of the operation it rose past, and the re-planted `EXTEND` puts it back before
anything can observe the difference.

## 5. Dropping, the one rewrite that is not a swap

A drop deletes the bind instead of moving it, so `?x` does not come back: the anchor moves up to the
operation that discards it, and it is there that `pVars` and the solution multiset must be unchanged.
Dropping is sound because `Extend` is total when `A` never binds `?x` — one solution in, one out — so
the multiset is unchanged modulo `?x`.

The `PROJECT` and `GROUP` drops fire only when a bind has floated to be a *direct* child of the drop
site, which misses the common `OPTIONAL { … BIND(:a AS ?x) }` under a projection that never wanted `?x`.
The general form is a top-down `needed` analysis, run before the bottom-up pull:

```
needed(root)  = every variable in pVars(root), unless the caller says otherwise
needed(child) = needed(op) ∪ variablesRead(op) ∪ ⋃ { pVars(sibling) : op is join/leftJoin/minus }
```

Siblings' `pVars` are in there because a variable bound in one operand silently acts as a join key with
another, and because `MINUS`' disjointness test reads the *domain*, not the values. A floating bind with
`?x ∉ needed` is dropped wherever it stands, including the `LEFT_JOIN` and `MINUS` right-hand sides.
Phase 2.

The "unless the caller says otherwise" is a small loose end: `queryTransform` strips the query's outer
`PROJECT` before running any transformation and re-adds it afterwards, so the pass never learns which
variables the user actually selected. A bind that floats to the root is therefore always re-planted,
never dropped, even when the final `SELECT ?a ?b` will discard it. Handing `pullUpExtends` that variable
list as an argument would close it. Minor, and listed only for completeness.

## 6. When the pull is blocked: transfer and weak assertion

Two moves remain when a `JOIN` sibling `B` has `?x` in scope and does not carry the identical bind.

- **Transfer (strong).** If `?x ∈ B.cVars`, `B` supplies `?x` on every solution and join compatibility
  already forces it to equal `e`. So `Join(Extend(A, ?x, e), B) ≡ Join(A, σ_{?x ≡ e}(B))` — the `EXTEND`
  is deleted, not moved. Ground `e` only.
- **Weak assertion.** If `?x ∈ B.vRanges` but `?x ∉ B.cVars`, the bind can neither move nor be deleted,
  but `W⟨?x ≡ e⟩` holds of every solution of `B` that reaches the join, so it may be asserted into `B`.

Both emit assertion filters that `pushDownAssertions` pushes down and re-materialises as `EXTEND`s at
`B`'s leaves, which this pass would pick up again. The strong transfer is monotone — it strictly
decreases the `EXTEND` count, and the copy it re-creates in `B` then rises over a join whose siblings no
longer bind `?x`. The weak assertion is not: it would re-emit the same filter forever, and needs an
idempotence guard (`assertionFilter` already tags its output with `metadata.assertions`, so the check is
`collectAssertions` over `B`'s top filter chain).

**Phase 1 ships neither.** Pure pull-up plus drop has no loop risk at all: every rewrite either deletes
an `EXTEND` or strictly decreases its depth, so one bottom-up traversal is a fixpoint.

## 7. Architecture and reuse

- **Traversal:** the post-order `algebraUtils.mapOperation` with a per-type `transform`, which runs
  after the children — leaves first, working up, the mirror of the pushdown's `mapOperationPreOrder`. By
  the time a node is visited its children have already floated everything they can to their own top, so
  the floating list is just the `EXTEND` chain at the top of each input: no custom recursion, and no
  second pass to reach a fixpoint.
- **New shared util** `lib/utils/extendChain.ts`: `peelExtends(op) → { core, binds }` and
  `replantExtends(c, op, binds)`. Generalises `directExtensions` (Literal/NamedNode only, loses order)
  and `deleteVarExtensionsInPlace` (in-place, name-list based) from `lib/utils.ts`; both move here and
  `pushUpBoundedFromUnion` is **deleted**, its `UNION` rule being the row in §4.
- **Two new predicates**, both needing tests of their own since every rule leans on them:
  `isStableExpression(e)` (the §1 blocklist plus the `NAMED` allowlist, recursing through `OPERATOR`
  arguments) and `expressionsEqual(a, b)` for the merge and the `UNION` rule. The algebra ships no
  structural equality — `Canonicalizer` only renames blank nodes — so this is ours: a structural walk,
  not generate-and-compare.
- **Reused as-is:** `withCpVars`/`withoutCpVars`/`CPMeta`/`VRanges` for every licence;
  `substituteInExpression` for §3; `collectVariableNames` for "does this expression mention `?x`" and
  for `vars(e)`, `EXISTS` operands included — which also gives `EXISTENCE` the reads-set §1 needs.
- **Metadata hygiene:** moving a node invalidates the cached `CPMeta` of everything it moved past. Enter
  through `withoutCpVars`, delete the metadata of every node this pass rebuilds, and read `cpVars` only
  off inputs as `mapOperation` hands them back. The likeliest source of a subtle bug; give it a test.

## 8. Pipeline placement

```
operationTransform → pushDownAssertions → transformFilterFalse
  → nullifyJoinOverIncompatibleBounds → nullifyUnbindableVars → transformFilterFalse
  → pullUpExtends → transformExtendsToValues → removeProjections
```

- **After `transformFilterFalse`**, which collapses the empty operands (C1) would otherwise trip on.
- **Before `removeProjections`**, which deletes the `PROJECT` nodes the drop rule reads.
- **Before `transformExtendsToValues`**, which turns `Extend(BGP([]), ?x, t)` into a `VALUES` this pass
  no longer recognises as a bind.

## 9. Phases and tests

1. **Phase 1** — `peelExtends`/`replantExtends`, `isStableExpression`/`expressionsEqual`, the congruent
   operations (`FILTER`, `DISTINCT`, `REDUCED`, `ORDER_BY`, `SLICE`, `FROM`, `GRAPH`), `JOIN` with the
   merge rule and the cost gate, `LEFT_JOIN` LHS, `MINUS` LHS, the all-branch `UNION` rule, and the two
   syntactic drop sites. Term and stable operator expressions both. Delete `pushUpBoundedFromUnion`.
2. **Phase 2** — the `needed` analysis and general dropping, including `LEFT_JOIN`/`MINUS` RHS; the
   `LEFT_JOIN` merge.
3. **Phase 3** — transfer and weak assertion, flag-gated, with the idempotence guard.
4. **Phase 4, edge cases** — the `GROUP`-over-a-constant-key hoist (`Group(A, keys \ {?x}, aggs)`,
   blocked when `keys = {?x}`, since a keyless `GROUP` over the empty input yields one group where
   `GROUP BY ?x` yields none); `NAMED` allowlisting and `EXISTENCE`; substituting a non-term `e` where
   `k = 1` and `?x` is dead above, which is break-even and deletes a node but needs §5's analysis.

Tests, mirroring `test/pushDownAssertions.test.ts`: a case per row of §4, the *negative* ones included —
a sibling with `?x` in scope carrying a different expression, a `UNION` branch that does not carry the
bind, `BIND(RAND() AS ?x)` staying put, a `FILTER` reading a computed `?x`, and a join whose carriers
share `?x` over a `?y ∈ V` that is not certain on both sides, which must **not** merge. Both merge
examples, one per `|S|`. **Idempotence** (`pullUpExtends ∘ pullUpExtends = pullUpExtends`). A **fixpoint
check against `pushDownAssertions`**, so the pair provably does not oscillate. And evaluation tests in
`test/eval.test.ts` for `OPTIONAL`, `MINUS`, `UNION` and a sub-`SELECT`, since those are where a wrong
`cVars` silently changes `SELECT *` without any test on the generated string noticing.
