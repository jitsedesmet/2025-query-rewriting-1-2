Start by reading the algebra section of the SPARQL SPEC
(from https://www.w3.org/TR/sparql12-query/#sparqlAlgebra stopping right before https://www.w3.org/TR/sparql12-query/#grammar) 
With that in mind, write a transformer that pushes down constrainting operators FILTER and JOIN into other operators.
Implement within the pushDownRestrictors which also contains some ideas already.

A query like:
```sparql
SELECT ?m_o WHERE {
{
  VALUES( ?m_p ?m_s ){
    ( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies><https://example.com/t> )
  }
  {
    {
      SELECT ?mi_o ?mi_p ?mi_s ?mi_t WHERE {
        ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> .
        ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Subject> ?mi_s .
        ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Predicate> ?mi_p .
        ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Object> ?mi_o .
      }
    }
    BIND( ?mi_t AS ?m_s )
    BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?m_p )
    BIND( <<( ?mi_s ?mi_p ?mi_o )>> AS ?m_o )
  }
  UNION {
    {
      SELECT ?mi_o ?mi_p ?mi_s WHERE {
        ?mi_s ?mi_p ?mi_o .
      }
    }
    BIND( ?mi_s AS ?m_s )
    BIND( ?mi_p AS ?m_p )
    BIND( ?mi_o AS ?m_o )
  }
  FILTER ( ( <https://example.com/me> = SUBJECT( ?m_o ) ) )
}
FILTER ( ( <https://example.com/name> = PREDICATE( ?m_o ) ) )
}
```

Can be optimized significantly by pushing down the transforming the JOIN over UNION into UNION over JOIN. In general, having JOIN as deep into the plan as possible is a good idea(?).
Look into the spec, but also related literature (see Foundations of SPARQL Query Optimization.pdf) and implement at least the distributive property between UNION and JOIN. 
Create a report on you findings in report.md in the root of this repo.


```sparql
SELECT ?m_o WHERE {
{
  {
    {
      {
        SELECT ?mi_o ?mi_p ?mi_s ?mi_t WHERE {
          ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> .
          ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Subject> ?mi_s .
          ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Predicate> ?mi_p .
          ?mi_t <http://www.w3.org/1999/02/22-rdf-syntax-ns#Object> ?mi_o .
        }
      }
      BIND( ?mi_t AS ?m_s )
      BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?m_p )
      BIND( <<( ?mi_s ?mi_p ?mi_o )>> AS ?m_o )
    }
    VALUES( ?m_p ?m_s ){
      ( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies><https://example.com/t> )
    }
  }
  UNION {
    {
      {
        SELECT ?mi_o ?mi_p ?mi_s WHERE {
          ?mi_s ?mi_p ?mi_o .
        }
      }
      BIND( ?mi_s AS ?m_s )
      BIND( ?mi_p AS ?m_p )
      BIND( ?mi_o AS ?m_o )
    }
    VALUES( ?m_p ?m_s ){
      ( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies><https://example.com/t> )
    }  
  }
  FILTER ( ( <https://example.com/me> = SUBJECT( ?m_o ) ) )
}
FILTER ( ( <https://example.com/name> = PREDICATE( ?m_o ) ) )
}
```

Implement rewriting tests to validate your work.
