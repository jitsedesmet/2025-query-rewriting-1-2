# Query Rewriting SPARQL 1.2 over RDF 1.1

We will be using SPARQL CONSTRUCT queries to express the mapping between RDF 1.1 and RDF 1.2.
![img.png](assets/schematic-plan.png)

Query rewrites like this are called GAV, LAV and GLAV in literature.
See: Principles of Data Integration - AnHai Doan - Alon Halevy - Zachary Ives
NOTE: in the construct template/ mapping head, you cannot share non-existential atoms (bnodes) between triples.
(unless you bind to them through your bgp (they map to a source bnode))

There is a working draft for a spec describing the mapping between RDF1.1 and RDF 1.2: [RDF1.2 interoperability](https://w3c.github.io/rdf-interop/spec/)

Example data expressed in Turtle 1.2

### Sparql 1.2 rewrite

The intention is that you have a SPARQL 1.2 query and mapping using construct queries.
The body of this mapping should not contain any SPARQL 1.2 syntax, but the head can contain triple terms.
Using this approach means that you cannot rewrite recursive triple terms for arbitrary depth,
you will need a construct for every depth you want to support.
What our rewriter will do is map each triple pattern in your BGP to a list of unions for each construct over some selects.
When you are solving the variables of your mapping head, it should be noted that triple term binding appears outside the SUB-SELECTS,
thereby creating a toplevel query that can use SPARQL 1.2 construct, but does not contain any BGPs, and a bunch of subselects that only use SPARQL1.1 and do contain the BGPs.
![](assets/query-rewritten.jpg)

### RDF 1.2 examples

```
:me :name "jitse" ~ :t {| :statedBy :govBE |}
```
-- RDF 1.2 spec ->
```
:me :name "jitse" .
< :me :name "jitse" ~ :t > :satatedBy :govBE
```
-- RDF 1.2 spec ->
```
:me :name "jitse"
:t rdf:reifies <<( :me :name "jitse" )>>
:t :statedBy :govBE
```

#### Interop spec/ RDF reification
-- to RDF1.1 ->
```
:me :name "jitse" .
:t :rdf:reifies _:temp .
:t :statedBy :govBE .

_:temp a rdftripleTerm .
_:temp rdf:ttSubject :me .
_:temp rdf:ttPredicate :name .
_:temp rdf:ttObject "jitse" .
```

construct to go back:
```
CONSTRUCT {
    ?t rdf:reifies <<( ?s ?p ?o )>>
} WHERE {
    ?t rdf:reifies [
        a rdf:tripleTerm ;
        rdf:ttSubject ?s ;
        rdf:ttPredicate ?p ;
        rdf:ttObject ?o ;
    ]
}
CONSTRUCT {
    ?s ?p ?o .
} WHERE {
    ?s ?p ?o .
    # Next filter is not needed since in 1.1 the function does not exist
    FILTER ( !isTripleTerm(?o)) .
    FILTER ( ?p != "rdf:reifies" && NOT EXISTS {
        ?sRoot rdf:reifies ?s .
    })
}
```
Construct to go to: (Because 2 ways, can do GLAV)
```
CONSTRUCT {
    ?t rdf:reifies [
        a rdf:tripleTerm ;
        rdf:ttSubject ?s ;
        rdf:ttPredicate ?p ;
        rdf:ttObject ?o ;
    ]
} WHERE {
    ?t rdf:reifies <<( ?s ?p ?o )>>
}
```

#### Singleton Property
-- to RDF 1.1 ->
```
:me :name "jitse"
:me :name#1 "jitse"
:name#1 rdf:singletonProperyOf :name ;
        :statedBy :govBE .
```

Construct to go back:
```
CONSTRUCT {
    ?p rdf:reifies <<( ?s ?trueProp ?o )>>
} WHERE {
    ?s ?p ?o .
    ?p rdf:singletonPropertyOf ?trueProp .
}
```

#### Named Graphs
Either:
1. trust the graph has only one triple,
2. use one subject multiple times to reify many triples,
3. Annotate the graph has only one triple (could also use a count subquery?)

-- to RDF1.1 ->
```
:me :name "jitse"
_:temp { :me :name "jitse" }
_:temp :statedBy :govBE .
```

Construct to go back:
```
CONSTRUCT {
    ?t rdf:reifies <<( ?s ?p ?o )>> ; ?p1 ?o1 .
} WHERE {
    GRAPH ?t { ?s ?p ?o } .
    ?t ?p1 ?o1 .
    OPTIONAL { ?t a some:reificationGraph }
}
```

Construct to go back with a check for only one triple
```
CONSTRUCT {
    ?t rdf:reifies <<( ?s ?p ?o )>> ; ?p1 ?o1 .
} WHERE {
    {
        SELECT ?t WHERE {
            GRAPH ?t { ?s ?p ?o }
        } GROUP BY (?t) having (count(*) = 1)
    }
    GRAPH ?t { ?s ?p ?o } .
    ?t ?p1 ?o1 .
}
```

#### N-ary
(used by Wikidata under the [prefixes](https://www.wikidata.org/wiki/EntitySchema:E49), p(property), ps(property statement) and wdt(property direct))

-- to RDF 1.1 ->
```
:me :name "jitse" .
:me :nameP _:temp .
_:temp :statedBy :govBE .
_:temp :namePs "jitse" .

# Made up properties...
:nameP :hasDirectProp :name .
:nameP :hasPropertyStatement ?ps .
```

Construct to go back:
```
CONSTRUCT {
    ?rel rdf:reifies <<( ?s ?trueProp ?o )>> ; ?p1 ?o1 .
} WHERE {
    ?s ?p ?rel .
    ?rel ?p1 ?o1 ;
         ?ps ?o .

     ?p :hasDirectProp :name ;
        :hasPropertyStatement ?ps ;
}
```

### Matchers
You match recursive triples:
`?rel rdf:reifies <<( :me :name ?name )>>`
=> `(?rel, rdf:reifies, (:me, :name, ?name)) ''` ('' = DefaultGraph)

#### Why you need a solver:
Take rewrite head: `?t rdf:reifies <<( ?s ?p ?o )>>`
With query: `?s1 ?s1 <<( ?s1 ?p1 ?o1 )>>`
Your solver will now be able to say conclude:
```
?t -> rdf:reifies
?s -> rdf:reifies
?p -> p1
?o -> o1
```

### Quirks documented

Empty groups emit a single binding that does not bind to anything ([proof](https://www.w3.org/TR/sparql11-query/#emptyGroupPattern)):
* `SELECT * {}`  gives 1 binding ([query](https://query.comunica.dev/#transientDatasources=%2F%2Ffragments.dbpedia.org%2F2016-04%2Fen&query=SELECT%20*%0AWHERE%20%7B%0A%0A%7D))
* `SELECT * { {} UNION {} }` gives 2 bindings [(query](https://query.comunica.dev/#transientDatasources=%2F%2Ffragments.dbpedia.org%2F2016-04%2Fen&query=SELECT%20*%0AWHERE%20%7B%0A%20%20%7B%7D%20UNION%20%7B%7D%0A%7D))

Therefore, a mapping that does not match under a union does **NOT produce the empty group**.
It does not produce results. To visualize this, one can also use the group: `{ FILTER(false) }` ([query](https://query.comunica.dev/#transientDatasources=%2F%2Ffragments.dbpedia.org%2F2016-04%2Fen&query=SELECT%20*%0AWHERE%20%7B%0A%20%20%7B%20FILTER%28false%29%20%7D%20UNION%20%7B%20FILTER%28false%29%20%7D%0A%7D))
