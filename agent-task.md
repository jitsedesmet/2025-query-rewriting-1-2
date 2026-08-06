# Implementation task: variable unification in `pushDownAssertions`

`report.md` is the design authority — read it fully first. This file is the work order, the invariants
and the traps.

## Goal

Extend the pushdown so `FILTER(sameTerm(?x, ?y))` travels like `FILTER(sameTerm(?x, c))` does today,
and so a term meeting a unified group lands on every member of it.

The representative of a cluster is its **lexicographically first member** (report §6): `{?s, ?o}`
unifies onto `?o`, `{?a, ?b, ?c}` onto `?a`. Every example follows that; so must your tests.

```sparql
SELECT * { ?s ?p ?o FILTER(sameTerm(?s, ?o)) }
-- becomes
SELECT * { ?o ?p ?o . BIND(?o AS ?s) }

SELECT * {
  { ?s ?p ?o FILTER(sameTerm(?s, <ex://x>)) } UNION { ?s <ex://p> ?o }
  FILTER(sameTerm(?s, ?o))
}
-- becomes
SELECT * {
  { <ex://x> ?p <ex://x> . BIND(<ex://x> AS ?s) BIND(<ex://x> AS ?o) }
  UNION
  { ?o <ex://p> ?o . BIND(?o AS ?s) }
}
```

## Before you start

Read `6016788` (#29, the BOUND assertion). It is the closest model for this work, and it moved every
licence in the pass from `subType === 'strong'` to `impliesBound(assertion)`. That predicate is your
hook: clique membership implies bound, so those licences are reused, not rewritten.

`yarn test` and `yarn lint` must be green before you touch anything.

## Work order

Each phase should build, lint and test green on its own — they are the review units.

**Phase 1 — `ClusterSet` and `TermClusterSet`.** Add to `ClusterSet`: `clone()`, a public non-creating
lookup (`groupOf(value): number | undefined`), `remove(value)`, group iteration. `remove` is the one
with real semantics: drop from `groupToValues` and `valueToGroup`, and delete the group once it holds
fewer than two values and carries no term. Then a new `lib/datastructures/TermClusterSet.ts`, generic
in value and term type, holding `groupToTerm`, the pin-conflict check **returning a boolean**, and the
term migration in the `mergeGroups` override; rebase `ClusterSolver` onto it, keeping its throwing
`registerTermToGroup` as a thin wrapper and its `RangeSet` narrowing in its own override.
*Acceptance:* every existing test passes byte-identically, `ClusterSolver` throws the same errors.

**Phase 2 — `AssertionConjunction`.** The class from report §2 on `TermClusterSet<string, RDF.Term>`,
in `lib/utils/assertions.ts` or a new file next to it. Exactly the five states in that table, no
sixth. `mergeAssertion` folds into it. `asStrongAssertion` accepts two variables. The `get(name)` view
must answer `impliesBound` truthfully for group members — that is what carries cliques through phase
3 — and `boundImpliedBy()` returns the B⟨?x⟩ each clique member entails.
*Acceptance:* unit tests for the state algebra, every U and B interaction in report §2, and the
invariant that `unbound` and `bound` stay disjoint from `clusters`.

**Phase 3 — the pass.** Per report §7: `normalise` becomes group-aware, `restrict` becomes edge-based
splitting (§3), and JOIN / LEFT JOIN / EXTEND / GRAPH / GROUP / VALUES / BGP / PATH take their deltas.
The `impliesBound` licences (`:147`, `:596`, `:612`, `:654`, `:666`) should not need rewriting. What
you add on top is the derived-B rule: when an edge is placed nowhere, still offer B⟨?x⟩ on its
endpoints to each operand, on the licence that already exists for it — that is what makes the
OPTIONAL→JOIN collapse (`:653-659`) fire on a pure unification.

Plus the two collateral fixes from report §6: let `constantFoldOperator('sameterm')` fold
`sameTerm(?v, ?v)` to `true` but **only** for variables in the substitution's image (never an
arbitrary variable — unbound makes it false), and exclude variable expressions from
`extendsToValues.ts:12-19`, which today would turn `BIND(?o AS ?s)` into the nonsense
`VALUES ?s { ?o }`.

**Phase 4 — docs.** `README.md` step 5.1 and the `@fileoverview` of `pushDownAssertions.ts`. Match the
existing register: that file explains *why* each rewrite is licensed and cites the Schmidt et al. rule
names. The clique/spanning-edge argument and the "weak ⇔ pinned" invariant are not guessable from the
code, so they belong there.

## Invariants — do not break these

1. **`pVars` exactly preserved, `cVars` never shrunk, multiplicities preserved.** Substituting
   `?s ↦ ?o` removes `?s` from the pattern, so the `BIND(?o AS ?s)` is mandatory, not cosmetic.
2. **Weak ⇔ pinned group.** Every member of an anchorless group is strong; `weakened()` drops
   anchorless edges rather than inventing a weak form (report §5 — the counterexamples are short).
3. **Split edges, never variables.** What you push plus what you keep must span the clique (§3).
4. **Deterministic representative**: lexicographically first, so `{?s, ?o}` unifies onto `?o`, never
   onto `?s`. The pass must stay idempotent.
5. **Contradiction is a value, not an exception** — it becomes `emptyOperation`, never a throw.
6. The pass never mutates its input tree.

## Traps

- Weakening an anchorless group looks like the obvious generalisation and is unsound (report §5). Nor
  should you serialise a symmetric three-disjunct weak form: reading it back *is* the unsound merge.
- `?x` as an EXTEND target must leave Θ before descending, but deleting it loses its edges — transfer
  them to the expression's variable (`pushDownAssertions.ts:433-445` generalised).
- `substituteInExpression` folding `bound(?x)` to `true` stays correct for var-representative
  substitution; do not "fix" it.
- `canOccupy` already permits variables in every position; adding a check there silently empties valid
  patterns.

## Tests

Extend `test/pushDownAssertions.test.ts` in its existing style (SPARQL in, generated SPARQL out; pin
expected strings by running the generator, not by hand). Cover: both goal queries verbatim; three-way
unification; unification meeting a term, and the contradicting variant (`?x ≡ ?y`, `?x ≡ :c`,
`?y ≡ :d`) ⇒ `FILTER(false)`; the U and B interactions of report §2; VALUES column pruning and
re-binding; the §3 join split, spanning-edge and free-shared-variable cases; GROUP BY where one member
is a key and one is not ⇒ empty; `BIND(?z AS ?t)` under `?t ≡ ?y` ⇒ `?z ≡ ?y` below; OPTIONAL→JOIN via
a unification over a right-only variable, asserting the collapse happens even though the edge itself
stays above; idempotency and input-tree-untouched for each new case.

Plus `eval` round-trips in the existing block, against `test/statics/assertionPushdown.ttl` extended
with rows where `?s = ?o` holds only sometimes, to guard multiplicities under UNION, MINUS and paths.

## Out of scope

Triple-term assertions (`sameTerm(?t, <<( ?s ?p ?o )>>)`), `RangeSet` narrowing per group, and any
change to the unfolding path beyond the `ClusterSolver` rebase in phase 1.

## Verify

`yarn lint` · `yarn test` · `yarn build`. Report honestly which are green; if something is blocked,
finish everything else and say explicitly what you left out and why.
