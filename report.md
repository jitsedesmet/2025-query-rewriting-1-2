# Study: extending `AssertionConjunction` with variable unification

Goal: handle `FILTER(sameTerm(?x, ?y))` next to today's `FILTER(sameTerm(?x, c))`, so `?s ?p ?o
FILTER(sameTerm(?s, ?o))` becomes `?o ?p ?o . BIND(?o AS ?s)`, and a unification that later meets a
term drags that term onto every variable it unified.

The representative of a cluster is its lexicographically first member, so `{?s, ?o}` unifies onto
`?o`. Every example here follows that, and the tests have to.

Not hypothetical input: `rewriteSinglePattern`'s `headUnificationFilter` (`:160,193`) already emits
`sameTerm(?mA, ?mB)` chains for every mapping-head cluster without a term. They sit in the unfolded
body and never move.

## 1. The one structural fact

Today's Θ is a conjunction of *independent, single-variable* constraints. That is what licenses
`restrict()` (`pushDownAssertions.ts:702`), the per-variable `normalise`, and the per-variable FJPush
check in `pushIntoJoin`.

Sharp dividing line: a group **pinned to a term** still decomposes into per-variable conjuncts and
behaves exactly as today. A group **without a term** is a clique that must be reasoned about as a
whole. Everything below follows.

## 2. The five states

<!-- eslint-skip -->

```ts
export class AssertionConjunction {
  private readonly clusters: ClusterSet<string>;     // variable -> group
  private readonly groupTerm: Map<number, RDF.Term>; // group -> its term, if pinned
  // Per *variable*, not per group: `normalise` promotes each member against cVars/pVars separately,
  // so one member of a pinned group can be strong while another is weak.
  private readonly strength: Map<string, 'strong' | 'weak'>;
  private readonly unbound: Set<string>;             // U⟨?x⟩
  private readonly bound: Set<string>;               // B⟨?x⟩
}
```

| state                                             | means                                     | serialised as                     |
|---------------------------------------------------|-------------------------------------------|-----------------------------------|
| strong member of a pinned group                   | `sameTerm(?x, c)` — implies `bnd(?x)`     | `SAMETERM(?x, c)`                 |
| weak member of a pinned group                     | `!bound(?x) ∨ sameTerm(?x, c)`            | `!BOUND(?x) \|\| SAMETERM(?x, c)` |
| member of an anchorless group (always strong, §5) | `sameTerm(?x, ?rep)` — implies both bound | `SAMETERM(?x, ?rep)`              |
| unbound                                           | `!bound(?x)`                              | `!BOUND(?x)`                      |
| bound                                             | `bound(?x)`, no term                      | `BOUND(?x)`                       |

Nothing new is serialised: every row but the third is today's form verbatim (`assertions.ts:50-68`),
and the third is the plain `sameTerm` the parser already reads back into an assertion.

**What U and B mean for a group containing `?x`** — these are today's `mergeAssertion` rules
(`assertions.ts:299-307`) unchanged, not new ones:

- U⟨?x⟩ ∧ *strong member*, pinned or anchorless ⇒ contradiction, since strong implies `bnd(?x)`.
- U⟨?x⟩ ∧ *weak member of a pinned group* ⇒ U absorbs it (`¬b ∧ (¬b ∨ φ) ≡ ¬b`) and `?x` leaves the
  group. U never propagates to the other members; a group left a singleton without a term is dropped.
- B⟨?x⟩ ∧ *strong member* ⇒ absorbed. B⟨?x⟩ ∧ *weak member* ⇒ promoted to strong. B⟨?x⟩ ∧ U⟨?x⟩ ⇒
  contradiction.

So `unbound` and `bound` are disjoint from `clusters` as a *consequence*, worth asserting in tests.
Note `!bound(?x) ∨ sameTerm(?x, c)` **is** the weak form, not the unbound one, and there is no
group-level U: it is per variable and always removes that variable from its group. Term propagation
to a whole group — the interop case in the task — is likewise not a rule, just `groupTerm[g] = c`,
with two distinct terms on one group a contradiction.

**#29 already did most of this work.** It moved every licence in the pass from `subType === 'strong'`
to `impliesBound(assertion)` (`:147`, `:596`, `:612`, `:654`, `:666`), and clique membership implies
bound — so those licences need no rewriting at all. A compatibility view `get(name): Assertion |
undefined` returning `{subType, term}` (pinned) or `{subType: 'strong', rep}` (anchorless), answering
`impliesBound` truthfully, carries cliques through them: most of `swapWith` keeps compiling and the
compiler finds every site that must decide what to do with a `rep`.

One rule is genuinely new: **an edge placed nowhere still entails B on its endpoints**, and B may be
licensed downwards where the edge is not. Strictly weaker than the edge, hence always sound — and it
is what collapses `A₁ ⟕ A₂ FILTER(sameTerm(?y, ?z))` with `?z ∉ pVars(A₁)` into a join, via the
OPTIONAL→JOIN rule at `:653-659`. Expose it as `boundImpliedBy()`.

API: `assertTerm/assertUnify/assertUnbound/assertBound/absorb` (`false` on contradiction), `clone`,
`restrictedTo`, `normalisedFor(cVars, pVars)`, `strongSubstitution`, `weakened`, `boundImpliedBy`,
`toExpression`.

## 3. Splitting Θ: split edges, not variables

A strong group is a clique, and cliques are transitively closed, so **any spanning tree of edges is
equivalent to the group**. Naive variable-wise `restrict` is what loses information (`Θ = A⟨x ≡ y⟩`
under `GROUP BY ?x` splits into two singletons and evaporates, where the right answer is empty since
`?y` is out of scope above the GROUP).

Rule: every edge of a spanning forest must be placed — pushed into a target whose licence covers both
endpoints, or kept above. Edges implied by already-placed edges are free. So for `w=x=y=z` over a
join with `cVars(L) ⊇ {w,x}`, `cVars(R) ⊇ {y,z}`:

```
σ_{x=y}( σ_{w=x}(L) ⋈ σ_{y=z}(R) )
```

and when the two pushed sub-cliques share a variable both sides bind (`x=y=z`, `y` shared), the
connecting edge is free — join compatibility *is* the equality on `y` — so `σ_{x=y}(L) ⋈ σ_{y=z}(R)`
needs no filter on top.

## 4. Reuse

**`ClusterSet<string>`: base class.** It has union-by-size and the `mergeGroups(): {oldGroup,
newGroup}` return that `ClusterSolver` uses to migrate satellite maps. Add `clone()` (Θ is copied
constantly), a public non-creating lookup (`getGroup` is `protected`; `ClusterSolver` re-publishes it
by override at `:158`), `remove`, and group iteration.

**`TermClusterSet<T, Term>`: introduce it.** `groupToTerm`, the conflict check and the merge
migration are genuinely shared. It returns a boolean on conflict — a contradiction is a normal
outcome for Θ — and `ClusterSolver` keeps its throwing `registerTermToGroup` as a thin wrapper, so
the unfolding path and its test output do not move. It is generic in the term type because
`ClusterSolver` narrows to `RawBasicTerm` (`RangeSet`, staying in its own override) while Θ allows
any ground term; equality on that type comes in as a constructor-injected comparator rather than a
structural `equals` bound.

**`ClusterSolver` itself: not reused.** Typed over `RangedVar` for triple positions, carries
`groupToExpressions`/`staticExpressionValidation`, and is a single mutable instance on the context
`clear()`ed per pattern, while Θ needs many cheap copies alive at once. Worth stealing later:
`RangeSet` per group (a group in predicate position is a `NamedNode`, so `sameTerm(?p, ?o)` against a
literal `?o` contradicts statically). Triple-term assertions are agreed out of scope.

## 5. Weak assertions stay per-variable-to-a-term

Weak copies are redundant *for correctness*, not useless: they are how intermediate cardinality gets
cut, and keeping the strong assertion on top while a weakened copy prunes the operands below is a win
we keep.

But there is no usable weakening of an **anchorless** group. Cluster-level weak ("all bound members
pairwise `sameTerm`") does not distribute over a join — `μ₁={?x↦a}` and `μ₂={?y↦b}` each satisfy it,
their merge does not — and merging two independent weak edges is unsound
(`W⟨{x,y}⟩ ∧ W⟨{y,z}⟩ ⊭ W⟨{x,y,z}⟩`, take `y` unbound). A term is what makes the weak form work: an
anchor both sides of a join already agree on.

**So: weak ⇔ pinned group.** Every member of an anchorless group is strong. `weakened()` is unchanged
for pinned groups and drops anchorless edges, exactly as it already drops B⟨?x⟩ — not a surrender:
the sub-clique inside one operand's `cVars` still goes down strongly (§3) and the derived B still
travels on its own licence (§2). Two invariants disappear with it: no three-disjunct symmetric weak
form to serialise, hence no reader through which the unsound merge could re-enter, and no
≤2-weak-members bookkeeping.

## 6. Substitution

`Assertions` needs no type change — `RDF.Variable` *is* an `RDF.Term`. `strongSubstitution()` maps
each strong member to the group's term, or to the group's representative: the lexicographically first
member, matching the `localeCompare` convention at `ClusterSolver:239`. Determinism is what keeps the
pass idempotent (no test covers that today — §9 adds one).

`pVars` is preserved exactly as it is for terms: substituting `?s ↦ ?o` removes `?s` from the BGP, so
the `BIND(?o AS ?s)` that `bindAssertedTerms` appends stays **mandatory**. `cVars` survives too —
`withCpVars`'s EXTEND case (`certainlyBoundVars.ts:137-142`) re-derives `?s ∈ cVars` from `?o ∈
cVars`, and `variablesImpliedBoundBy` (`:230`) already adds *both* arguments of a `sameterm`.
`canOccupy` (`assertions.ts:446`) already allows variables in every position.

Three guards:

- `constantFoldOperator('sameterm')` is gated on `isAssertableTerm`, which rejects variables, so the
  residual `sameTerm(?o, ?o)` left by substituting `?s ↦ ?o` will not fold. It should fold to `true`,
  but only for a variable *certainly bound* where the condition is evaluated: the `cVars` of the
  operation below it, plus both ends of every replacement the substitution makes (only a strong
  assertion substitutes, and a clique membership implies bound). Never for an arbitrary `?a` — an
  unbound one makes `sameTerm(?a, ?a)` an error, and no expression has that true-or-error semantics
  (`bound(?a)` answers `false`, which `COALESCE` tells apart).
- `substituteInExpression` folding `bound(?x)` to `true` stays sound.
- `transformExtendsToValues` (`extendsToValues.ts:12-19`) would turn `BIND(?o AS ?s)` over the empty
  BGP into the nonsense `VALUES ?s { ?o }`. Latent bug the new BINDs will trigger; exclude variable
  expressions. `directExtensions` (`utils.ts:102`) already guards correctly.

## 7. Per-operation deltas

- **BGP / PATH** — substitute the representative instead of the term; the multiplicity argument
  carries over (renaming inside a duplicate-free BGP is a restriction).
- **VALUES** — `pruneValues` becomes column-comparing: keep the representative's column, drop the
  others, re-BIND.
- **UNION** — unchanged; unconditional distribution is what makes the task's second example work.
- **FILTER** — unchanged in shape; `collectAssertions` now merges groups as well as terms, and its
  fixpoint must re-run after a merge (still terminates: each round drops a group or pins one).
- **EXTEND** — the target leaves Θ before descending, but do not just delete it: for `BIND(?z AS ?t)`
  under `A⟨?t ≡ ?y⟩`, *transfer* the membership so `A⟨?z ≡ ?y⟩` holds below. The existing renaming
  rule (`:433-445`) generalised, and strictly stronger.
- **GRAPH** — only the pinned case selects a graph; an anchorless group over the graph variable
  teaches nothing statically, so those edges stay above.
- **JOIN / LEFT JOIN** — licence per edge: push into operand `i` if both endpoints ∈ `cVars(Aᵢ)`, or
  if neither is in `pVars(Aⱼ)` for `j ≠ i`; place the rest per §3. Sub-cliques inside one operand's
  `cVars` are worth pushing even when the whole is unlicensed, and an edge placed nowhere still
  offers its derived B (§2) — which for LEFT JOIN fires OPTIONAL→JOIN before any of this.
- **GROUP** — push edges wholly inside the key set; the rest stays above, where `normalise` correctly
  empties on a non-key member.
- **`normalise`** — per member: `∉ pVars` + strong ⇒ empty (FBndII); `∉ pVars` + weak ⇒ drop the
  member; `∈ cVars` ⇒ promote (the same promotion B performs). Then re-check the group (singleton
  without a term ⇒ drop). `bound` and `unbound` keep today's handling verbatim.

## 8. Touch list

`datastructures/ClusterSet.ts` (clone, lookup, remove, iteration) · `datastructures/TermClusterSet.ts`
(new) · `ClusterSolver.ts` (rebase, keep the throwing wrappers) · `utils/assertions.ts` (the class;
`asStrongAssertion` accepting two variables; `mergeAssertion` → merge; `strongTermsOf` →
`strongSubstitution`) · `transformations/pushDownAssertions.ts` (`normalise`, edge-based splitting,
join/left-join/extend/graph/values) · `utils/partialExpressionEvaluation.ts` (fold guard) ·
`transformations/extendsToValues.ts` (latent bug) · `README.md` step 5.1.

## 9. Tests

Extend `test/pushDownAssertions.test.ts` in its existing style, with §6's representative in the
expected output: both task examples verbatim; three-way unification; term-meets-group and the
contradicting variant; the U and B interactions of §2; VALUES column pruning; the §3 join split, both
the spanning-edge and the free-shared-variable case; GROUP BY over a non-key member ⇒ empty;
`BIND(?z AS ?t)` transfer; the derived B firing OPTIONAL→JOIN over an edge that stays on top;
idempotency and input-untouched for each. Plus `eval` round-trips against `assertionPushdown.ttl`
extended with rows where `?s = ?o` holds only sometimes, to guard multiplicities under
UNION/MINUS/paths.

## 10. Settled

Representative = the lexicographically first member of the cluster (§6). The alternative — preferring
whichever member the enclosing PROJECT keeps, to save a BIND — would couple this pass to
`removeProjections`, so it is rejected.

Implementation instructions derived from this study: `agent-task.md`.
