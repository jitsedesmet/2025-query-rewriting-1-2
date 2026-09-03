# Comparison: this repo vs. `MaximeJakubowski/SRR`

A critical comparison of the **query‑rewriting capabilities** of this repository
(`traqula-sparql-1-2-rewriter`) and [`MaximeJakubowski/SRR`](https://github.com/MaximeJakubowski/SRR)
("SPARQL‑RML Rewriter"). Per request, this ignores the *serialization* of the mapping
(SPARQL `CONSTRUCT` here vs. RML there) and focuses on what each system can actually rewrite and how well.

Both solve the same GAV problem: given mappings from a source schema to a target schema and a SPARQL query
over the target, rewrite the query to run over the source. Both unfold each triple pattern with its
matching mapping(s) and combine the results.

## TL;DR verdict

* **Same core idea, opposite normal form.** SRR expands a BGP into a **UNION of JOINs** (one branch per
  full mapping‑to‑pattern assignment) and prunes impossible branches at compile time with a Prolog SAT
  check. This repo keeps a **JOIN of UNIONs** (each pattern → union over mappings) and prunes lazily with
  optional algebraic optimization passes.
* **This repo is far more capable and scalable**: polynomial output size, property‑path support, RDF‑1.2
  triple‑term (RDF‑star) support, a real optimization suite, and pure TypeScript (no native deps).
* **SRR is a smaller, published, citable artifact** (Zenodo DOI, 2024) that does one genuinely nice thing
  we do differently: *precise, eager* satisfiability pruning via unification. It is hampered by an
  exponential enumeration, a heavy native Prolog dependency, a narrow query surface, and a couple of real
  bugs.
* **Competitive?** For tiny mappings/BGPs, functionally comparable. For anything realistic, this repo
  dominates on scalability, expressivity, and portability; SRR is not competitive as an engine but remains
  a useful reference/baseline.

## The central algorithmic difference

For a BGP of *n* patterns and *m* mappings, the correct rewriting is
`JOIN_{i=1..n} ( UNION_{j=1..m} unfold(pattern_i, mapping_j) )`.

* **SRR** distributes this into disjunctive normal form: it enumerates **every assignment vector**
  (`generateAssignmentVectors`, `m^n` combinations), builds one JOIN per vector, SAT‑checks it, and drops
  the unsatisfiable ones. Output is a `UNION` of surviving JOINs.
  * ➕ Impossible pattern/mapping combinations are eliminated **precisely at compile time**; the emitted
    query is already pruned.
  * ➖ **Exponential** in the number of triple patterns, and all `m^n` vectors are materialized in memory
    before pruning. A 5‑triple BGP over 10 mappings = 100 000 candidates, each a Prolog SAT call.
* **This repo** keeps the factored form: each pattern is rewritten once against a *single merged mapping*
  whose body is a `UNION` of all mapping bodies (`transformContextFromConstructs`), then the per‑pattern
  subselects are JOINed (`operationTransform`). Output size is **`O(n·m)`**.
  * ➕ Compact, scalable, no combinatorial explosion.
  * ➖ Cross‑branch pruning is not intrinsic; it is recovered by *optional* optimization passes
    (`nullifyJoinOverIncompatibleBounds`, `filterFalse`, `pushDownAssertions`). Skip those passes and the
    engine sees a large latent cross‑product to prune at runtime.

This is the fundamental trade‑off: **SRR pays compile‑time (exponential) cost to hand the engine a
pre‑pruned query; this repo hands over a compact query plus algebraic passes that prune on demand.**

## Optimizations SRR performs

1. **Satisfiability pruning (`PrologSAT`).** Per candidate, all subject/predicate/object equality
   constraints are unified in SWI‑Prolog; unsatisfiable candidates become `null` and vanish from the
   UNION. Because templates/IRIs/literals are encoded as Prolog character difference‑lists, this does real
   **template/prefix reasoning** (e.g. a template `http://ex/{id}` cannot unify with `http://other/5`).
   This eager, precise pruning is the one thing SRR does that we approximate more loosely.
2. **`trivialNotEqual` fast path.** A syntactic short‑circuit that drops IRI‑vs‑IRI mismatches without
   invoking SAT.
3. **Connected‑component classification (JGraphT).** Equalities are split into *filter* equalities and
   *binding/rename* equalities via connected components, so a user variable acting only as a join
   intermediary does not emit a redundant `FILTER`.
4. **`select *` fix / empty‑branch dropping.** Reuses the original projection and drops null/empty UNION
   branches.

## Where the two approaches coincide

It is more accurate to say we **factor SRR's two eager steps across a different pipeline** than that we do
something wholly disjoint. Several of our mechanisms target the exact effect SRR gets inline — the
difference is *when* and *how*, not *what*:

| SRR does inline… | …we get the same effect via | Difference |
|------------------|-----------------------------|------------|
| **SAT‑prune an unsatisfiable candidate** (drop the whole JOIN branch) | `nullifyJoinOverIncompatibleBounds` + `filterFalse` (UNION‑identity) drop the equivalent branch | SRR: eager, per full candidate, before emit. Us: after the cross‑product is factored, by algebraic/type reasoning. |
| **`trivialNotEqual`** (IRI≠IRI short‑circuit) | static folding of `FILTER(sameTerm(iri₁, iri₂))` via the Comunica evaluator, then `filterFalse` | Same direct term comparison, one on constants at rewrite time, one as a pass. |
| **Template/prefix reasoning inside SAT** | prefix‑validation checks in `rewriteSinglePattern` + `RangeSet` type ranges + `getStaticExpressionValidation` | SRR: char‑list unification. Us: position ranges + concat/prefix checks. Ours adds pure *type* pruning (`nullifyUnbindableVars`) SRR's unification does not do. |
| **Connected‑component split into filter‑ vs bind‑equalities** (JGraphT) | `ClusterSolver` equality clustering deciding `sameTerm` filters vs. renames/binds | **Essentially the same equality‑graph / union‑find idea**, just built during unfolding instead of after. |
| **`select *` fix / drop empty branches** | `removeProjections` + `filterFalse` UNION‑identity | Same cleanup, different trigger. |

So our branch‑pruning is not a *new capability* over SRR — it is **the same satisfiability/equality pruning
relocated** from an eager SAT call into (a) a cluster solver during unfolding and (b) algebraic passes
afterward. What is genuinely additive is listed next.

## Optimizations this repo adds beyond SRR's remit

Beyond the coinciding pruning above, this repo ships passes and capabilities with **no SRR analogue**
(`lib/transformations/`):

| Pass | What it does |
|------|--------------|
| `pushDownAssertions` | Pushes `FILTER(sameTerm(?x, c))` / `sameTerm(?x, ?y)` down: substitutes terms into BGPs & paths, prunes `VALUES` rows/cols, empties dead UNION branches, turns OPTIONAL over an asserted var into a join. |
| `pullUpExtends` | Floats `BIND`s up past joins/optionals/unions/modifiers, merges duplicates, drops binds nothing reads. |
| `rewriteNonRecursivePaths` | Expands property paths into BGPs (**SRR cannot rewrite paths at all**). |
| `serviceCallMerge` | Hoists/merges `SERVICE` calls to push work to endpoints. |
| `extendsToValues` / `joinValuesToFilter` | Convert binds around empty BGP/VALUES into `VALUES`, and (TODO) constant VALUES into filters. |
| `removeProjections` | Strips subselect projections some engines handle poorly. |

(The pruning passes — `filterFalse`, `nullifyJoinOverIncompatibleBounds`, `nullifyUnbindableVars` — are the
*coinciding* ones from the previous section, not additive; `nullifyUnbindableVars` is the one that reaches
slightly past SRR, proving emptiness from term **types** rather than term values.)

It also supports capabilities SRR lacks entirely: **RDF‑1.2 triple terms** (nested `<<( )>>` heads/patterns,
`SUBJECT/PREDICATE/OBJECT` accessors, `isTRIPLE` guards), **skolem/blank‑node strategies**
(consistent‑bnode extension function, special‑literal, hashed‑IRI), and non‑BGP operators surviving
rewriting cleanly.

## Are they comparable / competitive?

* **Functionally, on a tiny scale:** yes — both correctly unfold single triple patterns and small BGPs and
  emit a UNION of source‑schema subqueries.
* **On pruning philosophy:** SRR is *eager and precise but exponential*; this repo is *compact with
  opt‑in, mostly‑complete pruning*. SRR's SAT pruning is arguably sharper per‑branch; this repo's total
  cost is dramatically lower and its type/range reasoning catches cases SRR's pure unification does not.
* **On expressivity, scalability, portability:** not competitive. This repo handles paths, RDF‑star,
  services, larger BGPs, and needs no native runtime.

## Errors / weaknesses in SRR

* **Exponential blow‑up, fully materialized.** `generateAssignmentVectors` builds all `m^n` vectors in
  memory before any pruning — an OOM/time hazard on realistic inputs. This is the dominant limitation.
* **Case‑folding bug in the SAT encoder.** `PrologSAT.stringAsCharTermList` and
  `NodeTerm.structureToTerm` lowercase every character (`.toLowerCase()`) before unification. Comparisons
  are therefore **case‑insensitive**. It is applied symmetrically, so it can only *fail to prune* a branch
  that is actually unsatisfiable (weaker optimization), not drop a valid one — results stay correct, but
  the headline feature is quietly degraded.
* **Dead/incomplete SAT backend.** `CoreLogicSAT.isSAT` unconditionally returns `false`. It is unused
  today (Prolog is wired in), but if ever selected it would mark **everything** unsatisfiable → empty
  results. Listed as future work ("replace Prolog with core.logic") but shipped as a stub.
* **Heavy, fragile native dependency.** Requires SWI‑Prolog + JPL7 (`libjpl`/`libswipl`) on the
  `java.library.path`. Platform‑specific, awkward to deploy, and a hard barrier to reproducibility.
* **No projection wall around unfolded bodies.** `buildQuery` emits `OpExtend` (not a subselect), leaking
  fresh `rvarN` mapping variables into outer scope; correctness leans on re‑applying the original
  projection at the end and on a global counter to avoid collisions.
* **Jena blank‑node hack.** `AlgebraUtils.isJenaBlank` detects blank nodes by a `?`‑prefixed name because
  "`.isBlank()` is broken in Jena ARQ" — fragile and version‑sensitive.

## Errors / weaknesses in this repo (be critical too)

* **Pruning is not automatic.** The compact JOIN‑of‑UNIONs is only as good as the passes the caller
  chooses to run. Without `nullifyJoinOverIncompatibleBounds`/`filterFalse`/`pushDownAssertions`, the
  output carries a large latent cross‑product for the engine to prune — the opposite of SRR's
  pre‑pruned output. Precision of pruning also depends on the Comunica evaluator and range reasoning
  rather than a single sound decision procedure.
* **Merged‑mapping over‑generation.** Every pattern is unfolded against the union of *all* mappings, even
  when a fixed predicate could select one; the redundant branches then rely on downstream passes to
  disappear. Verbose if those passes are skipped.
* **Unfinished passes / TODOs.** `joinValuesToFilter` is a TODO stub; `EXISTS/NOT EXISTS` handling in
  `pullUpExtends`/pushdown is a documented TODO; `serviceCallMerge` and `removeProjections` carry engine
  caveats ("may cause some engines to behave weird"). The optimization story is powerful but not yet
  uniformly complete.
* **Correctness relies on invariant‑heavy machinery.** `ClusterSolver`, range lattices, and
  cVars/pVars bookkeeping encode subtle invariants (spelled out in `report.md`/`agent-task.md`); this is
  more moving parts to get right than SRR's single SAT call, and several `throw new Error("Unreachable…")`
  guards assume upstream normalization holds.
* **Maturity.** Version `0.0.0`, papers under review, no published/citable release yet — against SRR's
  tagged, DOI‑bearing 1.1.1.

## Restrictions

**SRR**
* Templates must contain **exactly one variable, at the end** (`structureToTerm` handles only "naive"
  templates).
* Only `OpBGP` is rewritten (`Rewriter extends TransformCopy`, overrides `transform(OpBGP)` only).
  **Property paths (`OpPath`) and other non‑BGP constructs are passed through unchanged** — a path over the
  target vocabulary is left querying the source as‑is, which is generally wrong.
* Requires SWI‑Prolog/JPL native libraries at runtime.

**This repo**
* Mapping head must be a **single triple**; **no blank nodes in the head** (use variables); **no `BNODE()`
  in the body**.
* Query must have **no recursive property paths** (`+`, `*`); non‑recursive paths are expanded, recursive
  ones are out of scope.
* Effective pruning quality depends on running the optional optimization passes.

## Bottom line

SRR is a compact, published reference implementation whose defining feature — eager, unification‑based SAT
pruning — is genuinely nice but is bought with an exponential enumeration, a native‑Prolog dependency, a
case‑folding bug, and a query surface limited to plain BGPs with end‑anchored single‑variable templates.
This repository targets the same problem with a polynomial‑size, factored rewriting, a real algebraic
optimization suite, property‑path and RDF‑1.2 triple‑term support, and no native dependencies. It trades
SRR's built‑in precise pruning for opt‑in algebraic passes and more internal machinery to trust, and it is
less mature as a released artifact — but on capability and scalability the two are not close.

## Would the planned features close the gap?

Three features are on this repo's roadmap: **(1)** a transformation that applies the **distributive property
of JOIN over UNION**; **(2)** using Comunica's **expression evaluator to fold static expressions** directly;
and **(3)** extending that with a **word‑equations algorithm** deciding whether constructed strings can be
equal — so that e.g.
`sameTerm(IRI(CONCAT("https://", ?a)), IRI(CONCAT("http://", ?a)))` evaluates to `false`.

These target precisely SRR's two remaining genuine advantages (compile‑time *combination* pruning, and
precise template/string unsatisfiability). Feature‑by‑feature:

* **(1) Distribute JOIN over UNION — the structural enabler.** SRR's per‑candidate SAT pruning works *only*
  because it is in UNION‑of‑JOINs form: two patterns' incompatible mapping choices meet inside one JOIN and
  the branch can be killed. Our factored JOIN‑of‑UNIONs cannot see a *cross‑pattern* incompatibility until
  the branches are distributed into a common JOIN. Once they are, the existing `pushDownAssertions` +
  `nullifyJoinOverIncompatibleBounds` + `filterFalse` already reproduce SRR's combination elimination.
  So distribution is the missing structural step that lets our current passes match SRR's compile‑time
  pruning.
  * ⚠️ **Caveat:** full distribution re‑introduces exactly SRR's `mⁿ` blow‑up. The advantage over SRR is
    that it is **opt‑in and selective** — SRR is *always* exponential; this repo would pay the cost only
    where a combination actually prunes. To avoid materializing the whole DNF, the pass should **prune while
    distributing** (mirroring SRR dropping `null` candidates as it enumerates) rather than distribute‑then‑
    prune.

* **(2) Static evaluation via Comunica.** Subsumes SRR's `trivialNotEqual`: it folds *any* static
  (sub)expression, not just IRI‑vs‑IRI. Already partially present in the pruning passes; making it a
  first‑class step hardens the term‑level half of the check.

* **(3) Word equations on constructed strings.** This is the direct analogue — and a strict generalization
  — of SRR's Prolog char‑difference‑list unification. SRR only encodes **one variable, at the end** (pure
  prefix matching); a word‑equation solver over `CONCAT`/`IRI`/`STR` handles variables anywhere, multiple
  variables, and shared suffixes, and is **case‑correct** (SRR's encoding lowercases, see the bug above).
  The motivating example is actually decidable by SRR too (trailing variable), but the general template
  case is not representable in SRR at all — which is where this repo, whose mappings already permit general
  templates, needs the extra reasoning to prune as precisely as it unfolds.

**Net assessment.** With all three, this repo would **match SRR on pruning precision and exceed it on
template generality**, while retaining a compact, scalable *default* mode SRR does not offer. Two honesty
checks:

1. **Expressive parity is real.** SRR's SAT check is syntactic unification = union‑find over equalities +
   occurs‑check + structural decomposition. Our equality clustering (`ClusterSolver`) + assertion pushdown +
   range meet + a word‑equation refutation check cover the same reasoning, so the *power* is equivalent;
   what differs is staging, not strength.
2. **Cost and soundness.** The pre‑pruned mode inherits SRR's exponential size, so distribution must be
   selective and prune‑as‑you‑go, not a blanket pass. And word equations are PSPACE‑hard: the solver only
   needs to be **sound for refutation** ("cannot be equal" only when it truly cannot); incompleteness costs
   *pruning*, never correctness — the same sound‑but‑incomplete nature SRR's unification already has.

Everything that already makes this repo broader — property paths, RDF‑1.2 triple terms, `SERVICE` merging,
and no native Prolog dependency — remains a net advantage untouched by this comparison. So once (1)–(3)
land, the gap does not merely close; it tilts in this repo's favour, with the single standing caveat that
matching SRR's *eager* pruning means opting into SRR's *exponential* cost for that query.
