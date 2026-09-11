import { QueryEngine } from '@comunica/query-sparql-file';
import { toAst } from '@traqula/algebra-sparql-1-2';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import * as arrayifyStreamNS from 'arrayify-stream';
import { describe, it } from 'vitest';
import { transformFilterFalse } from '../lib/transformations/filterFalse.js';
import { nullifyJoinOverIncompatibleBounds } from '../lib/transformations/nullifyJoinOverIncompatibleBounds.js';
import { pullUpExtends } from '../lib/transformations/pullUpExtends.js';
import { pushDownAssertions } from '../lib/transformations/pushDownAssertions.js';
import { removeProjections } from '../lib/transformations/removeProjections.js';
import { operationTransform, queryTransform } from '../lib/transformBgp.js';
import type { TransformContext } from '../lib/transformContext.js';
import { createPartialContext, parseQuery, transformContextFromConstructs } from '../lib/transformContext.js';
import { createFilterFalse } from '../lib/utils/operationhelpers.js';
import { nonReificationTripleConstruct, nonTripleTermConstruct, rdfReificationConstruct } from './queryConsts.js';

// Crazy workaround to support both CJS and ESM
const arrayifyStream =
  (<any> arrayifyStreamNS).default ?? arrayifyStreamNS;

const prefixes = `PREFIX : <ex://>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
`;

const engine = new QueryEngine();

/** The solutions of a query as sorted `name=value` strings. */
async function sortedBindingsOf(query: string, source: string): Promise<string[]> {
  const rows: any[] = await arrayifyStream(await engine.queryBindings(query, { sources: [ source ]}));
  return rows
    .map(row => [ ...row ].map(([ key, value ]: [any, any]) => `${key.value}=${value.value}`).sort().join('|'))
    .sort();
}

/** The variables a query's result exposes. */
async function exposedVariablesOf(query: string, source: string): Promise<string[]> {
  const result = <any> await engine.query(query, { sources: [ source ]});
  const metadata = await result.metadata();
  const variableNames: string[] = metadata.variables.map((variable: { value: string }) => variable.value);
  return variableNames.sort();
}

describe('transformFilterFalse', () => {
  // The pass only ever reads AF / DF / generator off the context, never the mapping.
  const c = <TransformContext> createPartialContext();

  /** The pass over hand-built algebra. */
  function transformAlgebra(op: Algebra.Operation): Algebra.Operation {
    return transformFilterFalse(c, op);
  }

  /** The pass over a parsed query, back as SPARQL. */
  function transformQueryString(query: string): string {
    return c.generator.generate(toAst(transformFilterFalse(c, parseQuery(c, prefixes + query)))).trim();
  }

  function extendWithConstant(input: Algebra.Operation): Algebra.Extend {
    return c.AF.createExtend(input, c.DF.variable('b'), c.AF.createTermExpression(c.DF.namedNode('ex://b')));
  }

  const tripleScan = c.AF.createBgp([
    c.AF.createPattern(c.DF.variable('s'), c.DF.variable('p'), c.DF.variable('o')),
  ]);
  /** `{ SELECT ?a WHERE { ?a :p ?b FILTER(false) } }`, built the way the pushdown builds it. */
  const emptySubSelect = c.AF.createProject(
    createFilterFalse(c, c.AF.createBgp([
      c.AF.createPattern(c.DF.variable('a'), c.DF.namedNode('ex://p'), c.DF.variable('b')),
    ])),
    [ c.DF.variable('a') ],
  );
  const countAll = c.AF.createBoundAggregate(c.DF.variable('n'), 'count', c.AF.createWildcardExpression(), false);

  /** Sub-SELECT modifiers over an empty input, each still empty. */
  const emptyModifiedSubSelects: [string, Algebra.Operation][] = [
    [ 'DISTINCT', c.AF.createDistinct(emptySubSelect) ],
    [ 'REDUCED', c.AF.createReduced(emptySubSelect) ],
    [ 'LIMIT', c.AF.createSlice(emptySubSelect, 0, 10) ],
    [ 'OFFSET', c.AF.createSlice(emptySubSelect, 5) ],
    [ 'DISTINCT with LIMIT and OFFSET', c.AF.createSlice(c.AF.createDistinct(emptySubSelect), 5, 10) ],
  ];

  describe('emptiness through a sub-SELECT', () => {
    it('drops a UNION branch whose EXTEND stands over an empty sub-SELECT', ({ expect }) => {
      expect(transformAlgebra(c.AF.createUnion([ tripleScan, extendWithConstant(emptySubSelect) ], false)))
        .toEqual(tripleScan);
    });

    it('empties a JOIN over an empty sub-SELECT', ({ expect }) => {
      expect(transformAlgebra(c.AF.createJoin([ tripleScan, emptySubSelect ], false))).toEqual(createFilterFalse(c));
    });

    it('reduces a MINUS whose right operand is an empty sub-SELECT to its left', ({ expect }) => {
      expect(transformAlgebra(c.AF.createMinus(tripleScan, emptySubSelect))).toEqual(tripleScan);
    });

    it('reduces a LEFT JOIN whose right operand is an empty sub-SELECT to its left', ({ expect }) => {
      expect(transformAlgebra(c.AF.createLeftJoin(tripleScan, emptySubSelect))).toEqual(tripleScan);
    });

    for (const [ modifierName, modifiedSubSelect ] of emptyModifiedSubSelects) {
      it(`sees through the ${modifierName} of an empty sub-SELECT`, ({ expect }) => {
        expect(transformAlgebra(c.AF.createJoin([ tripleScan, modifiedSubSelect ], false)))
          .toEqual(createFilterFalse(c));
      });
    }
  });

  describe('the projection of an empty sub-SELECT', () => {
    it('collapses into a fresh FILTER(FALSE) when it is nested', ({ expect }) => {
      // Not the pushdown's FILTER(FALSE), which would bring the hidden ?b back into scope.
      expect(transformAlgebra(extendWithConstant(emptySubSelect))).toEqual(createFilterFalse(c));
    });

    it('is kept when it is the query\'s own projection', ({ expect }) => {
      expect(transformAlgebra(emptySubSelect)).toEqual(emptySubSelect);
    });

    it('leaves a GROUP over it alone, an aggregate over nothing still answering', ({ expect }) => {
      const grouped = c.AF.createGroup(emptySubSelect, [], [ countAll ]);
      // The sub-SELECT inside collapses; the GROUP over it, and the JOIN over that, do not.
      expect(transformAlgebra(c.AF.createJoin([ tripleScan, grouped ], false)))
        .toEqual(c.AF.createJoin([ tripleScan, c.AF.createGroup(createFilterFalse(c), [], [ countAll ]) ], false));
    });
  });

  describe('the query\'s own solution modifiers', () => {
    it('keeps an outermost projection over an empty input', ({ expect }) => {
      expect(transformQueryString('SELECT ?a ?b WHERE { ?a :p ?b FILTER(false) }'))
        .toContain('SELECT ?a ?b WHERE');
    });

    it('keeps an outermost DISTINCT and LIMIT over an empty input', ({ expect }) => {
      const transformed = transformQueryString('SELECT DISTINCT ?a ?b WHERE { ?a :p ?b FILTER(false) } LIMIT 10');
      expect(transformed).toContain('SELECT DISTINCT ?a ?b WHERE');
      expect(transformed).toContain('LIMIT 10');
    });

    // A parsed query always has a projection below its modifiers, so only hand-built algebra tests these.
    it('keeps an outermost SLICE and DISTINCT that have no projection below them', ({ expect }) => {
      const sliced = c.AF.createSlice(c.AF.createDistinct(createFilterFalse(c)), 0, 10);
      expect(transformAlgebra(sliced)).toEqual(sliced);
    });

    it('keeps an outermost FROM and REDUCED that have no projection below them', ({ expect }) => {
      const fromGraph = c.AF.createFrom(c.AF.createReduced(createFilterFalse(c)), [ c.DF.namedNode('ex://g') ], []);
      expect(transformAlgebra(fromGraph)).toEqual(fromGraph);
    });
  });

  describe('the answer of a rewritten query', () => {
    const source = './test/statics/multipleRdfReifiedTriples.ttl';

    // The pass-through mapping leaves every pattern as it was.
    function rewriteWithFilterFalse(query: string): string {
      const passThroughContext = transformContextFromConstructs([ nonTripleTermConstruct ]);
      return queryTransform(passThroughContext, query, [ transformFilterFalse ]);
    }

    it('exposes the same variables and rows when a SELECT * loses an empty sub-SELECT', async({ expect }) => {
      // `?a` is only in scope through the dropped branch.
      const query = `${prefixes}SELECT * WHERE { { ?s :knows ?o } UNION { SELECT ?a WHERE { ?a :p ?b FILTER(false) } } }`;
      const rewritten = rewriteWithFilterFalse(query);
      expect(rewritten).not.toContain('FILTER ( FALSE )');
      expect(await exposedVariablesOf(rewritten, source)).toEqual(await exposedVariablesOf(query, source));
      expect(await exposedVariablesOf(rewritten, source)).toContain('a');
      const originalBindings = await sortedBindingsOf(query, source);
      // Sanity: the query actually returns something, so the comparison is not two empty lists.
      expect(originalBindings.length).toBeGreaterThan(0);
      expect(await sortedBindingsOf(rewritten, source)).toEqual(originalBindings);
    });

    it('still returns the single row of an aggregate over an empty input', async({ expect }) => {
      // COUNT(*) of nothing is one row, 0.
      const query = `${prefixes}SELECT (COUNT(*) AS ?n) WHERE { ?s :knows ?o FILTER(false) }`;
      expect(await sortedBindingsOf(query, source)).toEqual([ 'n=0' ]);
      expect(await sortedBindingsOf(rewriteWithFilterFalse(query), source)).toEqual([ 'n=0' ]);
    });
  });

  describe('idempotence', () => {
    const shapes: [string, Algebra.Operation][] = [
      [ 'a UNION with an empty branch', c.AF.createUnion([ tripleScan, extendWithConstant(emptySubSelect) ], false) ],
      [ 'a JOIN over an empty sub-SELECT', c.AF.createJoin([ tripleScan, emptySubSelect ], false) ],
      [ 'a MINUS against an empty sub-SELECT', c.AF.createMinus(tripleScan, emptySubSelect) ],
      [ 'a LEFT JOIN over an empty sub-SELECT', c.AF.createLeftJoin(tripleScan, emptySubSelect) ],
      [ 'a GROUP over an empty sub-SELECT', c.AF.createGroup(emptySubSelect, [], [ countAll ]) ],
      [ 'an empty sub-SELECT on its own', emptySubSelect ],
      ...emptyModifiedSubSelects.map(([ modifierName, modifiedSubSelect ]): [string, Algebra.Operation] =>
        [ `a JOIN over the ${modifierName} of an empty sub-SELECT`, c.AF.createJoin([ tripleScan, modifiedSubSelect ], false) ]),
      [ 'an outermost projection', parseQuery(c, `${prefixes}SELECT ?a WHERE { ?a :p ?o FILTER(false) }`) ],
      [ 'an outermost DISTINCT and LIMIT', parseQuery(
        c,
        `${prefixes}SELECT DISTINCT ?a WHERE { ?a :p ?o FILTER(false) } LIMIT 10`,
      ) ],
      [ 'a SELECT * losing a sub-SELECT', parseQuery(
        c,
        `${prefixes}SELECT * WHERE { { ?s :knows ?o } UNION { SELECT ?a WHERE { ?a :p ?b FILTER(false) } } }`,
      ) ],
      [ 'an aggregate over an empty input', parseQuery(
        c,
        `${prefixes}SELECT (COUNT(*) AS ?n) WHERE { ?s :knows ?o FILTER(false) }`,
      ) ],
    ];

    for (const [ shapeName, shape ] of shapes) {
      it(`runs to a fixed point on ${shapeName}`, ({ expect }) => {
        const transformedOnce = transformAlgebra(shape);
        expect(transformAlgebra(transformedOnce)).toEqual(transformedOnce);
      });
    }
  });
});

describe('transformFilterFalse over a reification mapping', () => {
  const mappers = [ rdfReificationConstruct, nonReificationTripleConstruct ];
  const source = './test/statics/bkrReifiedStatements.ttl';

  // The constant subject is what lets the pushdown prove the pass-through branch empty.
  const query = `
PREFIX bkr: <http://mor.nlm.nih.gov/bkr/>
PREFIX bkr_sn: <http://mor.nlm.nih.gov/bkr/SEMNET_>
PREFIX provenir: <http://knoesis.wright.edu/provenir/>
SELECT ?o ?source WHERE { << bkr:META_C0040300-INST bkr_sn:PART_OF ?o >> provenir:derives_from ?source . }`;

  const pushdownPipeline = <const>[
    operationTransform,
    transformFilterFalse,
    nullifyJoinOverIncompatibleBounds,
    transformFilterFalse,
    pushDownAssertions,
    transformFilterFalse,
    removeProjections,
  ];

  const pullUpPipeline = <const>[
    operationTransform,
    transformFilterFalse,
    nullifyJoinOverIncompatibleBounds,
    transformFilterFalse,
    pushDownAssertions,
    transformFilterFalse,
    pullUpExtends,
    removeProjections,
    pullUpExtends,
  ];

  function rewriteWithPipeline(
    pipeline: readonly ((c: TransformContext, op: Algebra.Operation) => Algebra.Operation)[],
  ): string {
    return queryTransform(transformContextFromConstructs(mappers), query, [ ...pipeline ]);
  }

  it('leaves no dead branch in the pushdown pipeline', ({ expect }) => {
    expect(rewriteWithPipeline(pushdownPipeline)).not.toContain('FILTER ( FALSE )');
  });

  it('leaves no dead branch in the pullUpExtends pipeline', ({ expect }) => {
    expect(rewriteWithPipeline(pullUpPipeline)).not.toContain('FILTER ( FALSE )');
  });

  describe('the rewritten query still answers', () => {
    // The query's meaning over the RDF 1.1 data, written by hand.
    const expectedOverRdf11 = `
PREFIX bkr: <http://mor.nlm.nih.gov/bkr/>
PREFIX bkr_sn: <http://mor.nlm.nih.gov/bkr/SEMNET_>
PREFIX provenir: <http://knoesis.wright.edu/provenir/>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT ?o ?source WHERE {
  ?t rdf:type rdf:Statement ;
     rdf:subject bkr:META_C0040300-INST ;
     rdf:predicate bkr_sn:PART_OF ;
     rdf:object ?o ;
     provenir:derives_from ?source .
}`;

    it('agrees with the mapping, run through the pushdown pipeline', async({ expect }) => {
      const expectedBindings = await sortedBindingsOf(expectedOverRdf11, source);
      // Sanity: the data actually answers, so the comparison is not two empty lists.
      expect(expectedBindings).toHaveLength(2);
      expect(await sortedBindingsOf(rewriteWithPipeline(pushdownPipeline), source)).toEqual(expectedBindings);
    });

    it('agrees with the mapping, run through the pullUpExtends pipeline', async({ expect }) => {
      expect(await sortedBindingsOf(rewriteWithPipeline(pullUpPipeline), source))
        .toEqual(await sortedBindingsOf(expectedOverRdf11, source));
    });
  });
});
