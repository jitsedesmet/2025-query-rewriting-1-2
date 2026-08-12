The last two commits on main added support for variable assertion pushdown where a variable is asserted to equal a static term,
and also the variable clique assertion where many variables equal each-other but are not necessarily bound to a term.

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
