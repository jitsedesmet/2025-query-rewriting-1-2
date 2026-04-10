/**
 * An in-memory RDF.js Source backed by a single predicate-first (POS) index.
 *
 * Unlike `StreamingTurtleSource`, the entire file is loaded into memory once by
 * calling `await source.load()`.  The implementation avoids N3.Store's three
 * nested index structures (subjects / predicates / objects) by keeping only one:
 *   predicate URI → indices into the flat quad array
 *
 * **Term deduplication**: a `CachingDataFactory` wraps `rdf-data-factory` so that
 * every call to `namedNode`, `blankNode`, or `literal` with the same arguments
 * returns the **same JavaScript object**.  This means the per-quad cost is only
 * the RDF.Quad wrapper (~64 B on V8) plus an 8-byte slot in the flat array, rather
 * than fresh string + object allocations for every occurrence of a repeated URI.
 *
 * **Estimated memory** (63 M quads, 500 K unique terms):
 *   flat quad array   63 M × 8 B  (references)      ≈  504 MB
 *   Quad objects      63 M × 64 B                   ≈  4.0 GB
 *   predicate index   63 M × 8 B  (index numbers)   ≈  504 MB
 *   deduplicated terms 500 K × 80 B                 ≈   40 MB
 *   ─────────────────────────────────────────────────────────
 *   total                                            ≈  5.0 GB
 *
 * This is roughly one-third of N3.Store's three-index memory footprint.
 *
 * **match() behaviour**
 *   • predicate bound   → O(matchCount) via the POS index
 *   • predicate unbound → O(totalQuads) full scan through the flat array
 *
 * Usage:
 *   const src = new PosIndexedTurtleSource(filePath);
 *   await src.load();
 *   // pass to Comunica as { type: 'rdfjs', value: src }
 */

import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type * as RDF from '@rdfjs/types';
import { StreamParser } from 'n3';
import { DataFactory } from 'rdf-data-factory';
import { skolemizeTerm } from './StreamingTurtleSource.js';

// ---------------------------------------------------------------------------
// CachingDataFactory — deduplicates term objects across all parsed quads.
//
// V8's Map has a hard maximum size of ~16.7 M entries (2^24 − 1).  Large
// datasets such as BKR-Reification (168 M quads, tens of millions of unique
// IRIs) would exceed this limit and throw a `RangeError: Map maximum size
// exceeded`.  We therefore stop inserting into the cache once it reaches
// MAX_CACHE_SIZE and fall back to fresh object creation for any term beyond
// that point.  Common terms (rdf:*, xsd:*, shared property/entity IRIs) are
// loaded first and will always be cached; the long-tail unique statement
// subjects are where deduplication stops helping anyway.
// ---------------------------------------------------------------------------

const MAX_CACHE_SIZE = 15_000_000;

class CachingDataFactory {
  private readonly inner = new DataFactory({ blankNodePrefix: '' });
  private readonly cache = new Map<string, RDF.Term>();

  public namedNode(iri: string): RDF.NamedNode {
    const key = `n\0${iri}`;
    const cached = <RDF.NamedNode | undefined> this.cache.get(key);
    if (cached) {
      return cached;
    }
    const t = this.inner.namedNode(iri);
    if (this.cache.size < MAX_CACHE_SIZE) {
      this.cache.set(key, t);
    }
    return t;
  }

  public blankNode(id?: string): RDF.BlankNode {
    if (id === undefined) {
      return this.inner.blankNode();
    }
    const key = `b\0${id}`;
    const cached = <RDF.BlankNode | undefined> this.cache.get(key);
    if (cached) {
      return cached;
    }
    const t = this.inner.blankNode(id);
    if (this.cache.size < MAX_CACHE_SIZE) {
      this.cache.set(key, t);
    }
    return t;
  }

  public literal(value: string, langOrDatatype?: string | RDF.NamedNode): RDF.Literal {
    const suffix = typeof langOrDatatype === 'string' ?
      `@${langOrDatatype}` :
        (langOrDatatype ? `^^${langOrDatatype.value}` : '');
    const key = `l\0${value}${suffix}`;
    const cached = <RDF.Literal | undefined> this.cache.get(key);
    if (cached) {
      return cached;
    }
    const t = typeof langOrDatatype === 'string' ?
      this.inner.literal(value, langOrDatatype) :
        (langOrDatatype ?
          this.inner.literal(value, langOrDatatype) :
          this.inner.literal(value));
    if (this.cache.size < MAX_CACHE_SIZE) {
      this.cache.set(key, t);
    }
    return t;
  }

  public quad(
    s: RDF.Quad_Subject,
    p: RDF.Quad_Predicate,
    o: RDF.Quad_Object,
    g?: RDF.Quad_Graph,
  ): RDF.Quad {
    // Quads themselves are not cached — each is unique.
    return this.inner.quad(s, p, o, g);
  }

  public defaultGraph(): RDF.DefaultGraph {
    return this.inner.defaultGraph();
  }

  /** Skolemize any blank-node term using this factory for IRI construction. */
  public skolemize(term: RDF.Term, prefix: string): RDF.Term {
    return skolemizeTerm(term, prefix, this.inner);
  }

  /** Number of deduplicated terms cached. */
  public get cacheSize(): number {
    return this.cache.size;
  }
}

// ---------------------------------------------------------------------------

export class PosIndexedTurtleSource {
  public readonly features = <const>{ quotedTripleFiltering: false };

  private readonly df = new CachingDataFactory();

  /** All quads loaded from the file. */
  private readonly quads: RDF.Quad[] = [];

  /** Predicate URI → array of indices into `quads`. */
  private readonly byPred = new Map<string, number[]>();

  private loaded = false;

  public constructor(
    private readonly filePath: string,
    /**
     * N3.js parser format string (default: `'text/turtle'`).
     * Use `'text/n3'` for files that contain blank-node predicates.
     */
    private readonly format = 'text/turtle',
    /**
     * When `true`, blank nodes are replaced with Skolem IRIs during loading.
     * The Skolem prefix is `{skolemPrefix}{blankNodeId}`.
     */
    private readonly skolemize = false,
    /** IRI prefix used when `skolemize` is `true`. */
    private readonly skolemPrefix = 'urn:bkr:blank:',
  ) {}

  /** Load the file into memory.  Must be called before `match()`. */
  public async load(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const parser = new StreamParser({

        factory: <any> this.df,
        blankNodePrefix: '',
        format: this.format,
      });

      createReadStream(this.filePath)
        .on('error', reject)
        .pipe(parser);

      parser.on('error', reject);
      parser.on('data', (quad: RDF.Quad) => {
        const q = this.skolemize ? this.skolemizeQuad(quad) : quad;
        const idx = this.quads.length;
        this.quads.push(q);

        const predKey = q.predicate.value;
        let idxList = this.byPred.get(predKey);
        if (!idxList) {
          idxList = [];
          this.byPred.set(predKey, idxList);
        }
        idxList.push(idx);
      });

      parser.on('end', () => {
        this.loaded = true;
        process.stdout.write(
          `[PosIndexedTurtleSource] Loaded ${this.quads.length.toLocaleString()} quads, ` +
          `${this.byPred.size} unique predicates, ` +
          `${this.df.cacheSize} deduplicated terms\n`,
        );
        resolve();
      });
    });
  }

  public match(
    subject?: RDF.Term | null,
    predicate?: RDF.Term | null,
    object?: RDF.Term | null,
    graph?: RDF.Term | null,
  ): RDF.Stream<RDF.Quad> & NodeJS.EventEmitter {
    if (!this.loaded) {
      throw new Error('PosIndexedTurtleSource.load() must be awaited before match()');
    }

    const readable = new Readable({ objectMode: true });

    // Gather matching quads synchronously, then push asynchronously.
    process.nextTick(() => {
      try {
        if (predicate) {
          // Fast path: use the predicate index.
          const indices = this.byPred.get(predicate.value) ?? [];
          for (const idx of indices) {
            const q = this.quads[idx];
            if (
              (!subject || q.subject.equals(subject)) &&
              (!object || q.object.equals(object)) &&
              (!graph || q.graph.equals(graph))
            ) {
              readable.push(q);
            }
          }
        } else {
          // Full scan: iterate the flat quad array.
          for (const q of this.quads) {
            if (
              (!subject || q.subject.equals(subject)) &&
              (!object || q.object.equals(object)) &&
              (!graph || q.graph.equals(graph))
            ) {
              readable.push(q);
            }
          }
        }
        readable.push(null);
      } catch (err) {
        readable.destroy(<Error>err);
      }
    });

    return <RDF.Stream<RDF.Quad> & NodeJS.EventEmitter><unknown>readable;
  }

  // ---------------------------------------------------------------------------

  private skolemizeQuad(quad: RDF.Quad): RDF.Quad {
    const s = this.df.skolemize(quad.subject, this.skolemPrefix);
    const p = this.df.skolemize(quad.predicate, this.skolemPrefix);
    const o = this.df.skolemize(quad.object, this.skolemPrefix);
    const g = this.df.skolemize(quad.graph, this.skolemPrefix);
    return this.df.quad(
      <RDF.Quad_Subject>s,
      <RDF.Quad_Predicate>p,
      <RDF.Quad_Object>o,
      <RDF.Quad_Graph>g,
    );
  }
}
