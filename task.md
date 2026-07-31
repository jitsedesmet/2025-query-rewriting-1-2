Implement the sameTerm filter pushdown described bellow.
You can use the linked Traqula's `transformObjectPreOrder` (or `mapOperationPreOrder` - dedicated to algebra).
For completeness, you can find the foundational paper at the top level here.
Once done, commit your changes ensuring the commit hooks pass. Do not commit the paper.
You can clear the metadata fields recursively by using mapOperation with an ignore key of 'metadata', afterward, you should maintain it properly.
Use `withCpVars` to calculta pVars and cVars and maintain the metadata throughout the pushDownRestriction.
It is smart to accumulate filter containing a conjunction of sameterm filters that still hold at any point.
Know that whenever the conjuntcion of sameterm filters you maintain contradict (very simple check whenever you add a sameterm expression to the scoped filter), you can replace it with filter false and skip whatever is underneed.
To be clear: you should start from the most high up sameterm filter (or sameTerm in top level conjunction filter) and push the filter down as a conjuntcion of sameTerms.
Whenever you pass a filter, and that filter conatins other sameTerm filter in top level conjunction, add them to this one and push down the sameTerm filter. When a piece of the sameTerm conjunction filter you manage is split of (that sameFilter is absobed or needs to stay behind or whethever), you should not forget to continue with the remaining part of your conjunction.
To make management of the sameterm conjunction filter easier,
you can attach metadata to it in the same way `CPOp` does it.
Meaning in your mapOperationPreOrder, you have a callBack on 'filter', but using `withSametermConjuntion` (or whatever) you can see if the filter has a `SameTermConjunctionMeta` or not. Maintaining this metadata is also not expensive since the function checks whether it is there, or computes it otherwise. You could even make it a guard function such that you can simply fail fast if the filter is not the one we are interested in and have a smart cast if it is!   

# Assertion Filter Pushdown for SPARQL Algebra

## 1. Context

An earlier rewriting stage produces queries carrying a set of **top-level assertion
filters** of the form `FILTER(sameTerm(?x, <ex://p>))` — each stating that one variable
is fixed to one constant term.

Left at the top, these do nothing but discard rows at the end. Pushed down, they
eliminate work: they substitute into BGPs (fewer triple matches), prune VALUES rows,
delete whole UNION branches, and can turn an OPTIONAL into a plain join.

This document specifies how to push them. It is grounded in *Foundations of SPARQL
Query Optimization* (Schmidt, Meier, Lausen, ICDT 2010) — rule names in parentheses
below, e.g. (FJPush), refer to Figure 2 of that paper.

**Goal:** push each assertion as deep as possible, and into *every* branch that
permits it — for a join, that may be both sides at once.

**Out of scope for this PR:** pushing into `SERVICE` bodies. It is the highest-value
push available (it cuts network transfer, not just CPU) and `sameTerm` is a required
function, so a conformant endpoint can evaluate it — but it must be a *replication*
rather than a move, because `SILENT` turns endpoint failure into a single empty
solution that a moved filter would fail to discard. Tracked separately; `Service` is a
barrier here.

## 2. Notation and core objects

Write **A⟨?x≡c⟩** for `σ_{sameTerm(?x,c)}`. SPARQL solution sequences are multisets, so
the semantics is stated over bags (Definition 11 of the paper):

```
σ_{?x≡c}(Ω, m) = (Ω', m')   where  Ω' = { μ ∈ Ω | ?x ∈ dom(μ) ∧ μ(?x) = c }
                                   m'(μ) = m(μ) for μ ∈ Ω', else 0
```

Selection is **multiplicity-transparent**: it filters mappings and carries their
multiplicities through unchanged, never merging or splitting them. Set-algebra reasoning
about *which mappings survive* therefore transfers directly. Where a rewrite restructures
the plan rather than merely filtering it, an explicit multiplicity argument is given
(§10). This transparency is not a general property of SPARQL operators — it is precisely
why (UIdem) and (FDecompII) fail to carry from set to bag algebra — so it is stated
rather than assumed.

Two properties drive the whole design.

**(a) The assertion implies `bnd(?x)`.** So (FBndII) applies directly:

```
?x ∉ pVars(A)  ⟹  σ_{?x≡c}(A) ≡ ∅
```

Every `FILTER(false)` outcome in this spec falls out of that single rule. No
per-operator emptiness rules are needed. It is also why `bound(?x)` folds to `true`
during substitution (§7.1).

**(b) `sameTerm`, not `=`.** This is what makes substitution sound.
`?x = "01"^^xsd:integer` is true of the term `"1"^^xsd:integer`, so substituting a
term into a BGP under `=` would drop solutions. Under `sameTerm`,
`μ ↦ μ|_{V∖{?x}}` is a multiplicity-preserving bijection between
`{μ ∈ ⟦BGP⟧ | μ(?x) = c}` and `⟦BGP[?x↦c]⟧`. **Do not generalise this pass to `=`.**

### Empty node

Represent `FILTER(false)` as `Empty_S`, where `S` is the `pVars` of the expression it
replaced:

```
pVars(Empty_S) := S
cVars(Empty_S) := S
```

`cVars` may be stated as all of `S` because every variable is vacuously certain in an
empty relation; `pVars` may be over-approximated soundly (Prop. 2 of the paper).
**Do not set `pVars(Empty) = ∅`** — that silently changes `SELECT *` scoping and the
in-scope-variable set.

### Invariant

> Every rewrite in this scheme preserves `pVars` exactly, never shrinks `cVars`, and
> preserves the multiplicity of every surviving mapping.

Consequences: compute `pVars`/`cVars` **once**, before the pass; licences computed at
one node stay valid as descendants are rewritten. This is what allows a single
traversal.

### Refinement to `cVars`

The paper defines `cVars(σ_R(A)) := cVars(A)` — sound, but blind to filters that imply
`bnd`. Since assertions do imply it, strengthen:

```
cVars(σ_{?x≡c}(A))    := cVars(A) ∪ {?x}
cVars(σ_{bnd(?x)}(A)) := cVars(A) ∪ {?x}
```

Worth implementing: it can license the push of a *different* assertion at an enclosing
join, where `?y ∈ cVars(A₁)` holds only once `A₁`'s own assertion is recognised as
making `?y` certain.

## 3. The licence condition

Specialising (FJPush)/(FLPush) — "for all `?y ∈ vars(R)`: `?y ∈ cVars(A₁) ∨
?y ∉ pVars(A₂)`" — to a single-variable filter gives:

```
L(?x, A₁, A₂)  ≔  ?x ∈ cVars(A₁)  ∨  ?x ∉ pVars(A₂)
```

The second disjunct is easy to forget and does a lot of work in practice — see §4 for
the UNION case and §6.4, where it is what makes GRAPH transparent.

## 4. Where possible-but-not-certain variables come from

`L` fails only for variables that are in `pVars` but not `cVars`. Exactly four
constructs create them:

| Source | Gap introduced | Notes |
|---|---|---|
| **OPTIONAL** | `pVars(A₂) ∖ cVars(A₁)` | Largest source; the only one with a dedicated structural rule |
| **UNION** | `(pVars(A₁) ∪ pVars(A₂)) ∖ (cVars(A₁) ∩ cVars(A₂))` | Empty when both branches bind the same variables |
| **VALUES with UNDEF** | any column not bound in every row | |
| **BIND of a fallible expression** | the bound variable | See below — affects *correctness*, not just yield |

Derivation for OPTIONAL, via `A₁ ⟕ A₂ ≡ (A₁ ⋈ A₂) ∪ (A₁ ∖ A₂)` and Defs. 6/17:

```
cVars(A₁ ⟕ A₂) = (cVars(A₁) ∪ cVars(A₂)) ∩ cVars(A₁) = cVars(A₁)
pVars(A₁ ⟕ A₂) = pVars(A₁) ∪ pVars(A₂)
```

**Fallible BIND.** SPARQL 1.1 leaves the variable unbound when the expression errors:

```
cVars(Extend(A,?y,e)) = cVars(A) ∪ {?y}   if e is total on A
                      = cVars(A)          otherwise
pVars(Extend(A,?y,e)) = pVars(A) ∪ {?y}
```

An implementation that unconditionally adds `?y` to `cVars` **over-claims certainty and
hands out unsound licences** for (FJPush)/(FLPush). Totality is decidable for common
cases (constants; `IRI`-typed variables already in `cVars`; `STR` of a bound term);
default to the conservative branch otherwise.

**How the sources differ operationally:**

- OPTIONAL gap vars are usually in `pVars(A₂) ∖ pVars(A₁)` — exactly the trigger for the
  LeftJoin→Join conversion (§6.1). The assertion removes the left join outright.
- UNION gap vars sit in `pVars` of both branches, so no structural rule fires. They rely
  on the second disjunct of `L` to get below an enclosing join, after which the
  unconditional (FUPush) reaches the branches and (FBndII) prunes them.
- OPTIONAL gap vars that *are* in `pVars(A₁)` (because `A₁` itself contains a union or
  optional binding `?x`) get neither. That is the weak-assertion case (§11).

Worked example of the second disjunct:

```
A₁ = (?x :p ?y) UNION (?z :q ?w)     pVars {?x,?y,?z,?w}, cVars ∅
A₂ = (?a :r ?b)                       pVars {?a,?b}

σ_{?x≡c}(A₁ ⋈ A₂)
```

`?x ∉ cVars(A₁)` — first disjunct fails. `?x ∉ pVars(A₂)` — second holds, push into
`A₁`. (FUPush) then sends it into both branches unconditionally; the right branch has
`?x ∉ pVars` and collapses to `Empty` by (FBndII); `Empty ∪ A ≡ A` removes it. Without
the second disjunct the assertion strands on top of the join and none of that fires.

## 5. Per-operator rules

| Node | Rule | Needs |
|---|---|---|
| any `A` | `?x ∉ pVars(A)` ⟹ `Empty` | pVars (FBndII) |
| `A₁ ∪ A₂` | `σ(A₁) ∪ σ(A₂)` — **always, both branches, no precondition** | — (FUPush) |
| `A₁ ⋈ A₂` | into `A₁` if `L(?x,A₁,A₂)`; into `A₂` if `L(?x,A₂,A₁)`; into **both** if both hold; else keep on top | cVars+pVars (FJPush) |
| `A₁ ⟕ A₂` | if `?x ∉ pVars(A₁)`: convert to join (§6.1). Else into `A₁` if `L(?x,A₁,A₂)`; additionally into `A₂` if `?x ∈ cVars(A₁) ∩ cVars(A₂)` (§6.2) | cVars+pVars (FLPush) |
| `A₁ ∖ A₂` | `σ(A₁) ∖ σ_W(A₂)`, `W ≔ !bound(?x) \|\| sameTerm(?x,c)` — both sides, unconditional (§6.3) | — (FMPush) |
| `σ_R(A)` | `σ_{simplify(R[?x↦c])}(σ_{?x≡c}(A))`; `simplify` **must** map `bound(?x) ↦ true` (§7.1) | — (FReord) |
| `π_S(A)` | `?x ∉ S` ⟹ `Empty`; else `π_S(σ(A))` | — |
| `Extend(A,?y,e)`, `?y ≠ ?x` | `Extend(σ(A), ?y, simplify(e[?x↦c]))` | — |
| `Extend(A,?x,e)` | `Extend(σ_{sameTerm(e,c)}(A), ?x, c)` — see §7 | — |
| `Graph(g, P)`, `g ≠ ?x` | `Graph(g, σ(P))` — **unconditional**, `g` an IRI or any other variable (§6.4) | — |
| `Graph(?x, P)` | `c` not an IRI ⟹ `Empty`; else `Extend(Graph(c, P), ?x, c)` (§6.4) | — |
| `Distinct` / `Reduced` / `OrderBy` | push through (congruence) | — |
| `Group`, `?x` a grouping key | push below the grouping | — |
| `Slice`, `Group` (non-key), `Service` | **stop** — keep filter above | — |

`Slice` and non-key `Group` are genuine barriers: filtering before a slice changes which
rows fall in the window; filtering before aggregation changes the aggregate. `Service`
is a barrier by scoping decision (§1), not because a push is unsound.

## 6. The non-obvious rules

### 6.1 LeftJoin conversion — the biggest structural win

```
?x ∉ pVars(A₁)  ⟹  σ_{?x≡c}(A₁ ⟕ A₂) ≡ A₁ ⋈ σ_{?x≡c}(A₂)
```

*Proof.* `A₁ ⟕ A₂ ≡ (A₁ ⋈ A₂) ∪ (A₁ ∖ A₂)`, and `pVars(A₁ ∖ A₂) = pVars(A₁) ∌ ?x`, so
the anti-join branch dies by (FBndII). The surviving join is licensed on the right
because `?x ∉ pVars(A₁)` satisfies `L(?x, A₂, A₁)`. Multiplicity argument in §10. ∎

This generalises the paper's (FLBndII) from `bnd(?x)` to `?x ≡ c`. **Asserting on an
optional-only variable turns OPTIONAL into a join**, which additionally unlocks
reordering and the BGP substitution underneath.

With a left-join filter `R`: `LeftJoin(A₁,A₂,R) ≡ σ_R(A₁ ⋈ A₂) ∪ (A₁ ∖_R A₂)`, so the
result is `σ_{?x≡c}(σ_R(A₁ ⋈ A₂))` and the pass recurses into that.

### 6.2 Replication — pushing into both sides of a join

```
?x ∈ cVars(A₁) ∩ cVars(A₂)  ⟹  σ_{?x≡c}(A₁ ⟕ A₂) ≡ σ_{?x≡c}(A₁) ⟕ σ_{?x≡c}(A₂)
```

*Proof.* The `⋈` half is (FJPush) applied twice. For the `∖` half: any `μ₂ ∈ A₂`
compatible with a surviving `μ₁` must bind `?x` (certain) to `c`, hence `μ₂ ∈ σ(A₂)`;
the pruned rows never removed anything. ∎

This is what "push into every branch that allows it" means concretely: it is not a push
but **sideways information passing** — the join already enforces agreement on `?x`, so
the assertion is free on both sides and shrinks both inputs.

### 6.3 Pruning the right side of a MINUS

```
σ_{?x≡c}(A₁ ∖ A₂)  ≡  σ_{?x≡c}(A₁) ∖ σ_W(A₂)      where W ≔ !bound(?x) || sameTerm(?x,c)
```

**This is not a filter push.** `∖` is anti-monotone in its right argument — shrinking
`A₂` can only *grow* the result — so pushing the *strong* assertion into `A₂` is unsound
whenever `?x ∉ cVars(A₂)`. It is the §6.2 mechanism instead.

*Proof.* Let `μ₂ ∈ A₂` be a row the pruning removes and `μ₁ ∈ σ(A₁)` any survivor, so
`μ₁(?x) = c`. If `?x ∈ dom(μ₂)` then `μ₂(?x) ≠ c`, so `μ₁ ≁ μ₂` — that row was excluding
nothing and its removal changes no output. If `?x ∉ dom(μ₂)`, `μ₂` may be compatible
with `μ₁` and may have been excluding it, so it must be kept — which is exactly what the
`!bound` disjunct does. ∎

When `?x ∈ cVars(A₂)` the `!bound` disjunct is unsatisfiable and `σ_W(A₂) ≡ σ(A₂)`,
recovering the strong form. The weak form additionally fires when
`?x ∈ pVars(A₂) ∖ cVars(A₂)` — a VALUES with UNDEF, or a `?x` bound inside an OPTIONAL
under the MINUS — where a `cVars` precondition would have given up.

> **Trap.** Implementations must not "simplify" `σ_W` to `σ` on the right of a MINUS.
> With `A₁ = BGP(?x :p ?y)`, `A₂ = BGP(?z :q ?y)` and an assertion on `?x`, the strong
> form gives `?x ∉ pVars(A₂)` ⟹ `Empty` by (FBndII), then `A ∖ Empty ≡ A` deletes the
> MINUS entirely. On a graph where `:p` and `:q` share an object the correct answer is
> empty and you return everything. Test 12.

Note this is the mirror image of §11: there, `σ_W` is *pushed downward* through
operators; here an outer *strong* assertion licenses a *weak* prune on a sibling. Do not
merge the two rule sets.

**W3C MINUS.** The extra `dom(μ₁) ∩ dom(μ₂) ≠ ∅` condition only makes exclusion rarer,
so pruning stays safe. Bonus in the strong case: `?x` is certain on both sides
afterwards, so every pair shares `?x`, the domain-intersection condition is automatically
satisfied, and W3C `MINUS` coincides with the paper's `∖` on those inputs.

### 6.4 GRAPH is transparent

GRAPH is **not** a barrier. With
`Graph(?g, P) ≡ ⋃_{(uᵢ,Gᵢ) ∈ named} ( ⟦P⟧_{Gᵢ} ⋈ {?g↦uᵢ} )`:

```
pVars(Graph(?g,P)) = pVars(P) ∪ {?g}
cVars(Graph(?g,P)) = cVars(P) ∪ {?g}        -- ?g is bound in every solution
```

For `?x ≠ ?g` the assertion distributes over the union by (FUPush), then into the left
argument of each join by (FJPush) — licensed by the **second** disjunct of `L`, since
`?x ∉ pVars({?g↦uᵢ}) = {?g}`. No precondition survives, so the push is unconditional.
The same holds trivially when the graph term is a constant IRI.

For `?x = ?g`, the assertion selects the single named graph `c`:

```
c is not an IRI  → Empty                    -- graph names are IRIs
otherwise        → Extend(Graph(c, P), ?x, c)
```

The `Extend` is mandatory for the same reason as in the BGP case (§8) — without it
`?g` leaves `pVars`/`cVars` and the invariant breaks. If `c` is not among the named
graphs, evaluation yields the empty pattern naturally; no static check is required, but
one may be added as an optimisation when the dataset is known.

Recursion continues normally into `P` in both cases: the active graph changes, but
`pVars`/`cVars` do not depend on it.

## 7. Extend / BIND

```
Extend(A, ?x, e)  with assertion ?x ≡ c
  ⟹  Extend( σ_{sameTerm(e,c)}(A), ?x, c )
```

*Soundness.* `σ_{?x≡c}` keeps exactly those `μ ∈ A` for which `e` evaluates without
error to the term `c`. `σ_{sameTerm(e,c)}` keeps the same set: an error in `e` makes
`sameTerm(e,c)` error, which a filter treats as false — matching the dropped-unbound
case. Both sides are selections, hence multiplicity-transparent.

**Do not shortcut this to constant folding.** The important case is **renaming**: if `e`
is a bare variable `?z` (`BIND(?z AS ?x)`), then `sameTerm(?z, c)` *is itself an
assertion* `A⟨?z≡c⟩`, and the recursion restarts on `?z` — potentially reaching a BGP and
firing the substitution there. Assertions propagate through renamings.

- `e` is a variable `?z` → recurse with `θ` updated: drop `?x`, add `?z ↦ c`. If `?z`
  already in `dom(θ)` with a different term, the whole node is `Empty`.
- `e` is a constant → statically decide `sameTerm(e,c)`; drop the filter or `Empty`.
- otherwise → hand `sameTerm(e,c)` to the **generic** filter-pushdown pass, not to this
  one. For compound `e` it is a multi-variable filter and needs the full (FJPush) side
  condition quantified over `vars(e)`, not the collapsed single-variable `L`.

Note that `?x ∉ pVars(A)` below the Extend (SPARQL forbids BINDing an in-scope
variable), so `?x` must be removed from the substitution before descending — otherwise
the (FBndII) check at the top of the recursion wrongly yields `Empty`.

### 7.1 `simplify(R[θ])` — expression substitution

Substituting a term for a variable inside an expression is **not** uniform textual
replacement. `BOUND` is the only SPARQL built-in whose grammar takes a bare `Var` rather
than an `Expression`:

```
[121]  BuiltInCall ::= ... | 'BOUND' '(' Var ')' | ...
```

Naive substitution yields `bound(<ex://p>)`, which is **ungrammatical**. An internal
algebra representation may tolerate it silently, but it becomes a hard failure the moment
the plan is serialised back to SPARQL text (federation, query logging, explain output,
or a round-tripping test). Handling it is mandatory, not cosmetic.

The replacement is `true` by §2a — the assertion implies `bnd(?x)`. Full contract for
`θ = {?x ↦ c}`:

```
bound(?x)                → true         -- MANDATORY: grammar takes Var, not Expression
sameTerm(?x, c)          → true
sameTerm(?x, d), d ≠ c   → false
?x = ?x                  → true
EXISTS { P }             → EXISTS { P[θ] }        -- recurse into the pattern
NOT EXISTS { P }         → NOT EXISTS { P[θ] }
otherwise                → replace occurrences of ?x by c, then constant-fold
```

`BOUND` is the only built-in needing this treatment. Every other position taking a bare
variable — `GROUP BY`, `VALUES` headers, `(expr AS ?v)` targets, `Extend` targets — is
either covered by a dedicated rule above or is a binding target that is never
substituted.

Substituting into `EXISTS` patterns is sound because the EXISTS semantics substitutes
the current solution mapping into the pattern anyway, and every surviving `μ` has
`μ(?x) = c`. This is a further propagation route, not merely a repair.

**Bonus collapse.** `!bound(?x)` folds to `false`, so `σ_{false}(A) ≡ Empty` fires. This
is the (FBndIII) analogue and it triggers on the standard negation idiom: under an
assertion on `?x`, the pattern `(P OPT Q) FILTER(!bound(?x))` is contradictory and
collapses to `Empty` without any evaluation.

## 8. Base cases

### BGP / property path

All variables certain: `cVars = pVars = vars(P)`.

```
?x ∉ vars(P)                          → Empty
c is a literal, ?x in subject/predicate position → Empty   (no RDF triple can match)
c is a literal, ?x in graph position             → Empty
otherwise                             → Extend(P[?x ↦ c], ?x, c)
```

The `Extend` is **mandatory** — dropping it shrinks `pVars`/`cVars`, breaks the
invariant, and breaks `SELECT *`.

### VALUES

```
?x ∉ vars                                          → Empty
rows' = { r ∈ rows | r binds ?x explicitly to c }  -- UNDEF rows dropped
rows' = ∅                                          → Empty
otherwise → Extend( Values(vars∖{?x}, rows'|_{vars∖{?x}}), ?x, c )
```

UNDEF rows must drop, because the assertion implies `bnd(?x)` — the same reason a VALUES
variable is in `pVars` but in `cVars` only if every row binds it.

## 9. Algorithm

Thread a *substitution* `θ : Var ⇀ Term` rather than pushing one filter at a time:
multiple assertions arrive together, and joint threading means one traversal and one
substitution pass per BGP.

```
push(A, θ):                        -- returns an expression ≡ σ_θ(A)
  if θ = ∅                     → A
  if dom(θ) ⊄ pVars(A)         → Empty_{pVars(A)}                    -- (FBndII)
  case A of
    BGP / Path / Values        → base cases (§8), for all of dom(θ)

    Union(A₁,A₂)               → Union(push(A₁,θ), push(A₂,θ))       -- unconditional

    Filter(A₁,R)               → Filter(push(A₁,θ), simplify(R[θ]))  -- §7.1

    Extend(A₁,?y,e), ?y ∉ dom(θ)
                               → Extend(push(A₁,θ), ?y, simplify(e[θ]))
    Extend(A₁,?x,e), θ(?x)=c   → §7; recurse on A₁ with θ∖{?x} (plus ?z↦c if e = ?z)

    Graph(g,P), g ∉ dom(θ)     → Graph(g, push(P,θ))                 -- unconditional
    Graph(?x,P), θ(?x)=c       → c not an IRI ? Empty
                                 : Extend(Graph(c, push(P, θ∖{?x})), ?x, c)

    Project(S,A₁)              → Project(S, push(A₁,θ))              -- dom(θ) ⊆ S here

    Join(A₁,A₂)                → θ₁ = { ?x ∈ θ | L(?x,A₁,A₂) }
                                 θ₂ = { ?x ∈ θ | L(?x,A₂,A₁) }
                                 σ_{θ ∖ (θ₁ ∪ θ₂)}( Join(push(A₁,θ₁), push(A₂,θ₂)) )

    LeftJoin(A₁,A₂,R)          → θ_conv = { ?x ∈ θ | ?x ∉ pVars(A₁) }
                                 if θ_conv ≠ ∅:
                                   rebuild as Filter(Join(A₁,A₂), R); recurse   -- §6.1
                                 else:
                                   θ₁ = { ?x ∈ θ  | L(?x,A₁,A₂) }
                                   θ₂ = { ?x ∈ θ₁ | ?x ∈ cVars(A₂) }            -- §6.2
                                   σ_{θ∖θ₁}( LeftJoin(push(A₁,θ₁),
                                                      push(A₂,θ₂), simplify(R[θ₁])) )

    Minus(A₁,A₂)               → Minus(push(A₁,θ), pushWeak(A₂,θ))   -- §6.3

    Distinct/Reduced/OrderBy   → congruence
    Group, dom(θ) ⊆ keys       → push below grouping
    Slice/Group/Service        → σ_θ(A)                              -- stop
```

Because `θ₁` requires `?x ∈ cVars(A₁) ∨ ?x ∉ pVars(A₂)` and `θ₂` further requires
`?x ∈ cVars(A₂)`, the `θ₂` case reduces exactly to `?x ∈ cVars(A₁) ∩ cVars(A₂)`.

`pushWeak` applies `σ_W` per §11 and may be stubbed as a no-op in a first cut — the
MINUS right side is then simply left alone, which is correct but yields nothing.

### Normalisation pass

```
Empty ⋈ A ≡ Empty          A ⋈ Empty ≡ Empty
Empty ∪ A ≡ A              A ∪ Empty ≡ A
Empty ⟕ A ≡ Empty          A ⟕ Empty ≡ A
Empty ∖ A ≡ Empty          A ∖ Empty ≡ A
π_S(Empty) ≡ Empty         Graph(g, Empty) ≡ Empty
σ_false(A) ≡ Empty_{pVars(A)}
σ_true(A)  ≡ A
σ_{?x≡c}(Extend(A,?x,c)) ≡ Extend(A,?x,c)
```

All of these hold under bag algebra: `Empty` is the empty multiset, contributing 0 to
every multiplicity, and bag `∪` adds multiplicities.

### Termination

The filter count does **not** decrease — replication duplicates assertions — so order by
descent depth instead: every recursive call is on a strict subexpression with `|θ|`
non-increasing, and the base cases consume `θ` entirely.

## 10. Bag-semantics obligations

SPARQL evaluates under bag semantics by default; set semantics arises only via
`DISTINCT`, `REDUCED`, and `ASK`. Every algebraic rule this pass relies on —
(FUPush), (FJPush), (FLPush), (FMPush), (FReord), (FBndI–IV) — carries from set to bag
algebra by **Theorem 7** of the paper. The two rules that do *not* carry, (UIdem) and
(FDecompII), are not used anywhere in this spec.

Selections are multiplicity-transparent (§2), so most steps need no separate argument.
The steps that restructure the plan rather than filtering it each need one:

| Step | Multiplicity argument |
|---|---|
| **BGP substitution** (§8) | BGPs are duplicate-free: each triple pattern has `m ≡ 1` (Def. 12), and in a join of triple patterns the decomposition `μ ↦ (μ\|_{vars(t₁)}, μ\|_{vars(t₂)})` is unique, so the sum in the bag-join definition has the single term `1*1`. This is the `Ã⁺` incompatibility property (Lemma 5). Substitution restricts which mappings exist and preserves `m ≡ 1`. |
| **Property paths** | **Not** duplicate-free — `?x :p/:q ?y` yields one solution per intermediate witness, and the witness is projected away. Substituting `?x ↦ c` restricts the set of start nodes but leaves the witness count for every surviving pair untouched, so multiplicities are preserved. Paths lie outside the paper's fragment; this needs its own test (§13.11). |
| **VALUES pruning** (§8) | Row-level filtering. Duplicate rows remain duplicated; only rows failing the assertion are removed. |
| **LeftJoin→Join conversion** (§6.1) | Uses the bag definition `Ml ⟕ Mr := (Ml ⋈ Mr) ∪ (Ml ∖ Mr)` (Def. 11). The anti-join branch becomes the empty multiset, contributing 0 to every multiplicity, and bag `∪` adds multiplicities — so `A ∪ ∅ = A` holds. Same reasoning covers the `Empty` normalisation rules. |
| **MINUS right-side prune** (§6.3) | Trivial: `m'(μ) = ml(μ)` in Definition 11, so multiplicities in `A₂` never reach the output. Only the *set* of mappings in `A₂` matters, and pruning is a set operation. |
| **GRAPH** (§6.4) | The union over named graphs is a bag union and the `{?g↦uᵢ}` singletons have `m ≡ 1`, so each join contributes `m(μ)*1`. Selection inside `P` preserves those multiplicities. |

**Do not assume multiplicity 1 anywhere in the pass.** Duplicates are genuinely produced
by UNION (Example 3 of the paper), property paths, VALUES with repeated rows, and
projection. Nothing here depends on their absence — but an implementation that dedupes
"for efficiency" during rewriting would change results.

**Lemma 8** gives a convenient bound: for `Q ∈ AFO` (AND/FILTER/OPT, no UNION) with
`S ⊇ pVars(⟦Q⟧_D)`, set and bag semantics coincide. So for the UNION-free,
projection-free fragment the distinction is vacuous — the pass must not rely on this,
since UNION handling is one of its main payoffs, but it is useful when writing tests.

## 11. The weak assertion

**W⟨?x≡c⟩** ≔ `!bound(?x) || sameTerm(?x, c)`. Required by §6.3, and optionally usable
for the residual join case where `?x ∈ pVars(A₁) ∩ pVars(A₂)` but is certain in neither:

```
σ_{?x≡c}(A₁ ⋈ A₂) ≡ σ_{?x≡c}( σ_W(A₁) ⋈ σ_W(A₂) )      -- outer filter must remain
```

`σ_W` pushes unconditionally through: union branches, both join arguments, the **left**
argument of a left join, the left of MINUS, filter, extend, project, graph, distinct,
order. It collapses on arrival — where `?x ∈ cVars` it becomes the strong assertion (so
the BGP/VALUES rewrites fire); where `?x ∉ pVars` it becomes `true` and is **dropped**.

> Trap: `?x ∉ pVars` under `σ_W` yields `true`, **not** `Empty`. Getting this backwards
> silently deletes results.

`σ_W` is **unsound** into the right argument of a left join. Counterexample:
`A₁ = {?y↦1}`, `A₂ = {?x↦d}` — then `σ_W(A₁ ⟕ A₂) = ∅` but `A₁ ⟕ σ_W(A₂) = {?y↦1}`.

## 12. Traps

- **Bag semantics** — see §10. Every rule used carries over by Theorem 7; the
  restructuring steps have explicit arguments; never assume `m ≡ 1`.
- **`bound(?x)` must become `true`** (§7.1) — substituting a term into `BOUND` produces
  ungrammatical SPARQL that only surfaces on serialisation.
- **MINUS right side takes the weak assertion, never the strong one** (§6.3).
- **W3C MINUS** carries the extra `dom(μ₁) ∩ dom(μ₂) ≠ ∅` condition, unlike the paper's
  `∖`; pruning is safe under both (§6.3).
- **`Empty`'s variables** — carry the replaced expression's `pVars`; never `∅`.
- **GRAPH is transparent, not a barrier** (§6.4). The only real barriers are `Slice` and
  non-key `Group`; `Service` is a scoping decision (§1).
- **BIND ordering.** `Extend` errors if the target variable is already bound. The BGP
  rewrite substitutes `?x` out of the pattern first, so `?x` is guaranteed unbound at
  that point — assert this if the pass is ever reordered.
- **Never generalise `sameTerm` to `=`** (§2b).

## 13. Test cases worth pinning

1. **Renaming chain.** `FILTER(sameTerm(?x,c))` over `BIND(?z AS ?x)` over
   `BGP(?z :p ?y)` → substitution must reach the BGP as `?z ↦ c`.
2. **UNION branch pruning under a join** — the §4 worked example; assert the right branch
   becomes `Empty` and is normalised away.
3. **OPTIONAL → join conversion** where `?x` is bound only in the optional side; assert
   the resulting plan contains no left join.
4. **Replication into both join sides** where `?x ∈ cVars` of both.
5. **VALUES with UNDEF** in the asserted column — the UNDEF row must not survive.
6. **Fallible BIND** — `BIND(?a/?b AS ?x)` must not put `?x` in `cVars`; assert no
   unsound push at an enclosing join.
7. **Literal in subject position** → `Empty`.
8. **`sameTerm` vs `=`** — assert `"1"^^xsd:integer` is *not* matched by an assertion on
   `"01"^^xsd:integer`.
9. **Bag-semantics regression** — a UNION query producing duplicates; assert result
   *multiplicities* are unchanged by the pass, not just the mapping set.
10. **`SELECT *` scoping** — a plan where a branch collapses to `Empty`; assert the
    projected variable list is unchanged.
11. **Property path multiplicity** — `?x :p/:q ?y` with several intermediate witnesses;
    assert substitution of `?x` preserves the per-pair duplicate count.
12. **MINUS anti-monotonicity** — `A₁ = BGP(?x :p ?y)`, `A₂ = BGP(?z :q ?y)`, assertion
    on `?x`; assert the MINUS survives and the result is empty on a graph where `:p` and
    `:q` share an object. This is the test that catches a strong-instead-of-weak prune.
13. **`bound(?x)` in a pushed filter** — assert the rewritten plan re-serialises to valid
    SPARQL; specifically assert no `BOUND(<...>)` is ever emitted. Best written as a
    serialise-then-reparse round trip over the whole plan.
14. **`!bound(?x)` collapse** — `(P OPT Q) FILTER(!bound(?x))` with an assertion on `?x`
    → `Empty`.
15. **GRAPH transparency** — assertion on a pattern variable inside `GRAPH ?g { }`; assert
    the substitution reaches the BGP and `?g` handling is untouched. Companion case:
    assertion *on* `?g` with a literal `c` → `Empty`; with an IRI → `Extend(Graph(c,P))`
    and `?g` still in `pVars`/`cVars`.
16. **`EXISTS` propagation** — assertion on `?x` where `?x` occurs inside a
    `FILTER EXISTS { }` pattern; assert the substitution lands inside the pattern.
