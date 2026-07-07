We have concluded before that a GAV mapping for RDF means you only have one mapping that constructs the global schema (1 triples relation).
Full reasoning: https://2026-amw-rewriting.jitsedesmet.be/
Our current flow involves providing many mappings and Skolem head functions. This API can still hold but should be transformed in a single mapping with BIND/ Extend operations to cover the skolem functions. Our optimization steps then perform static analysis on the expressions in the newly created mapper.

For example the mappings:

```ts
const mappings = [{
        head: c.AF.createMappingHead(c.DF.variable('s'), c.DF.variable('p'), c.AF.createTemplateIri(
          [ 'ex://', c.DF.variable('s') ],
        )),
        body: <Algebra.Project>parseQuery(c, 'SELECT * { ?s  ?p <ex://b> }'),
      }, {
        head: c.AF.createMappingHead(c.DF.variable('s'), c.DF.variable('p'), c.AF.createTemplateIri(
          [ 'example://', c.DF.variable('s') ],
        )),
        body: <Algebra.Project>parseQuery(c, 'SELECT * { ?s  ?p <ex://c> }'),
      }]
```

can be transformed into a single mapping:

```sparql
CONSTRUCT { ?s ?p ?o } WHERE { {
    ?s ?p <ex://b> .
    BIND ( IRI ( CONCAT ( 'ex://', ?s ) ) AS ?o )
  } UNION {
    ?s ?p <ex://c> .
    BIND ( IRI( CONCAT( 'example://', ?s ) ) AS ?o )
  }
}
```
