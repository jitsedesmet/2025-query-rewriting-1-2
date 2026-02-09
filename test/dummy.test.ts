import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { describe, it } from 'vitest';
import type { expect as Expect } from 'vitest';
import { substituteVarsThatArePreBoundToTerms } from '../lib/transformations/boundedVarSubstitution.js';
import { transformFilterFalse } from '../lib/transformations/filterFalse.js';
import { nullifyJoinOverIncompatibleBounds } from '../lib/transformations/nullifyJoinOverIncompatibleBounds.js';
import { pushUpBoundedFromUnion } from '../lib/transformations/pushUpBoundedFromUnion.js';
import { operationTransform, queryTransform } from '../lib/transformBgp.js';
import type { Mapping, TransformContext } from '../lib/transformContext.js';
import { parseQuery, createPartialContext, transformContextFromConstructs } from '../lib/transformContext.js';
import {
  expectedQuery,
  expectedQueryOptimizedBounds,
  expectedQueryOptimizedBoundsAndEmptyRes,
  nonTripleTermConstruct,
  testQuery,
  tripleTermConstruct,
} from './queries.js';

describe('dummy', () => {
  const c = createPartialContext();

  function transformQueryUsingConstructs(
    userQuery: string,
    mappers: string[],
    transformations: ((c: TransformContext, op: Algebra.Operation) => Algebra.Operation)[] = [ operationTransform ],
  ): string {
    const transformerContext = transformContextFromConstructs(mappers);
    return queryTransform(transformerContext, userQuery, transformations);
  }

  function transformQuery(
    userQuery: string,
    mappers: Mapping[],
    transformations: ((c: TransformContext, op: Algebra.Operation) => Algebra.Operation)[] = [ operationTransform ],
  ): string {
    const transformerContext = {
      ...c,
      mappers,
    };
    return queryTransform(transformerContext, userQuery, transformations);
  }

  function testConstructMappers(
    expect: typeof Expect,
    userQuery: string,
    expectedQuery: string,
    mappers: string[],
    transformations: ((c: TransformContext, op: Algebra.Operation) => Algebra.Operation)[] = [ operationTransform ],
  ): void {
    expect(transformQueryUsingConstructs(userQuery, mappers, transformations).trim())
      .toEqual(expectedQuery.trim());

    // Const _expectedAst = parser.parse(expectedQuery);
    // const _expectedAlgebra = toAlgebra(_expectedAst, { quads: true });
    // const _me = 2;
  }

  function testMappers(
    expect: typeof Expect,
    userQuery: string,
    expectedQuery: string,
    mappers: Mapping[],
    transformations: ((c: TransformContext, op: Algebra.Operation) => Algebra.Operation)[] = [ operationTransform ],
  ): void {
    expect(transformQuery(userQuery, mappers, transformations).trim())
      .toEqual(expectedQuery.trim());
  }

  it('simple', ({ expect }) =>
    testConstructMappers(expect, testQuery, expectedQuery, [ tripleTermConstruct, nonTripleTermConstruct ]));

  it('simple & optimizeBinds', ({ expect }) => testConstructMappers(
    expect,
    testQuery,
    expectedQueryOptimizedBounds,
    [ tripleTermConstruct, nonTripleTermConstruct ],
    [ operationTransform, substituteVarsThatArePreBoundToTerms ],
  ));

  it('simple & optimizeBinds & optimizeEmptyResultSets', ({ expect }) => testConstructMappers(
    expect,
    testQuery,
    expectedQueryOptimizedBoundsAndEmptyRes,
    [ tripleTermConstruct, nonTripleTermConstruct ],
    [ operationTransform, substituteVarsThatArePreBoundToTerms, transformFilterFalse ],
  ));

  it('spo with blank in mapping head', ({ expect }) => {
    // Cannot perform the following test:
    // test(
    //     expect,
    //     // Say you have data: <s> <a> <o> . <s> <b> <o> .
    //     // It would be mapped to: <s> <a> _:b1 . <s> <b> _:b2 .
    //     // user query returns: ?s ?a ?b ?b2:
    //     // <s> _:b1 _:b2 / . <s> / / _:b2
    //     // While rewritten, making own bnodes returns ?s ?a ?b ?b2:
    //     // <s> _:bx _:by / . <s> / / _:bz
    // `SELECT * { { ?s <http://ex.org/a> ?a ; <http://ex.org/b> ?b } UNION { ?s <http://ex.org/b> ?b2 } }`,
    // `SELECT ?uq_a ?uq_b ?uq_b2 ?uq_s WHERE {
    //   {
    //     {
    //       {
    //         SELECT ?m0_s WHERE {
    //           {
    //             BIND( <http://ex.org/a> AS ?m0_p )
    //           }
    //           ?m0_s ?m0_p ?m0_o .
    //         }
    //       }
    //       BIND( ?m0_s AS ?uq_s )
    //       BIND( BNODE( "e_blank"^^<http://www.w3.org/2001/XMLSchema#string> ) AS ?uq_a )
    //     }
    //     {
    //       {
    //         SELECT ?m0_s WHERE {
    //           {
    //             BIND( <http://ex.org/b> AS ?m0_p )
    //           }
    //           ?m0_s ?m0_p ?m0_o .
    //         }
    //       }
    //       BIND( ?m0_s AS ?uq_s )
    //       BIND( BNODE( "e_blank"^^<http://www.w3.org/2001/XMLSchema#string> ) AS ?uq_b )
    //     }
    //   }
    //   UNION {
    //     {
    //       {
    //         SELECT ?m0_s WHERE {
    //           {
    //             BIND( <http://ex.org/b> AS ?m0_p )
    //           }
    //           ?m0_s ?m0_p ?m0_o .
    //         }
    //       }
    //       BIND( ?m0_s AS ?uq_s )
    //       BIND( BNODE( "e_blank"^^<http://www.w3.org/2001/XMLSchema#string> ) AS ?uq_b2 )
    //     }
    //   }
    // }`,
    // [ `CONSTRUCT { ?s ?p _:blank } WHERE { ?s ?p ?o }` ],
    //   )
    expect(() => transformQueryUsingConstructs(
      'SELECT * { { ?s <http://ex.org/a> ?a ; <http://ex.org/b> ?b } UNION { ?s <http://ex.org/b> ?b2 } }',
      [ `CONSTRUCT { ?s ?p _:blank } WHERE { ?s ?p ?o }` ],
    )).toThrow();
  });

  it('sps with blank in mapping head', ({ expect }) => {
    expect(() => transformQueryUsingConstructs(
      `SELECT * { ?s ?p ?s }`,
      [ `CONSTRUCT { ?s ?p _:blank } WHERE { ?s ?p ?o }` ],
    )).toThrow();
  });

  it('sps with bnode creation in mapping body', ({ expect }) => {
    expect(() => transformQueryUsingConstructs(
      `SELECT * { ?s ?p ?s }`,
      [ `CONSTRUCT { ?s ?p ?b } WHERE { ?s ?p ?o. EXTEND(bnode() as ?b) }` ],
    )).toThrow();
  });

  it('handle no matching query', ({ expect }) => testConstructMappers(
    expect,
    `SELECT * { ?s <ex://a> ?o }`,
    `SELECT ( ?uq_o AS ?o ) ( ?uq_s AS ?s ) WHERE {
  {
    FILTER ( FALSE )
  }
  UNION {
    FILTER ( FALSE )
  }
}`,
    [ `CONSTRUCT WHERE { ?s <ex://b> ?o }`, `CONSTRUCT WHERE { ?s <ex://c> ?o }` ],
  ));

  it('handle no matching query & optimizeBinds & optimizeEmptyResultSets', ({ expect }) => testConstructMappers(
    expect,
    `SELECT * { ?s <ex://a> ?o }`,
    `SELECT ( ?uq_o AS ?o ) ( ?uq_s AS ?s ) WHERE {
  FILTER ( FALSE )
}`,
    [ `CONSTRUCT WHERE { ?s <ex://b> ?o }`, `CONSTRUCT WHERE { ?s <ex://c> ?o }` ],
    [ operationTransform, substituteVarsThatArePreBoundToTerms, transformFilterFalse ],
  ));

  it('pushUpBinds', ({ expect }) => testConstructMappers(
    expect,
    `SELECT * { ?s ?p ?o }`,
    `SELECT ( ?uq_o AS ?o ) ( ?uq_p AS ?p ) ( ?uq_s AS ?s ) WHERE {
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

  it('no join optimization', ({ expect }) => testConstructMappers(
    expect,
    `SELECT * { ?s ?p ?o . <ex://a> ?p ?o }`,
    `SELECT ( ?uq_o AS ?o ) ( ?uq_p AS ?p ) ( ?uq_s AS ?s ) WHERE {
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

  it('join optimization', ({ expect }) => testConstructMappers(
    expect,
    `SELECT * { ?s ?p ?o . <ex://a> ?p ?o }`,
    `SELECT ( ?uq_o AS ?o ) ( ?uq_p AS ?p ) ( ?uq_s AS ?s ) WHERE {
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

  it('join optimization 1', ({ expect }) => testConstructMappers(
    expect,
    `SELECT * { ?s ?p ?o . <ex://a> ?p ?o }`,
    `SELECT ( ?uq_o AS ?o ) ( ?uq_p AS ?p ) ( ?uq_s AS ?s ) WHERE {
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

  it('nullifyJoinOverIncompatibleBounds - adding simple filter', ({ expect }) => testConstructMappers(
    expect,
    `SELECT * { <ex://a> ?p ?o . <ex://b> ?p ?o . }`,
    `SELECT ( ?uq_o AS ?o ) ( ?uq_p AS ?p ) WHERE {
  {
    {
      SELECT ?m0_p ?m0_o WHERE {
        VALUES ?m0_p {
          <ex://c>
        }
        <ex://a> ?m0_p ?m0_o .
      }
    }
    BIND( <ex://c> AS ?uq_p )
    BIND( ?m0_o AS ?uq_o )
  }
  {
    {
      SELECT ?m1_o WHERE {
        <ex://b> <ex://c> ?m1_o .
      }
    }
    BIND( <ex://c> AS ?uq_p )
    BIND( ?m1_o AS ?uq_o )
  }
}`,
    [ `CONSTRUCT WHERE { <ex://a> ?p ?o }`, `CONSTRUCT WHERE { <ex://b> <ex://c> ?o }` ],
    [
      operationTransform,
      transformFilterFalse,
      nullifyJoinOverIncompatibleBounds,
      transformFilterFalse,
    ],
  ));

  it('nullifyJoinOverIncompatibleBounds - adding simple filter and optimizing', ({ expect }) => testConstructMappers(
    expect,
    `SELECT * { <ex://a> ?p ?o . <ex://b> ?p ?o . }`,
    `SELECT ( ?uq_o AS ?o ) ( ?uq_p AS ?p ) WHERE {
  {
    {
      SELECT ?m0_p ?m0_o WHERE {
        VALUES ?m0_p {
          <ex://c>
        }
        <ex://a> ?m0_p ?m0_o .
      }
    }
    BIND( <ex://c> AS ?uq_p )
    BIND( ?m0_o AS ?uq_o )
  }
  {
    {
      SELECT ?m1_o WHERE {
        <ex://b> <ex://c> ?m1_o .
      }
    }
    BIND( <ex://c> AS ?uq_p )
    BIND( ?m1_o AS ?uq_o )
  }
}`,
    [ `CONSTRUCT WHERE { <ex://a> ?p ?o }`, `CONSTRUCT WHERE { <ex://b> <ex://c> ?o }` ],
    [
      operationTransform,
      transformFilterFalse,
      nullifyJoinOverIncompatibleBounds,
      transformFilterFalse,
      substituteVarsThatArePreBoundToTerms,
    ],
  ));

  it('nullifyJoinOverIncompatibleBounds - adding || filter', ({ expect }) => testConstructMappers(
    expect,
    `SELECT * { <ex://a> ?p ?o . <ex://b> ?p ?o . }`,
    `SELECT ( ?uq_o AS ?o ) ( ?uq_p AS ?p ) WHERE {
  {
    {
      SELECT ?m0_p ?m0_o WHERE {
        VALUES ?m0_p {
          <ex://c>
          <ex://d>
        }
        <ex://a> ?m0_p ?m0_o .
      }
    }
    BIND( ?m0_p AS ?uq_p )
    BIND( ?m0_o AS ?uq_o )
  }
  {
    {
      SELECT ?m1_o WHERE {
        <ex://b> <ex://c> ?m1_o .
      }
    }
    BIND( <ex://c> AS ?uq_p )
    BIND( ?m1_o AS ?uq_o )
  }
  UNION {
    {
      SELECT ?m2_o WHERE {
        <ex://b> <ex://d> ?m2_o .
      }
    }
    BIND( <ex://d> AS ?uq_p )
    BIND( ?m2_o AS ?uq_o )
  }
}`,
    [ `CONSTRUCT WHERE { <ex://a> ?p ?o }`, `CONSTRUCT WHERE { <ex://b> <ex://c> ?o }`, `CONSTRUCT WHERE { <ex://b> <ex://d> ?o }` ],
    [ operationTransform, transformFilterFalse, nullifyJoinOverIncompatibleBounds, transformFilterFalse ],
  ));

  it('nullifyJoinOverIncompatibleBounds - adding || filter on 2 vars', ({ expect }) => testConstructMappers(
    expect,
    `SELECT * { <ex://a> ?p ?o . <ex://b> ?p ?o . }`,
    `SELECT ( ?uq_o AS ?o ) ( ?uq_p AS ?p ) WHERE {
  {
    {
      SELECT ?m0_p ?m0_o WHERE {
        VALUES ?m0_p {
          <ex://c>
          <ex://d>
        }
        VALUES ?m0_o {
          <ex://c>
          <ex://d>
        }
        <ex://a> ?m0_p ?m0_o .
      }
    }
    BIND( ?m0_p AS ?uq_p )
    BIND( ?m0_o AS ?uq_o )
  }
  {
    {
      SELECT ( "dummy"^^<http://www.w3.org/2001/XMLSchema#string> AS ?dummy ) WHERE {
        <ex://b> <ex://c> <ex://c> .
      }
    }
    BIND( <ex://c> AS ?uq_p )
    BIND( <ex://c> AS ?uq_o )
  }
  UNION {
    {
      SELECT ( "dummy"^^<http://www.w3.org/2001/XMLSchema#string> AS ?dummy ) WHERE {
        <ex://b> <ex://d> <ex://d> .
      }
    }
    BIND( <ex://d> AS ?uq_p )
    BIND( <ex://d> AS ?uq_o )
  }
}`,
    [ `CONSTRUCT WHERE { <ex://a> ?p ?o }`, `CONSTRUCT WHERE { <ex://b> <ex://c> <ex://c> }`, `CONSTRUCT WHERE { <ex://b> <ex://d> <ex://d> }` ],
    [ operationTransform, transformFilterFalse, nullifyJoinOverIncompatibleBounds, transformFilterFalse ],
  ));

  it('algebra transformation on paths', ({ expect }) => testConstructMappers(
    expect,
    `SELECT * {
    ?s1 <ex://a> ?o1 .
    ?s2 <ex://a>/<ex://b> ?o2.
    ?s3 ^<ex://a> ?o3 .
    ?s4 <ex://a> | <ex://b> ?o4 .
    ?s5 !<ex://a> ?o5 .
    ?s6 <ex://a>? ?o6 .
    ?s7 <ex://a>* ?o7 .
    ?s8 <ex://a>+ ?o8 .
    ?s9 !(^<ex://a>|<ex://b>) ?o9 .
    
    ?s10 <ex://a> | ^<ex://b> ?o10 .
}`,
    `SELECT ( ?uq_o1 AS ?o1 ) ( ?uq_o10 AS ?o10 ) ( ?uq_o2 AS ?o2 ) ( ?uq_o3 AS ?o3 ) ( ?uq_o4 AS ?o4 ) ( ?uq_o5 AS ?o5 ) ( ?uq_o6 AS ?o6 ) ( ?uq_o7 AS ?o7 ) ( ?uq_o8 AS ?o8 ) ( ?uq_o9 AS ?o9 ) ( ?uq_s1 AS ?s1 ) ( ?uq_s10 AS ?s10 ) ( ?uq_s2 AS ?s2 ) ( ?uq_s3 AS ?s3 ) ( ?uq_s4 AS ?s4 ) ( ?uq_s5 AS ?s5 ) ( ?uq_s6 AS ?s6 ) ( ?uq_s7 AS ?s7 ) ( ?uq_s8 AS ?s8 ) ( ?uq_s9 AS ?s9 ) WHERE {
  ?uq_s1 <ex://a> ?uq_o1 .
  ?uq_s2 <ex://a> ?uq_var0 .
  ?uq_var0 <ex://b> ?uq_o2 .
  ?uq_o3 <ex://a> ?uq_s3 .
  ?uq_s4 (<ex://a>|<ex://b>) ?uq_o4 .
  ?uq_s5 (!(<ex://a>)) ?uq_o5 .
  ?uq_s6 (<ex://a>?) ?uq_o6 .
  ?uq_s7 (<ex://a>*) ?uq_o7 .
  ?uq_s8 (<ex://a>+) ?uq_o8 .
  ?uq_s9 (!(<ex://b>|^<ex://a>)) ?uq_o9 .
  ?uq_s10 (<ex://a>|(^<ex://b>)) ?uq_o10 .
}`,
    [],
    [],
  ));

  it('does not emit infinite recursion', ({ expect }) => testConstructMappers(
    expect,
    `SELECT * { ?s ?p ?s }`,
    `SELECT ( ?uq_p AS ?p ) ( ?uq_s AS ?s ) WHERE {
  {
    FILTER ( FALSE )
  }
}`,
    [ `CONSTRUCT { ?s ?p <<( ?s ?x ?y )>> } WHERE { ?s ?p ?x , ?y . }` ],
  ));

  it('works on simple transforms using mappers', ({ expect }) => testMappers(
    expect,
    `SELECT * { ?s <ex://a> ?o }`,
    `SELECT ( ?uq_o AS ?o ) ( ?uq_s AS ?s ) WHERE {
  {
    FILTER ( FALSE )
  }
  UNION {
    FILTER ( FALSE )
  }
}`,
    // [ `CONSTRUCT WHERE { ?s <ex://b> ?o }`, `CONSTRUCT WHERE { ?s <ex://c> ?o }` ],
    [{
      head: c.AF.createMappingHead(c.DF.variable('s'), c.DF.namedNode('ex://b'), c.DF.variable('o')),
      body: <Algebra.Project> parseQuery(c, 'SELECT * { ?s  <ex://b> ?o }'),
    }, {
      head: c.AF.createMappingHead(c.DF.variable('s'), c.DF.namedNode('ex://c'), c.DF.variable('o')),
      body: <Algebra.Project> parseQuery(c, 'SELECT * { ?s  <ex://c> ?o }'),
    }],
  ));

  it('templateIris', ({ expect }) => testMappers(
    expect,
    `SELECT * { ?s ?p <ex://a> }`,
    `SELECT ( ?uq_p AS ?p ) ( ?uq_s AS ?s ) WHERE {
  {
    FILTER ( FALSE )
  }
  UNION {
    FILTER ( FALSE )
  }
  UNION {
    FILTER ( FALSE )
  }
}`,
    // [ `CONSTRUCT WHERE { ?s <ex://b> ?o }`, `CONSTRUCT WHERE { ?s <ex://c> ?o }` ],
    [{
      head: c.AF.createMappingHead(c.DF.variable('s'), c.DF.variable('p'), c.DF.namedNode('ex://b')),
      body: <Algebra.Project> parseQuery(c, 'SELECT * { ?s  ?p <ex://b> }'),
    }, {
      head: c.AF.createMappingHead(c.DF.variable('s'), c.DF.variable('p'), c.DF.namedNode('ex://c')),
      body: <Algebra.Project> parseQuery(c, 'SELECT * { ?s  ?p <ex://c> }'),
    }, {
      head: c.AF.createMappingHead(c.DF.variable('s'), c.DF.variable('p'), c.AF.createMappingHead(
        c.DF.variable('s'),
        c.DF.variable('p'),
        c.DF.namedNode('ex://d'),
      )),
      body: <Algebra.Project> parseQuery(c, 'SELECT * { ?s  ?p <ex://c> }'),
    }],
  ));
});
