# Implementation task: variable unification in `pushDownAssertions`

`report.md` is the design authority. Read it fully before writing code; this file is the work order,
the invariants you must not break, and the traps that will otherwise cost a review round.

## Goal

Extend the assertion pushdown so that `FILTER(sameTerm(?x, ?y))` travels like `FILTER(sameTerm(?x, c))`
does today, and so that a term meeting a unified group lands on every member of it.

```sparql
SELECT * { ?s ?p ?o FILTER(sameTerm(?s, ?o)) }
-- becomes
SELECT * { ?s ?p ?s . BIND(?s AS ?o) }

SELECT * {
  { ?s ?p ?o FILTER(sameTerm(?s, <ex://x>)) } UNION { ?s <ex://p> ?o }
  FILTER(sameTerm(?s, ?o))
}
-- becomes
SELECT * {
  { <ex://x> ?p <ex://x> . BIND(<ex://x> AS ?s) BIND(<ex://x> AS ?o) }
  UNION
  { ?s <ex://p> ?s . BIND(?s AS ?o) }
}
```

## Before you start

- Check whether the separate `bound` assertion form (B⟨?x⟩, from `sameTerm(?x, ?x)`) has landed on
  `main`. If it has, integrate with it per report §2: B⟨?x⟩ contradicts `U⟨?x⟩`, is absorbed by strong
  membership, and promotes a weak member of a pinned group to strong. If it has not, do not build it —
  it is a separate PR.
- `yarn test` and `yarn lint` must be green before you touch anything, so you can tell your breakage
  from pre-existing breakage.

## Work order

Each phase should build, lint and test green on its own — they are the review units.

### Phase 1 — `ClusterSet` and `TermClusterSet`

`lib/datastructures/ClusterSet.ts`: add `clone()`, a public non-creating lookup
(`groupOf(value): number | undefined`, plus `sameGroup(a, b)` if it reads better at the call sites),
`remove(value)`, and iteration over groups. Keep `getGroup`/`createGroup` as they are otherwise —
`ClusterSolver` overrides both.

`remove` is the one with real semantics: drop the value from `groupToValues` and `valueToGroup`, and
delete the group once it holds fewer than two values and carries no term.

New `lib/datastructures/TermClusterSet.ts`, generic in both the value and the term type, holding
`groupToTerm`, the pin-conflict check **returning a boolean**, and the term migration in the
`mergeGroups` override. Rebase `ClusterSolver` onto it, keeping its throwing `registerTermToGroup` as
a thin wrapper over the boolean and leaving the `RangeSet` narrowing in its own override.

**Acceptance:** every existing test passes byte-identically. `ClusterSolver`'s public behaviour,
including which errors it throws with which messages, does not change.

### Phase 2 — `AssertionConjunction`

In `lib/utils/assertions.ts` (or a new file next to it, your call), the class from report §2 on top of
`TermClusterSet<string, RDF.Term>`: `clusters`, `groupTerm`, per-*variable* `strength`, `unbound`.

Public API: `assertTerm` / `assertUnify` / `assertUnbound` / `absorb` (all returning `false` on
contradiction, mirroring today's `mergeAssertion` returning `undefined`), `clone`, `restrictedTo`,
`normalisedFor(cVars, pVars)`, `strongSubstitution`, `weakened`, `toExpression`, plus the
compatibility view `get(name)` and `groups()`.

The four states, their meaning and their serialisation are the table in report §2 — implement exactly
those, and no fifth state. Extend `asStrongAssertion` to accept two variables. `mergeAssertion` folds
into the class.

**Acceptance:** unit tests for the state algebra, including every row of the `U⟨?x⟩` interaction list
in report §2 and the invariant that `unbound` and `clusters` stay disjoint.

### Phase 3 — the pass

`lib/transformations/pushDownAssertions.ts`, per report §7: `normalise` becomes group-aware, `restrict`
becomes edge-based splitting (§3), and JOIN / LEFT JOIN / EXTEND / GRAPH / GROUP / VALUES / BGP / PATH
take their deltas.

Also in this phase, the two collateral fixes from report §6:

- `utils/partialExpressionEvaluation.ts`: let `constantFoldOperator('sameterm')` fold `sameTerm(?v, ?v)`
  to `true`, but **only** for variables in the substitution's image. Never for an arbitrary variable —
  unbound makes it false.
- `transformations/extendsToValues.ts:12-19`: exclude variable expressions from the VALUES conversion.
  This is a latent bug today; the new `BIND(?s AS ?o)` would turn into the nonsense `VALUES ?o { ?s }`.

### Phase 4 — docs

`README.md` step 5.1, and the `@fileoverview` of `pushDownAssertions.ts`. Match the existing
documentation register: that file explains *why* each rewrite is licensed, cites the Schmidt et al.
rule names, and states its invariants. New rules deserve the same treatment — especially the clique /
spanning-edge argument and the "weak ⇔ pinned" invariant, which are not guessable from the code.

## Invariants — do not break these

1. **`pVars` exactly preserved, `cVars` never shrunk, multiplicities preserved.** Substituting
   `?o ↦ ?s` removes `?o` from the pattern, so the `BIND(?s AS ?o)` from `bindAssertedTerms` is
   mandatory, not cosmetic. `SELECT *` scoping depends on it.
2. **Weak ⇔ pinned group.** Every member of an anchorless group is strong. There is no weak form of a
   variable-to-variable assertion; `weakened()` drops anchorless edges rather than inventing one. See
   report §5 for why — the counterexamples are short and worth reading before you decide otherwise.
3. **Split edges, never variables.** A group's constraint is a clique; what you push plus what you keep
   must span it. Variable-wise `restrict` silently loses edges (report §3).
4. **Deterministic representative**: the lexicographically first member of the cluster. The pass must
   stay idempotent.
5. **Contradiction is a value, not an exception** — it becomes `emptyOperation`, never a throw.
6. The pass never mutates its input tree.

## Traps

- Weakening an anchorless group looks like the obvious generalisation and is unsound (report §5).
- Emitting a symmetric three-disjunct weak form would need a reader, and reading it back is exactly the
  unsound merge. Invariant 2 keeps this from ever arising — do not work around it.
- `?x` as an EXTEND target must leave Θ before descending, but deleting it loses its edges. Transfer
  them to the expression's variable instead (report §7, generalising `pushDownAssertions.ts:411-425`).
- `substituteInExpression` folding `bound(?x)` to `true` stays correct for var-representative
  substitution; do not "fix" it.
- `canOccupy` already permits variables in every position — no change needed there, and adding one
  will silently empty valid patterns.

## Tests

Extend `test/pushDownAssertions.test.ts` in its existing style (SPARQL in, generated SPARQL out; pin
exact expected strings by running the generator, do not hand-write them). Cover:

- both goal queries above, verbatim
- three-way unification; unification that meets a term; the contradicting variant (`?x ≡ ?y`,
  `?x ≡ :c`, `?y ≡ :d`) ⇒ `FILTER(false)`
- `U` against a strong member ⇒ empty; `U` against a weak member of a pinned group ⇒ absorbed, group
  keeps its other members
- VALUES column pruning and re-binding
- the report §3 join split: the spanning-edge case, and the case where a shared variable makes the
  connecting edge free
- GROUP BY where one member is a key and one is not ⇒ empty
- `BIND(?z AS ?t)` under `?t ≡ ?y` ⇒ `?z ≡ ?y` below
- OPTIONAL → JOIN via a unification over a right-only variable
- idempotency (`transform(transform(q)) === transform(q)`) and input-tree-untouched for each new case

Plus `eval` round-trips in the existing block, against `test/statics/assertionPushdown.ttl` extended
with rows where `?s = ?o` holds only sometimes, to guard multiplicities under UNION, MINUS and paths.

## Out of scope

Triple-term assertions (`sameTerm(?t, <<( ?s ?p ?o )>>)`), `RangeSet` narrowing per group, the `bound`
form itself, and any change to the unfolding path beyond the `ClusterSolver` rebase in phase 1.

## Verify

`yarn lint` · `yarn test` · `yarn build`. Report honestly which of the three are green; if something in
the scope above turns out to be blocked, finish everything else and say explicitly what you left out
and why.
