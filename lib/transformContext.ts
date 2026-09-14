/* eslint-disable jsdoc/check-param-names */
import { toAlgebra } from '@traqula/algebra-sparql-1-2';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { AlgebraFactory } from '@traqula/algebra-transformations-1-2';
import type { Generator } from '@traqula/generator-sparql-1-2';
import { Parser } from '@traqula/parser-sparql-1-2';
import { AstFactory, AstTransformer } from '@traqula/rules-sparql-1-2';
import { DataFactory } from 'rdf-data-factory';
import { ClusterSolver } from './ClusterSolver.js';
import { MyGenerator } from './generator/generator.js';
import { isRdfTerm } from './utils/typeGuards.js';

/**
 * The factories and the solver every transformation works through.
 *
 * It holds no mapping: a mapping reaches the one pass that needs it through the closure
 * {@link transformations/unfolding!unfoldingTransformation} creates. It is built fresh per rewrite, the
 * {@link ClusterSolver} being stateful and the pipeline asynchronous.
 */
export interface TransformationContext {
  /** SPARQL parser for parsing query strings */
  parser: Parser;
  /** SPARQL generator for converting algebra back to query strings */
  generator: Generator;
  /** Factory for creating AST nodes */
  astFactory: AstFactory;
  /** Factory for creating algebra operations and expressions */
  AF: AlgebraFactory;
  /** RDF data factory for creating terms */
  DF: DataFactory;
  /** Transformer for traversing and modifying AST/algebra structures */
  astTransformer: AstTransformer;
  /** Solver for variable clustering and unification during rewriting */
  clusterSolver: ClusterSolver;
}

/**
 * Parses a SPARQL query string into its algebra representation, in quad mode and with blank nodes converted
 * to variables.
 * @param context - Object containing the parser
 * @param query - SPARQL query string to parse
 * @returns the parsed algebra operation
 */
export function parseQuery(
  { parser }: Pick<TransformationContext, 'parser'>,
  query: string,
): Algebra.Operation {
  const ast = parser.parse(query);
  return <Algebra.Construct> toAlgebra(ast, { quads: true, blankToVariable: true });
}

/**
 * Prefixes all variable names in an operation, so that patterns combined later cannot collide.
 * @param context - Object containing astTransformer and DF
 * @param obj - The object to transform
 * @param prefix - The prefix to add to all variable names
 * @returns the object with all variables prefixed
 */
export function prefixVarsInOperation<T extends object>(
  { astTransformer, DF }: Pick<TransformationContext, 'astTransformer' | 'DF'>,
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
 * Creates a {@link TransformationContext} with a solver of its own, one rewrite's worth of state.
 * @returns the context
 */
export function createTransformationContext(): TransformationContext {
  return {
    parser: new Parser(),
    generator: new MyGenerator(),
    astFactory: new AstFactory(),
    AF: new AlgebraFactory(),
    DF: new DataFactory(),
    astTransformer: new AstTransformer(),
    clusterSolver: new ClusterSolver(),
  };
}
