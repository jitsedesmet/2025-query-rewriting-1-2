import { QueryEngine } from '@comunica/query-sparql-file';
import type * as RDF from '@rdfjs/types';
import * as arrayifyStreamNS from 'arrayify-stream';
import { Store } from 'n3';
import { describe, it } from 'vitest';
import { transformFilterFalse } from '../lib/transformations/filterFalse.js';
import { nullifyJoinOverIncompatibleBounds } from '../lib/transformations/nullifyJoinOverIncompatibleBounds.js';
import { operationTransform, queryTransform } from '../lib/transformBgp.js';
import { transformContextFromConstructs } from '../lib/transformContext.js';
import {
  nonSingletonTripleConstruct,
  nonTripleTermConstruct,
  singletonPropertyConstruct,
  tripleTermConstruct,
} from './queries.js';
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
});
