/**
 * Maps BKR-star.ttl to four target representations by executing SPARQL CONSTRUCT queries.
 *
 * Outputs written to the same directory as this script:
 *   BKR-Graph.trig        — named-graph representation        (mapToGraph-Q1/Q2)
 *   BKR-Reification.ttl   — RDF 1.1 reification pattern       (mapToReification-Q1/Q2)
 *   BKR-Singleton.ttl     — singleton-property pattern         (mapToSingleton-Q1/Q2)
 *   BKR-WikiData.ttl      — Wikidata-style n-ary pattern       (mapToWikiData-Q1/Q2)
 *
 * Performance: instead of re-reading the source file from disk for every SPARQL
 * pattern-match call, the entire source is loaded into memory once using
 * `PosIndexedTurtleSource`.  A single predicate-indexed in-memory store is then
 * shared across all queries and all mappings, running in one process.
 *
 * Output is written in a streaming fashion: each quad is serialised and flushed to
 * disk as it arrives from the SPARQL engine — no output is buffered in memory.
 *
 * Memory: the script requires ~20 GiB of heap.  It will automatically re-exec
 * itself with `--max-old-space-size=20480` if that flag is not already present.
 *
 * Usage:
 *   npx tsx mapBkrStar.ts
 */

import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryEngine } from '@comunica/query-sparql-file';
import type * as RDF from '@rdfjs/types';
import { Writer } from 'n3';
import { DataFactory } from 'rdf-data-factory';
import { termToString } from 'rdf-string';
import { PosIndexedTurtleSource } from './PosIndexedTurtleSource.js';
import { skolemizeTerm } from './StreamingTurtleSource.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DF = new DataFactory();
const skolemDF = new DataFactory({ blankNodePrefix: '' });
const SKOLEM_PREFIX = 'urn:bkr:blank:';
const sourcePath = resolve(__dirname, 'BKR-star.ttl');

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
    // Singleton properties are blank nodes used as predicates, which requires N3 format.
    format: 'text/n3',
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

async function executeMapping(spec: MappingSpec, rdfjsSource: PosIndexedTurtleSource): Promise<void> {
  const { name, queries, output, format, context = {}} = spec;
  const outputPath = resolve(__dirname, output);
  const outStream = createWriteStream(outputPath);
  const writer = new Writer(outStream, { format });
  const engine = new QueryEngine();

  process.stdout.write(`[${name}] Starting → ${output}\n`);
  let totalQuads = 0;

  for (const queryFile of queries) {
    const queryPath = resolve(__dirname, queryFile);
    const query = await readFile(queryPath, 'utf-8');
    process.stdout.write(`[${name}] Executing ${queryFile}...\n`);

    const quadStream = await engine.queryQuads(query, {
      sources: [{ type: 'rdfjs', value: rdfjsSource }],
      ...context,
    });

    // Consume the quad stream with backpressure: pause the source while the
    // underlying file-write stream is draining so quads don't pile up in memory.
    await new Promise<void>((res, rej) => {
      quadStream.on('error', rej);
      quadStream.on('data', (quad: RDF.Quad) => {
        // Skolemize blank nodes so the output files contain no blank nodes.
        // The rewriting algorithm assumes datasets are blank-node free.
        const s = skolemizeTerm(quad.subject, SKOLEM_PREFIX, skolemDF);
        const p = skolemizeTerm(quad.predicate, SKOLEM_PREFIX, skolemDF);
        const o = skolemizeTerm(quad.object, SKOLEM_PREFIX, skolemDF);
        const g = skolemizeTerm(quad.graph, SKOLEM_PREFIX, skolemDF);
        writer.addQuad(skolemDF.quad(
          <RDF.Quad_Subject>s,
          <RDF.Quad_Predicate>p,
          <RDF.Quad_Object>o,
          <RDF.Quad_Graph>g,
        ));

        if (++totalQuads % 100_000 === 0) {
          process.stdout.write(`\r[${name}] ${totalQuads.toLocaleString()} quads written...`);
        }
      });
      quadStream.on('end', () => res());
    });
  }

  if (totalQuads >= 100_000) {
    process.stdout.write('\r');
  }

  await new Promise<void>((res, rej) => {
    writer.end(error => (error ? rej(error) : res()));
  });

  process.stdout.write(`[${name}] Done — ${totalQuads.toLocaleString()} quads → ${output}\n`);
}

// ---------------------------------------------------------------------------
// Entry point: re-exec with 20 GiB heap when the flag is absent, then load the
// source once and run all mappings sequentially in this process.
// ---------------------------------------------------------------------------

const HEAP_MB = 20_480;
const heapFlag = `--max-old-space-size=${HEAP_MB}`;

if (!process.execArgv.some(a => a.startsWith('--max-old-space-size='))) {
  process.stdout.write(`Re-execing with ${heapFlag}...\n`);
  const result = spawnSync(
    process.execPath,
    [ heapFlag, ...process.execArgv, process.argv[1], ...process.argv.slice(2) ],
    { stdio: 'inherit' },
  );
  // eslint-disable-next-line unicorn/no-process-exit
  process.exit(result.status ?? 1);
}

// Load the source into memory once; it is shared across all mappings.
process.stdout.write(`Loading source: ${sourcePath}\n`);
const rdfjsSource = new PosIndexedTurtleSource(sourcePath, 'text/turtle', true, SKOLEM_PREFIX);
await rdfjsSource.load();

for (const mapping of mappings) {
  await executeMapping(mapping, rdfjsSource);
}

process.stdout.write('\nAll mappings complete.\n');
