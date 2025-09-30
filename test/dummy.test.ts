import { toAlgebra } from '@traqula/algebra-sparql-1-2';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { Parser } from '@traqula/parser-sparql-1-2';
import { describe, it } from 'vitest';
import type { expect as Expect } from 'vitest';
import { substituteVarsThatArePreBoundToTerms } from '../lib/transformations/boundedVarSubstitution.js';
import { transformFilterFalse } from '../lib/transformations/filterFalse.js';
import { nullifyJoinOverIncompatibleBounds } from '../lib/transformations/nullifyJoinOverIncompatibleBounds.js';
import { pushUpBoundedFromUnion } from '../lib/transformations/pushUpBoundedFromUnion.js';
import { operationTransform, queryTransform } from '../lib/transformBgp.js';
import type { TransformContext } from '../lib/transformContext.js';
import { createTransformContext } from '../lib/transformContext.js';
import {
  expectedQuery,
  expectedQueryOptimizedBounds,
  expectedQueryOptimizedBoundsAndEmptyRes,
  nonTripleTermConstruct,
  testQuery,
  tripleTermConstruct,
} from './queries.js';

describe('dummy', () => {
  const parser = new Parser();

  function test(
    expect: typeof Expect,
    userQuery: string,
    expectedQuery: string,
    mappers: string[],
    transformations: ((c: TransformContext, op: Algebra.Operation) => Algebra.Operation)[] = [ operationTransform ],
  ): void {
    const transformerContext = createTransformContext(mappers);
    expect(queryTransform(transformerContext, userQuery, transformations).trim())
      .toEqual(expectedQuery.trim());

    const _expectedAst = parser.parse(expectedQuery);
    const _expectedAlgebra = toAlgebra(_expectedAst, { quads: true });
    const _me = 2;
  }

  it('simple', ({ expect }) => test(expect, testQuery, expectedQuery, [ tripleTermConstruct, nonTripleTermConstruct ]));

  it('simple & optimizeBinds', ({ expect }) => test(
    expect,
    testQuery,
    expectedQueryOptimizedBounds,
    [ tripleTermConstruct, nonTripleTermConstruct ],
    [ operationTransform, substituteVarsThatArePreBoundToTerms ],
  ));

  it('simple & optimizeBinds & optimizeEmptyResultSets', ({ expect }) => test(
    expect,
    testQuery,
    expectedQueryOptimizedBoundsAndEmptyRes,
    [ tripleTermConstruct, nonTripleTermConstruct ],
    [ operationTransform, substituteVarsThatArePreBoundToTerms, transformFilterFalse ],
  ));

  it('spo with blank in mapping head', ({ expect }) => test(
    expect,
`SELECT * { ?s ?p ?o }`,
`SELECT ?uq_o ?uq_p ?uq_s WHERE {
  {
    {
      SELECT ?m0_s ?m0_p WHERE {
        ?m0_s ?m0_p ?m0_o .        
      }      
    }
    BIND( ?m0_s AS ?uq_s )
    BIND( ?m0_p AS ?uq_p )
    BIND( BNODE( "e_blank"^^<http://www.w3.org/2001/XMLSchema#string> ) AS ?uq_o )    
  }  
}`,
[ `CONSTRUCT { ?s ?p _:blank } WHERE { ?s ?p ?o }` ],
  ));

  it('sps with blank in mapping head', ({ expect }) => test(
    expect,
`SELECT * { ?s ?p ?s }`,
`SELECT ?uq_p ?uq_s WHERE {
  {
    FILTER ( "false"^^<http://www.w3.org/2001/XMLSchema#boolean> )    
  }  
}`,
[ `CONSTRUCT { ?s ?p _:blank } WHERE { ?s ?p ?o }` ],
  ));

  it('handle no matching query', ({ expect }) => test(
    expect,
    `SELECT * { ?s <ex://a> ?o }`,
    `SELECT ?uq_o ?uq_s WHERE {
  {
    FILTER ( "false"^^<http://www.w3.org/2001/XMLSchema#boolean> )    
  }
  UNION {
    FILTER ( "false"^^<http://www.w3.org/2001/XMLSchema#boolean> )    
  }  
}`,
    [ `CONSTRUCT WHERE { ?s <ex://b> ?o }`, `CONSTRUCT WHERE { ?s <ex://c> ?o }` ],
  ));

  it('handle no matching query & optimizeBinds & optimizeEmptyResultSets', ({ expect }) => test(
    expect,
    `SELECT * { ?s <ex://a> ?o }`,
    `SELECT ?uq_o ?uq_s WHERE {
  FILTER ( "false"^^<http://www.w3.org/2001/XMLSchema#boolean> )  
}`,
    [ `CONSTRUCT WHERE { ?s <ex://b> ?o }`, `CONSTRUCT WHERE { ?s <ex://c> ?o }` ],
    [ operationTransform, substituteVarsThatArePreBoundToTerms, transformFilterFalse ],
  ));

  it('pushUpBinds', ({ expect }) => test(
    expect,
    `SELECT * { ?s ?p ?o }`,
    `SELECT ?uq_o ?uq_p ?uq_s WHERE {
  {
    {
      SELECT ?m0_s ?m0_o WHERE {
        ?m0_s <ex://b> ?m0_o .        
      }      
    }
    BIND( ?m0_s AS ?uq_s )
    BIND( ?m0_o AS ?uq_o )    
  }
  UNION {
    {
      SELECT ?m1_s ?m1_o WHERE {
        ?m1_s <ex://b> ?m1_o .        
      }      
    }
    BIND( ?m1_s AS ?uq_s )
    BIND( ?m1_o AS ?uq_o )    
  }
  BIND( <ex://b> AS ?uq_p )  
}`,
    [ `CONSTRUCT WHERE { ?s <ex://b> ?o }`, `CONSTRUCT WHERE { ?s <ex://b> ?o }` ],
    [ operationTransform, substituteVarsThatArePreBoundToTerms, transformFilterFalse, pushUpBoundedFromUnion ],
  ));

  it('no join optimization', ({ expect }) => test(
    expect,
    `SELECT * { ?s ?p ?o . <ex://a> ?p ?o }`,
    `SELECT ?uq_o ?uq_p ?uq_s WHERE {
  {
    {
      SELECT ?m0_o WHERE {
        <ex://a> <ex://a> ?m0_o .        
      }      
    }
    BIND( <ex://a> AS ?uq_s )
    BIND( <ex://a> AS ?uq_p )
    BIND( ?m0_o AS ?uq_o )    
  }
  UNION {
    {
      SELECT ?m1_o WHERE {
        <ex://b> <ex://b> ?m1_o .        
      }      
    }
    BIND( <ex://b> AS ?uq_s )
    BIND( <ex://b> AS ?uq_p )
    BIND( ?m1_o AS ?uq_o )    
  }
  {
    {
      SELECT ?m0_o WHERE {
        <ex://a> <ex://a> ?m0_o .        
      }      
    }
    BIND( <ex://a> AS ?uq_p )
    BIND( ?m0_o AS ?uq_o )    
  }  
}`,
    [ `CONSTRUCT WHERE { <ex://a> <ex://a> ?o }`, `CONSTRUCT WHERE { <ex://b> <ex://b> ?o }` ],
    [ operationTransform, transformFilterFalse ],
  ));

  it('join optimization', ({ expect }) => test(
    expect,
    `SELECT * { ?s ?p ?o . <ex://a> ?p ?o }`,
    `SELECT ?uq_o ?uq_p ?uq_s WHERE {
  {
    {
      SELECT ?m0_o WHERE {
        <ex://a> <ex://a> ?m0_o .        
      }      
    }
    BIND( <ex://a> AS ?uq_s )
    BIND( <ex://a> AS ?uq_p )
    BIND( ?m0_o AS ?uq_o )    
  }
  {
    {
      SELECT ?m0_o WHERE {
        <ex://a> <ex://a> ?m0_o .        
      }      
    }
    BIND( <ex://a> AS ?uq_p )
    BIND( ?m0_o AS ?uq_o )    
  }  
}`,
    [ `CONSTRUCT WHERE { <ex://a> <ex://a> ?o }`, `CONSTRUCT WHERE { <ex://b> <ex://b> ?o }` ],
    [ operationTransform, transformFilterFalse, nullifyJoinOverIncompatibleBounds, transformFilterFalse ],
  ));

  it('join optimization 1', ({ expect }) => test(
    expect,
    `SELECT * { ?s ?p ?o . <ex://a> ?p ?o }`,
    `SELECT ?uq_o ?uq_p ?uq_s WHERE {
  {
    {
      SELECT ?m0_o WHERE {
        <ex://a> <ex://a> ?m0_o .        
      }      
    }
    BIND( <ex://a> AS ?uq_s )
    BIND( <ex://a> AS ?uq_p )
    BIND( ?m0_o AS ?uq_o )    
  }
  UNION {
    {
      SELECT ?m1_o WHERE {
        <ex://a> <ex://b> ?m1_o .        
      }      
    }
    BIND( <ex://a> AS ?uq_s )
    BIND( <ex://b> AS ?uq_p )
    BIND( ?m1_o AS ?uq_o )    
  }
  {
    {
      SELECT ?m0_o WHERE {
        <ex://a> <ex://a> ?m0_o .        
      }      
    }
    BIND( <ex://a> AS ?uq_p )
    BIND( ?m0_o AS ?uq_o )    
  }
  UNION {
    {
      SELECT ?m1_o WHERE {
        <ex://a> <ex://b> ?m1_o .        
      }      
    }
    BIND( <ex://b> AS ?uq_p )
    BIND( ?m1_o AS ?uq_o )    
  }  
}`,
    [ `CONSTRUCT WHERE { <ex://a> <ex://a> ?o }`, `CONSTRUCT WHERE { <ex://a> <ex://b> ?o }`, `CONSTRUCT WHERE { <ex://b> <ex://c> ?o }` ],
    [ operationTransform, transformFilterFalse, nullifyJoinOverIncompatibleBounds, transformFilterFalse ],
  ));

  it('nullifyJoinOverIncompatibleBounds - adding simple filter', ({ expect }) => test(
    expect,
    `SELECT * {
  {
    { SELECT ?sp { ?ss ?sp ?so } }
    BIND ( ?sp AS ?s )
  }
  {
    BIND( <ex://a> as ?s )
  }
}`,
    `SELECT ?uq_s ?uq_sp WHERE {
  {
    SELECT ?uq_sp WHERE {
      ?uq_ss ?uq_sp ?uq_so .
      FILTER ( ( ?uq_sp = <ex://a> ) )      
    }    
  }
  {
    BIND( <ex://a> AS ?uq_s )    
  }  
}`,
    [ ],
    [ nullifyJoinOverIncompatibleBounds, transformFilterFalse ],
  ));

  it('nullifyJoinOverIncompatibleBounds - adding || filter', ({ expect }) => test(
    expect,
    `SELECT * {
  {
    { SELECT ?sp { ?ss ?sp ?so } }
    BIND ( ?sp AS ?s )
  }
  { BIND( <ex://a> as ?s ) }
  UNION
  { BIND( <ex://b> as ?s ) }
}`,
    `SELECT ?uq_s ?uq_sp WHERE {
  {
    SELECT ?uq_sp WHERE {
      ?uq_ss ?uq_sp ?uq_so .
      FILTER ( ( ( ?uq_sp = <ex://a> ) || ( ?uq_sp = <ex://b> ) ) )      
    }    
  }
  {
    BIND( <ex://a> AS ?uq_s )    
  }
  UNION {
    BIND( <ex://b> AS ?uq_s )    
  }  
}`,
    [ ],
    [ nullifyJoinOverIncompatibleBounds, transformFilterFalse ],
  ));

  it('nullifyJoinOverIncompatibleBounds - adding || filter on 2 vars', ({ expect }) => test(
    expect,
    `SELECT * {
  {
    { SELECT ?sp ?so { ?ss ?sp ?so } }
    BIND ( ?sp AS ?s )
    BIND ( ?so AS ?s )
  }
  { BIND( <ex://a> as ?s ) }
  UNION
  { BIND( <ex://b> as ?s ) }
}`,
    `SELECT ?uq_s ?uq_so ?uq_sp WHERE {
  {
    SELECT ?uq_sp ?uq_so WHERE {
      ?uq_ss ?uq_sp ?uq_so .
      FILTER ( ( ( ( ?uq_so = <ex://a> ) || ( ?uq_so = <ex://b> ) ) && ( ( ?uq_sp = <ex://a> ) || ( ?uq_sp = <ex://b> ) ) ) )      
    }    
  }
  {
    BIND( <ex://a> AS ?uq_s )    
  }
  UNION {
    BIND( <ex://b> AS ?uq_s )    
  }  
}`,
    [ ],
    [ nullifyJoinOverIncompatibleBounds, transformFilterFalse ],
  ));
});
