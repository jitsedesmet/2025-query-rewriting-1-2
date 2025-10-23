import { QueryEngine } from '@comunica/query-sparql-file';
import arrayifyStream from 'arrayify-stream';
import { DataFactory } from 'rdf-data-factory';
import { describe, it } from 'vitest';

describe('evaluation tests', () => {
  const engine = new QueryEngine();
  const DF = new DataFactory();

  it('an empty eval text', async({ expect }) => {
    const query = 'CONSTRUCT WHERE { ?s ?p ?o }';
    // eslint-disable-next-line ts/ban-ts-comment
    // @ts-expect-error 2349
    const queryRes = arrayifyStream(
      await engine.queryQuads(query, { sources: [ './test/statics/data01.ttl' ]}),
    );
    await expect(queryRes)
      .resolves.toMatchObject([
        DF.quad(DF.namedNode('ex:a'), DF.namedNode('ex:p1'), DF.namedNode('ex:o1')),
        DF.quad(DF.namedNode('ex:a'), DF.namedNode('ex:p2'), DF.namedNode('ex:o2')),
      ]);
  });
});
