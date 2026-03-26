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
import type { Mapping, MappingHead } from './types.js';
import { isRdfTerm } from './utils.js';

/**
 * Shared context object that is threaded through every transformation step.
 *
 * It bundles all stateless factories and the stateful {@link ClusterSolver}
 * together with the list of active {@link Mapping} rules so that individual
 * transformation functions do not need to accept them as separate parameters.
 */
export interface TransformContext {
  /** SPARQL parser used to turn query strings into an AST. */
  parser: Parser;
  /** SPARQL generator used to serialise algebra back to a query string. */
  generator: Generator;
  /** AST node factory for the traqula SPARQL grammar. */
  astFactory: AstFactory;
  /** Extended algebra factory that also creates template nodes. */
  AF: AlgebraTemplateFactory;
  /** RDF/JS data factory for creating terms. */
  DF: DataFactory;
  /** AST/algebra object transformer used for deep structural rewrites. */
  astTransformer: AstTransformer;
  /**
   * Stateful solver that tracks variable-to-group clusters during the
   * rewriting of a single triple pattern.  It must be cleared before each
   * call to {@link rewriteSinglePattern}.
   */
  clusterSolver: ClusterSolver;
  /** The mapping rules whose heads are matched against the user query patterns. */
  mappers: Mapping[];
}

/**
 * Parse the query and change each variable by prefixing it with prefix
 *
 * @param context - Partial context containing the SPARQL parser.
 * @param query   - The SPARQL query string to parse.
 * @returns The root algebra operation for the parsed query.
 */
export function parseQuery(
  { parser }: Pick<TransformContext, 'parser'>,
  query: string,
): Algebra.Operation {
  const ast = parser.parse(query);
  return <Algebra.Construct> toAlgebra(ast, { quads: true, blankToVariable: true });
}

/**
 * Deep-walks `obj` and returns a copy where every {@link RDF.Variable} has its
 * `value` prepended with `prefix`.
 *
 * This is used to namespace the variables of the user query (prefix `uq_`) and
 * each mapping rule (prefix `m<index>_`) so that they never collide with each
 * other during rewriting.
 *
 * @param context   - Partial context providing the AST transformer and data factory.
 * @param obj       - The object (algebra node, term, …) to transform.
 * @param prefix    - The string to prepend to every variable name.
 * @returns A new object of the same type with renamed variables.
 */
export function prefixVarsInOperation<T extends object>(
  { astTransformer, DF }: Pick<TransformContext, 'astTransformer' | 'DF'>,
  obj: T,
  prefix: string,
): T {
  return <T> astTransformer.transformObject(obj, (obj) => {
    if (isRdfTerm(obj) && obj.termType === 'Variable') {
      return DF.variable(prefix + obj.value);
    }
    return obj;
  });
}

/**
 * Returns a copy of `mapping` with all variables in both the head and body
 * prefixed with `prefix` via {@link prefixVarsInOperation}.
 *
 * @param c       - Partial context providing the AST transformer and data factory.
 * @param mapping - The mapping rule to rename.
 * @param prefix  - The prefix to apply to every variable name.
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
 * Parses a SPARQL `CONSTRUCT` query and converts it into a {@link Mapping} rule.
 *
 * Restrictions enforced at parse time:
 * - The template must contain exactly one triple pattern (the mapping head).
 * - The mapping body may not call the `BNODE()` function.
 * - The mapping head may not contain blank nodes (only blank-node *templates* are allowed).
 *
 * The body is projected to only the variables that appear in the head.
 *
 * @param context        - Partial context providing the parser, algebra factory, and AST transformer.
 * @param constructQuery - A SPARQL `CONSTRUCT … WHERE { … }` query string.
 * @returns A {@link Mapping} with the parsed head template and body projection.
 * @throws If the template has ≠ 1 triple, if `BNODE()` appears in the body, or if the head
 *         contains a literal blank node.
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
  // Get used vars to create the propper projection
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
 * Creates a {@link TransformContext} without the `mappers` field.
 *
 * Useful when you need a context for helper operations (e.g. parsing individual
 * mapping queries) before all mappings are available.
 *
 * @returns A partial context with fresh instances of all factories and solvers.
 */
export function createPartialContext(): Omit<TransformContext, 'mappers'> {
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
 * Builds a complete {@link TransformContext} from an array of SPARQL `CONSTRUCT`
 * query strings.
 *
 * Each query is parsed via {@link constructToMapper} and then has its variables
 * prefixed with `m<index>_` via {@link prefixMappingVars} to avoid name collisions.
 *
 * @param mappers - Array of SPARQL `CONSTRUCT … WHERE { … }` query strings.
 * @returns A fully initialised {@link TransformContext} ready for query rewriting.
 */
export function transformContextFromConstructs(mappers: readonly string[]): TransformContext {
  const partialContext = createPartialContext();
  const algebraMappers = mappers
    .map(constructQuery => constructToMapper(partialContext, constructQuery))
    .map((mapping, index) => prefixMappingVars(partialContext, mapping, `m${index}_`));
  return {
    mappers: algebraMappers,
    ...partialContext,
  };
}
