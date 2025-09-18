export const tripleTermConstruct = `
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
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
`;

export const nonTripleTermConstruct = `
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
CONSTRUCT {
  ?s ?p ?o .
} WHERE {
  ?s ?p ?o .
  # Next filter is not needed since in 1.1 the function does not exist
  FILTER ( !isTriple(?o) ) . 
  FILTER ( ?p != "rdf:reifies" && NOT EXISTS {
    ?sRoot rdf:reifies ?s . 
  } )
}
`;

export const testQuery = `
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX : <https://example.com/>

SELECT * WHERE {
  :t rdf:reifies <<( :me :name ?name )>> .
  :t :statedBy :govBE
}`;

export const expectedQuery = `
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX : <https://example.com/>

SELECT * WHERE {
  # We use m1 m2 m3 any time the Mapping Head has a triple term
  {
   # Need only select what is not bound by the Mapping Head.
    { SELECT ?o WHERE {
        # mapping head as triple pattern bind
      BIND( :t as ?t ).
      BIND( :me as ?s ).
      BIND( :name as ?p )
      ?t rdf:reifies [
        a rdf:tripleTerm ;
        rdf:ttSubject ?s ;
        rdf:ttPredicate ?p ;
        rdf:ttObject ?o ;
    ] } }
     # triple Pattern as mapping head
    BIND (?o as ?name ).
    # Bind is only needed if user query tries to bind a variable to a TT.
    # BIND (triple(?m1 ?m2 ?m3) as ?o)
  } UNION {
    { SELECT ?s ?p ?o WHERE {
        BIND( :t as ?s ).
        BIND( rdf:reifies as ?p ).
        BIND( <<(:me :name ?name)>> as ?o ). # Rewrite knows you cannot...
        ?s ?p ?o .
        # Next filter is not needed since in 1.1 the function does not exist
        FILTER ( !isTriple(?o) ) . 
        FILTER ( ?p != "rdf:reifies" && NOT EXISTS {
            ?sRoot rdf:reifies ?s . 
        } )
    } }
    # NO bind cuz it is wrong. Mapping
  }
}`;
