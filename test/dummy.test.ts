import { toAlgebra } from '@traqula/algebra-sparql-1-2';
import { Parser } from '@traqula/parser-sparql-1-2';
import { describe, it } from 'vitest';
import {
  expectedQuery,
  expectedQueryOptimizedBounds,
  nonTripleTermConstruct,
  testQuery,
  tripleTermConstruct,
} from '../lib/queries.js';
import { queryTransform } from '../lib/transformBgp.js';
import { createTransformContext } from '../lib/transformContext.js';

describe('dummy', () => {
  const parser = new Parser();

  function test(
    name: string,
    userQuery: string,
    expectedQuery: string,
    mappers: string[],
    optimizeBinds = false,
  ): void {
    it(name, ({ expect }) => {
      const transformerContext = createTransformContext(mappers);
      expect(queryTransform(transformerContext, userQuery, { optimizeBinds }).trim()).toEqual(expectedQuery.trim());

      const _expectedAst = parser.parse(expectedQuery);
      const _expectedAlgebra = toAlgebra(_expectedAst, { quads: true });
      const _me = 2;
    });
  }

  test('simple', testQuery, expectedQuery, [
    tripleTermConstruct,
    nonTripleTermConstruct,
  ]);

  test('simple', testQuery, expectedQueryOptimizedBounds, [
    tripleTermConstruct,
    nonTripleTermConstruct,
  ], true);

  test(
    'spo with blank in mapping head',
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
  );

  test(
    'sps with blank in mapping head',
`SELECT * { ?s ?p ?s }`,
`SELECT ?uq_p ?uq_s WHERE {
  {    
  }  
}`,
[ `CONSTRUCT { ?s ?p _:blank } WHERE { ?s ?p ?o }` ],
  );
});
