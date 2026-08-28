# Pulling static assignments up — design report

```sparql
SELECT * { { ?s ?p ?o . BIND(:a AS ?x) } { ?a ?b ?c } }
-- becomes
SELECT * { ?s ?p ?o . ?a ?b ?c . BIND(:a AS ?x) }
```

`pushDownAssertions` leaves an `EXTEND` behind at *every* leaf it substitutes into
(`bindAssertedTerms`), because that is the only way it can preserve `pVars`/`cVars` exactly without
knowing what is above it. This pass is the other half: once the whole plan is visible, most of those
re-bindings are not needed where they stand, and each one that rises turns a per-solution assignment on
a scan into one assignment on a much smaller intermediate result — or disappears.

The proposal is one new pass, `lib/transformations/pullUpExtends.ts`, exported as `pullUpExtends(c, op)`.

## 1. What floats

A **floatable bind** is an `Extend(A, ?x, e)` whose expression `e` is **stable**: a pure function of the
variables it reads, giving the same answer every time it is asked about the same values. Write
`V = vars(e)` for those variables. Stability, not simplicity, is what the rules need — nothing below
cares how big `e` is.

Two grades of it, and both belong in the pass:

- **Term expressions** (`ExpressionTypes.TERM`) — a ground term, a variable, or a triple term with
  variables in it. Exactly what `bindAssertedTerms` and the clique substitution emit (`BIND(:a AS ?x)`,
  `BIND(?o AS ?s)`, `BIND(<<( ?s ?o_p ?o_o )>> AS ?o)`), so they are the pass's bread and butter. They
  are also free to re-evaluate anywhere, which is what makes their pull-up unconditionally a win (§3,
  *cost*) and what makes them the only ones worth substituting back for `?x` (§2b). `withCpVars`'
  `EXTEND` case additionally decides when one is *infallible* — `?x ∈ cVars(Extend(…))` iff
  `V ⊆ cVars(A)` and a triple-term construction cannot fail. Call that a **certain** bind; its one job
  is licensing the `bound(?x)` fold of §2b.
- **Stable operator expressions** (`ExpressionTypes.OPERATOR`) — `BIND(CONCAT(?a, "x") AS ?y)`,
  `BIND(STR(?s) AS ?x)`, and everything else built from deterministic builtins. These rise under exactly
  the same licences. They are never *certain*, since any of them may raise an evaluation error and leave
  `?x` unbound — which costs them only the `bound(?x)` fold, not the ability to rise (§2b).

What is **not** stable, and so never floats: `RAND`, `UUID`, `STRUUID`, and `BNODE` (the spec fixes a
blank node per solution mapping, not per argument value). `NOW` *is* stable — the spec fixes it for the
whole query execution — which is worth writing down next to the blocklist so nobody re-adds it.
`ExpressionTypes.NAMED`, an extension function, is opaque and must be treated as unstable unless
allowlisted; this repo's own `bnodeConsistent` is deliberately stable ("same inputs = same identity")
and is the first entry. `ExpressionTypes.EXISTENCE` is a third case: `EXISTS { P }` is stable, but it
reads `vars(P)` rather than anything visible in the expression tree, so its reads-set has to be computed
before (C2) can be applied to it. `AGGREGATE` and `WILDCARD` cannot occur in a `BIND` at all.

A subtree hands its parent a *list* of floating binds, in order. Two ordering rules:

- **Dependency.** A bind reading a variable another floating bind writes may only rise with it. In
  practice: peel the `EXTEND` chain top-down and stop at the first one that cannot rise.
- **Relative order is preserved** when re-planted, since `BIND(<<( ?s ?p ?o )>> AS ?t)` may read the `?s`
  a lower bind wrote.

## 2. The invariant, and the three side conditions

**The invariant is local, and there is no global target.** Every rewrite here is one swap,
`Op1(Op2(…))` ⟶ `Op2(Op1(…))`, and what it has to preserve is the solution multiset, `pVars` and
`cVars` **at the node the swap is anchored at** — the same discipline as the pushdown, run upwards.
Below that node nothing is preserved and nothing needs to be: `Op1` without the bind has a strictly
smaller `pVars`, which is the whole point. Reaching the outer `PROJECT` is a nice outcome, not the
goal; a bind that rises two levels and stops is a complete, sound result, and one that cannot rise at
all costs nothing.

Hoisting `op(…, Extend(A, ?x, e), …)` into `Extend(op(…, A, …), ?x, e)` needs:

- **(C1) No capture — read on `pVars`, not on the ranges.** `?x` must not be in scope in the new child:
  `?x ∉ pVars(op(…, A, …))`, i.e. every *other* input `B` must satisfy `!B.vRanges.has(?x)`, and `op`
  must not introduce `?x` itself (a `GRAPH ?x`, another `EXTEND`, a grouping key, an aggregate target,
  a `PROJECT` that lists it — see §3).

  Scope rather than `neverBinds` because two things go wrong, not one. The runtime one is the failure
  the spec leaves undefined and this codebase defines as a crash. The static one is worse and fires
  even where no solution would have bound `?x`: SPARQL restricts `BIND` *syntactically* — the variable
  it introduces must not already be in scope — so an `Extend` over a child that merely **declares**
  `?x` generates a query no engine will accept. A declared-but-unbindable `?x` (an all-`UNDEF` VALUES
  column, a `FILTER(FALSE)` branch that keeps `pVars(Empty_S) := S`) passes `neverBinds` and is exactly
  the case that would slip through.

- **(C2) Same inputs — read on the ranges.** Every `?y ∈ V` must take the same value above `op` as it
  did in `A`; `e` being stable (§1) then makes it produce the same value, bound or errored. This one is
  about values, not legality, so it is the pushdown's `licensed` predicate read the other way round:
  `?y ∈ A.cVars ∨ ∀ other inputs B: B.vRanges.neverBinds(?y)`. Ground `e` satisfies it vacuously, which
  is the common case; `V = {?s}` with `?s ∈ cVars(A)` is the interesting one, and it is why
  `BIND(stableFunction(?s) AS ?x)` rises out of a join on `?s`.
- **(C3) Row correspondence.** `op` must produce solutions in 1-1 multiset correspondence whether the
  bind is applied below or above, and must not *read* `?x` — or `?x` must be substituted away first
  (§2b).

`?x` and `V` are the only variables that matter, so all three are decided from `CPMeta` of the inputs
*before* any rewriting. `VRanges` already carries both readings — the key set is `pVars`, `neverBinds`
is the range — and the pass wants them under distinct names; suggest adding `VRanges.inScope(name)`
alongside `canBind`/`neverBinds` so a licence cannot silently pick the wrong one.

## 2b. Substituting `e` back for `?x`

**When it is *sound*.** Almost always, and an earlier draft of this report had it wrong: it claimed the
bind had to be *certain* — infallible — before `e` could replace `?x` in an expression the bind rises
past. It does not. If `e` errors, the original leaves `?x` unbound and the reader evaluates an unbound
variable, which is a **type error**; the substituted version evaluates `e`, which is the *same* type
error. SPARQL's error propagation does not distinguish them, and the special forms that treat errors
specially — `COALESCE`, `IF`, `||`, `&&` — treat unbound and errored identically too. So the value the
reader computes is the same either way.

Two exceptions, and they are the whole of it:

- **`bound(?x)`** is the one built-in that reads unboundness rather than propagating it, and it takes a
  bare `Var`, so `bound(e)` is not even grammatical. It folds to `true` only when the bind is *certain*
  — which is exactly what `withCpVars`' `EXTEND` case decides — and otherwise blocks the hoist. So
  certainty keeps a job, just a much smaller one than I gave it.
- **`EXISTS` / `NOT EXISTS` reading `?x`** blocks outright. `μ` is substituted into the nested *pattern*,
  where an unbound `?x` stays a variable and matches anything, and where an expression cannot go at all.

`substituteInExpression` already implements both: `AssertionView.resolve` supplies the value, and the
separate `bound` set is what licenses the `bound(?x)` fold. Feeding it `resolve: ?x ↦ e` always and
`bound: {?x}` only for a certain bind is the whole integration.

**When it is *wanted*** — the real question, since (C3) makes substitution the price of hoisting past a
reader, not a bonus. Let `k` be the number of occurrences of `?x` in the reader. Originally `e` is
evaluated once per row and read back `k` times for free. After substituting, the reader computes `e`
`k` times per row *and* the hoisted bind computes it once more: `k+1` evaluations where there was one.

That is not a marginal cost, so the heuristic is the one you suggest, and I would make it the rule:

- **`e` is a term expression → always substitute.** A constant or a variable read is free, `k+1` copies
  of free is still free, and `substituteInExpression` constant-folds on top.
- **`e` is any other stable expression → never substitute; block the hoist.** Cheap to state and never
  a regression. Nothing is really lost: a bind that cannot pass its reader would be re-planted directly
  above it anyway, which is where it already is.

This lands neatly on the existing API rather than fighting it: `AssertionView.resolve` returns an
`RDF.Term`, so `substituteInExpression` *only* expresses the term case — the case we want — and a
general substitute-an-expression-for-a-variable helper is one we deliberately never write.

## 3. Per-operation rules

| Operation | Bind may rise | Licence, beyond (C1)+(C2) |
| --- | --- | --- |
| `FILTER` | yes | condition must not mention `?x`, or `e` is a term expression and substitutes in (§2b). **`EXISTS` reading `?x` blocks outright**, substitution or not. |
| `EXTEND(?y, e2)` | yes | `e2` must not mention `?x`, or `e` is a term expression and substitutes into `e2` (§2b). |
| `PROJECT` | **drop** if `?x ∉ variables`; else yes | to rise, `V ⊆ variables` too, **and `?x` must be struck from `variables`**: a projected variable of a sub-`SELECT` is in scope outside it, so leaving it listed puts the re-planted `BIND` back in violation of (C1). `pVars` at the swap is unchanged — `(variables \ {?x}) ∪ {?x}`. This is the main drop site. |
| `GROUP` | **drop** if `?x` is neither a key nor an aggregate target; else barrier | second drop site. Optional refinement: a *ground* bind on a key `?x` may rise as `Group(A, keys \ {?x}, aggs)` — but not when `keys = {?x}`, since a keyless GROUP over the empty input yields one group where `GROUP BY ?x` yields none. |
| `DISTINCT` / `REDUCED` | yes | unconditional. `e` is a deterministic function of the row, so the extra column never refines the equivalence classes. |
| `ORDER_BY` | yes | expressions must not mention `?x` (or substitute, §2b). `EXTEND` maps element-wise and preserves the sequence. |
| `SLICE` | yes | unconditional, for the same reason — a rare case where the pull-up goes where the pushdown may not. |
| `FROM` | yes | congruent. |
| `JOIN` | yes | (C1)/(C2) over the sibling operands: `?x ∉ pVars(B)` for each sibling `B` — *or* `B` carries the identical bind, see **merge** below. This is the motivating example. |
| `LEFT_JOIN`, from the **LHS** | yes | `?x ∉ pVars(R)`, or `R` carries the identical bind (merge); the left-join condition is treated like a `FILTER`. |
| `LEFT_JOIN`, from the **RHS** | no | hoisting would bind `?x` on the unmatched left rows, where it must stay unbound. Drop-only (§4). |
| `MINUS`, from the **LHS** | yes | the one row where the condition is `R.vRanges.neverBinds(?x)` rather than scope: `pVars(Minus) = pVars(L)`, so `R` declaring `?x` cannot make the re-planted `BIND` illegal, but an `R` that *binds* it changes both the compatibility and the domain-disjointness test. |
| `MINUS`, from the **RHS** | no | RHS bindings are out of scope above. Droppable when `L.vRanges.neverBinds(?x)`: then `?x` is in neither test. |
| `UNION` | only when **every** branch floats the same bind | same `?x`, `e` structurally equal and stable — and *no* (C2) condition, since a union merges nothing: the solution above is exactly the branch solution, so `e` is being asked about the same μ either way. Hoisting from one branch alone would bind `?x` in the other branches' solutions; adding it to the others instead would *grow* `cVars(union)`, which is a wrong answer, not a conservative one. This rule subsumes `pushUpBoundedFromUnion`. |
| `GRAPH ?g` | yes | `?x ≠ ?g` and `?g ∉ V` (unless `?g ∈ A.cVars`) — `?g` is bound by the join *outside* the pattern. |
| `SERVICE` | no | barrier, matching the pushdown: `SILENT` turns endpoint failure into one empty solution, where the hoisted bind would still bind `?x`. |
| `BGP`, `PATH`, `VALUES` | — | leaves; nothing to float. |

**Merge: when a sibling carries the bind too.** (C1) says a sibling must not have `?x` in scope, which
would block

```sparql
{ ?s :p ?o . BIND(f(?s) AS ?x) } { ?s :p2 ?a . BIND(f(?s) AS ?x) }
```

But the join is only enforcing an equality that already holds. Let `S` be the operands carrying a
structurally equal, stable `BIND(e AS ?x)`. If **`V ⊆ O.cVars` for every `O ∈ S`**, then join
compatibility forces every `?y ∈ V` to one value across the merge, `e` is stable, so every carrier
computed the *same* `?x` — the `?x` component of the compatibility test is a tautology, and the copies
collapse into one `EXTEND` above the join:

```
Join(Extend(A, ?x, e), Extend(B, ?x, e))  ≡  Extend(Join(A, B), ?x, e)
```

with (C1) still required of the operands *not* in `S`. Multiplicity is untouched: no pair of rows was
being rejected on `?x`, so exactly the same merges survive. `cVars` matches on both sides too — the
hoisted `EXTEND` is certain iff `V ⊆ cVars(Join)`, which `V ⊆ O.cVars` gives.

This is one rule with the single-carrier hoist, not a second one: `|S| = 1` reduces it to (C2)'s first
disjunct, which is why the version of the example where only the LHS binds `?x` needs nothing extra. It
extends to `LEFT_JOIN` under `V ⊆ cVars(L) ∩ cVars(R)` — for the unmatched rows the anti-join half keeps,
`e` is computed on `μ_L` either way — but the anti-join half always deserves a second look, so I would
land the `JOIN` case first.

**Cost is not automatic once `e` is non-trivial.** A term expression is free to re-evaluate, so its
pull-up is a pure win. A `stableFunction(?s)` is not: a join may *increase* cardinality, and then the
hoisted bind is evaluated more often than the original. The merge case is always a win (it deletes an
evaluation outright), and so is any rise past a cardinality-non-increasing operation (`FILTER`, `SLICE`,
`DISTINCT`, `PROJECT`, `ORDER_BY`, `MINUS` from the LHS). A single-carrier rise past a `JOIN` is a
judgement call — it enables everything downstream but may cost evaluations. Suggest: unconditional for
term expressions, and gated behind the merge or an explicit option for the rest.

**`pVars`/`cVars` discipline.** Every hoist above is a swap in the sense of §2: `?x` leaves the
`vRanges`/`cVars` of the operation it rose past, and the re-planted `EXTEND` puts it back before
anything can observe the difference. Nothing about the root is claimed, and nothing needs to be.

## 4. Dropping, the one rewrite that is not a swap

A drop deletes the bind instead of moving it, so `?x` does *not* come back — the anchor for the
invariant moves up to the operation that discards it, and it is there that `pVars` and the solution
multiset have to be unchanged. That is what makes it a different kind of rule, and why it needs its own
licence rather than falling out of §2.

The `PROJECT` and `GROUP` drops only fire when a bind has floated to be a *direct* child of the drop
site. That misses the common `OPTIONAL { … BIND(:a AS ?x) }` under a projection that never wanted `?x`.

The general form is a **top-down `needed` analysis**, run before the bottom-up pull:

```
needed(root)  = the variables the caller projects (see §6)
needed(child) = needed(op) ∪ variablesRead(op) ∪ ⋃ { pVars(sibling) : op is join/leftJoin/minus }
```

Siblings' `pVars` are in there because a variable bound in one operand silently acts as a join key with
another, and because `MINUS`' disjointness test reads the *domain*, not the values. A floating bind
with `?x ∉ needed` is dropped wherever it is. Dropping is sound because `Extend` is total when `A` never
binds `?x` — it maps each solution to exactly one solution — so the multiset is unchanged modulo `?x`.

I would build this in phase 2 and keep phase 1 to the two syntactic drop sites, which already covers
what the pushdown emits under a sub-`SELECT`.

## 5. When the pull is blocked: transfer and weak assertion

Two things are still available when a `JOIN` sibling `B` can bind `?x`, and this is where the loop
hazard the task flags lives.

- **Transfer (strong).** If `?x ∈ B.cVars`, then `B` supplies `?x` on every solution, and join
  compatibility already forces it to equal `e`. So `Join(Extend(A, ?x, e), B) ≡ Join(A, σ_{?x ≡ e}(B))`
  — the `EXTEND` is *deleted*, not moved, and `pVars`/`cVars` are unchanged. Only for ground `e`
  (`isAssertableTerm`), and only where `e` is in `B`'s range for `?x`, which the pushdown's
  `normalisedFor` decides.
- **Weak assertion.** If `?x ∈ B.vRanges` but `?x ∉ B.cVars`, the bind cannot move and cannot be
  deleted, but `W⟨?x ≡ e⟩` holds on every solution of `B` that reaches the join, so it may be asserted
  into `B`.

Both emit assertion filters that `pushDownAssertions` then pushes down and re-materialises as `EXTEND`s
at `B`'s leaves — which this pass would pick up again. **Termination argument:** the strong transfer is
monotone (it strictly decreases the number of `EXTEND` nodes; the one it re-creates in `B` then rises
over a join whose siblings no longer bind `?x`, so the second round is a plain hoist). The weak
assertion is *not* monotone on its own — a weak conjunct is never materialised as a bind, but the pass
would keep re-emitting the same filter. It needs an idempotence guard: `assertionFilter` already tags
its output with `metadata.assertions`, so the check is "does `B` already carry this conjunct", via
`collectAssertions` over `B`'s top filter chain.

Recommendation: **phase 1 ships neither.** Pure pull-up + drop has no loop risk at all — every rewrite
either deletes an `EXTEND` or strictly decreases its depth, so a single bottom-up traversal is a
fixpoint. Transfer and weak assertion are a phase 3 behind an option flag, with the guard above.

## 6. Architecture and reuse

- **Traversal:** `algebraUtils.mapOperation` with a per-type `transform`. It is bottom-up, so by the
  time a node is visited its children have already floated everything they can to their own top — the
  floating list is just "the `EXTEND` chain at the top of each input", no custom recursion needed.
- **New shared util** `lib/utils/extendChain.ts`: `peelExtends(op) → { core, binds }` and
  `replantExtends(c, op, binds)`. This generalises `directExtensions` (currently Literal/NamedNode only,
  loses order) and `deleteVarExtensionsInPlace` (in-place, name-list based) from `lib/utils.ts`; both
  move here and `pushUpBoundedFromUnion` is **deleted**, its UNION rule being the row in §3.
- **Two small new predicates**, both in the same util and both needing tests of their own since every
  rule leans on them: `isStableExpression(e)` (the §1 blocklist plus the `NAMED` allowlist, recursing
  through `OPERATOR` arguments) and `expressionsEqual(a, b)` for the merge and the `UNION` rule. The
  algebra ships no structural equality — `Canonicalizer` only renames blank nodes — so this is ours to
  write; a plain structural walk, not a generate-and-compare.
- **Reused as-is:** `withCpVars`/`withoutCpVars`/`CPMeta`/`VRanges.neverBinds`/`canBind` for every
  licence; `substituteInExpression` for (C3), fed by a small `AssertionView` built from the floating
  binds (`resolve` on bare accesses, `bound` = the certain ones); `collectVariableNames` for "does this
  expression mention `?x`" and for `vars(e)`, `EXISTS` operands included — which is also what gives
  `EXISTENCE` the reads-set §1 says it needs.
- **Metadata hygiene:** moving a node invalidates the cached `CPMeta` of everything it moved past.
  Enter through `withoutCpVars`, delete the metadata of every node this pass rebuilds, and read
  `cpVars` only off inputs as `mapOperation` hands them back. This is the likeliest source of a subtle
  bug and deserves its own test.

## 7. Pipeline placement

```
operationTransform → pushDownAssertions → transformFilterFalse
  → nullifyJoinOverIncompatibleBounds → nullifyUnbindableVars → transformFilterFalse
  → pullUpExtends → transformExtendsToValues → removeProjections
```

Two constraints, both load-bearing:

- **Before `removeProjections`**, which deletes the `PROJECT` nodes the drop rule reads.
- **Before `transformExtendsToValues`**, which turns `Extend(BGP([]), ?x, t)` into a `VALUES` this pass
  no longer recognises as a bind.

Worth knowing rather than deciding: `queryTransform` strips the outer `PROJECT` before running the
transformations and re-adds it afterwards, so the pass never sees the query's own projection. Every bind
that survives is simply re-planted wherever it stopped — which is sound by §2 and, for the task's
example, is the root. Nothing depends on it getting there. Passing `innerAlgebra.variables` in as a
root-needed set would only let the *drop* rule fire at the top as well; that is an optional extra, not a
correctness matter.

## 8. Phasing and tests

1. **Phase 1** — `peelExtends`/`replantExtends`, `isStableExpression`/`expressionsEqual`, the congruent
   operations (`FILTER`, `EXTEND`, `DISTINCT`, `REDUCED`, `ORDER_BY`, `SLICE`, `FROM`, `GRAPH`), `JOIN`
   with the merge rule, `LEFT_JOIN` LHS, `MINUS` LHS, the all-branch `UNION` rule, and the two syntactic
   drop sites. Term and stable operator expressions both, since they share every licence. Delete
   `pushUpBoundedFromUnion`.
2. **Phase 2** — the `needed` analysis and general dropping, including `LEFT_JOIN`/`MINUS` RHS; the
   `LEFT_JOIN` merge; `NAMED` allowlisting and `EXISTENCE`.
3. **Phase 3** — sibling transfer and weak assertion, flag-gated, with the idempotence guard.

Tests, mirroring `test/pushDownAssertions.test.ts`: a case per row of §3 including the *negative* ones
(a sibling that has `?x` in scope but carries a *different* expression, a UNION branch that does not
carry the bind, a fallible triple-term bind read by a `FILTER`, `BIND(RAND() AS ?x)` staying put); the
two merge examples from review, one per `|S|`; **idempotence**
(`pullUpExtends ∘ pullUpExtends = pullUpExtends`); a **fixpoint check against `pushDownAssertions`** on
the queries in the task, so the pair provably does not oscillate; and evaluation tests in
`test/eval.test.ts` for the cases where a wrong `cVars` would silently change `SELECT *` — `OPTIONAL`,
`MINUS`, `UNION` and a sub-`SELECT` — since those are where every rule above can be wrong without any
test on the generated string noticing. The merge rule wants one more: a join whose carriers bind `?x`
over a `?y ∈ V` that is *not* certain on both sides, which must **not** merge.

## 9. Open questions for review

1. Is `SERVICE` really a barrier, or should a non-`SILENT` service let a bind out? Hoisting there
   *reduces* what is shipped to the endpoint, so it may be a pessimisation to keep it in.
2. Is the `GROUP`-over-a-constant-key refinement worth the empty-input edge case, or is drop-plus-barrier
   enough?
3. Is the substitution heuristic of §2b (term expressions only, everything else blocks) too blunt? It
   costs us the hoist past any `FILTER` that reads a computed `?x`, which may be common enough to want
   the `k = 1`-and-dead refinement sooner than phase 2.
4. Should phase 1 also hoist over `SLICE`? It is sound (§3) but it is the one place the pushdown
   deliberately refuses to go, so the asymmetry is worth confirming rather than assuming.
5. Do we want the root-needed-variables parameter (§7) in phase 1, so that the top-level `SELECT ?x ?y`
   drops the binds it never projects? Purely an extra, by §2.
6. Should a single-carrier rise of a non-trivial expression past a `JOIN` be unconditional, or gated
   (§3, *cost*)? It can increase how often the function is evaluated, and I do not think we can decide
   it without cardinality information we do not have.
7. `pushIntoGraph` argues the same capture question the other way — "read as `canBind` rather than as
   scope: `?g` may be *declared* below and bindable by nothing there" — and on the runtime failure alone
   it is right. The syntactic in-scope restriction of (C1) applies to the `EXTEND` it builds too, so
   either that comment is missing a case or I am over-reading the restriction. Worth settling once for
   both passes, since it is the same `BIND` legality question.
