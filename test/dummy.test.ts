import { toAlgebra } from '@traqula/algebra-sparql-1-2';
import { Parser } from '@traqula/parser-sparql-1-2';
import { describe, it } from 'vitest';
import type { expect as Expect } from 'vitest';
import {
  expectedQuery,
  expectedQueryOptimizedBounds,
  expectedQueryOptimizedBoundsAndEmptyRes,
  nonTripleTermConstruct,
  testQuery,
  tripleTermConstruct,
} from '../lib/queries.js';
import type { QueryTransFormContext } from '../lib/transformBgp.js';
import { queryTransform } from '../lib/transformBgp.js';
import { createTransformContext } from '../lib/transformContext.js';

describe('dummy', () => {
  const parser = new Parser();

  function test(
    expect: typeof Expect,
    userQuery: string,
    expectedQuery: string,
    mappers: string[],
    context: QueryTransFormContext = {},
  ): void {
    const transformerContext = createTransformContext(mappers);
    expect(queryTransform(transformerContext, userQuery, { pushUpBinds: true, ...context }).trim())
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
    { optimizeBinds: true },
  ));

  it('simple & optimizeBinds & optimizeEmptyResultSets', ({ expect }) => test(
    expect,
    testQuery,
    expectedQueryOptimizedBoundsAndEmptyRes,
    [ tripleTermConstruct, nonTripleTermConstruct ],
    { optimizeBinds: true, optimizeEmptyResultSets: true },
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
    {
      FILTER ( "false"^^<http://www.w3.org/2001/XMLSchema#boolean> )      
    }    
  }  
}`,
[ `CONSTRUCT { ?s ?p _:blank } WHERE { ?s ?p ?o }` ],
  ));

  it('handle no matching query', ({ expect }) => test(
    expect,
    `SELECT * { ?s <ex://a> ?o }`,
    `SELECT ?uq_o ?uq_s WHERE {
  {
    {
      FILTER ( "false"^^<http://www.w3.org/2001/XMLSchema#boolean> )      
    }    
  }
  UNION {
    {
      FILTER ( "false"^^<http://www.w3.org/2001/XMLSchema#boolean> )      
    }    
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
    { optimizeBinds: true, optimizeEmptyResultSets: true },
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
    { optimizeBinds: true, optimizeEmptyResultSets: true, pushUpBinds: true },
  ));
});
