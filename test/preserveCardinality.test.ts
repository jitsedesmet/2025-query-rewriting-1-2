import { QueryEngine } from '@comunica/query-sparql-file';
import type * as RDF from '@rdfjs/types';
import * as arrayifyStreamNS from 'arrayify-stream';
import { DataFactory, Store } from 'n3';
import { describe, it } from 'vitest';
import { mappingFromConstructQueries } from '../lib/mapping.js';
import { createQueryRewriter } from '../lib/queryRewriter.js';
import { filterFalseTransformation } from '../lib/transformations/filterFalse.js';
import { unfoldingTransformation } from '../lib/transformations/unfolding.js';

// Crazy workaround to support both CJS and ESM
const arrayifyStream =
  (<any> arrayifyStreamNS).default ?? arrayifyStreamNS;

/**
 * The unfolded query treats the virtual RDF 1.2 graph as a **bag**: two solutions of the mapping body
 * producing the same triple are counted twice, where the mapped graph is a set. `preserveCardinality`
 * closes that gap, at the cost of deduplicating the whole body of every unfolded pattern.
 */
describe('preserveCardinality', () => {
  const engine = new QueryEngine();
  const DF = DataFactory;

  // Both branches of the union produce <ex://alice> <ex://knows> <ex://bob>, so the body has two
  // solutions where the mapped graph holds one triple.
  const duplicatingConstruct = `CONSTRUCT { ?s <ex://knows> ?o } WHERE {
    { ?s <ex://a> ?o } UNION { ?s <ex://b> ?o }
  }`;
  const mapping = mappingFromConstructQueries([ duplicatingConstruct ]);

  const store11 = new Store([
    DF.quad(DF.namedNode('ex://alice'), DF.namedNode('ex://a'), DF.namedNode('ex://bob')),
    DF.quad(DF.namedNode('ex://alice'), DF.namedNode('ex://b'), DF.namedNode('ex://bob')),
  ]);

  function rewriterPreserving(preserveCardinality: boolean): ReturnType<typeof createQueryRewriter> {
    return createQueryRewriter([
      unfoldingTransformation(mapping, { preserveCardinality }),
      filterFalseTransformation(),
    ]);
  }

  /** The solutions of a query, duplicates kept, as sorted `name=value` strings. */
  async function solutionsOf(query: string, source: Store): Promise<string[]> {
    const rows: RDF.Bindings[] = await arrayifyStream(await engine.queryBindings(query, { sources: [ source ]}));
    return rows
      .map(row => [ ...row ].map(([ key, value ]) => `${key.value}=${value.value}`).sort().join('|'))
      .sort();
  }

  /** The RDF 1.2 graph the mapping denotes, which is a set. */
  async function mappedStore(): Promise<Store> {
    const quads: RDF.Quad[] = await arrayifyStream(
      await engine.queryQuads(duplicatingConstruct, { sources: [ store11 ]}),
    );
    return new Store(quads);
  }

  it('counts a repeated triple twice when it is off', async({ expect }) => {
    const userQuery = 'SELECT * WHERE { ?s <ex://knows> ?o }';
    const theOneTriple = 'o=ex://bob|s=ex://alice';
    expect(await solutionsOf(await rewriterPreserving(false).rewriteQuery(userQuery), store11))
      .toEqual([ theOneTriple, theOneTriple ]);
    expect(await solutionsOf(userQuery, await mappedStore())).toEqual([ theOneTriple ]);
  });

  it('counts it once when it is on, as the mapped graph does', async({ expect }) => {
    const userQuery = 'SELECT * WHERE { ?s <ex://knows> ?o }';
    expect(await solutionsOf(await rewriterPreserving(true).rewriteQuery(userQuery), store11))
      .toEqual(await solutionsOf(userQuery, await mappedStore()));
  });

  it('agrees with the mapped graph on COUNT(*) only when it is on', async({ expect }) => {
    const userQuery = 'SELECT (COUNT(*) AS ?n) WHERE { ?s <ex://knows> ?o }';
    const onMappedData = await solutionsOf(userQuery, await mappedStore());
    expect(onMappedData).toEqual([ 'n=1' ]);

    expect(await solutionsOf(await rewriterPreserving(true).rewriteQuery(userQuery), store11))
      .toEqual(onMappedData);
    expect(await solutionsOf(await rewriterPreserving(false).rewriteQuery(userQuery), store11))
      .toEqual([ 'n=2' ]);
  });
});
