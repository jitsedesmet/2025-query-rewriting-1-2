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
          BIND( <https://example.com/t> AS ?m0_t )
          BIND( <https://example.com/me> AS ?m0_s )
          BIND( <https://example.com/name> AS ?m0_p )
        }
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#tripleTerm> .
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttSubject> ?m0_s .
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttPredicate> ?m0_p .
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttObject> ?m0_o .
        ?m0_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?m0_g_0 .
      }
    }
    BIND( ?m0_o AS ?uq_name )
  }
  UNION {
    FILTER ( "false"^^<http://www.w3.org/2001/XMLSchema#boolean> )
  }
  {
    FILTER ( "false"^^<http://www.w3.org/2001/XMLSchema#boolean> )
  }
  UNION {
    SELECT ( "dummy"^^<http://www.w3.org/2001/XMLSchema#string> AS ?dummy ) WHERE {
      {
        BIND( <https://example.com/t> AS ?m1_s )
        BIND( <https://example.com/statedBy> AS ?m1_p )
        BIND( <https://example.com/govBE> AS ?m1_o )
      }
      {
        ?m1_s ?m1_p ?m1_o .
        FILTER ( ( ! ISTRIPLE( ?m1_o ) && ( ( ?m1_p != "rdf:reifies"^^<http://www.w3.org/2001/XMLSchema#string> ) && NOT EXISTS {
          ?m1_sRoot <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?m1_s .
        }
        ) ) )
      }
    }
  }
  {
    {
      SELECT ?m0_t ?m0_s ?m0_p ?m0_o WHERE {
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#tripleTerm> .
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttSubject> ?m0_s .
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttPredicate> ?m0_p .
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttObject> ?m0_o .
        ?m0_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?m0_g_0 .
      }
    }
    BIND( ?m0_t AS ?uq_s )
    BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?uq_p )
    BIND( <<( ?m0_s ?m0_p ?m0_o )>> AS ?uq_o )
  }
  UNION {
    {
      SELECT ?m1_s ?m1_p ?m1_o WHERE {
        ?m1_s ?m1_p ?m1_o .
        FILTER ( ( ! ISTRIPLE( ?m1_o ) && ( ( ?m1_p != "rdf:reifies"^^<http://www.w3.org/2001/XMLSchema#string> ) && NOT EXISTS {
          ?m1_sRoot <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?m1_s .
        }
        ) ) )
      }
    }
    BIND( ?m1_s AS ?uq_s )
    BIND( ?m1_p AS ?uq_p )
    BIND( ?m1_o AS ?uq_o )
  }
  {
    {
      SELECT ?m0_s ?m0_p ?m0_o WHERE {
        {
          BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?m0_t )
        }
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#tripleTerm> .
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttSubject> ?m0_s .
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttPredicate> ?m0_p .
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttObject> ?m0_o .
        ?m0_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?m0_g_0 .
      }
    }
    BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?uq_s1 )
    BIND( <<( ?m0_s ?m0_p ?m0_o )>> AS ?uq_o1 )
  }
  UNION {
    {
      SELECT ?rm1_s_AND_p ?m1_o WHERE {
        ?rm1_s_AND_p ?rm1_s_AND_p ?m1_o .
        FILTER ( ( ! ISTRIPLE( ?m1_o ) && ( ( ?rm1_s_AND_p != "rdf:reifies"^^<http://www.w3.org/2001/XMLSchema#string> ) && NOT EXISTS {
          ?m1_sRoot <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?rm1_s_AND_p .
        }
        ) ) )
      }
    }
    BIND( ?rm1_s_AND_p AS ?uq_s1 )
    BIND( ?m1_o AS ?uq_o1 )
  }
}`;

export const expectedQueryOptimizedBounds = `
SELECT ( ?uq_name AS ?name ) ( ?uq_o AS ?o ) ( ?uq_o1 AS ?o1 ) ( ?uq_p AS ?p ) ( ?uq_s AS ?s ) ( ?uq_s1 AS ?s1 ) WHERE {
  {
    {
      SELECT ?m0_o WHERE {
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#tripleTerm> .
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttSubject> <https://example.com/me> .
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttPredicate> <https://example.com/name> .
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttObject> ?m0_o .
        <https://example.com/t> <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?m0_g_0 .
      }
    }
    BIND( ?m0_o AS ?uq_name )
  }
  UNION {
    FILTER ( "false"^^<http://www.w3.org/2001/XMLSchema#boolean> )
  }
  {
    FILTER ( "false"^^<http://www.w3.org/2001/XMLSchema#boolean> )
  }
  UNION {
    SELECT ( "dummy"^^<http://www.w3.org/2001/XMLSchema#string> AS ?dummy ) WHERE {
      {
        <https://example.com/t> <https://example.com/statedBy> <https://example.com/govBE> .
        FILTER ( ( ! ISTRIPLE( ?m1_o ) && ( ( ?m1_p != "rdf:reifies"^^<http://www.w3.org/2001/XMLSchema#string> ) && NOT EXISTS {
          ?m1_sRoot <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> <https://example.com/t> .
        }
        ) ) )
      }
    }
  }
  {
    {
      SELECT ?m0_t ?m0_s ?m0_p ?m0_o WHERE {
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#tripleTerm> .
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttSubject> ?m0_s .
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttPredicate> ?m0_p .
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttObject> ?m0_o .
        ?m0_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?m0_g_0 .
      }
    }
    BIND( ?m0_t AS ?uq_s )
    BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?uq_p )
    BIND( <<( ?m0_s ?m0_p ?m0_o )>> AS ?uq_o )
  }
  UNION {
    {
      SELECT ?m1_s ?m1_p ?m1_o WHERE {
        ?m1_s ?m1_p ?m1_o .
        FILTER ( ( ! ISTRIPLE( ?m1_o ) && ( ( ?m1_p != "rdf:reifies"^^<http://www.w3.org/2001/XMLSchema#string> ) && NOT EXISTS {
          ?m1_sRoot <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?m1_s .
        }
        ) ) )
      }
    }
    BIND( ?m1_s AS ?uq_s )
    BIND( ?m1_p AS ?uq_p )
    BIND( ?m1_o AS ?uq_o )
  }
  {
    {
      SELECT ?m0_s ?m0_p ?m0_o WHERE {
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#tripleTerm> .
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttSubject> ?m0_s .
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttPredicate> ?m0_p .
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttObject> ?m0_o .
        <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?m0_g_0 .
      }
    }
    BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?uq_s1 )
    BIND( <<( ?m0_s ?m0_p ?m0_o )>> AS ?uq_o1 )
  }
  UNION {
    {
      SELECT ?rm1_s_AND_p ?m1_o WHERE {
        ?rm1_s_AND_p ?rm1_s_AND_p ?m1_o .
        FILTER ( ( ! ISTRIPLE( ?m1_o ) && ( ( ?rm1_s_AND_p != "rdf:reifies"^^<http://www.w3.org/2001/XMLSchema#string> ) && NOT EXISTS {
          ?m1_sRoot <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?rm1_s_AND_p .
        }
        ) ) )
      }
    }
    BIND( ?rm1_s_AND_p AS ?uq_s1 )
    BIND( ?m1_o AS ?uq_o1 )
  }
}`;

export const expectedQueryOptimizedBoundsAndEmptyRes = `
SELECT ( ?uq_name AS ?name ) ( ?uq_o AS ?o ) ( ?uq_o1 AS ?o1 ) ( ?uq_p AS ?p ) ( ?uq_s AS ?s ) ( ?uq_s1 AS ?s1 ) WHERE {
  {
    {
      SELECT ?m0_o WHERE {
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#tripleTerm> .
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttSubject> <https://example.com/me> .
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttPredicate> <https://example.com/name> .
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttObject> ?m0_o .
        <https://example.com/t> <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?m0_g_0 .
      }
    }
    BIND( ?m0_o AS ?uq_name )
  }
  {
    SELECT ( "dummy"^^<http://www.w3.org/2001/XMLSchema#string> AS ?dummy ) WHERE {
      {
        <https://example.com/t> <https://example.com/statedBy> <https://example.com/govBE> .
        FILTER ( ( ! ISTRIPLE( ?m1_o ) && ( ( ?m1_p != "rdf:reifies"^^<http://www.w3.org/2001/XMLSchema#string> ) && NOT EXISTS {
          ?m1_sRoot <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> <https://example.com/t> .
        }
        ) ) )
      }
    }
  }
  {
    {
      SELECT ?m0_t ?m0_s ?m0_p ?m0_o WHERE {
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#tripleTerm> .
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttSubject> ?m0_s .
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttPredicate> ?m0_p .
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttObject> ?m0_o .
        ?m0_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?m0_g_0 .
      }
    }
    BIND( ?m0_t AS ?uq_s )
    BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?uq_p )
    BIND( <<( ?m0_s ?m0_p ?m0_o )>> AS ?uq_o )
  }
  UNION {
    {
      SELECT ?m1_s ?m1_p ?m1_o WHERE {
        ?m1_s ?m1_p ?m1_o .
        FILTER ( ( ! ISTRIPLE( ?m1_o ) && ( ( ?m1_p != "rdf:reifies"^^<http://www.w3.org/2001/XMLSchema#string> ) && NOT EXISTS {
          ?m1_sRoot <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?m1_s .
        }
        ) ) )
      }
    }
    BIND( ?m1_s AS ?uq_s )
    BIND( ?m1_p AS ?uq_p )
    BIND( ?m1_o AS ?uq_o )
  }
  {
    {
      SELECT ?m0_s ?m0_p ?m0_o WHERE {
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#tripleTerm> .
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttSubject> ?m0_s .
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttPredicate> ?m0_p .
        ?m0_g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttObject> ?m0_o .
        <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?m0_g_0 .
      }
    }
    BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?uq_s1 )
    BIND( <<( ?m0_s ?m0_p ?m0_o )>> AS ?uq_o1 )
  }
  UNION {
    {
      SELECT ?rm1_s_AND_p ?m1_o WHERE {
        ?rm1_s_AND_p ?rm1_s_AND_p ?m1_o .
        FILTER ( ( ! ISTRIPLE( ?m1_o ) && ( ( ?rm1_s_AND_p != "rdf:reifies"^^<http://www.w3.org/2001/XMLSchema#string> ) && NOT EXISTS {
          ?m1_sRoot <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?rm1_s_AND_p .
        }
        ) ) )
      }
    }
    BIND( ?rm1_s_AND_p AS ?uq_s1 )
    BIND( ?m1_o AS ?uq_o1 )
  }
}`;
