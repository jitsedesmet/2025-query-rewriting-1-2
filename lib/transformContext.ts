/* eslint-disable jsdoc/check-param-names */
import type * as RDF from '@rdfjs/types';
import { toAlgebra } from '@traqula/algebra-sparql-1-2';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { Generator } from '@traqula/generator-sparql-1-2';
import { Parser } from '@traqula/parser-sparql-1-2';
import { AstFactory, AstTransformer } from '@traqula/rules-sparql-1-2';
import { DataFactory } from 'rdf-data-factory';
import { AlgebraTemplateFactory } from './AlgebraTemplateFactory.js';
import { ClusterSolver } from './ClusterSolver.js';
import { MyGenerator } from './generator/generator.js';
import type { Mapping, MappingHead, Template } from './types.js';
import { isRdfTerm, templateToExpr } from './utils.js';

/**
 * The context object passed through all transformation operations.
 * Contains all necessary factories, parsers, and the active mappings.
 */
export interface TransformContext {
  /** SPARQL parser for parsing query strings */
  parser: Parser;
  /** SPARQL generator for converting algebra back to query strings */
  generator: Generator;
  /** Factory for creating AST nodes */
  astFactory: AstFactory;
  /** Extended algebra factory with template creation methods */
  AF: AlgebraTemplateFactory;
  /** RDF data factory for creating terms */
  DF: DataFactory;
  /** Transformer for traversing and modifying AST/algebra structures */
  astTransformer: AstTransformer;
  /** Solver for variable clustering and unification during rewriting */
  clusterSolver: ClusterSolver;
  /** The active mapping to apply during transformation */
  mapper: Mapping;
}

/**
 * Parses a SPARQL query string into algebra representation.
 * Enables quad mode and converts blank nodes to variables.
 * @param context - Object containing the parser
 * @param query - SPARQL query string to parse
 * @returns The parsed algebra operation
 */
export function parseQuery(
  { parser }: Pick<TransformContext, 'parser'>,
  query: string,
): Algebra.Operation {
  const ast = parser.parse(query);
  return <Algebra.Construct> toAlgebra(ast, { quads: true, blankToVariable: true });
}

/**
 * Prefixes all variable names in an operation with the given prefix.
 * Used to avoid variable name collisions when combining multiple patterns.
 * @param context - Object containing astTransformer and DF
 * @param obj - The object to transform
 * @param prefix - The prefix to add to all variable names
 * @returns The object with all variables prefixed
 */
export function prefixVarsInOperation<T extends object>(
  { astTransformer, DF }: Pick<TransformContext, 'astTransformer' | 'DF'>,
  obj: T,
  prefix: string,
): T {
  return <T> astTransformer.transformObject(obj, (obj) => {
    if (isRdfTerm(obj) && obj.termType === 'Variable') {
      return DF.variable(prefix + (obj).value);
    }
    // Values.bindings uses string keys for variable names — rename those too.
    if ('type' in obj && obj.type === 'values' && 'bindings' in obj) {
      const valuesOp = <Algebra.Values> obj;
      valuesOp.bindings = valuesOp.bindings.map(binding => Object.fromEntries(
        Object.entries(binding).map(([ key, value ]) => [ prefix + key, value ]),
      ));
    }
    return obj;
  });
}

/**
 * Prefixes all variables in a mapping (both head and body) with the given prefix.
 * @param c - Partial context with astTransformer and DF
 * @param mapping - The mapping to transform
 * @param prefix - The prefix to add (e.g., "m0_" for first mapper)
 * @returns A new mapping with all variables prefixed
 */
export function prefixMappingVars(
  c: Pick<TransformContext, 'astTransformer' | 'DF'>,
  mapping: Mapping,
  prefix: string,
): Mapping {
  return {
    head: prefixVarsInOperation(c, mapping.head, prefix),
    body: prefixVarsInOperation(c, mapping.body, prefix),
  };
}

/**
 * Converts a SPARQL CONSTRUCT query string into a Mapping object.
 *
 * The CONSTRUCT query must have exactly one triple in the template (head).
 * The WHERE clause becomes the mapping body, wrapped in a projection of
 * the variables used in the head.
 *
 * @param context - Partial context with parser, AF, and astTransformer
 * @param constructQuery - SPARQL CONSTRUCT query string
 * @returns A Mapping with the template as head and WHERE clause as body
 * @throws Error if the construct has != 1 template triple
 * @throws Error if the head contains blank nodes
 * @throws Error if the body uses the BNODE() function
 */
export function constructToMapper(
  { parser, AF, astTransformer }: Pick<TransformContext, 'parser' | 'AF' | 'astTransformer'>,
  constructQuery: string,
): Mapping {
  const construct = <Algebra.Construct> parseQuery({ parser }, constructQuery);
  if (construct.template.length !== 1) {
    throw new Error(`Mappers should have only a single mapping head, found ${construct.template.length}:
${JSON.stringify(construct.template, null, 2)}`);
  }
  const head: MappingHead = {
    ...construct.template[0],
    type: 'template',
    subType: 'Quad',
  };
  // Get used vars to create the proper projection
  const usedVars: Record<string, RDF.Variable> = {};
  for (const term of [ head.subject, head.object, head.predicate, head.graph ]) {
    if (term && isRdfTerm(term) && term.termType === 'Variable') {
      usedVars[term.value] = term;
    }
  }
  const body = AF.createProject(construct.input, Object.values(usedVars));
  // Body should not call bnode function (you should not create blank nodes in mapping body)
  algebraUtils.visitOperationSub(body, {}, {
    expression: { operator: {
      visitor: (operatorExpression) => {
        if (operatorExpression.operator === 'bnode') {
          throw new Error('BNODE function cannot be used in mapping body');
        }
      },
    }},
    // Mapping body may contain any path
  });
  // Fail if mapping head contains a BlankNode (only blank node templates are allowed!)
  astTransformer.visitObject(head, (object) => {
    if ('termType' in object && (<RDF.Term> object).termType === 'BlankNode') {
      throw new Error('Mapping head may not contain blank nodes');
    }
  });
  return {
    head,
    body,
  } satisfies Mapping;
}

/**
 * Creates a partial TransformContext without a mapper.
 * Used as a base for creating full contexts with a specific mapper configuration.
 * @returns A context object with all components except the mapper
 */
export function createPartialContext(): Omit<TransformContext, 'mapper'> {
  return {
    parser: new Parser(),
    generator: new MyGenerator(),
    astFactory: new AstFactory(),
    AF: new AlgebraTemplateFactory(),
    DF: new DataFactory(),
    astTransformer: new AstTransformer(),
    clusterSolver: new ClusterSolver(),
  };
}

/**
 * Creates a complete TransformContext from an array of CONSTRUCT query strings.
 * Each CONSTRUCT query becomes a mapper with its variables prefixed (m0_, m1_, etc.).
 *
 * @param mappers - Array of SPARQL CONSTRUCT query strings defining the mappings
 * @returns A complete TransformContext ready for query transformation
 * @example
 * const context = transformContextFromConstructs([
 *   'CONSTRUCT { ?t rdf:reifies <<( ?s ?p ?o )>> } WHERE { ... }',
 *   'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o . FILTER(!isTriple(?o)) }'
 * ]);
 */
export function transformContextFromConstructs(mappers: readonly string[]): TransformContext {
  const partialContext = createPartialContext();
  const algebraMappers = mappers
    .map(constructQuery => constructToMapper(partialContext, constructQuery))
    .map((mapping, index) => prefixMappingVars(partialContext, mapping, `m${index}_`));
  const mapper = mergeMappingsIntoSingle(partialContext, algebraMappers);
  return {
    ...partialContext,
    mapper,
  };
}

/**
 * Merges multiple mappings into a single GAV (Global-As-View) mapping.
 *
 * In a GAV mapping for RDF, a single mapping constructs the global schema (one
 * triples relation).  This function takes an array of mappings — each of which
 * may contain Skolem head functions (TemplateIri, TemplateLiteral, TemplateBlank)
 * — and combines them into one mapping by:
 *
 * 1. Converting every head template in each mapping to a BIND/Extend operation
 *    that binds the constructed value to a canonical variable (`?ms_s`, `?ms_p`, `?ms_o`).
 * 2. Wrapping each mapping body with those BIND expressions to form a branch.
 * 3. Joining all branches using UNION.
 * 4. Projecting the canonical variables in a single mapping body.
 *
 * The resulting mapping has a plain triple-variable head `?ms_s ?ms_p ?ms_o` and
 * carries all Skolem construction logic inside the body as BIND/Extend nodes, making
 * the expressions available for static analysis by downstream optimisation passes.
 *
 * The canonical variable names use the `ms_` prefix (merged-single) to ensure they
 * are recognised as mapping variables by the rewriting algorithm (which relies on
 * variables whose names start with `m`).
 *
 * @param c - Partial context providing the algebra and data factories
 * @param mappings - Array of mappings to merge (should already have prefixed variables,
 *   e.g. via {@link prefixMappingVars})
 * @returns A single Mapping with a variable-only head and a UNION body
 *
 * @example
 * // Given two mappings with Skolem IRIs in the object position (already prefixed):
 * const merged = mergeMappingsIntoSingle(c, prefixedMappings);
 * // merged.head = ?ms_s ?ms_p ?ms_o
 * // merged.body = SELECT ?ms_s ?ms_p ?ms_o WHERE {
 * //   { <body0> BIND(IRI(CONCAT("ex://", STR(?m0_s))) AS ?ms_o) BIND(?m0_p AS ?ms_p) BIND(?m0_s AS ?ms_s) }
 * //   UNION
 * //   { <body1> BIND(IRI(CONCAT("example://", STR(?m1_s))) AS ?ms_o) BIND(?m1_p AS ?ms_p) BIND(?m1_s AS ?ms_s) }
 * // }
 */
export function mergeMappingsIntoSingle(
  c: Pick<TransformContext, 'AF' | 'DF'>,
  mappings: Mapping[],
): Mapping {
  // Canonical variable names use the `ms_` prefix so that the rewriting algorithm
  // (which checks `variable.startsWith('m')`) treats them as mapping variables.
  const sVar = c.DF.variable('ms_s');
  const pVar = c.DF.variable('ms_p');
  const oVar = c.DF.variable('ms_o');

  const branches = mappings.map(({ head, body }) => {
    // Build extends in reverse (object first, then predicate, then subject) so
    // that after wrapping, subject is the outermost extend (first to evaluate).
    let bodyOp: Algebra.Operation = body;
    for (const [ term, canonicalVar ] of <[Template | RDF.Term, RDF.Variable][]>[
      [ head.object, oVar ],
      [ head.predicate, pVar ],
      [ head.subject, sVar ],
    ]) {
      bodyOp = c.AF.createExtend(bodyOp, canonicalVar, templateToExpr(c.AF, c.DF, term));
    }
    return bodyOp;
  });

  let bodyOp: Algebra.Operation;
  if (branches.length === 0) {
    bodyOp = c.AF.createBgp([]);
  } else if (branches.length === 1) {
    bodyOp = branches[0];
  } else {
    bodyOp = c.AF.createUnion(branches, true);
  }

  return {
    head: c.AF.createMappingHead(sVar, pVar, oVar),
    body: c.AF.createProject(bodyOp, [ sVar, pVar, oVar ]),
  };
}
