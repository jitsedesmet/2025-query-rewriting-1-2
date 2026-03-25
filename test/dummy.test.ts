import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { describe, it } from 'vitest';
import type { expect as Expect } from 'vitest';
import { internalBnodeAsSpecialIri, internalBnodeAsSpecialLiteral } from '../lib/transformations/bnodeMapAsLiteral.js';
import { substituteVarsThatArePreBoundToTerms } from '../lib/transformations/boundedVarSubstitution.js';
import { transformFilterFalse } from '../lib/transformations/filterFalse.js';
import { nullifyJoinOverIncompatibleBounds } from '../lib/transformations/nullifyJoinOverIncompatibleBounds.js';
import { rewriteNonRecursivePaths } from '../lib/transformations/pathTransformation.js';
import { pushUpBoundedFromUnion } from '../lib/transformations/pushUpBoundedFromUnion.js';
import { operationTransform, queryTransform } from '../lib/transformBgp.js';
import type { TransformContext } from '../lib/transformContext.js';
import {
  prefixMappingVars,
  parseQuery,
  createPartialContext,
  transformContextFromConstructs,
} from '../lib/transformContext.js';
import type { Mapping } from '../lib/types.js';
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
      mappers: mappers
        .map((mapping, index) => prefixMappingVars(c, mapping, `m${index}_`)),
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
    //       BIND( BNODE( "e_blank" ) AS ?uq_a )
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
    //       BIND( BNODE( "e_blank" ) AS ?uq_b )
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
    //       BIND( BNODE( "e_blank" ) AS ?uq_b2 )
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
      SELECT ?m0_o ?m0_s WHERE {
        ?m0_s <ex://b> ?m0_o .
      }
    }
    BIND( ?m0_o AS ?uq_o )
    BIND( ?m0_s AS ?uq_s )
  }
  UNION {
    {
      SELECT ?m1_o ?m1_s WHERE {
        ?m1_s <ex://b> ?m1_o .
      }
    }
    BIND( ?m1_o AS ?uq_o )
    BIND( ?m1_s AS ?uq_s )
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
    BIND( ?m0_o AS ?uq_o )
    BIND( <ex://a> AS ?uq_p )
    BIND( <ex://a> AS ?uq_s )
  }
  UNION {
    {
      SELECT ?m1_o WHERE {
        <ex://b> <ex://b> ?m1_o .
      }
    }
    BIND( ?m1_o AS ?uq_o )
    BIND( <ex://b> AS ?uq_p )
    BIND( <ex://b> AS ?uq_s )
  }
  {
    {
      SELECT ?m0_o WHERE {
        <ex://a> <ex://a> ?m0_o .
      }
    }
    BIND( ?m0_o AS ?uq_o )
    BIND( <ex://a> AS ?uq_p )
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
    BIND( ?m0_o AS ?uq_o )
    BIND( <ex://a> AS ?uq_p )
    BIND( <ex://a> AS ?uq_s )
  }
  {
    {
      SELECT ?m0_o WHERE {
        <ex://a> <ex://a> ?m0_o .
      }
    }
    BIND( ?m0_o AS ?uq_o )
    BIND( <ex://a> AS ?uq_p )
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
    BIND( ?m0_o AS ?uq_o )
    BIND( <ex://a> AS ?uq_p )
    BIND( <ex://a> AS ?uq_s )
  }
  UNION {
    {
      SELECT ?m1_o WHERE {
        <ex://a> <ex://b> ?m1_o .
      }
    }
    BIND( ?m1_o AS ?uq_o )
    BIND( <ex://b> AS ?uq_p )
    BIND( <ex://a> AS ?uq_s )
  }
  {
    {
      SELECT ?m0_o WHERE {
        <ex://a> <ex://a> ?m0_o .
      }
    }
    BIND( ?m0_o AS ?uq_o )
    BIND( <ex://a> AS ?uq_p )
  }
  UNION {
    {
      SELECT ?m1_o WHERE {
        <ex://a> <ex://b> ?m1_o .
      }
    }
    BIND( ?m1_o AS ?uq_o )
    BIND( <ex://b> AS ?uq_p )
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
      SELECT ?m0_o ?m0_p WHERE {
        VALUES ?m0_p {
          <ex://c>
        }
        <ex://a> ?m0_p ?m0_o .
      }
    }
    BIND( ?m0_o AS ?uq_o )
    BIND( <ex://c> AS ?uq_p )
  }
  {
    {
      SELECT ?m1_o WHERE {
        <ex://b> <ex://c> ?m1_o .
      }
    }
    BIND( ?m1_o AS ?uq_o )
    BIND( <ex://c> AS ?uq_p )
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
      SELECT ?m0_o ?m0_p WHERE {
        VALUES ?m0_p {
          <ex://c>
        }
        <ex://a> ?m0_p ?m0_o .
      }
    }
    BIND( ?m0_o AS ?uq_o )
    BIND( <ex://c> AS ?uq_p )
  }
  {
    {
      SELECT ?m1_o WHERE {
        <ex://b> <ex://c> ?m1_o .
      }
    }
    BIND( ?m1_o AS ?uq_o )
    BIND( <ex://c> AS ?uq_p )
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
      SELECT ?m0_o ?m0_p WHERE {
        VALUES ?m0_p {
          <ex://c>
          <ex://d>
        }
        <ex://a> ?m0_p ?m0_o .
      }
    }
    BIND( ?m0_o AS ?uq_o )
    BIND( ?m0_p AS ?uq_p )
  }
  {
    {
      SELECT ?m1_o WHERE {
        <ex://b> <ex://c> ?m1_o .
      }
    }
    BIND( ?m1_o AS ?uq_o )
    BIND( <ex://c> AS ?uq_p )
  }
  UNION {
    {
      SELECT ?m2_o WHERE {
        <ex://b> <ex://d> ?m2_o .
      }
    }
    BIND( ?m2_o AS ?uq_o )
    BIND( <ex://d> AS ?uq_p )
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
      SELECT ?m0_o ?m0_p WHERE {
        VALUES ?m0_o {
          <ex://c>
          <ex://d>
        }
        VALUES ?m0_p {
          <ex://c>
          <ex://d>
        }
        <ex://a> ?m0_p ?m0_o .
      }
    }
    BIND( ?m0_o AS ?uq_o )
    BIND( ?m0_p AS ?uq_p )
  }
  {
    {
      SELECT ( "dummy" AS ?dummy ) WHERE {
        <ex://b> <ex://c> <ex://c> .
      }
    }
    BIND( <ex://c> AS ?uq_o )
    BIND( <ex://c> AS ?uq_p )
  }
  UNION {
    {
      SELECT ( "dummy" AS ?dummy ) WHERE {
        <ex://b> <ex://d> <ex://d> .
      }
    }
    BIND( <ex://d> AS ?uq_o )
    BIND( <ex://d> AS ?uq_p )
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

  it('algebra transformation on paths only leaving * and +', ({ expect }) => testConstructMappers(
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
  {
    ?uq_s4 <ex://a> ?uq_o4 .
  }
  UNION {
    ?uq_s4 <ex://b> ?uq_o4 .
  }
  ?uq_s5 (!(<ex://a>)) ?uq_o5 .
  {
    ?uq_s6 <ex://a> ?uq_o6 .
  }
  UNION {
    {
      SELECT DISTINCT ?uq_s6 WHERE {
        ?uq_s6 ?p_uq_s6 ?o_uq_s6 .
      }
    }
    BIND( ?uq_s6 AS ?uq_o6 )
  }
  ?uq_s7 (<ex://a>*) ?uq_o7 .
  ?uq_s8 (<ex://a>+) ?uq_o8 .
  {
    ?uq_s9 (!(<ex://b>)) ?uq_o9 .
  }
  UNION {
    ?uq_o9 (!(<ex://a>)) ?uq_s9 .
  }
  {
    ?uq_s10 <ex://a> ?uq_o10 .
  }
  UNION {
    ?uq_o10 <ex://b> ?uq_s10 .
  }
}`,
    [],
    [ rewriteNonRecursivePaths ],
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
    {
      SELECT ?m0_p ?m0_s WHERE {
        ?m0_s ?m0_p <ex://b> .
        FILTER ( ( <ex://a> = IRI( CONCAT( "ex://" , STR( ?m0_s ) ) ) ) )
      }
    }
    BIND( ?m0_p AS ?uq_p )
    BIND( ?m0_s AS ?uq_s )
  }
  UNION {
    {
      SELECT ?m1_p ?m1_s WHERE {
        ?m1_s ?m1_p <ex://c> .
        FILTER ( ( <ex://a> = IRI( CONCAT( "example://" , STR( ?m1_s ) ) ) ) )
      }
    }
    BIND( ?m1_p AS ?uq_p )
    BIND( ?m1_s AS ?uq_s )
  }
  UNION {
    {
      SELECT ?m2_p ?m2_s WHERE {
        ?m2_s ?m2_p <ex://c> .
        FILTER ( ( <ex://a> = IRI( CONCAT( STR( ?m2_s ) ) ) ) )
      }
    }
    BIND( ?m2_p AS ?uq_p )
    BIND( ?m2_s AS ?uq_s )
  }
  UNION {
    FILTER ( FALSE )
  }
}`,
    [{
      head: c.AF.createMappingHead(c.DF.variable('s'), c.DF.variable('p'), c.AF.createTemplateIri(
        [ 'ex://', c.DF.variable('s') ],
      )),
      body: <Algebra.Project> parseQuery(c, 'SELECT * { ?s  ?p <ex://b> }'),
    }, {
      head: c.AF.createMappingHead(c.DF.variable('s'), c.DF.variable('p'), c.AF.createTemplateIri(
        [ 'example://', c.DF.variable('s') ],
      )),
      body: <Algebra.Project> parseQuery(c, 'SELECT * { ?s  ?p <ex://c> }'),
    }, {
      head: c.AF.createMappingHead(c.DF.variable('s'), c.DF.variable('p'), c.AF.createTemplateIri(
        [ c.DF.variable('s') ],
      )),
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

  it('template mapping simple', ({ expect }) => testMappers(
    expect,
    'SELECT * { ?s ?p ?o }',
    `SELECT ( ?uq_o AS ?o ) ( ?uq_p AS ?p ) ( ?uq_s AS ?s ) WHERE {
  {
    {
      SELECT ?m0_p ?m0_s WHERE {
        ?m0_s ?m0_p <ex://b> .
      }
    }
    BIND( IRI( CONCAT( "ex://" , STR( ?m0_s ) ) ) AS ?uq_o )
    BIND( ?m0_p AS ?uq_p )
    BIND( ?m0_s AS ?uq_s )
  }
}`,
    [{
      head: c.AF.createMappingHead(c.DF.variable('s'), c.DF.variable('p'), c.AF.createTemplateIri(
        [ 'ex://', c.DF.variable('s') ],
      )),
      body: <Algebra.Project> parseQuery(c, 'SELECT * { ?s  ?p <ex://b> }'),
    }],
  ));

  it('template sps', ({ expect }) => testMappers(
    expect,
    'SELECT * { ?s  ?p ?s }',
    `SELECT ( ?uq_p AS ?p ) ( ?uq_s AS ?s ) WHERE {
  {
    {
      SELECT ?m0_p ?m0_s WHERE {
        ?m0_s ?m0_p <ex://b> .
        FILTER ( ( ?m0_s = IRI( CONCAT( "ex://" , STR( ?m0_s ) ) ) ) )
      }
    }
    BIND( ?m0_p AS ?uq_p )
    BIND( ?m0_s AS ?uq_s )
  }
}`,
    [{
      head: c.AF.createMappingHead(c.DF.variable('s'), c.DF.variable('p'), c.AF.createTemplateIri(
        [ 'ex://', c.DF.variable('s') ],
      )),
      body: <Algebra.Project> parseQuery(c, 'SELECT * { ?s  ?p <ex://b> }'),
    }],
  ));

  it('two templates equal all', ({ expect }) => testMappers(
    expect,
    'SELECT * { ?x ?x ?x }',
    `SELECT ( ?uq_x AS ?x ) WHERE {
  {
    {
      SELECT ?m0_p WHERE {
        {
          ?m0_s ?m0_p ?m0_o .
          FILTER ( ( ?m0_p = IRI( CONCAT( STR( ?m0_s ) , STR( ?m0_p ) ) ) ) )
        }
        FILTER ( ( ?m0_p = IRI( CONCAT( STR( ?m0_o ) , STR( ?m0_p ) ) ) ) )
      }
    }
    BIND( ?m0_p AS ?uq_x )
  }
}`,
    [{
      head: c.AF.createMappingHead(
        c.AF.createTemplateIri([ c.DF.variable('s'), c.DF.variable('p') ]),
        c.DF.variable('p'),
        c.AF.createTemplateIri([ c.DF.variable('o'), c.DF.variable('p') ]),
      ),
      body: <Algebra.Project> parseQuery(c, 'SELECT * { ?s ?p ?o }'),
    }],
  ));

  it('template with containing var being bound', ({ expect }) => testMappers(
    expect,
    'SELECT * { ?x <ex://a> ?y }',
    `SELECT ( ?uq_x AS ?x ) ( ?uq_y AS ?y ) WHERE {
  {
    {
      SELECT ?m0_o ?m0_p ?m0_s WHERE {
        {
          BIND( <ex://a> AS ?m0_p )
        }
        ?m0_s ?m0_p ?m0_o .
      }
    }
    BIND( IRI( CONCAT( STR( ?m0_s ) , STR( ?m0_p ) ) ) AS ?uq_x )
    BIND( ?m0_o AS ?uq_y )
  }
}`,
    [{
      head: c.AF.createMappingHead(
        c.AF.createTemplateIri([ c.DF.variable('s'), c.DF.variable('p') ]),
        c.DF.variable('p'),
        c.DF.variable('o'),
      ),
      body: <Algebra.Project> parseQuery(c, 'SELECT * { ?s ?p ?o }'),
    }],
  ));

  it('two templates but not equal to each other', ({ expect }) => testMappers(
    expect,
    'SELECT * { ?x ?y ?y }',
    `SELECT ( ?uq_x AS ?x ) ( ?uq_y AS ?y ) WHERE {
  {
    {
      SELECT ?m0_p ?m0_s WHERE {
        ?m0_s ?m0_p ?m0_o .
        FILTER ( ( ?m0_p = IRI( CONCAT( STR( ?m0_o ) ) ) ) )
      }
    }
    BIND( IRI( CONCAT( STR( ?m0_s ) , STR( ?m0_p ) ) ) AS ?uq_x )
    BIND( ?m0_p AS ?uq_y )
  }
}`,
    [{
      head: c.AF.createMappingHead(
        c.AF.createTemplateIri([ c.DF.variable('s'), c.DF.variable('p') ]),
        c.DF.variable('p'),
        c.AF.createTemplateIri([ c.DF.variable('o') ]),
      ),
      body: <Algebra.Project> parseQuery(c, 'SELECT * { ?s ?p ?o }'),
    }],
  ));

  it('quad in mapping head', ({ expect }) => testMappers(
    expect,
    'SELECT * { ?x ?y ?z }',
    `SELECT ( ?uq_x AS ?x ) ( ?uq_y AS ?y ) ( ?uq_z AS ?z ) WHERE {
  {
    {
      SELECT ?m0_p ?m0_s WHERE {
        ?m0_s ?m0_p <ex://a> .
      }
    }
    BIND( ?m0_s AS ?uq_x )
    BIND( ?m0_p AS ?uq_y )
    BIND( TRIPLE( <ex://a> , <ex://b> , IRI( CONCAT( STR( ?m0_s ) ) ) ) AS ?uq_z )
  }
}`,
    [{
      head: c.AF.createMappingHead(
        c.DF.variable('s'),
        c.DF.variable('p'),
        c.AF.createMappingHead(
          c.DF.namedNode('ex://a'),
          c.DF.namedNode('ex://b'),
          c.AF.createTemplateIri([ c.DF.variable('s') ]),
        ),
      ),
      body: <Algebra.Project> parseQuery(c, 'SELECT * { ?s ?p <ex://a> }'),
    }],
  ));

  it('template equals term through connecting TP var', ({ expect }) => testMappers(
    expect,
    'SELECT * { ?x ?p ?x }',
    `SELECT ( ?uq_p AS ?p ) ( ?uq_x AS ?x ) WHERE {
  {
    {
      SELECT ?m0_p WHERE {
        ?m0_s ?m0_p <ex://a> .
        FILTER ( ( <ex://apple> = IRI( CONCAT( STR( ?m0_s ) ) ) ) )
      }
    }
    BIND( ?m0_p AS ?uq_p )
    BIND( <ex://apple> AS ?uq_x )
  }
}`,
    [{
      head: c.AF.createMappingHead(
        c.AF.createTemplateIri([ c.DF.variable('s') ]),
        c.DF.variable('p'),
        c.DF.namedNode('ex://apple'),
      ),
      body: <Algebra.Project> parseQuery(c, 'SELECT * { ?s ?p <ex://a> }'),
    }],
  ));

  it('does not generate conditions twice on group through connecting var', ({ expect }) => testMappers(
    expect,
    'SELECT * { ?x ?x ?x }',
    `SELECT ( ?uq_x AS ?x ) WHERE {
  {
    {
      SELECT ( "dummy" AS ?dummy ) WHERE {
        {
          BIND( <ex://apple> AS ?m0_p )
        }
        ?m0_s ?m0_p <ex://a> .
        FILTER ( ( <ex://apple> = IRI( CONCAT( STR( ?m0_s ) ) ) ) )
      }
    }
    BIND( <ex://apple> AS ?uq_x )
  }
}`,
    [{
      head: c.AF.createMappingHead(
        c.AF.createTemplateIri([ c.DF.variable('s') ]),
        c.DF.variable('p'),
        c.DF.namedNode('ex://apple'),
      ),
      body: <Algebra.Project> parseQuery(c, 'SELECT * { ?s ?p <ex://a> }'),
    }],
  ));

  it('blankNode template generation', ({ expect }) => testMappers(
    expect,
    'SELECT * { ?s ?p1 ?o1 ; ?p2 ?o2 }',
    `SELECT ( ?uq_o1 AS ?o1 ) ( ?uq_o2 AS ?o2 ) ( ?uq_p1 AS ?p1 ) ( ?uq_p2 AS ?p2 ) ( ?uq_s AS ?s ) WHERE {
  {
    {
      SELECT ?m0_o ?m0_p ?m0_s WHERE {
        ?m0_s ?m0_p ?m0_o .
      }
    }
    BIND( ?m0_o AS ?uq_o1 )
    BIND( ?m0_p AS ?uq_p1 )
    BIND( <internal://blank> ( ?m0_s , ?m0_p ) AS ?uq_s )
  }
  UNION {
    {
      SELECT ?m1_o ?m1_p ?m1_s WHERE {
        ?m1_s ?m1_p ?m1_o .
      }
    }
    BIND( ?m1_o AS ?uq_o1 )
    BIND( ?m1_p AS ?uq_p1 )
    BIND( ?m1_s AS ?uq_s )
  }
  {
    {
      SELECT ?m0_o ?m0_p ?m0_s WHERE {
        ?m0_s ?m0_p ?m0_o .
      }
    }
    BIND( ?m0_o AS ?uq_o2 )
    BIND( ?m0_p AS ?uq_p2 )
    BIND( <internal://blank> ( ?m0_s , ?m0_p ) AS ?uq_s )
  }
  UNION {
    {
      SELECT ?m1_o ?m1_p ?m1_s WHERE {
        ?m1_s ?m1_p ?m1_o .
      }
    }
    BIND( ?m1_o AS ?uq_o2 )
    BIND( ?m1_p AS ?uq_p2 )
    BIND( ?m1_s AS ?uq_s )
  }
}`,
    [{
      head: c.AF.createMappingHead(
        c.AF.createTemplateBlank([ c.DF.variable('s'), c.DF.variable('p') ]),
        c.DF.variable('p'),
        c.DF.variable('o'),
      ),
      body: <Algebra.Project> parseQuery(c, 'SELECT * { ?s ?p ?o }'),
    }, {
      head: c.AF.createMappingHead(
        c.DF.variable('s'),
        c.DF.variable('p'),
        c.DF.variable('o'),
      ),
      body: <Algebra.Project> parseQuery(c, 'SELECT * { ?s ?p ?o }'),
    }],
  ));

  it('blankNode template followed by bnode filter', ({ expect }) => testMappers(
    expect,
    'SELECT * { ?s ?p1 ?o1 ; FILTER(isBlank(?s)) }',
    `SELECT ( ?uq_o1 AS ?o1 ) ( ?uq_p1 AS ?p1 ) ( ?uq_s AS ?s ) WHERE {
  {
    {
      SELECT ?m0_o ?m0_p ?m0_s WHERE {
        ?m0_s ?m0_p ?m0_o .
      }
    }
    BIND( ?m0_o AS ?uq_o1 )
    BIND( ?m0_p AS ?uq_p1 )
    BIND( <internal://blank> ( ?m0_s , ?m0_p ) AS ?uq_s )
  }
  FILTER ( ISBLANK( ?uq_s ) )
}`,
    [{
      head: c.AF.createMappingHead(
        c.AF.createTemplateBlank([ c.DF.variable('s'), c.DF.variable('p') ]),
        c.DF.variable('p'),
        c.DF.variable('o'),
      ),
      body: <Algebra.Project> parseQuery(c, 'SELECT * { ?s ?p ?o }'),
    }],
  ));

  it('blankNode template followed by bnode filter rewritten to term', ({ expect }) => testMappers(
    expect,
    'SELECT * { ?s ?p1 ?o1 ; FILTER(isBlank(?s)) }',
    `SELECT ( ?uq_o1 AS ?o1 ) ( ?uq_p1 AS ?p1 ) ( ?uq_s AS ?s ) WHERE {
  {
    {
      SELECT ?m0_o ?m0_p ?m0_s WHERE {
        ?m0_s ?m0_p ?m0_o .
      }
    }
    BIND( ?m0_o AS ?uq_o1 )
    BIND( ?m0_p AS ?uq_p1 )
    BIND( STRDT( CONCAT( IF( ISIRI( ?m0_s ) , CONCAT( ",iri," , REPLACE( REPLACE( STR( ?m0_s ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , IF( HASLANGDIR( ?m0_s ) , CONCAT( ",literal@D," , REPLACE( REPLACE( STR( ?m0_s ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( LANG( ?m0_s ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( LANGDIR( ?m0_s ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , IF( HASLANG( ?m0_s ) , CONCAT( ",literal@," , REPLACE( REPLACE( STR( ?m0_s ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( LANG( ?m0_s ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , CONCAT( ",literal," , REPLACE( REPLACE( STR( ?m0_s ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( STR( DATATYPE( ?m0_s ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) ) ) ) ) , <https://sparql-extension.knows.idlab.ugent.be/bnode> ) AS ?uq_s )
  }
  FILTER ( ( DATATYPE( ?uq_s ) = "https://sparql-extension.knows.idlab.ugent.be/bnode" ) )
}`,
    [{
      head: c.AF.createMappingHead(
        c.AF.createTemplateBlank([ c.DF.variable('s') ]),
        c.DF.variable('p'),
        c.DF.variable('o'),
      ),
      body: <Algebra.Project> parseQuery(c, 'SELECT * { ?s ?p ?o }'),
    }],
    [ operationTransform, internalBnodeAsSpecialLiteral ],
  ));

  it('blankNode template followed by bnode filter rewritten to iri', ({ expect }) => testMappers(
    expect,
    'SELECT * { ?s ?p1 ?o1 ; FILTER(isBlank(?s)) }',
    `SELECT ( ?uq_o1 AS ?o1 ) ( ?uq_p1 AS ?p1 ) ( ?uq_s AS ?s ) WHERE {
  {
    {
      SELECT ?m0_o ?m0_p ?m0_s WHERE {
        ?m0_s ?m0_p ?m0_o .
      }
    }
    BIND( ?m0_o AS ?uq_o1 )
    BIND( ?m0_p AS ?uq_p1 )
    BIND( IRI( CONCAT( "https://myInternalBnode.example.org/" , SHA1( CONCAT( IF( ISIRI( ?m0_s ) , CONCAT( ",iri," , REPLACE( REPLACE( STR( ?m0_s ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , IF( HASLANGDIR( ?m0_s ) , CONCAT( ",literal@D," , REPLACE( REPLACE( STR( ?m0_s ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( LANG( ?m0_s ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( LANGDIR( ?m0_s ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , IF( HASLANG( ?m0_s ) , CONCAT( ",literal@," , REPLACE( REPLACE( STR( ?m0_s ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( LANG( ?m0_s ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) , CONCAT( ",literal," , REPLACE( REPLACE( STR( ?m0_s ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) , "," , REPLACE( REPLACE( STR( DATATYPE( ?m0_s ) ) , "\\\\" , "\\\\\\\\" ) , "," , "\\\\," ) ) ) ) ) ) ) ) ) AS ?uq_s )
  }
  FILTER ( ( ISIRI( ?uq_s ) && STRSTARTS( STR( ?uq_s ) , "https://myInternalBnode.example.org/" ) ) )
}`,
    [{
      head: c.AF.createMappingHead(
        c.AF.createTemplateBlank([ c.DF.variable('s') ]),
        c.DF.variable('p'),
        c.DF.variable('o'),
      ),
      body: <Algebra.Project> parseQuery(c, 'SELECT * { ?s ?p ?o }'),
    }],
    [ operationTransform, internalBnodeAsSpecialIri ],
  ));
});
