# Study: extending `AssertionConjunction` with triple terms

**Scope.** What has to change in the assertion machinery (`lib/utils/assertionConjunction.ts`,
`lib/utils/assertions.ts`, `lib/datastructures/TermClusterSet.ts`,
`lib/utils/partialExpressionEvaluation.ts`, `lib/transformations/pushDownAssertions.ts`) so that
a filter constraining the *structure* of a triple term pushes down, and interoperates with the term
assertions of #28/#29 and the variable cliques of #30.

The target:

```sparql
SELECT * { ?s ?p ?o FILTER(sameTerm(subject(?o), ?s)) }
```
```sparql
SELECT * { ?s ?p <<( ?s ?o_p ?o_o )>> . BIND(<<( ?s ?o_p ?o_o )>> AS ?o) }
```

---

## 0. Recommendation in one page

1. **Do not add a "triple term assertion" as a fifth/sixth *form*.** Generalise what a conjunct is
   *about*: today it is a variable, it should become an **access** — a variable read through a chain
   of triple-term accessors (`?x`, `subject(?x)`, `object(subject(?x))`). Every existing form
   (A/W/B/U) then applies unchanged, and the whole feature is *one* new form, `T⟨?x⟩ ≔ isTRIPLE(?x)`,
   which is only ever the degenerate case of "this thing is a triple term but I know nothing about its
   parts".
2. **Reuse `TermClusterSet`, with one generalisation**: a group is pinned not to a *term* but to a
   **shape** — either a ground term (as today) or a triple constructor whose three children are
   *group ids*. Pin conflict resolution generalises from `compareTerm` (equal or contradiction) to
   `meetPins` (equal, contradiction, or **decompose into child unifications**). That is textbook
   syntactic unification / congruence closure, and it is what makes the interop with #30 automatic:
   the shape lives on the *group*, so unifying `?o` with `?x` makes everything known about
   `subject(?o)` known about `subject(?x)` by construction.
3. **Fresh variables are a rendering concern, not part of Θ.** Unconstrained positions stay
   *anonymous groups* inside the conjunction; a fresh variable is coined only where the pass writes a
   triple term into a *pattern*, and is derived from the group representative so the pass stays
   idempotent. Serialising Θ back to a `FILTER` never coins one — the accessor form
   (`sameTerm(subject(?o), ?s)`) says the same thing without mentioning the unknown positions.
4. **The existing dividing line survives verbatim.** "Weak ⇔ pinned group" becomes the same rule it
   always was: *a conjunct mentioning one variable has a weak form; a conjunct mentioning two does
   not*. `sameTerm(subject(?o), :a)` weakens to `!bound(?o) || sameTerm(subject(?o), :a)`;
   `sameTerm(subject(?o), ?s)` is a clique edge and does not weaken.
5. **Two new soundness obligations** that the term-only pass never had: an **occurs check**
   (`?o ≡ <<( ?o ?p ?q )>>` is unsatisfiable and must yield the empty operation, and without it the
   substitution does not terminate), and **positional ranges** (a triple term is never a subject, a
   predicate, or a graph name) — for which `RangeSet` already exists and can be lifted into the shared
   base class.
6. **Two invariants genuinely bend** and need your decision (§6): materialising a shape adds fresh
   variables to `pVars`, and `BIND(<<( … )>> AS ?o)` loses `?o` from `cVars` under the current
   `withCpVars` rule. Both have cheap, local fixes; neither is a soundness problem, but the second
   silently costs optimisation power everywhere if left alone.

Phasing (§10) puts the ground-triple-term case first — it is ~30 lines and needs none of the above.

---

## 1. What the feature has to express

### 1.1 The four facts a triple-term filter carries

`FILTER(sameTerm(subject(?o), ?s))` is *not* an assertion about `?o`'s value. It says four things at
once:

| | fact | why |
|---|---|---|
| (a) | `bound(?o)` | every function errors on an unbound argument, and an erroring conjunct of a filter is `false` |
| (b) | `isTRIPLE(?o)` | `SUBJECT` raises a type error on anything else |
| (c) | `bound(?s)` and `subject(?o) ≡ ?s` | `sameTerm` errors on an unbound argument |
| (d) | nothing at all about `predicate(?o)`, `object(?o)` | |

(a) and (c) are what the pass already understands (B⟨?x⟩ and a clique edge). (b) is new. (d) is what
forces fresh variables at materialisation time, and is the reason the internal representation must be
able to say *"a triple term, one of whose positions I have no name for"*.

### 1.2 The three things structure adds over cliques

* **Congruence.** From `?o ≡ ?x` it must follow that `subject(?o) ≡ subject(?x)`. This is exactly
  what the task asks for ("if a unified group of variables gets asserted, this information would also
  travel down as such") and it is free if the shape is a property of the *group* rather than of the
  variable.
* **Decomposition.** From `?o ≡ <<( ?a ?b ?c )>>` and `?o ≡ <<( ?d ?e ?f )>>` it must follow that
  `?a ≡ ?d`, `?b ≡ ?e`, `?c ≡ ?f`. A pin conflict is therefore no longer automatically a
  contradiction, which is the one place `TermClusterSet`'s current contract is too narrow.
* **Acyclicity.** RDF terms are finite trees, so `?o ≡ <<( ?o :p :q )>>` has no solution. Detecting it
  is not optional: it is both a real (if rare) optimisation — the whole plan is empty — and the
  termination argument for resolving a group to a term.

---

## 2. Representation

### 2.1 Accesses: the conjunct language

```ts
/** A position inside a triple term. RDF triple terms have no graph slot. */
export type TriplePosition = 'subject' | 'predicate' | 'object';

/**
 * A variable read through a chain of triple-term accessors:
 * `?x` (no positions), `subject(?x)`, `object(subject(?x))`.
 */
export interface Access {
  name: string;
  positions: readonly TriplePosition[];
}

/** The identity an access is keyed by, so that two spellings of one access are one value. */
export function accessId(access: Access): string {
  return [ access.name, ...access.positions ].join('.');
}
```

`AssertionConjunct` becomes `{ access: Access; assertion: Assertion }`, where today's
`{ name, assertion }` is the `positions: []` case. The right-hand side of a strong/weak assertion
becomes `RDF.Term | Access` — a variable RHS is the zero-length access, and I would normalise to *one*
spelling (`Access`) rather than keep `DF.variable(x)` and `{name:x, positions:[]}` both meaning the
same thing; `conjunctVars` and `splitClique` currently pattern-match on `term.termType === 'Variable'`
and would otherwise have to match on both.

`U⟨π⟩` and `B⟨π⟩` stay restricted to `positions.length === 0`: `BOUND` takes a `Var` by grammar, and
`bound(subject(?o))` is neither writable nor meaningful (the subject of a triple term is always bound).

The point of accesses is **serialisation without fresh variables**. `Θ` containing "`?o` is a triple
term whose subject is `?s`" writes back as `FILTER(sameTerm(subject(?o), ?s))` — the same condition it
was read from, which is what keeps the pass idempotent and what lets an unplaceable shape stay on top
of an operation without inventing variables that are unbound there (§5.2).

### 2.2 Pins: from term to shape

```ts
/** What a group is fixed to. Ordered by information: none ⊑ triple ⊑ ground quad, none ⊑ ground term. */
export type Pin =
  | { kind: 'term'; term: RDF.Term }                       // ground, as today (quads allowed, see §3)
  | { kind: 'triple'; children: [ number, number, number ] }; // group ids, in S/P/O order
```

A group may have no pin (a clique, as today), a `term` pin (a pinned group, as today), or a `triple`
pin (new). The children are **group ids, not variable names**, so a position nobody has named is an
*anonymous group*: it exists, it can be unified with things, and it contributes nothing to
`conjuncts()`, `size` or `names()` until some named variable joins it.

That last property is why children are groups and not fresh names. If unconstrained positions were
materialised eagerly as `?o_p`, `?o_o`, then `Θ` would report `size > 0` for conjunctions that say
nothing, `isAssertionFilter` would fire on vacuous filters, `order` would fill with names that never
appear in the plan, and every fresh name would have to be chosen *before* knowing whether it is ever
needed.

The pin lattice makes the meet operation total:

| left ⊓ right | none | term `c` | triple `T'` |
|---|---|---|---|
| **none** | none | term `c` | triple `T'` |
| **term `c`** | term `c` | `c ≡ d` ? term : ⊥ | `c` a ground quad ? decompose : ⊥ |
| **triple `T`** | triple `T` | symmetric | decompose: unify `T[i]` with `T'[i]` |

"Decompose" is the only genuinely new outcome, and it is what lets a *ground* triple term meet a
*shape*: `VALUES ?o { <<( :a :b :c )>> }` under `subject(?o) ≡ ?s` decomposes into `?s ≡ :a` with no
special case anywhere in the pass.

### 2.3 What has to change in `TermClusterSet`

Small and, I think, worth doing in the base class rather than in a third subclass:

* `groupToTerm: Record<number, Term | undefined>` → `groupToPin: Record<number, Pin<Term> | undefined>`,
  or keep the name and let the type parameter carry the structure.
* `compareTerm: (a, b) => boolean` → `meetPins: (a, b) => { pin: Pin; pending: [number, number][] } | false`,
  where `pending` are child group pairs the caller must merge. `ClusterSolver` passes
  `(a, b) => a.equals(b) ? { pin: a, pending: [] } : false` and is unaffected.
* `mergeGroups` / `migrateGroupData` must drain `pending` through a **work list**, not through
  recursion — merging children can merge further children, and a naive recursive `migrateGroupData`
  re-enters `mergeGroups` while its caller is mid-update. Standard congruence closure: push pairs on a
  queue, loop until empty, report contradiction on any `false`.
* `carriesInformation(group)` must also be true when the group **is a child of a live shape**.
  Today the only way a group survives with one member is a term pin; a shape child with one member
  still says something about its parent. Without this, `remove()` drops a group that a `Pin` still
  points at, and the child pointer dangles. This is the sharpest implementation hazard in the whole
  change — either reference-count children or scan `groupToPin` in `carriesInformation`.
* Add an **occurs / acyclicity check**: before pinning group `g` to a shape reachable from `g`, and
  after each merge, verify the child DAG has no cycle. Cheap version: a `resolve(g)` with a
  visited-set that returns "cyclic", called once per merge on the affected component.

Two things fall out of doing it in the base class:

* `ClusterSolver` can drop the `Quad` exclusion in `RawBasicTerm` and finally answer its own TODO at
  `ClusterSolver.ts:191` ("validate in the case of triple term by also registering that some variables
  present might be the same") — the mapping head `?t rdf:reifies <<( ?s ?p ?o )>>` against a pattern
  binding a triple term is *the same unification problem*.
* `groupToRange` (`ClusterSolver.ts:43`) can move down as well, giving `AssertionConjunction`
  positional type narrowing for free (§5.5).

### 2.4 What does *not* change

* The five states, their absorption rules (`assertTerm`, `assertBound`, `assertUnbound`), the
  representative-is-lexicographically-first rule, `split`, `weakened`, `transferred`, `absorb`,
  `normalisedFor`'s `cVars`/`pVars` reading, and every licence in `pushDownAssertions`. They are all
  phrased over conjuncts and their variables, and conjuncts-over-accesses keep those shapes.
* `AssertionConjunctionMeta`, `withAssertionConjunction`, `isAssertionFilter`, the metadata caching.
* `substituteInTerm` / `substituteInPattern` / `canOccupy` — they already recurse into quads and
  already refuse a quad in subject/predicate/graph position.

---

## 3. The new form: `T⟨?x⟩ ≔ isTRIPLE(?x)`

A group with a `triple` pin whose children are all anonymous and uninformative says exactly
`isTRIPLE(?x)`. Rather than treating that as a degenerate shape with no serialisation, give it a name
and a form, because it arises on its own three ways:

* the user writes `FILTER(isTRIPLE(?o))`;
* it is what is left of a shape when the informative positions are dropped — which is how a shape
  *weakens for a target that is not licensed for its children* (§5.3);
* it is what `?o ≡ <<( ?a ?b ?c )>>` degenerates to under a projection that keeps `?o` and drops
  `?a ?b ?c`.

Properties, all of which are the ones the pass already asks of a form:

* **implies bound** — `isTRIPLE` errors on an unbound argument, so it joins `strong` and `bound` in
  `impliesBound`, and triggers (FBndII) and the OPTIONAL→JOIN collapse.
* **has a weak form** — `!bound(?x) || isTRIPLE(?x)` is a legitimate unary predicate on a value, so it
  travels into unlicensed join operands and into the RHS of a MINUS like any other weak assertion.
* **is absorbed by anything stronger** — a term pin to a ground quad, or a shape with informative
  children, entails it.
* **contradicts** `U⟨?x⟩`, and contradicts a term pin to a non-quad.

The state table of `AssertionConjunction` becomes:

| state | means |
|---|---|
| strong member of a term-pinned group | `sameTerm(π, c)` |
| weak member of a term-pinned group | `!bound(root(π)) \|\| sameTerm(π, c)` |
| member of an anchorless group (clique) | `sameTerm(π, ρ)` |
| **strong member of a shape-pinned group** | **`isTRIPLE(π)`, plus one clique edge per informative position** |
| **weak member of a shape-pinned group** | **`!bound(root(π)) \|\| isTRIPLE(π)`** |
| unbound | `!bound(?x)` |
| bound | `bound(?x)`, no term |

The two new rows are not new machinery: the fourth is "clique edges over accesses" and the fifth is
"the unary part of it", which is precisely the general rule stated in §5.3.

---

## 4. Worked traces

### 4.1 The target example

```sparql
SELECT * { ?s ?p ?o FILTER(sameTerm(subject(?o), ?s)) }
```

1. `collectAssertions` recognises `sameTerm(subject(?o), ?s)` as a strong assertion between the
   accesses `subject(?o)` and `?s`. Asserting it walks the path: group(`?o`) has no pin, so it is
   pinned to `triple` with three fresh **anonymous** child groups; the subject child is then merged
   with group(`?s`). Residual: none.
2. `pushAssertions` on the BGP: `cVars = pVars = {s,p,o}`. `normalisedFor` promotes nothing and empties
   nothing — every root is in `pVars`.
3. `swapWith` → `Algebra.Types.BGP` → **pattern substitution**. Group(`?o`) resolves to
   `<<( ?s, fresh(o,predicate), fresh(o,object) )>>`; group(`?s`) resolves to `?s` (its own
   representative). `substituteInPattern` puts the quad in the object position — `canOccupy` already
   permits that, and would already have refused it in the subject slot.
4. `bindAssertedTerms` re-binds the substituted variable: `BIND(<<( ?s ?o_p ?o_o )>> AS ?o)`.

```sparql
SELECT * { ?s ?p <<( ?s ?o_p ?o_o )>> . BIND(<<( ?s ?o_p ?o_o )>> AS ?o) }
```

I verified against the installed traqula that this generates *and* re-parses exactly: the pattern
object round-trips as a nested `Quad` term, and the `BIND` round-trips as a `term` expression holding
a `Quad` with variables (SPARQL 1.2 `ExprTripleTerm`, grammar rule 137). `SUBJECT(?x)` round-trips as
the `subject` operator. No generator or parser work is needed.

### 4.2 Interop with the term assertion and the clique

```sparql
SELECT * {
  ?s ?p ?o . ?a ?b ?o2
  FILTER(sameTerm(?o, ?o2) && sameTerm(subject(?o2), ?s) && sameTerm(?s, :c))
}
```

* `?o ≡ ?o2` merges their groups (existing clique machinery).
* `subject(?o2) ≡ ?s` pins the *merged* group to a shape — so it is `?o`'s shape too, with no extra
  rule. This is the congruence the task asks for.
* `?s ≡ :c` pins the subject child group to `:c`, which travels *into* the shape.
* Both patterns substitute their object to the **same** rendering,
  `<<( <ex://c> ?o_p ?o_o )>>`, and both get their `BIND` back.

Note what fixes the fresh names: they are derived from the **representative of the group carrying the
shape**, not from the variable being substituted. Otherwise `?o` and `?o2` would render as
`<<( :c ?o_p ?o_o )>>` and `<<( :c ?o2_p ?o2_o )>>` and the join would no longer state that they are
equal in those positions — still sound, but a lost inference and a non-idempotent output.

### 4.3 Where it must *not* fire

```sparql
SELECT * { ?s ?p ?o FILTER(sameTerm(subject(?o), ?o)) }
```

The occurs check fires: group(`?o`) would be its own subject child. `assert` returns `false`,
`collectAssertions` returns `undefined`, `contradictory` is set, and `pushFilter` replaces the whole
subtree with the empty operation. Without the check, `resolve` diverges.

### 4.4 Chained accesses and arbitrary depth

```sparql
SELECT * {
  ?s ?p ?o . ?y :q ?x
  FILTER(sameTerm(?x, object(?o)) && sameTerm(?s, predicate(?x)))
}
```

Asserting is two path walks and two merges, neither of which knows how deep it is:

1. `?x ≡ object(?o)`: group(`?o`) has no pin, so it is pinned to `triple` with three anonymous
   children; the *object* child is merged with group(`?x`).
2. `?s ≡ predicate(?x)`: group(`?x`) — which is now also `?o`'s object child, one group, not two — has
   no pin, so it is pinned to `triple` with three fresh anonymous children; its *predicate* child is
   merged with group(`?s`).

```
G_o : triple( ⟨anon⟩, ⟨anon⟩, G_x )
G_x : triple( ⟨anon⟩, G_s,    ⟨anon⟩ )      -- also reachable as G_o.object
G_s : no pin, member ?s
```

and the pass renders

```sparql
SELECT * {
  ?s ?p <<( ?o_s ?o_p <<( ?x_s ?s ?x_o )>> )>> .
  ?y :q <<( ?x_s ?s ?x_o )>> .
  BIND(<<( ?x_s ?s ?x_o )>> AS ?x)
  BIND(<<( ?o_s ?o_p <<( ?x_s ?s ?x_o )>> )>> AS ?o)
}
```

**The algorithm does not care about depth.** Unification is depth-agnostic: a path walk creates one
pin per step, and a merge unifies children pairwise without ever deepening anything. Depth is bounded
by the number of groups (a chain `?a ≡ object(?b)`, `?b ≡ object(?c)`, … of *n* conjuncts of depth 1
produces a shape of depth *n*, so it is not bounded by the syntactic nesting in the query — but it is
finite, and each rendering is linear in the depth below it).

Four things depth does change, all of which are already in this design but were stated for the
one-level case:

**(a) Resolution is a memoised DAG walk, and the occurs check is what makes it terminate.** With one
level, "resolve a group to a term" is a lookup; with chains it is a recursion that must be memoised
per group (`G_x` above is reached both as `?x` and as `?o.object` and must render *identically* in
both) and must be known to be acyclic. `?x ≡ object(?o) ∧ ?o ≡ object(?x)` is a cycle, and it is
unsatisfiable for the same reason as §4.3 — so the occurs check moves from "nice extra emptiness rule"
to load-bearing.

**(b) Every group needs one canonical anchor, shared by serialisation and materialisation.** This is
the part §5.2 left too vague. A group is reachable by several access paths (`G_x` is `?x` and
`object(?o)`; an anonymous child of two shapes, from `predicate(?o) ≡ predicate(?x)`, is `?o_p` and
`?x_p` and is *one* group). Fix

```
anchor(g) = ground pin, else lexicographically first named member,
            else the lexicographically first access path reaching it from a named group
```

memoised per group, and use it for *everything*: the accessor form written into a condition, the
representative a clique substitutes to, and the fresh variable name a materialisation coins
(`?x_s` above is `anchor(G_x) + '_s'`, not `?o_o_s`). Two independent renderings of the same anonymous
group must produce the same variable name or the two patterns above stop joining on it.

**(c) Nesting only ever runs down the `object` chain — provided ranges are tracked.** A triple term is
never a subject and never a predicate, so a `triple` pin on a subject or predicate child is an
immediate contradiction, and any *satisfiable* shape is a chain of object-nested triples whose
subject/predicate positions are all leaves. Without ranges (§5.5) this is not detected at assert time;
it surfaces later as `canOccupy` refusing the substitution and emptying the BGP — sound, but only for
the operations that substitute, so an unsatisfiable shape kept as a residual filter would survive.
Depth is what makes me lean towards doing ranges in this PR rather than after it.

**(d) The paths in `conjuncts()` get longer, and that is all.** `sameTerm(predicate(object(?o)), ?s)`
is what the conjunction writes back when `?x` is not available to anchor the inner group — e.g. after
a `split` that kept `?x` out. Nothing in `weakenedConjunct`, `splitClique`, or the join licences reads
the length: they all read `conjunctVars`, which returns the *roots*, and the root of a path of any
depth is one variable. So a chained conjunct weakens exactly when it has one root
(`!bound(?o) || sameTerm(predicate(object(?o)), :c)`) and behaves as a clique edge when it has two,
per §5.3.

The one pathological case is size rather than correctness: a chain of *n* variables each rendering its
own suffix is O(n²) of pattern text. It needs a query with *n* chained accessor filters to trigger,
and the alternative (rendering `G_x` as `?x` and leaving its shape behind in a filter) throws away
exactly the restriction the pass exists to push into the pattern. I would not cap the depth.

---

## 5. Semantics and soundness

### 5.1 Error vs. `false`: the accessor form is a *filter conjunct*, not an expression

`sameTerm(subject(?o), ?s)` and `sameTerm(?o, TRIPLE(?s, ?p1, ?p2))` are **not** interchangeable
expressions: for a bound non-triple `?o` the first errors and the second is `false`. As *top-level
conjuncts of a `FILTER`* they are interchangeable, because a filter treats an error as `false` — which
is the same identification the existing pass already relies on for `sameTerm` against a term. Two
consequences, both of which are constraints on the implementation rather than caveats on the theory:

* Θ is only ever placed as the condition of a FILTER (or a disjunct of a weak form, where the guard is
  `!bound(root)` and `false || error = error` still drops the row). Fine.
* A shape conjunct must **never** be substituted into an arbitrary expression context. See §5.4.

### 5.2 Fresh variables never appear in a condition

An assertion that cannot be placed stays on top as a `FILTER`. If a shape were serialised as
`sameTerm(?o, <<( ?s ?o_p ?o_o )>>)`, and `?o_p`/`?o_o` were unbound *there* — which they are,
everywhere except the pattern that materialised them — the condition would error and drop every row.
This is a silent wrong-answer bug, and it is avoided structurally: the accessor form mentions only the
variables the conjunction actually knows about, and positions with an uninformative anonymous child
contribute nothing but the `isTRIPLE` anchor.

Rule for `toExpression`, per group with a `triple` pin: emit `isTRIPLE(anchor)` when no position is
informative, otherwise emit one `sameTerm(position(anchor), …)` per informative position (which
already entails `isTRIPLE`). "Anchor" is the group's canonical rendering — a term pin, else the
lexicographically first named member, else the lexicographically first access path reaching it from a
named group — computed **once per group** and reused by every renderer, for the reasons in §4.4(b).

### 5.3 The weak form: one variable weakens, two do not

The file overview currently states this as "weak ⇔ pinned group", justified by
`W⟨{x,y}⟩ ∧ W⟨{y,z}⟩ ⊭ W⟨{x,y,z}⟩`. The general statement, which covers shapes without a new argument:

> A conjunct has a weak form iff it constrains the value of **exactly one** variable.
> `W⟨φ⟩ ≔ !bound(?x) || φ(?x)` is then a predicate on a single value, and the two identities the pass
> lives on — `σ_W(A₁ ⋈ A₂) ≡ σ_W(A₁) ⋈ σ_W(A₂)` and the MINUS-RHS argument — hold for any such
> predicate, because a merged mapping binds `?x` exactly when one of its halves does.

So:

| conjunct | weakens to |
|---|---|
| `sameTerm(?x, c)` | `!bound(?x) \|\| sameTerm(?x, c)` (today) |
| `isTRIPLE(?x)` | `!bound(?x) \|\| isTRIPLE(?x)` |
| `sameTerm(subject(?x), c)` | `!bound(?x) \|\| sameTerm(subject(?x), c)` |
| `sameTerm(object(subject(?x)), c)` | likewise |
| `sameTerm(?x, ?y)` | — (clique edge, today) |
| `sameTerm(subject(?x), ?y)` | — |
| `sameTerm(subject(?x), predicate(?y))` | — |

`weakenedConjunct` therefore keeps its exact current shape: weaken iff `conjunctVars(conjunct).length === 1`,
where `conjunctVars` returns the *roots* of both sides. `weakenedTerms` (the MINUS filter,
`pushDownAssertions.ts:944`) generalises the same way — its argument ("an incompatible RHS mapping
removes nothing anyway") turns on the LHS and RHS agreeing on `?x`'s value, and equal values have
equal subjects, so any unary predicate on the value is admissible, not only `sameTerm` against a term.

There is a second, weaker projection available for two-variable conjuncts that has no analogue for
cliques and is worth having: a shape whose children are not licensed can drop those children and push
`T⟨?x⟩`. `A⟨subject(?o) ≡ ?s⟩` into an operand that binds `?o` but not `?s` still yields
`isTRIPLE(?o)`. This is the shape analogue of "a clique member gets `B⟨?x⟩` where the edge cannot go"
(`splitClique`'s single-member case), and it is exactly a walk down the pin lattice.

### 5.4 Two substitutions, not one

`strongSubstitution()` currently serves two callers with different needs, and shapes force them apart:

* **into patterns** (`substituteIntoPatterns`, `substituteIntoPath`, and the `bindAssertedTerms`
  re-binding): shapes are materialised as quads with fresh variables. Sound because the pattern is
  what *binds* those variables.
* **into expressions** (`collectAssertions`'s fixpoint, `pushIntoExtend`, `pushIntoLeftJoin`'s
  condition): a shape with an anonymous child must **not** be substituted — the fresh variable would
  be unbound in the expression and the whole expression would error. Only *ground* pins (including a
  fully ground quad) and clique representatives may substitute here.

Concretely: `strongSubstitution()` splits into `patternSubstitution(fresh)` and
`expressionSubstitution()`. The `sameSubstitution` fixpoint test in `collectAssertions` compares the
latter, plus a cheap structural version number for the shape/child state — merging two anonymous
children changes nothing in the substitution map but *can* collapse a residual
(`sameTerm(subject(?o), subject(?x))` becomes decidable once `?o ≡ ?x`), so the current
"substitution unchanged ⇒ nothing more to learn" test would stop one round too early.

### 5.5 Positional ranges are free contradictions

`RangeSet` (`lib/RangeSet.ts`) already encodes that a subject is an IRI or blank node, a predicate an
IRI, and an object anything. Lifting `groupToRange` from `ClusterSolver` into the shared base gives
`AssertionConjunction`:

* `FILTER(sameTerm(subject(?o), "lit"))` → empty. `subject(…)` is never a literal, so the condition is
  false whenever it is not an error.
* `FILTER(sameTerm(predicate(?o), ?p) && sameTerm(?p, "x"))` → empty.
* `FILTER(isTRIPLE(?g))` under `GRAPH ?g { … }` → empty; graph names are IRIs. (`pushIntoGraph`
  already returns `empty` for a non-IRI term pin, `pushDownAssertions.ts:564`; a shape pin joins that
  branch.)
* A group in subject range can never take a shape pin at all — which is what confines nesting to the
  `object` chain (§4.4(c)).

This is *nearly* optional for a first cut — most of these merely stay as a residual filter otherwise —
and it is close to free once the pin lives in a class that also has the range. The one case that is
not merely a missed optimisation is a shape pinned into a subject or predicate position: the BGP rule
catches it through `canOccupy`, but an operation that does not substitute would carry an unsatisfiable
residual around instead of collapsing. §4.4(c).

### 5.6 Multiplicity and functional determination

Materialising `?o ↦ <<( ?s ?o_p ?o_o )>>` adds two columns. It does not add rows: the fresh variables
are *functionally determined* by `?o` (`?o_p = predicate(?o)`), so each surviving solution of the
original pattern extends to exactly one solution of the rewritten one. The existing multiplicity
arguments for BGP substitution ("BGPs are duplicate-free and substituting only restricts") carry over
unchanged, and the same determination is what makes it harmless when two join operands materialise the
same fresh names from the same group representative: the extra join equality is entailed.

---

## 6. The two invariants that bend

The pass's stated invariant is: *"Every rewrite here preserves `pVars` exactly, never shrinks `cVars`,
and preserves the multiplicity of every surviving mapping."* Multiplicity holds (§5.6). The other two
need a decision.

### 6.1 `pVars` grows by the fresh variables

Unavoidable: SPARQL has no wildcard in a pattern position, so constraining `?o` to be a triple term
with subject `?s` requires naming the other two positions.

The invariant is used to justify reading licences off `withCpVars` metadata *before* rewriting the
operands. Growth by a fresh name is harmless for that — every licence is a statement about a name that
already existed — provided the fresh names cannot collide with a name the plan uses elsewhere. In the
current pipeline the outer `PROJECT` that `queryTransform` re-attaches
(`transformBgp.ts`, and `SELECT *` is already expanded to an explicit variable list at parse time)
drops them at the query boundary.

I would still recommend the belt-and-braces version, because `pushDownAssertions` is also called
directly (tests, and any future pipeline order): at the entry point, remember `pVars` of the input; if
the result's `pVars` grew, wrap the result in `Project(originalPVars)`. Projection is
multiplicity-preserving in SPARQL algebra, so this is unconditionally safe, and `removeProjections`
already knows how to eliminate a redundant one. Restate the invariant as *"preserves `pVars` up to
fresh variables that are functionally determined and projected away"*.

### 6.2 `BIND(<<( … )>> AS ?o)` loses `?o` from `cVars`

`withCpVars`'s EXTEND case (`certainlyBoundVars.ts:137`) refuses to call a target certain when the
expression is a `Quad` term, because constructing a triple term may raise an evaluation error. So the
re-binding `bindAssertedTerms` emits takes `?o` *out* of `cVars`, where the BGP had put it in.

This is a completeness problem, not a soundness one — every consumer of `cVars` (promotion of weak to
strong in `normalisedFor`, the `sameTerm(?x,?x)` fold, the join and left-join licences) is conservative
when `cVars` shrinks. But it degrades every later assertion in the same plan, so it should not be left
as is. Three options, in my order of preference:

1. **Stamp the metadata.** `withCpVars` returns early when an operation already carries `cVars`/`pVars`,
   which the pass already exploits for its own filters (`assertionFilter` does exactly this for
   assertion metadata). `bindAssertedTerms` knows the construction cannot error — its components come
   from a pattern that just matched a real triple term, so the subject is an IRI/blank node and the
   predicate an IRI — so it can build the `Extend` with `cVars = cVars(input) ∪ {?o}` itself and
   document the argument.
2. **Refine the rule** in `withCpVars`: a quad term expression is certainly bound when every component
   is either a non-variable term valid for its position, or a certainly-bound variable *known* to be
   valid for its position. The second half needs range information `withCpVars` does not have, so in
   practice this only fixes the fully-ground case.
3. Accept the loss and note it. Cheapest, and it makes the ground-quad phase (§10, phase 1) land
   without touching `certainlyBoundVars.ts` at all.

Note that this is the same question as the `isAssertableTerm` TODO (`assertions.ts:106-118`), which
explicitly asks for the two sides to be settled together. For **ground** triple terms the answer is
clean: construction of a ground, well-formed triple term cannot error, so `isAssertableTerm` may admit
it and `withCpVars` may call its target certain. I would settle the ground case as part of phase 1 and
leave the variable case to option 1.

---

## 7. Per-operation impact in `pushDownAssertions`

| operation | change |
|---|---|
| BGP / PATH | `patternSubstitution` instead of `strongSubstitution`; `bindAssertedTerms` gains the quad case (§6.2). `canOccupy` already refuses a quad outside object position, which for a PATH means the current `'object'` reading of the subject slot stays right. |
| VALUES | biggest change. A shape does **not** decide a column (the children differ per row), so it prunes rows and keeps the column. I recommend replacing the per-variable `switch` in `pruneValues` with *"clone Θ, assert the row into it, prune the row iff it contradicts"* — asserting each bound column as a strong ground term and each absent column as `U⟨?x⟩`. That handles terms, cliques, shapes and ground triple terms uniformly, and drops a column exactly when Θ decides it independently of the row (a ground pin). Behaviour on the existing forms must be checked against the current tests, especially the weak/UNDEF cases. |
| UNION / PROJECT / DISTINCT / REDUCED / ORDER BY / FROM | nothing. |
| FILTER | nothing beyond `collectAssertions` (§5.4). |
| GRAPH | a shape pin on `?g` is a contradiction (§5.5) if ranges land; otherwise it behaves like a clique over `?g` and stays on top. The `splitClique` call generalises with the rest. |
| JOIN / LEFT JOIN | licences read over the *roots* of both sides of a conjunct, i.e. `conjunctVars` — no rule change. `splitClique` generalises to "split a group", and additionally may now push the lattice-weakened `T⟨?x⟩` into a target licensed for the root but not the children (§5.3). |
| MINUS | `weakenedTerms` becomes "the conjuncts with exactly one variable, weakened" (§5.3). |
| EXTEND | `transferred` gains two cases, and this is where the existing `TODO(next time)` at `pushDownAssertions.ts:455` lands: `BIND(<<( ?a ?b ?c )>> AS ?o)` under a shape on `?o` transfers the shape onto `?a ?b ?c` (unify child groups with their groups); `BIND(subject(?x) AS ?o)` under anything on `?o` transfers it onto the access `subject(?x)`. Both are pure unification once `transferred` takes an access-shaped replacement. |
| GROUP | `split` is already predicate-over-`conjunctVars`; unchanged. |

---

## 8. File-by-file checklist

**`lib/utils/assertions.ts`**
- `Access`, `accessId`, `TriplePosition`; `Assertion.term: RDF.Term | Access`; new `TripleAssertion`.
- `isAssertableTerm` → admit **ground** quads (recurse: no variable anywhere), keep refusing variables.
  Update the TODO comment per §6.2.
- Recognisers: `sameTerm(subject(?o), X)` / `sameTerm(X, subject(?o))` and their nestings;
  `istriple(?o)`; `sameTerm(?o, <<( … )>>)` where the quad has variables → a shape assertion (note:
  the accessor form and the `TRIPLE` form differ on error-vs-false and agree as filter conjuncts, §5.1).
- Builders: `accessExpression(access)` (nested `subject`/`predicate`/`object` operators),
  `tripleAssertionExpression` (`istriple`), and the access-aware versions of
  `assertionExpression` / `weakAssertionExpression`.

**`lib/datastructures/TermClusterSet.ts`** — §2.3: `Pin`, `meetPins`, work-list merge, occurs check,
`carriesInformation` counting child references. Optionally absorb `groupToRange`.

**`lib/utils/assertionConjunction.ts`** — conjuncts over accesses; `assert(access, …)` walking/creating
paths; `get`, `conjuncts`, `cliques`→`groups`, `split`, `weakened`, `boundImpliedBy` (a shape implies
`bound` of its root *and* of every named child), `transferred`, `toExpression` (§5.2), the two
substitutions (§5.4), and the fixpoint test in `collectAssertions` (§5.4).

**`lib/utils/partialExpressionEvaluation.ts`** — the substitution argument becomes a *view*
(`resolve(access)`, `isTriple(access)`, `isBound(name)`) rather than a bare `Map`; fold
`subject/predicate/object` over a known shape and over a literal quad term expression, fold `istriple`,
fold `triple(a,b,c)` of three constants into a quad term. Without the accessor fold the residual of the
very filter that produced the assertion does not fold away and the pass is not idempotent.

**`lib/transformations/pushDownAssertions.ts`** — §7, plus the fresh-variable coining
(derived from the group representative, checked against the tree's variable set, falling back to
`freshVarGenerator` from `lib/utils.ts` on collision) and the `pVars` guard of §6.1.

**`lib/utils/certainlyBoundVars.ts`** — §6.2, if option 2 is taken.

**`lib/ClusterSolver.ts`** — optional follow-up: drop the `Quad` exclusion from `RawBasicTerm`, resolve
the TODO at line 191.

---

## 9. Alternatives considered

* **A `shape` assertion form carrying an `RDF.Quad` with materialised fresh variables**, reusing
  `assertStrong` as-is. Rejected: the fresh names would leak into `size`/`names`/`order`, the
  serialised condition would mention variables that are unbound where it sits (§5.2 — an actual
  wrong-answer bug), and unification of two shapes would have to be done by name-matching rather than
  by group.
* **Paths as the union-find values** (`ClusterSet<Access>` — congruence closure over accessor paths,
  no pins at all). Theoretically the same thing and arguably prettier, but every congruence step needs
  an index from (group, position) to child group *anyway*, which is the shape pin; and the path space
  is infinite, so materialising `?o.subject` as a *value* whenever something mentions it makes
  `groupToValues` grow with derived names that are not variables. The recommended design uses paths as
  the conjunct language (where they are finite and come from the query text) and groups as the
  structure (where they are canonical).
* **Handling triple terms in a separate pass** after the assertion pushdown. Rejected: the task's
  interop requirement is congruence, and congruence between shapes and cliques cannot be split across
  two fixpoints without iterating them to a joint fixpoint anyway.
* **Eagerly materialising fresh variables at assertion time** and relying on the outer projection.
  Rejected for the reasons in §2.2, and because it makes idempotency depend on a global counter.

---

## 10. Phasing and tests

**Phase 1 — ground triple terms (small, independent).** Relax `isAssertableTerm` to admit ground quads;
settle the ground half of the `withCpVars` EXTEND question; fold `sameTerm` between two ground quads.
`FILTER(sameTerm(?o, <<( :a :b :c )>>))` then pushes into a BGP with the *existing* machinery, since a
ground quad is just a term. No structure, no fresh variables, no new form.

**Phase 2 — the pin lattice.** `TermClusterSet` generalisation, work-list merge, occurs check,
`carriesInformation`. Unit-testable entirely at the data-structure level.

**Phase 3 — accesses and `T⟨?x⟩`.** Conjunct language, recognisers, `toExpression`, the accessor folds
in the partial evaluator. At the end of this phase Θ round-trips through a condition and the pass is
idempotent, without yet writing a single triple term into a pattern.

**Phase 4 — materialisation.** `patternSubstitution`, fresh-variable coining, `bindAssertedTerms`, the
`pVars` guard. This is where the target example starts working.

**Phase 5 — the operation rules.** `pruneValues` (the row-wise rewrite), `transferred` through a
triple-term or accessor `BIND`, the lattice-weakened push in `splitClique`, ranges.

**Tests.** The existing three-layer structure covers this well:
* `test/assertionConjunction.test.ts` — decomposition (`?o ≡ <<(?a ?b ?c)>>` twice), congruence
  (unify then read a child), ground-meets-shape decomposition, occurs check, the `T⟨?x⟩` absorption
  rules, and `conditionOf` round-trips for every new form (the existing helper already serialises Θ
  through the generator, which is exactly the check that no fresh variable escapes into a condition).
* `test/pushDownAssertions.test.ts` — the target example, the interop example of §4.2, the
  idempotency test ("applying the transformation twice"), and the "leaves the input tree untouched"
  test, all of which already exist and just need triple-term cases.
* the `semantic equivalence (evaluation)` block — the real safety net, and the place I would put the
  cases where I would most expect to be wrong: a shape pushed weakly into a join operand that never
  binds the variable; a shape over a VALUES with an UNDEF column; a shape on the RHS of a MINUS; a
  shape under an OPTIONAL that the implied `bound` collapses into a join; and a query where the
  asserted variable is bound to something that is *not* a triple term, which must keep returning
  nothing rather than erroring. `test/statics/assertionPushdown.ttl` needs triple-term data — note it
  is loaded through Comunica, so check that the engine version in the lockfile evaluates
  `SUBJECT`/`isTRIPLE` and triple-term patterns before relying on it.

## 11. Open questions for you

1. **`pVars` growth** (§6.1): defensive `Project` at the pass entry, or rely on the pipeline's outer
   projection and merely restate the invariant?
2. **`cVars` of the re-binding `BIND`** (§6.2): stamp the metadata with the "cannot error" argument, or
   accept the conservative loss for now?
3. **Ranges** (§5.5): lift `groupToRange` into the shared base in this PR, or leave the extra
   contradictions on the table and keep the diff smaller? I lean towards doing it here — with chained
   accesses it is what keeps an unsatisfiable nesting from being carried around as a residual
   (§4.4(c)) — but it is the one item that could equally well be its own PR.
4. **`pruneValues`** (§7): rewrite row-wise as "assert the row into a clone of Θ", or extend the
   existing per-variable `switch` with a shape branch? The rewrite is cleaner and uniform but touches
   behaviour that the current evaluation tests pin down quite precisely.
5. Should `sameTerm(?o, <<( ?a ?b ?c )>>)` (the `ExprTripleTerm` spelling) be *recognised* as an
   assertion, given that it is written back in accessor form and so does not round-trip verbatim? I
   think yes — it is the natural way for a user to write it — but it means the pass rewrites a
   condition into a form that is equivalent only in filter position (§5.1).
