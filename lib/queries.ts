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
  :t rdf:reifies <<( :me :name ?q_name )>> .
  :t :statedBy :govBE .
  ?q_s ?q_p ?q_o .
}`;

export const expectedQuery = `
SELECT ?q_name ?q_o ?q_p ?q_s WHERE {
  {
    {
      SELECT ?o WHERE {
        BIND( <https://example.com/t> AS ?t )
        BIND( <https://example.com/me> AS ?s )
        BIND( <https://example.com/name> AS ?p )
        ?g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#tripleTerm> .
        ?g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttSubject> ?s .
        ?g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttPredicate> ?p .
        ?g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttObject> ?o .
        ?t <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?g_0 .        
      }      
    }
    BIND( ?o AS ?q_name )    
  }
  {
    {
      SELECT ( "dummy"^^<http://www.w3.org/2001/XMLSchema#string> AS ?dummy ) WHERE {
        BIND( <https://example.com/t> AS ?s )
        BIND( <https://example.com/statedBy> AS ?p )
        BIND( <https://example.com/govBE> AS ?o )
        {
          ?s ?p ?o .
          FILTER ( ( ! ISTRIPLE( ?o ) && ( ( ?p != "rdf:reifies"^^<http://www.w3.org/2001/XMLSchema#string> ) && NOT EXISTS {
            ?sRoot <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?s .            
          }
          ) ) )          
        }        
      }      
    }    
  }
  {
    {
      SELECT ?t ?s ?p ?o WHERE {
        ?g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#tripleTerm> .
        ?g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttSubject> ?s .
        ?g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttPredicate> ?p .
        ?g_0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#ttObject> ?o .
        ?t <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?g_0 .        
      }      
    }
    BIND( ?t AS ?q_s )
    BIND( <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> AS ?q_p )
    BIND( <<( ?s ?p ?o )>> AS ?q_o )    
  }
  UNION {
    {
      SELECT ?s ?p ?o WHERE {
        ?s ?p ?o .
        FILTER ( ( ! ISTRIPLE( ?o ) && ( ( ?p != "rdf:reifies"^^<http://www.w3.org/2001/XMLSchema#string> ) && NOT EXISTS {
          ?sRoot <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?s .          
        }
        ) ) )        
      }      
    }
    BIND( ?s AS ?q_s )
    BIND( ?p AS ?q_p )
    BIND( ?o AS ?q_o )    
  }  
}
`;
