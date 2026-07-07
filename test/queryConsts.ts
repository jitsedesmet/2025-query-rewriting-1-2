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

/**
 * Maps singleton properties to RDF 1.2 triple terms.
 * A singleton property (?prop) represents a unique occurrence of a property relationship
 * that carries annotations via rdf:singletonPropertyOf.
 */
export const singletonPropertyConstruct = `
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
CONSTRUCT {
  ?prop rdf:reifies <<( ?s ?trueProp ?o )>>
} WHERE {
  ?s ?prop ?o .
  ?prop rdf:singletonPropertyOf ?trueProp .
}
`;

/**
 * Maps non-singleton triples (excluding singleton property predicates and their metadata)
 * to normal form for use alongside singletonPropertyConstruct.
 */
export const nonSingletonTripleConstruct = `
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
CONSTRUCT {
  ?s ?p ?o .
} WHERE {
  ?s ?p ?o .
  FILTER ( !isTriple(?o) ) .
  FILTER NOT EXISTS { ?p rdf:singletonPropertyOf ?trueProp . }
  FILTER NOT EXISTS { ?s rdf:singletonPropertyOf ?trueProp . }
}
`;

export const testQuery = `
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX : <https://example.com/>

SELECT * WHERE {
  :t rdf:reifies <<( :me :name ?name )>> .
  :t :statedBy :govBE .
  ?s ?p ?o .
  ?s1 ?s1 ?o1 .
}`;

export const expectedQuery = `SELECT ( ?uq_name AS ?name ) ( ?uq_o AS ?o ) ( ?uq_o1 AS ?o1 ) ( ?uq_p AS ?p ) ( ?uq_s AS ?s ) ( ?uq_s1 AS ?s1 ) WHERE {
  {
    FILTER ( FALSE )
  }
  {
    SELECT ( "dummy" AS ?dummy ) WHERE {
      {
        BIND( <https://example.com/govBE> AS ?ms_o )
        BIND( <https://example.com/statedBy> AS ?ms_p )
        BIND( <https://example.com/t> AS ?ms_s )
      }
      {
        {
          SELECT ?m0_t WHERE {
            ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#tripleTerm> .
            ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttSubject> ?m0_s .
            ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttPredicate> ?m0_p .
            ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttObject> ?m0_o .
            ?m0_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?m0_g_0 .
          }
        }
        BIND( <<( ?m0_s ?m0_p ?m0_o )>> AS ?ms_o )
        BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?ms_p )
        BIND( ?m0_t AS ?ms_s )
      }
      UNION {
        {
          SELECT ?m1_s ?m1_o ?m1_p WHERE {
            ?m1_s ?m1_p ?m1_o .
            FILTER ( ( ! ISTRIPLE( ?m1_o ) && ( ( ?m1_p != "rdf:reifies" ) && NOT EXISTS {
              ?m1_sRoot <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?m1_s .
            }
            ) ) )
          }
        }
        BIND( ?m1_o AS ?ms_o )
        BIND( ?m1_p AS ?ms_p )
        BIND( ?m1_s AS ?ms_s )
      }
    }
  }
  {
    {
      SELECT ?ms_o ?ms_p ?ms_s WHERE {
        {
          {
            SELECT ?m0_t WHERE {
              ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#tripleTerm> .
              ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttSubject> ?m0_s .
              ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttPredicate> ?m0_p .
              ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttObject> ?m0_o .
              ?m0_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?m0_g_0 .
            }
          }
          BIND( <<( ?m0_s ?m0_p ?m0_o )>> AS ?ms_o )
          BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?ms_p )
          BIND( ?m0_t AS ?ms_s )
        }
        UNION {
          {
            SELECT ?m1_s ?m1_o ?m1_p WHERE {
              ?m1_s ?m1_p ?m1_o .
              FILTER ( ( ! ISTRIPLE( ?m1_o ) && ( ( ?m1_p != "rdf:reifies" ) && NOT EXISTS {
                ?m1_sRoot <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?m1_s .
              }
              ) ) )
            }
          }
          BIND( ?m1_o AS ?ms_o )
          BIND( ?m1_p AS ?ms_p )
          BIND( ?m1_s AS ?ms_s )
        }
      }
    }
    BIND( ?ms_o AS ?uq_o )
    BIND( ?ms_p AS ?uq_p )
    BIND( ?ms_s AS ?uq_s )
  }
  {
    {
      SELECT ?ms_o ?rms_s_AND_p WHERE {
        {
          {
            SELECT ?m0_t WHERE {
              ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#tripleTerm> .
              ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttSubject> ?m0_s .
              ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttPredicate> ?m0_p .
              ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttObject> ?m0_o .
              ?m0_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?m0_g_0 .
            }
          }
          BIND( <<( ?m0_s ?m0_p ?m0_o )>> AS ?ms_o )
          BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?rms_s_AND_p )
          BIND( ?m0_t AS ?rms_s_AND_p )
        }
        UNION {
          {
            SELECT ?m1_s ?m1_o ?m1_p WHERE {
              ?m1_s ?m1_p ?m1_o .
              FILTER ( ( ! ISTRIPLE( ?m1_o ) && ( ( ?m1_p != "rdf:reifies" ) && NOT EXISTS {
                ?m1_sRoot <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?m1_s .
              }
              ) ) )
            }
          }
          BIND( ?m1_o AS ?ms_o )
          BIND( ?m1_p AS ?rms_s_AND_p )
          BIND( ?m1_s AS ?rms_s_AND_p )
        }
      }
    }
    BIND( ?ms_o AS ?uq_o1 )
    BIND( ?rms_s_AND_p AS ?uq_s1 )
  }
}`;

export const expectedQueryOptimizedBounds = `SELECT ( ?uq_name AS ?name ) ( ?uq_o AS ?o ) ( ?uq_o1 AS ?o1 ) ( ?uq_p AS ?p ) ( ?uq_s AS ?s ) ( ?uq_s1 AS ?s1 ) WHERE {
  {
    FILTER ( FALSE )
  }
  {
    SELECT ( "dummy" AS ?dummy ) WHERE {
      {
        {
          {
            {
              SELECT ?m0_t WHERE {
                ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#tripleTerm> .
                ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttSubject> ?m0_s .
                ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttPredicate> ?m0_p .
                ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttObject> ?m0_o .
                ?m0_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?m0_g_0 .
              }
            }
            FILTER ( FALSE )
          }
          FILTER ( FALSE )
        }
        FILTER ( ( ?m0_t = <https://example.com/t> ) )
      }
      UNION {
        {
          {
            {
              SELECT ?m1_s ?m1_o ?m1_p WHERE {
                ?m1_s ?m1_p ?m1_o .
                FILTER ( ( ! ISTRIPLE( ?m1_o ) && ( ( ?m1_p != "rdf:reifies" ) && NOT EXISTS {
                  ?m1_sRoot <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?m1_s .
                }
                ) ) )
              }
            }
            FILTER ( ( ?m1_o = <https://example.com/govBE> ) )
          }
          FILTER ( ( ?m1_p = <https://example.com/statedBy> ) )
        }
        FILTER ( ( ?m1_s = <https://example.com/t> ) )
      }
    }
  }
  {
    {
      SELECT ?ms_o ?ms_p ?ms_s WHERE {
        {
          {
            SELECT ?m0_t WHERE {
              ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#tripleTerm> .
              ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttSubject> ?m0_s .
              ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttPredicate> ?m0_p .
              ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttObject> ?m0_o .
              ?m0_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?m0_g_0 .
            }
          }
          BIND( <<( ?m0_s ?m0_p ?m0_o )>> AS ?ms_o )
          BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?ms_p )
          BIND( ?m0_t AS ?ms_s )
        }
        UNION {
          {
            SELECT ?m1_s ?m1_o ?m1_p WHERE {
              ?m1_s ?m1_p ?m1_o .
              FILTER ( ( ! ISTRIPLE( ?m1_o ) && ( ( ?m1_p != "rdf:reifies" ) && NOT EXISTS {
                ?m1_sRoot <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?m1_s .
              }
              ) ) )
            }
          }
          BIND( ?m1_o AS ?ms_o )
          BIND( ?m1_p AS ?ms_p )
          BIND( ?m1_s AS ?ms_s )
        }
      }
    }
    BIND( ?ms_o AS ?uq_o )
    BIND( ?ms_p AS ?uq_p )
    BIND( ?ms_s AS ?uq_s )
  }
  {
    {
      SELECT ?ms_o ?rms_s_AND_p WHERE {
        {
          {
            SELECT ?m0_t WHERE {
              ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#tripleTerm> .
              ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttSubject> ?m0_s .
              ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttPredicate> ?m0_p .
              ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttObject> ?m0_o .
              ?m0_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?m0_g_0 .
            }
          }
          BIND( <<( ?m0_s ?m0_p ?m0_o )>> AS ?ms_o )
          BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?rms_s_AND_p )
          BIND( ?m0_t AS ?rms_s_AND_p )
        }
        UNION {
          {
            SELECT ?m1_s ?m1_o ?m1_p WHERE {
              ?m1_s ?m1_p ?m1_o .
              FILTER ( ( ! ISTRIPLE( ?m1_o ) && ( ( ?m1_p != "rdf:reifies" ) && NOT EXISTS {
                ?m1_sRoot <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?m1_s .
              }
              ) ) )
            }
          }
          BIND( ?m1_o AS ?ms_o )
          BIND( ?m1_p AS ?rms_s_AND_p )
          BIND( ?m1_s AS ?rms_s_AND_p )
        }
      }
    }
    BIND( ?ms_o AS ?uq_o1 )
    BIND( ?rms_s_AND_p AS ?uq_s1 )
  }
}`;

export const expectedQueryOptimizedBoundsAndEmptyRes = `SELECT ( ?uq_name AS ?name ) ( ?uq_o AS ?o ) ( ?uq_o1 AS ?o1 ) ( ?uq_p AS ?p ) ( ?uq_s AS ?s ) ( ?uq_s1 AS ?s1 ) WHERE {
  FILTER ( FALSE )
}`;
