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

export const expectedQuery = `
SELECT ( ?uq_name AS ?name ) ( ?uq_o AS ?o ) ( ?uq_o1 AS ?o1 ) ( ?uq_p AS ?p ) ( ?uq_s AS ?s ) ( ?uq_s1 AS ?s1 ) WHERE {
  {
    {
      SELECT ?m0_o WHERE {
        {
          BIND( <https://example.com/name> AS ?m0_p )
          BIND( <https://example.com/me> AS ?m0_s )
          BIND( <https://example.com/t> AS ?m0_t )
        }
        ?m0_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> .
        ?m0_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Subject> ?m0_s .
        ?m0_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Predicate> ?m0_p .
        ?m0_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Object> ?m0_o .
      }
    }
    BIND( ?m0_o AS ?uq_name )
  }
  UNION {
    FILTER ( FALSE )
  }
  {
    FILTER ( FALSE )
  }
  UNION {
    SELECT ( "dummy" AS ?dummy ) WHERE {
      {
        BIND( <https://example.com/govBE> AS ?m1_o )
        BIND( <https://example.com/statedBy> AS ?m1_p )
        BIND( <https://example.com/t> AS ?m1_s )
      }
      ?m1_s ?m1_p ?m1_o .
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
        {
          BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?m0_t )
        }
        ?m0_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> .
        ?m0_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Subject> ?m0_s .
        ?m0_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Predicate> ?m0_p .
        ?m0_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Object> ?m0_o .
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

export const expectedQueryOptimizedBounds = `
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
  UNION {
    FILTER ( FALSE )
  }
  {
    FILTER ( FALSE )
  }
  UNION {
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
