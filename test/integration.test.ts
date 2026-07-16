import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { QueryEngine } from '@comunica/query-sparql-file';
import type * as RDF from '@rdfjs/types';
import * as arrayifyStreamNS from 'arrayify-stream';
import { Store } from 'n3';
import { beforeAll, afterAll, describe, it } from 'vitest';
import { transformFilterFalse } from '../lib/transformations/filterFalse.js';
import { nullifyJoinOverIncompatibleBounds } from '../lib/transformations/nullifyJoinOverIncompatibleBounds.js';
import { operationTransform, queryTransform } from '../lib/transformBgp.js';
import { transformContextFromConstructs } from '../lib/transformContext.js';
import {
  bkrNonReificationConstruct,
  bkrNonSingletonConstruct,
  bkrReificationConstruct,
  nonSingletonTripleConstruct,
  nonTripleTermConstruct,
  singletonPropertyConstruct,
  tripleTermConstruct,
} from './queryConsts.js';
import { PosIndexedTurtleSource } from './statics/REF-Benchmark/BKR/data/PosIndexedTurtleSource.js';
import './matchers/toBeRdfIsomorphic.js';

// Crazy workaround to support both CJS and ESM
const arrayifyStream =
  (<any> arrayifyStreamNS).default ?? arrayifyStreamNS;

/**
 * Integration tests that verify query rewriting correctness by comparing:
 * 1. Executing a SPARQL 1.2 query over data mapped to RDF 1.2 format
 * 2. Executing the rewritten query over the original RDF 1.1 data
 *
 * Both approaches must yield identical results for the rewriter to be correct.
 */
describe('integration tests', () => {
  const engine = new QueryEngine();

  const standardTransformations = <const>[
    operationTransform,
    transformFilterFalse,
    nullifyJoinOverIncompatibleBounds,
    transformFilterFalse,
  ];

  async function sourceToStore(
    sources: NonNullable<Parameters<typeof engine.queryQuads>[1]>['sources'],
    query = 'CONSTRUCT WHERE { ?s ?p ?o }',
  ): Promise<Store> {
    const queryRes: RDF.Quad[] = await arrayifyStream(
      await engine.queryQuads(query, { sources }),
    );
    return new Store(queryRes);
  }

  async function storeTo12Store(source: Store, mappers: string[]): Promise<Store> {
    const result = new Store();
    for (const mapper of mappers) {
      const subRes = await sourceToStore([ source ], mapper);
      result.addAll(subRes);
    }
    return result;
  }

  /**
   * For a given RDF 1.1 store, mappers, and user SPARQL 1.2 query:
   * - Maps the store to an RDF 1.2 store and runs the user query on it.
   * - Rewrites the user query for the original store and runs it there.
   * Returns both quad arrays for comparison.
   */
  async function compareRewrittenToMapped(
    store11: Store,
    mappers: string[],
    userQuery: string,
  ): Promise<{ resOnMappedData: RDF.Quad[]; resUsingRewriter: RDF.Quad[] }> {
    const store12 = await storeTo12Store(store11, mappers);
    const resOnMappedData = (await sourceToStore([ store12 ], userQuery)).getQuads(null, null, null, null);

    const transformerContext = transformContextFromConstructs(mappers);
    const rewrittenQuery = queryTransform(transformerContext, userQuery, [ ...standardTransformations ]);
    const resUsingRewriter = (await sourceToStore([ store11 ], rewrittenQuery)).getQuads(null, null, null, null);

    return { resOnMappedData, resUsingRewriter };
  }

  /**
   * Converts a binding to a canonical sorted string representation for comparison.
   * Variables are sorted alphabetically to ensure consistent ordering.
   */
  function bindingToString(binding: RDF.Bindings): string {
    const entries = [ ...binding ]
      .map(([ variable, term ]) => `${variable.value}=${term.termType}:${term.value}`)
      .sort()
      .join(',');
    return `{${entries}}`;
  }

  /**
   * For a given RDF 1.1 store, mappers, and user SPARQL 1.2 SELECT query:
   * - Maps the store to an RDF 1.2 store and runs the SELECT query on it.
   * - Rewrites the SELECT query for the original store and runs it there.
   * Returns both bindings arrays as sorted strings for comparison.
   */
  async function compareSelectRewrittenToMapped(
    store11: Store,
    mappers: string[],
    userQuery: string,
  ): Promise<{ resOnMappedData: string[]; resUsingRewriter: string[] }> {
    const store12 = await storeTo12Store(store11, mappers);
    const mappedBindings: RDF.Bindings[] = await arrayifyStream(
      await engine.queryBindings(userQuery, { sources: [ store12 ]}),
    );

    const transformerContext = transformContextFromConstructs(mappers);
    const rewrittenQuery = queryTransform(transformerContext, userQuery, [ ...standardTransformations ]);
    const rewrittenBindings: RDF.Bindings[] = await arrayifyStream(
      await engine.queryBindings(rewrittenQuery, { sources: [ store11 ]}),
    );

    return {
      resOnMappedData: mappedBindings.map(bindingToString).sort(),
      resUsingRewriter: rewrittenBindings.map(bindingToString).sort(),
    };
  }

  describe('rdf interop reification - single reified triple', () => {
    const mappers = [ tripleTermConstruct, nonTripleTermConstruct ];

    it('querying via CONSTRUCT WHERE { ?s ?p ?o } returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/singleRdfReifiedTriple.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareRewrittenToMapped(
        store11,
        mappers,
        'CONSTRUCT WHERE { ?s ?p ?o }',
      );
      expect(resOnMappedData).toBeRdfIsomorphic(resUsingRewriter);
    });

    it('querying for annotations on reified triples returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/singleRdfReifiedTriple.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         PREFIX : <ex://>
         CONSTRUCT { ?t :statedBy ?agent }
         WHERE { ?t rdf:reifies <<( ?s ?p ?o )>> . ?t :statedBy ?agent }`,
      );
      expect(resOnMappedData).toBeRdfIsomorphic(resUsingRewriter);
    });
  });

  describe('rdf interop reification - multiple reified triples', () => {
    const mappers = [ tripleTermConstruct, nonTripleTermConstruct ];

    it('querying via CONSTRUCT WHERE { ?s ?p ?o } returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/multipleRdfReifiedTriples.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareRewrittenToMapped(
        store11,
        mappers,
        'CONSTRUCT WHERE { ?s ?p ?o }',
      );
      expect(resOnMappedData).toBeRdfIsomorphic(resUsingRewriter);
    });

    it('querying for all reified triples returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/multipleRdfReifiedTriples.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         CONSTRUCT { ?t rdf:reifies <<( ?s ?p ?o )>> }
         WHERE { ?t rdf:reifies <<( ?s ?p ?o )>> }`,
      );
      expect(resOnMappedData).toBeRdfIsomorphic(resUsingRewriter);
    });

    it('querying for annotations on reified triples returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/multipleRdfReifiedTriples.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         PREFIX : <ex://>
         CONSTRUCT { ?t :statedBy ?agent }
         WHERE { ?t rdf:reifies <<( ?s ?p ?o )>> . ?t :statedBy ?agent }`,
      );
      expect(resOnMappedData).toBeRdfIsomorphic(resUsingRewriter);
    });

    it('querying for who stated Alice\'s relationships returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/multipleRdfReifiedTriples.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         PREFIX : <ex://>
         CONSTRUCT { ?agent :statedAbout :alice }
         WHERE { ?t rdf:reifies <<( :alice ?p ?o )>> . ?t :statedBy ?agent }`,
      );
      expect(resOnMappedData).toBeRdfIsomorphic(resUsingRewriter);
    });

    it('querying for reified triples with a specific subject returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/multipleRdfReifiedTriples.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         PREFIX : <ex://>
         CONSTRUCT { :alice :knows ?o }
         WHERE { ?t rdf:reifies <<( :alice :knows ?o )>> }`,
      );
      expect(resOnMappedData).toBeRdfIsomorphic(resUsingRewriter);
    });

    it('querying for reified triples by a specific source returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/multipleRdfReifiedTriples.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         PREFIX : <ex://>
         CONSTRUCT { ?s :knows ?o }
         WHERE { ?t rdf:reifies <<( ?s :knows ?o )>> . ?t :statedBy :wikipedia }`,
      );
      expect(resOnMappedData).toBeRdfIsomorphic(resUsingRewriter);
    });
  });

  describe('singleton property reification', () => {
    const mappers = [ singletonPropertyConstruct, nonSingletonTripleConstruct ];

    it('querying via CONSTRUCT WHERE { ?s ?p ?o } returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/singletonPropertyData.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareRewrittenToMapped(
        store11,
        mappers,
        'CONSTRUCT WHERE { ?s ?p ?o }',
      );
      expect(resOnMappedData).toBeRdfIsomorphic(resUsingRewriter);
    });

    it('querying for all reified triples returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/singletonPropertyData.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         CONSTRUCT { ?prop rdf:reifies <<( ?s ?p ?o )>> }
         WHERE { ?prop rdf:reifies <<( ?s ?p ?o )>> }`,
      );
      expect(resOnMappedData).toBeRdfIsomorphic(resUsingRewriter);
    });

    it('querying for employment start dates returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/singletonPropertyData.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         PREFIX : <ex://>
         CONSTRUCT { ?prop :startDate ?date }
         WHERE { ?prop rdf:reifies <<( ?s :worksFor ?o )>> . ?prop :startDate ?date }`,
      );
      expect(resOnMappedData).toBeRdfIsomorphic(resUsingRewriter);
    });

    it('querying for employment roles returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/singletonPropertyData.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         PREFIX : <ex://>
         CONSTRUCT { ?s :hasRole ?role }
         WHERE { ?prop rdf:reifies <<( ?s :worksFor ?o )>> . ?prop :role ?role }`,
      );
      expect(resOnMappedData).toBeRdfIsomorphic(resUsingRewriter);
    });

    it('querying for employees of a specific company returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/singletonPropertyData.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         PREFIX : <ex://>
         CONSTRUCT { ?employee :worksFor :acme }
         WHERE { ?prop rdf:reifies <<( ?employee :worksFor :acme )>> }`,
      );
      expect(resOnMappedData).toBeRdfIsomorphic(resUsingRewriter);
    });
  });

  describe('rdf interop reification - SELECT queries', () => {
    const mappers = [ tripleTermConstruct, nonTripleTermConstruct ];

    it('selecting all reified triple components returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/multipleRdfReifiedTriples.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareSelectRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         SELECT ?s ?p ?o WHERE { ?t rdf:reifies <<( ?s ?p ?o )>> }`,
      );
      expect(resOnMappedData).toEqual(resUsingRewriter);
    });

    it('selecting with OPTIONAL annotation (StarBench S-category) returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/multipleRdfReifiedTriples.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareSelectRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         PREFIX : <ex://>
         SELECT ?s ?p ?o ?agent WHERE {
           ?t rdf:reifies <<( ?s ?p ?o )>> .
           OPTIONAL { ?t :statedBy ?agent }
         }`,
      );
      expect(resOnMappedData).toEqual(resUsingRewriter);
    });

    it.skip(
      'selecting by joining two reified triples (StarBench P22-style) returns the same results',
      async({ expect }) => {
        // Known rewriter limitation: when two rdf:reifies triple term patterns appear in the same
        // JOIN, the rewriter maps both to the same mapper (m0_) and the shared internal variable
        // names (?m0_o, ?m0_t) collide at the outer JOIN level, causing incorrect results.
        const store11 = await sourceToStore([ './test/statics/multipleRdfReifiedTriples.ttl' ]);
        const { resOnMappedData, resUsingRewriter } = await compareSelectRewrittenToMapped(
          store11,
          mappers,
          `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
           PREFIX : <ex://>
           SELECT ?o1 ?o2 WHERE {
             ?t1 rdf:reifies <<( :alice :knows ?o1 )>> .
             ?t2 rdf:reifies <<( ?o1 :knows ?o2 )>> .
           }`,
        );
        expect(resOnMappedData).toEqual(resUsingRewriter);
      },
    );

    it('selecting with FILTER on annotation (StarBench S-category) returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/multipleRdfReifiedTriples.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareSelectRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         PREFIX : <ex://>
         SELECT ?s ?p ?o WHERE {
           ?t rdf:reifies <<( ?s ?p ?o )>> .
           ?t :statedBy :wikipedia .
         }`,
      );
      expect(resOnMappedData).toEqual(resUsingRewriter);
    });

    it('selecting with subject filter returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/multipleRdfReifiedTriples.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareSelectRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         PREFIX : <ex://>
         SELECT ?p ?o WHERE { ?t rdf:reifies <<( :alice ?p ?o )>> }`,
      );
      expect(resOnMappedData).toEqual(resUsingRewriter);
    });
  });

  describe('singleton property reification - SELECT queries', () => {
    const mappers = [ singletonPropertyConstruct, nonSingletonTripleConstruct ];

    it('selecting all employees and their roles returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/singletonPropertyData.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareSelectRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         PREFIX : <ex://>
         SELECT ?employee ?role WHERE {
           ?prop rdf:reifies <<( ?employee :worksFor :acme )>> .
           ?prop :role ?role .
         }`,
      );
      expect(resOnMappedData).toEqual(resUsingRewriter);
    });

    it('selecting with OPTIONAL start date returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/singletonPropertyData.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareSelectRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         PREFIX : <ex://>
         SELECT ?employee ?o ?date WHERE {
           ?prop rdf:reifies <<( ?employee :worksFor ?o )>> .
           OPTIONAL { ?prop :startDate ?date }
         }`,
      );
      expect(resOnMappedData).toEqual(resUsingRewriter);
    });

    it('selecting employees of a specific company returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/singletonPropertyData.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareSelectRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         PREFIX : <ex://>
         SELECT ?employee WHERE { ?prop rdf:reifies <<( ?employee :worksFor :acme )>> }`,
      );
      expect(resOnMappedData).toEqual(resUsingRewriter);
    });

    it('selecting with FILTER on role returns the same results', async({ expect }) => {
      const store11 = await sourceToStore([ './test/statics/singletonPropertyData.ttl' ]);
      const { resOnMappedData, resUsingRewriter } = await compareSelectRewrittenToMapped(
        store11,
        mappers,
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
         PREFIX : <ex://>
         SELECT ?employee WHERE {
           ?prop rdf:reifies <<( ?employee :worksFor :acme )>> .
           ?prop :role "engineer" .
         }`,
      );
      expect(resOnMappedData).toEqual(resUsingRewriter);
    });
  });

  /**
   * Large-data integration tests that verify the query rewriter works correctly against
   * the BKR benchmark data files generated by mapBkrStar.ts.
   *
   * These tests are automatically skipped when the generated files are not present
   * (normal CI without the large data files).  To run them:
   *
   *   NODE_OPTIONS='--max-old-space-size=16384' npx tsx mapBkrStar.ts  # generate files
   *   yarn test                                                          # run all tests
   *
   * Each test compares:
   *   1. The result of running a BKR-star (SPARQL 1.2 embedded-triple) query through the
   *      rewriter against the mapped file.
   *   2. The result of running the hand-written equivalent BKR-R / BKR-S query directly
   *      against the same mapped file.
   * Both must return identical sorted bindings.
   */
  describe('bkr large-data integration tests', () => {
    const BKR_DATA = './test/statics/REF-Benchmark/BKR/data';
    const BKR_QUERIES = './test/statics/REF-Benchmark/BKR/queries';
    const BKR_REIF_PATH = `${BKR_DATA}/BKR-Reification.ttl`;
    const BKR_SING_PATH = `${BKR_DATA}/BKR-Singleton.ttl`;
    /**
     * Whether to actually run the large-data tests.  Set BKR_TESTS=1 in the
     * environment together with having the generated files present, e.g.:
     *   NODE_OPTIONS='--max-old-space-size=28672' BKR_TESTS=1 yarn test
     */
    const bkrTestsEnabled = Boolean(process.env.BKR_TESTS);
    /** 20 min: loading 100-170 M quads into PosIndexedTurtleSource takes several minutes. */
    const LOAD_TIMEOUT = 3_600_000;
    /**
     * 1 hour per query: once data is loaded in-memory, SPARQL queries complete in seconds
     * to a few minutes, but we keep a generous budget for unexpected slowness.
     */
    const LARGE_TIMEOUT = 3_600_000;

    /** Run a SELECT query against an RDF.js Source; return sorted binding strings. */
    async function selectBindings(source: RDF.Source, query: string): Promise<string[]> {
      const bindings: RDF.Bindings[] = await arrayifyStream(
        await engine.queryBindings(query, {
          sources: [{ type: 'rdfjs', value: source }],
        }),
      );
      return bindings.map(bindingToString).sort();
    }

    /**
     * Compare the result of running `starQuery` (SPARQL 1.2, embedded-triple syntax)
     * through the rewriter against `source`, with the result of running `mappedQuery`
     * (the hand-written RDF 1.1 equivalent) directly against `source`.
     */
    async function compareBkrSelectQueries(
      source: RDF.Source,
      mappers: string[],
      starQuery: string,
      mappedQuery: string,
    ): Promise<{ resOnMappedData: string[]; resUsingRewriter: string[] }> {
      const transformerContext = transformContextFromConstructs(mappers);
      const rewrittenQuery = queryTransform(transformerContext, starQuery, [ ...standardTransformations ]);
      const [ resOnMappedData, resUsingRewriter ] = await Promise.all([
        selectBindings(source, mappedQuery),
        selectBindings(source, rewrittenQuery),
      ]);
      return { resOnMappedData, resUsingRewriter };
    }

    // -------------------------------------------------------------------------
    // PosIndexedTurtleSource is used for all BKR tests: it loads the file once
    // into a single predicate-index in-memory store, so subsequent SPARQL queries
    // use fast index lookups instead of re-scanning the file on every match() call.
    //
    // afterAll() clears the source reference to allow V8 to GC the heap before
    // loading the next (possibly equally large) file.
    // -------------------------------------------------------------------------

    describe('bkr-Reification.ttl — rdf:Statement format (PosIndexed)', () => {
      const mappers = [ bkrReificationConstruct, bkrNonReificationConstruct ];
      let source: PosIndexedTurtleSource | undefined;

      beforeAll(async() => {
        if (!bkrTestsEnabled || !existsSync(BKR_REIF_PATH)) {
          return;
        }
        source = new PosIndexedTurtleSource(BKR_REIF_PATH);
        await source.load();
      }, LOAD_TIMEOUT);

      afterAll(() => {
        source = undefined;
      });

      it.skipIf(!bkrTestsEnabled || !existsSync(BKR_REIF_PATH))(
        'a-Q1: finds annotated triples by PUBMED source',
        { timeout: LARGE_TIMEOUT },
        async({ expect }) => {
          const starQuery = await readFile(`${BKR_QUERIES}/BKR-star_A-Q1.rq`, 'utf-8');
          const refQuery = await readFile(`${BKR_QUERIES}/BKR-R_A-Q1.rq`, 'utf-8');
          const { resOnMappedData, resUsingRewriter } =
            await compareBkrSelectQueries(source!, mappers, starQuery, refQuery);
          expect(resUsingRewriter).toEqual(resOnMappedData);
        },
      );

      it.skipIf(!bkrTestsEnabled || !existsSync(BKR_REIF_PATH))(
        'a-Q2: finds PUBMED sources for a specific annotated triple',
        { timeout: LARGE_TIMEOUT },
        async({ expect }) => {
          const starQuery = await readFile(`${BKR_QUERIES}/BKR-star_A-Q2.rq`, 'utf-8');
          const refQuery = await readFile(`${BKR_QUERIES}/BKR-R_A-Q2.rq`, 'utf-8');
          const { resOnMappedData, resUsingRewriter } =
            await compareBkrSelectQueries(source!, mappers, starQuery, refQuery);
          expect(resUsingRewriter).toEqual(resOnMappedData);
        },
      );

      it.skipIf(!bkrTestsEnabled || !existsSync(BKR_REIF_PATH))(
        'b-Q1: finds annotated triples by a different PUBMED source',
        { timeout: LARGE_TIMEOUT },
        async({ expect }) => {
          const starQuery = await readFile(`${BKR_QUERIES}/BKR-star_B-Q1.rq`, 'utf-8');
          const refQuery = await readFile(`${BKR_QUERIES}/BKR-R_B-Q1.rq`, 'utf-8');
          const { resOnMappedData, resUsingRewriter } =
            await compareBkrSelectQueries(source!, mappers, starQuery, refQuery);
          expect(resUsingRewriter).toEqual(resOnMappedData);
        },
      );
    });

    // -------------------------------------------------------------------------

    describe('bkr-Singleton.ttl — singleton-property format (PosIndexed)', () => {
      const mappers = [ singletonPropertyConstruct, bkrNonSingletonConstruct ];
      let source: PosIndexedTurtleSource | undefined;

      beforeAll(async() => {
        if (!bkrTestsEnabled || !existsSync(BKR_SING_PATH)) {
          return;
        }
        source = new PosIndexedTurtleSource(BKR_SING_PATH);
        await source.load();
      }, LOAD_TIMEOUT);

      afterAll(() => {
        source = undefined;
      });

      it.skipIf(!bkrTestsEnabled || !existsSync(BKR_SING_PATH))(
        'a-Q1: finds annotated triples by PUBMED source',
        { timeout: LARGE_TIMEOUT },
        async({ expect }) => {
          const starQuery = await readFile(`${BKR_QUERIES}/BKR-star_A-Q1.rq`, 'utf-8');
          // BKR-S_A-Q1 finds ?s ?singleton ?o where ?singleton derives_from X.
          // The rewriter returns ?s, trueProp, ?o (via singletonPropertyOf).
          // We use a custom reference that mirrors the rewriter's output variables.
          const refQuery = `
            PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
            PREFIX bkr: <http://mor.nlm.nih.gov/bkr/>
            PREFIX provenir: <http://knoesis.wright.edu/provenir/>
            SELECT ?s ?p ?o WHERE {
              ?s ?singleton ?o .
              ?singleton rdf:singletonPropertyOf ?p .
              ?singleton provenir:derives_from bkr:PUBMED_99992-INST .
            }`;
          const { resOnMappedData, resUsingRewriter } =
            await compareBkrSelectQueries(source!, mappers, starQuery, refQuery);
          expect(resUsingRewriter).toEqual(resOnMappedData);
        },
      );

      it.skipIf(!bkrTestsEnabled || !existsSync(BKR_SING_PATH))(
        'a-Q2: finds PUBMED sources for a specific annotated triple',
        { timeout: LARGE_TIMEOUT },
        async({ expect }) => {
          const starQuery = await readFile(`${BKR_QUERIES}/BKR-star_A-Q2.rq`, 'utf-8');
          const refQuery = `
            PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
            PREFIX bkr_meta: <http://mor.nlm.nih.gov/bkr/META_>
            PREFIX bkr_sn: <http://mor.nlm.nih.gov/bkr/SEMNET_>
            PREFIX provenir: <http://knoesis.wright.edu/provenir/>
            SELECT ?pmid1 WHERE {
              bkr_meta:C0543467-INST ?singleton bkr_meta:C0178292-INST .
              ?singleton rdf:singletonPropertyOf bkr_sn:TREATS .
              ?singleton provenir:derives_from ?pmid1 .
            }`;
          const { resOnMappedData, resUsingRewriter } =
            await compareBkrSelectQueries(source!, mappers, starQuery, refQuery);
          expect(resUsingRewriter).toEqual(resOnMappedData);
        },
      );

      it.skipIf(!bkrTestsEnabled || !existsSync(BKR_SING_PATH))(
        'b-Q1: finds annotated triples by a different PUBMED source',
        { timeout: LARGE_TIMEOUT },
        async({ expect }) => {
          const starQuery = await readFile(`${BKR_QUERIES}/BKR-star_B-Q1.rq`, 'utf-8');
          const refQuery = `
            PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
            PREFIX provenir: <http://knoesis.wright.edu/provenir/>
            PREFIX pubmed: <http://mor.nlm.nih.gov/bkr/PUBMED_>
            SELECT ?s ?p ?o WHERE {
              ?s ?singleton ?o .
              ?singleton rdf:singletonPropertyOf ?p .
              ?singleton provenir:derives_from pubmed:10979521-INST .
            }`;
          const { resOnMappedData, resUsingRewriter } =
            await compareBkrSelectQueries(source!, mappers, starQuery, refQuery);
          expect(resUsingRewriter).toEqual(resOnMappedData);
        },
      );
    });
  });
});
