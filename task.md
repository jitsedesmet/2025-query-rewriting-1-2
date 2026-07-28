Please implement the feature requested bellow in accordance to the SPARQL 1.2 specification:
https://www.w3.org/TR/sparql12-query/

Write rewriting tests for it (in rewriting.test.ts) and commit your changes once you are done (ensuring the pre commit hooks pass).

``````
For a filter whose top-level conjuncts include `sameTerm(?v, term)` or
`<iri> = ?v` (equivalent for IRIs), push the filter down to an operand that
allows substitution, replace every occurrence of `?v` with `term`, and wrap the
result in `Extend(term AS ?v)`.

```
Filter(sameTerm(?v, <a>), P)   ->   Extend(P[?v := <a>], ?v, <a>)
```

The `Extend` makes the rewrite value-preserving, so no proof that `?v` is unused
is needed. `BOUND(?v)` inside the substituted operand becomes `true`.

Depends on the existing filter-pushdown pass; adds an extend pull-up/merge pass:

```
Union(Extend(A,?x,a), Extend(B,?x,a))  ->  Extend(Union(A,B), ?x, a)
```

Plus dead-extend elimination: drop `Extend(P,?v,t)` when `?v` is not in scope anywhere above. (like not being projected)

``````
