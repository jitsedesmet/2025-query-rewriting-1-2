export const tripleTermConstruct = `
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
CONSTRUCT {
  ?t rdf:reifies <<( ?s ?p ?o )>>
} WHERE {
  ?t a rdf:Statement ;
       rdf:Subject ?s ;
       rdf:Predicate ?p ;
       rdf:Object ?o ;
}
`;

export const nonTripleTermConstruct = `
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
CONSTRUCT WHERE {
  ?s ?p ?o .
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
    {
      SELECT ?p0_m_o WHERE {
        {
          {
            BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?p0_m_p )
            BIND( <https://example.com/t> AS ?p0_m_s )
          }
          {
            {
              SELECT ?p0_mi_o ?p0_mi_p ?p0_mi_s ?p0_mi_t WHERE {
                ?p0_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> .
                ?p0_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Subject> ?p0_mi_s .
                ?p0_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Predicate> ?p0_mi_p .
                ?p0_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Object> ?p0_mi_o .
              }
            }
            BIND( ?p0_mi_t AS ?p0_m_s )
            BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?p0_m_p )
            BIND( <<( ?p0_mi_s ?p0_mi_p ?p0_mi_o )>> AS ?p0_m_o )
          }
          UNION {
            {
              SELECT ?p0_mi_o ?p0_mi_p ?p0_mi_s WHERE {
                ?p0_mi_s ?p0_mi_p ?p0_mi_o .
              }
            }
            BIND( ?p0_mi_s AS ?p0_m_s )
            BIND( ?p0_mi_p AS ?p0_m_p )
            BIND( ?p0_mi_o AS ?p0_m_o )
          }
          FILTER ( ( <https://example.com/me> = SUBJECT( ?p0_m_o ) ) )
        }
        FILTER ( ( <https://example.com/name> = PREDICATE( ?p0_m_o ) ) )
      }
    }
    BIND( OBJECT( ?p0_m_o ) AS ?uq_name )
  }
  {
    SELECT ( "dummy" AS ?p1_mExists ) WHERE {
      {
        BIND( <https://example.com/govBE> AS ?p1_m_o )
        BIND( <https://example.com/statedBy> AS ?p1_m_p )
        BIND( <https://example.com/t> AS ?p1_m_s )
      }
      {
        {
          SELECT ?p1_mi_o ?p1_mi_p ?p1_mi_s ?p1_mi_t WHERE {
            ?p1_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> .
            ?p1_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Subject> ?p1_mi_s .
            ?p1_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Predicate> ?p1_mi_p .
            ?p1_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Object> ?p1_mi_o .
          }
        }
        BIND( ?p1_mi_t AS ?p1_m_s )
        BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?p1_m_p )
        BIND( <<( ?p1_mi_s ?p1_mi_p ?p1_mi_o )>> AS ?p1_m_o )
      }
      UNION {
        {
          SELECT ?p1_mi_o ?p1_mi_p ?p1_mi_s WHERE {
            ?p1_mi_s ?p1_mi_p ?p1_mi_o .
          }
        }
        BIND( ?p1_mi_s AS ?p1_m_s )
        BIND( ?p1_mi_p AS ?p1_m_p )
        BIND( ?p1_mi_o AS ?p1_m_o )
      }
    }
  }
  {
    {
      SELECT ?p2_m_o ?p2_m_p ?p2_m_s WHERE {
        {
          {
            SELECT ?p2_mi_o ?p2_mi_p ?p2_mi_s ?p2_mi_t WHERE {
              ?p2_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> .
              ?p2_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Subject> ?p2_mi_s .
              ?p2_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Predicate> ?p2_mi_p .
              ?p2_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Object> ?p2_mi_o .
            }
          }
          BIND( ?p2_mi_t AS ?p2_m_s )
          BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?p2_m_p )
          BIND( <<( ?p2_mi_s ?p2_mi_p ?p2_mi_o )>> AS ?p2_m_o )
        }
        UNION {
          {
            SELECT ?p2_mi_o ?p2_mi_p ?p2_mi_s WHERE {
              ?p2_mi_s ?p2_mi_p ?p2_mi_o .
            }
          }
          BIND( ?p2_mi_s AS ?p2_m_s )
          BIND( ?p2_mi_p AS ?p2_m_p )
          BIND( ?p2_mi_o AS ?p2_m_o )
        }
      }
    }
    BIND( ?p2_m_o AS ?uq_o )
    BIND( ?p2_m_p AS ?uq_p )
    BIND( ?p2_m_s AS ?uq_s )
  }
  {
    {
      SELECT ?p3_m_o ?p3_rm_s_AND_p WHERE {
        {
          {
            {
              {
                SELECT ?p3_mi_o ?p3_mi_p ?p3_mi_s ?p3_mi_t WHERE {
                  ?p3_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> .
                  ?p3_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Subject> ?p3_mi_s .
                  ?p3_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Predicate> ?p3_mi_p .
                  ?p3_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Object> ?p3_mi_o .
                }
              }
              BIND( ?p3_mi_t AS ?p3_rm_s_AND_p )
            }
            FILTER ( SAMETERM( ?p3_rm_s_AND_p , <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ) )
          }
          BIND( <<( ?p3_mi_s ?p3_mi_p ?p3_mi_o )>> AS ?p3_m_o )
        }
        UNION {
          {
            {
              {
                SELECT ?p3_mi_o ?p3_mi_p ?p3_mi_s WHERE {
                  ?p3_mi_s ?p3_mi_p ?p3_mi_o .
                }
              }
              BIND( ?p3_mi_s AS ?p3_rm_s_AND_p )
            }
            FILTER ( SAMETERM( ?p3_rm_s_AND_p , ?p3_mi_p ) )
          }
          BIND( ?p3_mi_o AS ?p3_m_o )
        }
      }
    }
    BIND( ?p3_m_o AS ?uq_o1 )
    BIND( ?p3_rm_s_AND_p AS ?uq_s1 )
  }
}`;

export const expectedQueryToValues = `SELECT ( ?uq_name AS ?name ) ( ?uq_o AS ?o ) ( ?uq_o1 AS ?o1 ) ( ?uq_p AS ?p ) ( ?uq_s AS ?s ) ( ?uq_s1 AS ?s1 ) WHERE {
  {
    {
      SELECT ?p0_m_o WHERE {
        {
          VALUES( ?p0_m_p ?p0_m_s ){
            ( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies><https://example.com/t> )
          }
          {
            {
              SELECT ?p0_mi_o ?p0_mi_p ?p0_mi_s ?p0_mi_t WHERE {
                ?p0_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> .
                ?p0_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Subject> ?p0_mi_s .
                ?p0_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Predicate> ?p0_mi_p .
                ?p0_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Object> ?p0_mi_o .
              }
            }
            BIND( ?p0_mi_t AS ?p0_m_s )
            BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?p0_m_p )
            BIND( <<( ?p0_mi_s ?p0_mi_p ?p0_mi_o )>> AS ?p0_m_o )
          }
          UNION {
            {
              SELECT ?p0_mi_o ?p0_mi_p ?p0_mi_s WHERE {
                ?p0_mi_s ?p0_mi_p ?p0_mi_o .
              }
            }
            BIND( ?p0_mi_s AS ?p0_m_s )
            BIND( ?p0_mi_p AS ?p0_m_p )
            BIND( ?p0_mi_o AS ?p0_m_o )
          }
          FILTER ( ( <https://example.com/me> = SUBJECT( ?p0_m_o ) ) )
        }
        FILTER ( ( <https://example.com/name> = PREDICATE( ?p0_m_o ) ) )
      }
    }
    BIND( OBJECT( ?p0_m_o ) AS ?uq_name )
  }
  {
    SELECT ( "dummy" AS ?p1_mExists ) WHERE {
      VALUES( ?p1_m_o ?p1_m_p ?p1_m_s ){
        ( <https://example.com/govBE><https://example.com/statedBy><https://example.com/t> )
      }
      {
        {
          SELECT ?p1_mi_o ?p1_mi_p ?p1_mi_s ?p1_mi_t WHERE {
            ?p1_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> .
            ?p1_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Subject> ?p1_mi_s .
            ?p1_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Predicate> ?p1_mi_p .
            ?p1_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Object> ?p1_mi_o .
          }
        }
        BIND( ?p1_mi_t AS ?p1_m_s )
        BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?p1_m_p )
        BIND( <<( ?p1_mi_s ?p1_mi_p ?p1_mi_o )>> AS ?p1_m_o )
      }
      UNION {
        {
          SELECT ?p1_mi_o ?p1_mi_p ?p1_mi_s WHERE {
            ?p1_mi_s ?p1_mi_p ?p1_mi_o .
          }
        }
        BIND( ?p1_mi_s AS ?p1_m_s )
        BIND( ?p1_mi_p AS ?p1_m_p )
        BIND( ?p1_mi_o AS ?p1_m_o )
      }
    }
  }
  {
    {
      SELECT ?p2_m_o ?p2_m_p ?p2_m_s WHERE {
        {
          {
            SELECT ?p2_mi_o ?p2_mi_p ?p2_mi_s ?p2_mi_t WHERE {
              ?p2_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> .
              ?p2_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Subject> ?p2_mi_s .
              ?p2_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Predicate> ?p2_mi_p .
              ?p2_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Object> ?p2_mi_o .
            }
          }
          BIND( ?p2_mi_t AS ?p2_m_s )
          BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?p2_m_p )
          BIND( <<( ?p2_mi_s ?p2_mi_p ?p2_mi_o )>> AS ?p2_m_o )
        }
        UNION {
          {
            SELECT ?p2_mi_o ?p2_mi_p ?p2_mi_s WHERE {
              ?p2_mi_s ?p2_mi_p ?p2_mi_o .
            }
          }
          BIND( ?p2_mi_s AS ?p2_m_s )
          BIND( ?p2_mi_p AS ?p2_m_p )
          BIND( ?p2_mi_o AS ?p2_m_o )
        }
      }
    }
    BIND( ?p2_m_o AS ?uq_o )
    BIND( ?p2_m_p AS ?uq_p )
    BIND( ?p2_m_s AS ?uq_s )
  }
  {
    {
      SELECT ?p3_m_o ?p3_rm_s_AND_p WHERE {
        {
          {
            {
              {
                SELECT ?p3_mi_o ?p3_mi_p ?p3_mi_s ?p3_mi_t WHERE {
                  ?p3_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> .
                  ?p3_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Subject> ?p3_mi_s .
                  ?p3_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Predicate> ?p3_mi_p .
                  ?p3_mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Object> ?p3_mi_o .
                }
              }
              BIND( ?p3_mi_t AS ?p3_rm_s_AND_p )
            }
            FILTER ( SAMETERM( ?p3_rm_s_AND_p , <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ) )
          }
          BIND( <<( ?p3_mi_s ?p3_mi_p ?p3_mi_o )>> AS ?p3_m_o )
        }
        UNION {
          {
            {
              {
                SELECT ?p3_mi_o ?p3_mi_p ?p3_mi_s WHERE {
                  ?p3_mi_s ?p3_mi_p ?p3_mi_o .
                }
              }
              BIND( ?p3_mi_s AS ?p3_rm_s_AND_p )
            }
            FILTER ( SAMETERM( ?p3_rm_s_AND_p , ?p3_mi_p ) )
          }
          BIND( ?p3_mi_o AS ?p3_m_o )
        }
      }
    }
    BIND( ?p3_m_o AS ?uq_o1 )
    BIND( ?p3_rm_s_AND_p AS ?uq_s1 )
  }
}`;

export const expectedQueryOptimizedBoundsAndEmptyRes = `
SELECT ( ?uq_name AS ?name ) ( ?uq_o AS ?o ) ( ?uq_o1 AS ?o1 ) ( ?uq_p AS ?p ) ( ?uq_s AS ?s ) ( ?uq_s1 AS ?s1 ) WHERE {
  {
    {
      SELECT ?m0_o WHERE {
        <https://example.com/t> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> .
        <https://example.com/t> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Subject> <https://example.com/me> .
        <https://example.com/t> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Predicate> <https://example.com/name> .
        <https://example.com/t> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Object> ?m0_o .
      }
    }
    BIND( ?m0_o AS ?uq_name )
  }
  {
    SELECT ( "dummy" AS ?dummy ) WHERE {
      <https://example.com/t> <https://example.com/statedBy> <https://example.com/govBE> .
    }
  }
  {
    {
      SELECT ?m0_o ?m0_p ?m0_s ?m0_t WHERE {
        ?m0_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> .
        ?m0_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Subject> ?m0_s .
        ?m0_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Predicate> ?m0_p .
        ?m0_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Object> ?m0_o .
      }
    }
    BIND( <<( ?m0_s ?m0_p ?m0_o )>> AS ?uq_o )
    BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?uq_p )
    BIND( ?m0_t AS ?uq_s )
  }
  UNION {
    {
      SELECT ?m1_o ?m1_p ?m1_s WHERE {
        ?m1_s ?m1_p ?m1_o .
      }
    }
    BIND( ?m1_o AS ?uq_o )
    BIND( ?m1_p AS ?uq_p )
    BIND( ?m1_s AS ?uq_s )
  }
  {
    {
      SELECT ?m0_o ?m0_p ?m0_s WHERE {
        <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> .
        <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Subject> ?m0_s .
        <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Predicate> ?m0_p .
        <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Object> ?m0_o .
      }
    }
    BIND( <<( ?m0_s ?m0_p ?m0_o )>> AS ?uq_o1 )
    BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?uq_s1 )
  }
  UNION {
    {
      SELECT ?m1_o ?rm1_s_AND_p WHERE {
        ?rm1_s_AND_p ?rm1_s_AND_p ?m1_o .
      }
    }
    BIND( ?m1_o AS ?uq_o1 )
    BIND( ?rm1_s_AND_p AS ?uq_s1 )
  }
}`;
