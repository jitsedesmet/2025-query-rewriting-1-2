The last commit on main added support for variable assertion pushdown where a variable is asserted to equal a static term.

In this PR we aim to extend that filter pushdown with support for variable unification.
E.g.:

```sparql
SELECT * {
   ?s ?p ?o
   FILTER(sameTerm(?s, ?o))
}
```
Can be optimized to:
```sparql
SELECT * {
  ?s ?p ?s .
  BIND(?s AS ?o) .
}
```

Of course, this feature should interop with the term assertion. So if a unified group of variables gets asserted, this information would also travel down as such:  

```sparql
SELECT * {
   { ?s ?p ?o FILTER(sameTerm(x, <ex://x>) }
   UNION
   { ?s <ex://p> ?o }
   FILTER(sameTerm(?s, ?o))
}
```
becomes
```sparql
SELECT * {
  { <ex://x> ?p <ex://x> . BIND(<ex://x> AS ?s). BIND(<ex://x> AS ?o)}
  UNION
  { ?s <ex://p> ?s . BIND(?s AS ?o) }
}
```

Support for Strong and Weak Variables might also be required for effective push down (just like we have now).

Start by creating a study of how our `AssertionConjunction` structure should be updated.
Look whether we can reuse e.g. ClusterSolver or ClusterSet given some changes. 
Write your finding in `report.md` in the root of this repo so I can properly review.
