/**
 * Maps BKR-star.ttl to four target representations by executing SPARQL CONSTRUCT queries.
 *
 * Outputs written to the same directory as this script:
 *   BKR-Graph.trig        — named-graph representation        (mapToGraph-Q1/Q2)
 *   BKR-Reification.ttl   — RDF 1.1 reification pattern       (mapToReification-Q1/Q2)
 *   BKR-Singleton.ttl     — singleton-property pattern         (mapToSingleton-Q1/Q2)
 *   BKR-WikiData.ttl      — Wikidata-style n-ary pattern       (mapToWikiData-Q1/Q2)
 *
 * Usage:
 *   npx tsx map-bkr-star.ts
 */

import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryEngine } from '@comunica/query-sparql-file';
import type * as RDF from '@rdfjs/types';
import { Writer } from 'n3';
import { DataFactory } from 'rdf-data-factory';
import { termToString } from 'rdf-string';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DF = new DataFactory();
const engine = new QueryEngine();
const source = resolve(__dirname, 'BKR-star.ttl');

/**
 * Extension function `<internal://bnode>`.
 *
 * Given any number of RDF term arguments, returns a blank node that is:
 *  - the same blank node every time the identical combination of arguments is seen, and
 *  - a fresh blank node the first time a new combination is encountered.
 *
 * The cache is intentionally global so that a single blank node is produced per unique
 * argument combination across the entire mapping run.
 */
const bnodeCache = new Map<string, RDF.BlankNode>();
let bnodeCounter = 0;

function cachedBnode(args: RDF.Term[]): RDF.BlankNode {
  // Build a collision-resistant key from termType + value of each argument.
  const key = args.map(t => `${t.termType}\x00${termToString(t)}`).join('\x01');
  let bnode = bnodeCache.get(key);
  if (!bnode) {
    bnode = DF.blankNode(`b${bnodeCounter++}`);
    bnodeCache.set(key, bnode);
  }
  return bnode;
}

const extensionFunctions: Record<string, (args: RDF.Term[]) => Promise<RDF.Term>> = {
  'internal://bnode': async(args: RDF.Term[]): Promise<RDF.Term> => cachedBnode(args),
};

// ---------------------------------------------------------------------------

interface MappingSpec {
  name: string;
  queries: readonly string[];
  output: string;
  /** N3 Writer format string, e.g. 'text/turtle' or 'application/trig'. */
  format: string;
  context?: Record<string, unknown>;
}

const mappings: MappingSpec[] = [
  // {
  //   name: 'mapToGraph',
  //   queries: [ 'mapToGraph-Q1.rq', 'mapToGraph-Q2.rq' ],
  //   // Q1 places triples inside named graphs; TriG is required to represent them.
  //   output: 'BKR-Graph.trig',
  //   format: 'application/trig',
  // },
  {
    name: 'mapToReification',
    queries: [ 'mapToReification-Q1.rq', 'mapToReification-Q2.rq' ],
    output: 'BKR-Reification.ttl',
    format: 'text/turtle',
  },
  {
    name: 'mapToSingleton',
    queries: [ 'mapToSingleton-Q1.rq', 'mapToSingleton-Q2.rq' ],
    output: 'BKR-Singleton.ttl',
    format: 'text/turtle',
  },
  {
    name: 'mapToWikiData',
    queries: [ 'mapToWikiData-Q1.rq', 'mapToWikiData-Q2.rq' ],
    output: 'BKR-WikiData.ttl',
    format: 'text/turtle',
    // Provide the <internal://bnode> extension function used in mapToWikiData-Q1.rq.
    context: { extensionFunctions },
  },
];

// ---------------------------------------------------------------------------

async function executeMapping(spec: MappingSpec): Promise<void> {
  const { name, queries, output, format, context = {}} = spec;
  const outputPath = resolve(__dirname, output);
  const outStream = createWriteStream(outputPath);
  const writer = new Writer(outStream, { format });

  process.stdout.write(`[${name}] Starting → ${output}\n`);
  let totalQuads = 0;

  for (const queryFile of queries) {
    const queryPath = resolve(__dirname, queryFile);
    const query = await readFile(queryPath, 'utf-8');
    process.stdout.write(`[${name}] Executing ${queryFile}...\n`);

    const quadStream = await engine.queryQuads(query, {
      sources: [ source ],
      ...context,
    });

    quadStream.on('data', (quad) => {
      writer.addQuad(quad);
      if (++totalQuads % 100_000 === 0) {
        process.stdout.write(`\r[${name}] ${totalQuads.toLocaleString()} quads written...`);
      }
    });
    await new Promise((resolve, reject) => {
      quadStream.on('done', resolve);
      quadStream.on('error', reject);
    });
  }

  if (totalQuads >= 100_000) {
    // Overwrite the in-progress line with the final count.
    process.stdout.write('\r');
  }

  await new Promise<void>((res, rej) => {
    writer.end(error => (error ? rej(error) : res()));
  });

  process.stdout.write(`[${name}] Done — ${totalQuads.toLocaleString()} quads → ${output}\n`);
}

// ---------------------------------------------------------------------------

for (const mapping of mappings) {
  await executeMapping(mapping);
}

process.stdout.write('All mappings complete.\n');
