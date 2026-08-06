# Study: extending `AssertionConjunction` with variable unification

Goal: handle `FILTER(sameTerm(?x, ?y))` next to today's `FILTER(sameTerm(?x, c))`, so `?s ?p ?o
FILTER(sameTerm(?s, ?o))` becomes `?s ?p ?s . BIND(?s AS ?o)`, and a unification that later meets a
term drags that term onto every variable it unified.

Not hypothetical input: `rewriteSinglePattern`'s `headUnificationFilter`
(`rewriteSinglePattern.ts:186-197`) already emits chains of `sameTerm(?mA, ?mB)` for every mapping-head
cluster without a term. They currently sit in the unfolded body and never move.

## 1. The one structural fact

Today's `Θ` is a conjunction of *independent, single-variable* constraints. That is what licenses
`restrict()` (`pushDownAssertions.ts:666`), the per-variable `normalise`, and the per-variable FJPush
check in `pushIntoJoin`. Unification breaks the independence, and everything below follows.

Sharp dividing line: a group **pinned to a term** still decomposes into per-variable conjuncts and
behaves exactly as today. A group **without a term** is a clique of equalities that must be reasoned
about as a whole.

## 2. The four states, and what they mean together

```ts
export class AssertionConjunction {
  private readonly clusters: ClusterSet<string>;     // variable -> group
  private readonly groupTerm: Map<number, RDF.Term>; // group -> its term, if pinned
  // Per *variable*, not per group: `normalise` promotes each member against cVars/pVars separately,
  // so one member of a pinned group can be strong while another is weak.
  private readonly strength: Map<string, 'strong' | 'weak'>;
  private readonly unbound: Set<string>;             // U⟨?x⟩
  ...
}
```

| state                                             | means                                     | serialised as                     |
|---------------------------------------------------|-------------------------------------------|-----------------------------------|
| strong member of a pinned group                   | `sameTerm(?x, c)` — implies `bnd(?x)`     | `SAMETERM(?x, c)`                 |
| weak member of a pinned group                     | `!bound(?x) ∨ sameTerm(?x, c)`            | `!BOUND(?x) \|\| SAMETERM(?x, c)` |
| member of an anchorless group (always strong, §5) | `sameTerm(?x, ?rep)` — implies both bound | `SAMETERM(?x, ?rep)`              |
| unbound                                           | `!bound(?x)`                              | `!BOUND(?x)`                      |

Nothing new is serialised: the first, second and fourth row are today's forms verbatim, and the third
is the plain `sameTerm` the parser already reads back into an assertion.

**What `U⟨?x⟩` means for a group containing `?x`.** The answer is that the combination cannot arise,
and that is forced by the algebra rather than chosen:

- `U⟨?x⟩` ∧ *`?x` strong in any group* ⇒ **contradiction** ⇒ `FILTER(false)`. Strong membership implies
  `bnd(?x)`, whether the group is pinned (`sameTerm(?x, c)`) or anchorless (`sameTerm(?x, ?rep)`).
- `U⟨?x⟩` ∧ *`?x` weak in a pinned group* ⇒ **U absorbs it** (`¬b ∧ (¬b ∨ φ) ≡ ¬b`), so `?x` leaves the
  group carrying `U⟨?x⟩`. This is today's `mergeAssertion` rule (`assertions.ts:261-263`) unchanged.
- `U` **never propagates** to the other members: they keep whatever they had, and the group simply
  loses one variable (dropping to a singleton without a term ⇒ dropped entirely).

So `unbound` is disjoint from `clusters` as a *consequence*. The merge routine establishes it, and it
is worth asserting in tests.

To the "or" reading in your question: `!bound(?x) ∨ sameTerm(?x, c)` **is** the weak form, not the
unbound one. `U` is the strict `!bound(?x)`, and it absorbs the weak form rather than being it. There
is no group-level `U` ("all members unbound") — `U` is per variable and always removes that variable
from its group.

Other structure notes:

- Term propagation to a whole group — the interop case in the task — is not a rule, just
  `groupTerm[g] = c`. Two distinct terms on one group is a contradiction.
- Keep a compatibility view `get(name): Assertion | undefined` returning `{subType, term}` (pinned,
  unchanged) or `{subType: 'strong', rep}` (anchorless): most of `swapWith` keeps compiling, and the
  compiler finds every site that must now decide what to do with a `rep`.
- API: `assertTerm/assertUnify/assertUnbound/absorb` (returning `false` on contradiction), `clone`,
  `restrictedTo`, `normalisedFor(cVars, pVars)`, `strongSubstitution`, `weakened`, `toExpression`.
- `certainlyBoundVars.variablesImpliedBoundBy` (`:230`) already adds both `sameterm` arguments to
  `cVars` — no change needed there.

**Interaction with the `bound` form you are landing first.** B⟨?x⟩ slots in as the promoter of the
strength lattice `unbound < weak < strong`: B⟨?x⟩ contradicts `U⟨?x⟩`, is implied by (so absorbed
into) strong membership, and **promotes a weak member of a pinned group to strong** — exactly what
`normalise` does today when it finds the variable in `cVars`. Nothing about cliques changes, since
every member of an anchorless group is already bound.

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

**`ClusterSet<string>`: base class.** It already has union-by-size and the
`mergeGroups(): {oldGroup, newGroup}` return that `ClusterSolver` uses to migrate satellite maps.
Needs adding: `clone()` (Θ is copied constantly), a public non-creating lookup (`getGroup` is
`protected`, `ClusterSolver` re-publishes it by override at `:158`), `remove`/`restrictedTo` (it
currently only grows), and group iteration.

**`TermClusterSet<T, TTerm>`: introduce it.** `groupToTerm`, the conflict check and the merge
migration are genuinely shared, so both `ClusterSolver` and `AssertionConjunction` extend it. It
returns a boolean on conflict — which is what Θ needs, since a contradiction is a normal outcome here
— and `ClusterSolver` keeps its throwing `registerTermToGroup` as a thin wrapper, so the unfolding
path and its test output do not move. The `RangeSet` narrowing stays in `ClusterSolver`'s override; it
is generic in the term type because `ClusterSolver` narrows to `RawBasicTerm` while Θ allows any
ground term.

**`ClusterSolver` itself: not reused.** Typed over `RangedVar` for triple positions, carries
`groupToExpressions` / `staticExpressionValidation`, and is a single mutable instance on the context
(`transformContext.ts:187`) `clear()`ed per pattern, while Θ needs many cheap copies alive at once.

Worth stealing later: `RangeSet` per group (a group in predicate position is a `NamedNode` — would
statically contradict `sameTerm(?p, ?o)` against a literal `?o`). Triple-term assertions
(`sameTerm(?t, <<( ?s ?p ?o )>>)`, today rejected by `isAssertableTerm`) are agreed out of scope.

## 5. Weak assertions stay per-variable-to-a-term

Weak copies are redundant *for correctness*, not useless: they are exactly how intermediate
cardinality gets cut, and keeping the strong assertion on top while a weakened copy prunes the
operands below is a win we keep. Being redundant is also what makes them safe to drop whenever they
conflict, which is what the rule below relies on.

But there is no usable weakening of an **anchorless** group. Cluster-level weak ("all bound members
pairwise `sameTerm`") does not distribute over a join — `μ₁={?x↦a}` and `μ₂={?y↦b}` each satisfy it,
their merge does not — and merging two independent weak edges is unsound
(`W⟨{x,y}⟩ ∧ W⟨{y,z}⟩ ⊭ W⟨{x,y,z}⟩`, take `y` unbound). A term is what makes the weak form work,
because it is an anchor both sides of a join already agree on.

**So: weak ⇔ pinned group.** Invariant: every member of an anchorless group is strong. Consequences,
all simplifications:

- `weakened()` is unchanged for pinned groups (today's behaviour, fully alive) and drops anchorless
  edges. "Drops" is not "gives up": what the licence permits still goes down strongly, per §3 — the
  sub-clique inside one operand's `cVars` is pushed either way, and only the weakening fallback is
  gone.
- No new serialised form (§2 table), hence no reader for a three-disjunct symmetric weak form, hence
  no way for the unsound weak-edge merge to enter through a re-read.
- No ≤2-weak-members invariant to maintain.

## 6. Substitution

`Assertions` needs no type change — `RDF.Variable` *is* an `RDF.Term`. `strongSubstitution()` maps
each strong member to the group's term, or to the group's representative variable (lexicographically
first member, matching the `localeCompare` convention at `ClusterSolver:239`; determinism is what
keeps the pass idempotent, test `:1098`).

`pVars` is preserved exactly as it is for terms: substituting `?o ↦ ?s` removes `?o` from the BGP, so
the `BIND(?s AS ?o)` that `bindAssertedTerms` (`:720`) appends stays **mandatory**. `cVars` survives
too — `withCpVars`'s EXTEND case (`certainlyBoundVars.ts:137-142`) re-derives `?o ∈ cVars` from
`?s ∈ cVars`. `canOccupy` (`assertions.ts:391`) already allows variables in every position.

Three guards:

- `constantFoldOperator('sameterm')` is gated on `isAssertableTerm`, which rejects variables, so the
  residual `sameTerm(?s, ?s)` will not fold. It should fold to `true` — but only because a strong
  group implies bound. Fold only for variables in the substitution's image; never for an arbitrary
  `?a` (unbound makes it false).
- `substituteInExpression` folding `bound(?x)` to `true` stays sound.
- `transformExtendsToValues` (`extendsToValues.ts:12-19`) would turn `BIND(?s AS ?o)` over the empty
  BGP into the nonsense `VALUES ?o { ?s }`. Latent bug the new BINDs will trigger; exclude variable
  expressions. `directExtensions` (`utils.ts:102`) already guards correctly.

## 7. Per-operation deltas

- **BGP / PATH** — substitute the representative instead of the term; existing multiplicity arguments
  carry over (renaming inside a duplicate-free BGP is a restriction).
- **VALUES** — `pruneValues` becomes column-comparing; keep the representative's column, drop the
  others, re-BIND.
- **UNION** — unchanged; unconditional distribution is what makes the task's second example work.
- **FILTER** — unchanged in shape; `collectAssertions` now merges groups as well as terms, and its
  fixpoint must also re-run after a merge (still terminates: each round drops a group or pins one).
- **EXTEND** — the target leaves Θ before descending, but do not just delete it: for `BIND(?z AS ?t)`
  under `A⟨?t ≡ ?y⟩`, *transfer* the membership so `A⟨?z ≡ ?y⟩` holds below. That is the existing
  renaming rule (`:411-425`) generalised, and strictly stronger.
- **GRAPH** — only the pinned case selects a graph; an anchorless group over the graph variable
  teaches nothing statically, keep those edges above.
- **JOIN / LEFT JOIN** — licence per edge: push into operand `i` if both endpoints ∈ `cVars(Aᵢ)`, or if
  neither is in `pVars(Aⱼ)` for `j ≠ i`; place the rest per §3. Sub-cliques inside one operand's
  `cVars` are worth pushing even when unlicensed as a whole (sideways information passing).
- **GROUP** — push edges wholly inside the key set; the rest stays above, where `normalise` correctly
  empties on a non-key member.
- **`normalise`** — per member: `∉ pVars` + strong ⇒ empty; `∉ pVars` + weak ⇒ drop the member;
  `∈ cVars` ⇒ promote. Then re-check the group (singleton without a term ⇒ drop).

## 8. Touch list

`datastructures/ClusterSet.ts` (clone, lookup, remove, iteration) · `datastructures/TermClusterSet.ts`
(new) · `ClusterSolver.ts` (rebase onto it, keep the throwing wrappers) · `utils/assertions.ts` (the
class; `asStrongAssertion` accepting two variables; `mergeAssertion` → merge; `strongTermsOf` →
`strongSubstitution`) · `transformations/pushDownAssertions.ts` (`normalise`, edge-based splitting,
join/left-join/extend/graph/values) · `utils/partialExpressionEvaluation.ts` (fold guard) ·
`transformations/extendsToValues.ts` (latent bug) · `README.md` step 5.1.

## 9. Tests

Extend `test/pushDownAssertions.test.ts` in its existing style: both task examples verbatim;
three-way unification; term-meets-group and the contradicting variant; `U` against a strong member
(⇒ empty) and against a weak member of a pinned group (⇒ absorbed, group keeps its other members);
VALUES column pruning; the §3 join split, both the spanning-edge and the free-shared-variable case;
GROUP BY over a non-key member ⇒ empty; `BIND(?z AS ?t)` transfer; OPTIONAL→JOIN; idempotency and
input-untouched for each; plus `eval` round-trips against `assertionPushdown.ttl` extended with rows
where `?s = ?o` holds only sometimes, to guard multiplicities under UNION/MINUS/paths.

## 10. Settled

Representative = the lexicographically first member of the cluster (§6). The alternative — preferring
whichever member the enclosing PROJECT keeps, to save a BIND — would couple this pass to
`removeProjections`, so it is rejected.

Implementation instructions derived from this study: `agent-task.md`.
