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
import { createFilterFalse, isEmptyOperation } from '../lib/utils/operationhelpers.js';
import { nonReificationTripleConstruct, rdfReificationConstruct } from './queryConsts.js';

// Crazy workaround to support both CJS and ESM
const arrayifyStream =
  (<any> arrayifyStreamNS).default ?? arrayifyStreamNS;

const prefixes = `PREFIX : <ex://>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
`;

describe('transformFilterFalse', () => {
  // The pass only ever reads AF / DF / generator off the context, never the mapping.
  const c = <TransformContext> createPartialContext();

  /** The pass over algebra built by hand, which is how the sub-SELECT shapes are reached exactly. */
  function transform(op: Algebra.Operation): Algebra.Operation {
    return transformFilterFalse(c, op);
  }

  /** The pass over a parsed query, back as SPARQL. */
  function transformQuery(query: string): string {
    return c.generator.generate(toAst(transformFilterFalse(c, parseQuery(c, prefixes + query)))).trim();
  }

  /** The `SELECT` clause of a generated query: what it exposes, which no rewrite here may change. */
  function selectClauseOf(query: string): string {
    return query.split('\n')[0];
  }

  const scan = c.AF.createBgp([
    c.AF.createPattern(c.DF.variable('s'), c.DF.variable('p'), c.DF.variable('o')),
  ]);
  /** `{ SELECT ?a WHERE { FILTER(false) } }`: the shape `operationTransform` leaves an empty branch in. */
  const emptySubSelect = c.AF.createProject(createFilterFalse(c), [ c.DF.variable('a') ]);

  describe('emptiness through a sub-SELECT', () => {
    it('drops a UNION branch whose EXTEND stands over an empty sub-SELECT', ({ expect }) => {
      const extended = c.AF.createExtend(
        emptySubSelect,
        c.DF.variable('b'),
        c.AF.createTermExpression(c.DF.namedNode('ex://b')),
      );
      expect(transform(c.AF.createUnion([ scan, extended ], false))).toEqual(scan);
    });

    it('empties a JOIN over an empty sub-SELECT', ({ expect }) => {
      expect(transform(c.AF.createJoin([ scan, emptySubSelect ], false))).toEqual(createFilterFalse(c));
    });

    it('reduces a MINUS whose right operand is an empty sub-SELECT to its left', ({ expect }) => {
      expect(transform(c.AF.createMinus(scan, emptySubSelect))).toEqual(scan);
    });

    it('reduces a LEFT JOIN whose right operand is an empty sub-SELECT to its left', ({ expect }) => {
      expect(transform(c.AF.createLeftJoin(scan, emptySubSelect))).toEqual(scan);
    });

    it('sees through the modifiers of an empty sub-SELECT', ({ expect }) => {
      // DISTINCT, REDUCED and LIMIT/OFFSET over nothing are still nothing.
      const modified = c.AF.createSlice(c.AF.createDistinct(emptySubSelect), 0, 10);
      expect(transform(c.AF.createJoin([ scan, modified ], false))).toEqual(createFilterFalse(c));
    });
  });

  describe('the projection of an empty sub-SELECT', () => {
    it('is recognised as empty', ({ expect }) => {
      expect(isEmptyOperation(c, emptySubSelect)).toBe(true);
    });

    it('is kept as it stands, so that its columns stay in scope', ({ expect }) => {
      // `pVars(Empty_S) := S`: replacing it by a FILTER(FALSE) over the empty BGP would take ?a out of
      // scope for whatever reads the sub-SELECT.
      expect(transform(emptySubSelect)).toEqual(emptySubSelect);
    });

    it('leaves a GROUP over it alone, an aggregate over nothing still answering', ({ expect }) => {
      const grouped = c.AF.createGroup(emptySubSelect, [], [
        c.AF.createBoundAggregate(c.DF.variable('n'), 'count', c.AF.createWildcardExpression(), false),
      ]);
      expect(isEmptyOperation(c, grouped)).toBe(false);
      expect(transform(c.AF.createJoin([ scan, grouped ], false)))
        .toEqual(c.AF.createJoin([ scan, grouped ], false));
    });
  });

  describe('the query the caller reads its answer off', () => {
    it('keeps an outermost projection over an empty input', ({ expect }) => {
      expect(transformQuery('SELECT ?a ?b WHERE { ?a :p ?b FILTER(false) }'))
        .toContain('SELECT ?a ?b WHERE');
    });

    it('keeps an outermost DISTINCT and LIMIT over an empty input', ({ expect }) => {
      const transformed = transformQuery('SELECT DISTINCT ?a ?b WHERE { ?a :p ?b FILTER(false) } LIMIT 10');
      expect(transformed).toContain('SELECT DISTINCT ?a ?b WHERE');
      expect(transformed).toContain('LIMIT 10');
    });

    it('exposes the same variables when a sub-SELECT of a SELECT * goes empty', ({ expect }) => {
      const query = 'SELECT * WHERE { ?s :q ?r { SELECT ?a WHERE { ?a :p ?o FILTER(false) } } }';
      expect(selectClauseOf(transformQuery(query)))
        .toEqual(selectClauseOf(c.generator.generate(toAst(parseQuery(c, prefixes + query))).trim()));
    });

    it('leaves an aggregate without a GROUP BY over an empty input alone', ({ expect }) => {
      // COUNT(*) of nothing is 0, one row - so this query is not empty and may not be collapsed.
      expect(transformQuery('SELECT (COUNT(*) AS ?n) WHERE { ?s :p ?o FILTER(false) }'))
        .toEqual(c.generator.generate(toAst(parseQuery(
          c,
          `${prefixes}SELECT (COUNT(*) AS ?n) WHERE { ?s :p ?o FILTER(false) }`,
        ))).trim());
    });
  });

  describe('idempotence', () => {
    const shapes: [string, Algebra.Operation][] = [
      [ 'a UNION with an empty branch', c.AF.createUnion([
        scan,
        c.AF.createExtend(emptySubSelect, c.DF.variable('b'), c.AF.createTermExpression(c.DF.namedNode('ex://b'))),
      ], false) ],
      [ 'a JOIN over an empty sub-SELECT', c.AF.createJoin([ scan, emptySubSelect ], false) ],
      [ 'an empty sub-SELECT on its own', emptySubSelect ],
      [ 'an empty outermost projection', parseQuery(c, `${prefixes}SELECT ?a WHERE { ?a :p ?o FILTER(false) }`) ],
    ];

    for (const [ name, shape ] of shapes) {
      it(`runs to a fixed point on ${name}`, ({ expect }) => {
        const once = transform(shape);
        expect(transform(once)).toEqual(once);
      });
    }
  });
});

describe('transformFilterFalse over a reification mapping', () => {
  const mappers = [ rdfReificationConstruct, nonReificationTripleConstruct ];

  // A constant in the quoted triple is what lets the pushdown prove the pass-through branch empty; a
  // fully variable << ?s ?p ?o >> leaves nothing to decide.
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

  function rewrite(pipeline: readonly ((c: TransformContext, op: Algebra.Operation) => Algebra.Operation)[]):
  string {
    return queryTransform(transformContextFromConstructs(mappers), query, [ ...pipeline ]);
  }

  it('leaves no dead branch in the pushdown pipeline', ({ expect }) => {
    expect(rewrite(pushdownPipeline)).not.toContain('FILTER ( FALSE )');
  });

  it('leaves no dead branch in the pullUpExtends pipeline', ({ expect }) => {
    expect(rewrite(pullUpPipeline)).not.toContain('FILTER ( FALSE )');
  });

  describe('the rewritten query still answers', () => {
    const engine = new QueryEngine();

    async function bindings(toRun: string): Promise<string[]> {
      const rows: any[] = await arrayifyStream(await engine.queryBindings(toRun, {
        sources: [ './test/statics/bkrReifiedStatements.ttl' ],
      }));
      return rows
        .map(row => [ ...row ].map(([ key, value ]: [any, any]) => `${key.value}=${value.value}`).sort().join('|'))
        .sort();
    }

    // What the mapping means over RDF 1.1 data, written out by hand: the reifying pattern can only be
    // answered by the reification structure, never by the pass-through branch the pushdown empties.
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
      const expected = await bindings(expectedOverRdf11);
      // Sanity: the data actually answers, so the comparison is not two empty lists.
      expect(expected).toHaveLength(2);
      expect(await bindings(rewrite(pushdownPipeline))).toEqual(expected);
    });

    it('agrees with the mapping, run through the pullUpExtends pipeline', async({ expect }) => {
      expect(await bindings(rewrite(pullUpPipeline))).toEqual(await bindings(expectedOverRdf11));
    });
  });
});
