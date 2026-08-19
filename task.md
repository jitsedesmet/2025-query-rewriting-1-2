Main has support for variable assertion pushdown where a variable is asserted to equal a static term (#28, #29),
and the variable clique assertion where many variables equal each-other but are not necessarily bound to a term (#30).
This is our extension of the algebraic rewriting framework of Schmidt, Meier, Lausen, ["Foundations of SPARQL
Query Optimization"](https://dl.acm.org/doi/pdf/10.1145/1804669.1804675) (ICDT 2010), whose Figure 2 the rule
names throughout the code refer to: the pushdown is its
filter elimination (FElimI/FElimII) carried across the whole algebra rather than only under a projection
that drops the eliminated variable, licensed by the (F*Push) side conditions and bounded by (FBndI)-(FBndIV).

In this PR we aim to extend that filter pushdown with support for triple terms.
E.g.:

```sparql
SELECT * {
   ?s ?p ?o
   FILTER(sameTerm(subject(?o), ?s))
}
```
Can be optimized to:
```sparql
SELECT * {
  ?s ?p <<( ?s ?fresh1 ?fresh2 )>> .
  BIND(<<( ?s ?fresh1 ?fresh2 )>> AS ?o) .
}
```

Of course, this feature should interop with the term assertion and variable unification.
So if a unified group of variables gets asserted, this information would also travel down as such.

Support for Strong and Weak Variables might also be required for effective push down (just like we have now).

Start by creating a study of how our `AssertionConjunction` structure should be updated.
Look whether we can reuse e.g. TermClusterSet given some changes.
Write your finding in `report.md` in the root of this repo so I can properly review.

## Progress

That study is `report.md`, and `task-for-agent.md` is the implementation contract it was turned into.
Two of its phases are already on main:

* **#31 `ac6d447`** — phase 0: `vRanges` on `CPMeta`, which absorbed `pVars` as its key set, plus the
  emptiness rules that reads (in `normalisedFor` and in the new `nullifyUnbindableVars` pass) and the
  metadata clearing at the end of the pushdown.
* **#32 `e18a8dd`** — phase 1: ground triple terms are assertable, and `BIND(<<( :a :b :c )>> AS ?t)`
  binds `?t` certainly.

Left to do: the pin lattice on `TermClusterSet`, accesses and `T⟨?x⟩`, materialising derived variables
into patterns, and the per-operation rules. See the status table at the top of `task-for-agent.md`.
