/**
 * @fileoverview SPARQL Query Rewriting for RDF 1.2 over RDF 1.1
 *
 * This package provides tools for rewriting SPARQL 1.2 queries (which may contain
 * triple terms and other RDF 1.2 features) into equivalent SPARQL 1.1 queries that
 * can be executed against RDF 1.1 data sources.
 *
 * ## Key Concepts
 *
 * **Mappings**: SPARQL CONSTRUCT queries that define how RDF 1.2 data is represented
 * in RDF 1.1. The CONSTRUCT template (head) shows the RDF 1.2 pattern, and the WHERE
 * clause (body) shows the equivalent RDF 1.1 representation.
 *
 * **Query Rewriting**: Each triple pattern in the user's query is rewritten to a
 * UNION of subselects, one for each mapping that could produce matching data.
 *
 * ## Usage
 *
 * ```typescript
 * import { transformContextFromConstructs, queryTransform, operationTransform } from 'query-rewriting-1-2';
 *
 * const context = transformContextFromConstructs([
 *   'CONSTRUCT { ?t rdf:reifies <<( ?s ?p ?o )>> } WHERE { ... RDF 1.1 pattern ... }'
 * ]);
 *
 * const rewrittenQuery =
 *   queryTransform(context, 'SELECT * WHERE { ?x rdf:reifies <<( ?s ?p ?o )>> }', [operationTransform]);
 * ```
 *
 * @module query-rewriting-1-2
 * @see {@link https://w3c.github.io/rdf-interop/spec/} RDF 1.2 Interoperability Spec
 */
export * from './transformations/index.js';
