Task: let transformFilterFalse see through nested PROJECT (sub-SELECT) nodes

Repository: jitsedesmet/2025-query-rewriting-1-2. Branch off main and open a PR against main.

Problem

transformFilterFalse (lib/transformations/filterFalse.ts) propagates an empty result (FILTER(FALSE)) upward through JOIN, UNION, EXTEND, FILTER, DISTINCT, SLICE, GRAPH, ORDER_BY, MINUS, LEFT_JOIN and VALUES, but not through   
PROJECT. The file already has this TODO:

// TODO: the projection of an empty query is the empty query (if not outer project)

operationTransform wraps every mapper branch in a sub-SELECT. So when pushDownAssertions proves a UNION branch empty, the FILTER(FALSE) it produces sits inside a PROJECT:

join > project > extend > extend > union > extend > extend > extend > project > filter(false)

- transformFilterFalse stops at that inner project.
- So the EXTENDs above it are not absorbed, and the UNION never drops the branch.
- removeProjections later strips the PROJECT, but no transformFilterFalse runs after it.
- The dead branch therefore survives into the generated SPARQL as a full ?s ?p ?o scan guarded by FILTER(false).

Measured impact

Over the 24 BKR-star benchmark queries (reification and singleton mappings), two pipelines each leave 32 dead FILTER(false) branches, spread over 20 of the 24 queries:
- operationTransform, transformFilterFalse, nullifyJoinOverIncompatibleBounds, transformFilterFalse, pushDownAssertions, transformFilterFalse, removeProjections
- the same, with pullUpExtends applied after the pushdown and again after removeProjections

The plain pipeline and the removeProjections pipeline leave none. Appending one more transformFilterFalse after removeProjections removes all 32, which confirms the cause. That is only a pipeline workaround, though; the fix   
belongs in transformFilterFalse itself.

The dead branches return no rows, but they are not free. Engines still plan or evaluate the scan, and Comunica's cardinality estimate for it (about the size of the whole dataset) makes the join planner pick a disastrous join  
order. On reification/F-Q3 that is the difference between an out-of-memory crash and a plan that streams results.

                               Minimal reproduction                                                                                                                                                                                                              

It does not reproduce with tripleTermConstruct / nonTripleTermConstruct from test/queryConsts.ts; it needs a reification-style mapping. Use these two mappers. They are not on main yet, so add them to test/queryConsts.ts or    
inline them in the test:

sparql
# reification mapper
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>                                                                                                                                                                         
CONSTRUCT { ?t rdf:reifies <<( ?s ?p ?o )>> }                                                                                                                                                                                     
WHERE { ?t rdf:type rdf:Statement ; rdf:subject ?s ; rdf:predicate ?p ; rdf:object ?o . }

# pass-through mapper for everything that is not reification structure
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>                                                                                                                                                                         
CONSTRUCT { ?s ?p ?o . }                                                                                                                                                                                                          
WHERE {                                                                                                                                                                                                                           
?s ?p ?o .                                                                                                                                                                                                                      
FILTER ( !isTriple(?o) ) .                                                                                                                                                                                                      
FILTER ( ?p != rdf:subject && ?p != rdf:predicate && ?p != rdf:object ) .                                                                                                                                                       
FILTER ( ?p != rdf:type || ?o != rdf:Statement ) .                                                                                                                                                                              
}

Query (a constant subject in the quoted triple is enough to trigger it; a fully variable << ?s ?p ?o >> is not):


sparql                                                                                                                                                                                                                            
PREFIX bkr: <http://mor.nlm.nih.gov/bkr/>                                                                                                                                                                                         
PREFIX bkr_sn: <http://mor.nlm.nih.gov/bkr/SEMNET_>                                                                                                                                                                               
PREFIX provenir: <http://knoesis.wright.edu/provenir/>                                                                                                                                                                            
SELECT ?o ?source WHERE { << bkr:META_C0040300-INST bkr_sn:PART_OF ?o >> provenir:derives_from ?source . }

Run it with:

queryTransform(transformContextFromConstructs([ reification, passThrough ]), query, [                                                                                                                                             
operationTransform, transformFilterFalse, nullifyJoinOverIncompatibleBounds, transformFilterFalse,                                                                                                                              
pushDownAssertions, transformFilterFalse, removeProjections,                                                                                                                                                                    
]);

Today the output contains one FILTER ( FALSE ) branch; it should contain none. test/statics/REF-Benchmark/BKR/queries/BKR-star_F-Q3.rq, which is already on main, shows the same with two annotations.

What to change

In transformFilterFalse, treat a PROJECT whose input is FILTER(FALSE) as empty, so the emptiness keeps propagating to the EXTENDs, JOINs and UNIONs above it. Remove the TODO, and update the behaviour list in the function's doc
comment and in lib/transformations/index.ts.

The implementation must respect these constraints:

1. Keep in-scope variables. pushDownAssertions deliberately builds its FILTER(FALSE) with the replaced operation as input (createFilterFalse(c, replaced)); its doc says "pVars(Empty_S) := S, never the empty set, or SELECT *
   scoping changes silently". The replacement for an empty PROJECT must still carry the projection's variables. Do not turn it into FILTER(FALSE) over an empty BGP if that changes what an enclosing SELECT * exposes.
2. Outermost projection. queryTransform strips the query's own top-level PROJECT before running passes and re-adds it afterwards, so within that flow every PROJECT a pass sees is nested. But transformFilterFalse is exported   
   publicly. If it is handed an operation whose root is a PROJECT, the result must still expose the same variables (an empty SELECT ?a ?b is still a SELECT ?a ?b). Decide how to handle that, and test it.
3. Idempotent. Running transformFilterFalse twice must give the same algebra as running it once, with no ever-growing FILTER(FALSE)/PROJECT wrappers.
4. Sub-SELECT modifiers. A sub-SELECT with DISTINCT, REDUCED, or LIMIT/OFFSET over an empty input is still empty. Aggregation is different: an aggregate without GROUP BY over an empty input returns one row in SPARQL (COUNT(*)
   = 0), so a GROUP must not be treated as absorbing. Only collapse what is really empty.




Tests to add

- Algebra-level unit tests: UNION(A, EXTEND(PROJECT(FILTER(FALSE)))) becomes A, and JOIN(A, PROJECT(FILTER(FALSE))) becomes empty.
- The reproduction above: both the pushdown pipeline and the pullUpExtends pipeline produce SPARQL with no FILTER(false).
- Root-level PROJECT and SELECT * scoping: the generated query exposes the same variables as before the change.
- Aggregates: a GROUP/aggregate over FILTER(FALSE) is left alone and still returns its single row.
- Idempotence: transformFilterFalse(c, transformFilterFalse(c, op)) deep-equals transformFilterFalse(c, op) for the shapes above.
- Style: follow the existing style in test/removeProjections.test.ts and test/pushDownAssertions.test.ts: queryTransform plus string assertions, and a Comunica bindings-equivalence check where the data allows it.

Definition of done

- yarn build, yarn lint and yarn test pass (the husky pre-commit hook runs all three).
- No existing expected-query fixtures change, except ones that previously contained an unreachable FILTER(false) branch. Explain any such fixture change in the PR.
- The PR description states the root cause, the before/after on the reproduction, and how constraints 1–4 are handled.

Out of scope: the EXISTS/NOT EXISTS and SERVICE SILENT TODOs in the same file, and any benchmark-harness changes.                                                                                                                 
            
