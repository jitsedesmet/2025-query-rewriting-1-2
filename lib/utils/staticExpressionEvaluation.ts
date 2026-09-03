/* eslint-disable import/no-nodejs-modules -- Components.js is bootstrapped from Node's module resolution */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { ActorExpressionEvaluatorFactory } from '@comunica/bus-expression-evaluator-factory';
import { KeysInitQuery } from '@comunica/context-entries';
import { ActionContext } from '@comunica/core';
import { BindingsFactory } from '@comunica/utils-bindings-factory';
import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import { ComponentsManager } from 'componentsjs';
import type { TransformContext } from '../transformContext.js';
import { termIsStaticTerm } from './typeGuards.js';

/**
 * @fileoverview Folds fully static expressions through Comunica's Expression Evaluator.
 *
 * Where {@link utils/partialExpressionEvaluation!constantFoldOperator} hand-folds the few operators the
 * pushdown depends on, this pass hands *any* static operator expression - `1 + 2`, `CONCAT("a", "b")`,
 * `STRLEN("abc")` - to Comunica's reference implementation and writes back the term it evaluates to.
 * `@comunica/utils-algebra` builds its algebra directly on `@traqula/algebra-transformations-1-2`, so this
 * project's expressions can be fed to the evaluator without conversion. The evaluator is asynchronous, hence
 * a standalone pass rather than a fold inside the synchronous substitution.
 */

/** Operators whose value is not a pure function of their arguments and so may never be folded away. */
const NON_DETERMINISTIC_OPERATORS = new Set([ 'rand', 'uuid', 'struuid', 'bnode', 'now' ]);

/** The IRI the default Comunica configuration gives its runner. */
const RUNNER_IRI = 'urn:comunica:default:Runner';

/** An expression carrying the metadata this pass memoizes on it. */
type MetadataExpression = Algebra.Expression & { metadata?: { isStatic?: boolean; staticId?: number }};

let factoryPromise: Promise<ActorExpressionEvaluatorFactory> | undefined;

/**
 * Builds the default Comunica expression evaluator factory, wired with every function actor.
 * @returns the factory, able to build an evaluator for a single expression
 */
async function buildExpressionEvaluatorFactory(): Promise<ActorExpressionEvaluatorFactory> {
  // The whole runner is instantiated - not the factory alone - because the function actors register on
  // their bus as a side effect of construction, and the factory reads that bus through a mediator.
  // `@comunica/query-sparql-file` is the module that has all of them installed.
  const require = createRequire(join(process.cwd(), 'package.json'));
  const mainModulePath = dirname(require.resolve('@comunica/query-sparql-file/package.json'));
  const configPath = require.resolve('@comunica/config-query-sparql/config/config-default.json');

  const manager = await ComponentsManager.build({ mainModulePath, typeChecking: false });
  await manager.configRegistry.register(configPath);
  const runner: { actors: unknown[] } = await manager.instantiate(RUNNER_IRI);
  const factory: unknown = runner.actors.find(actor =>
    typeof (<{ name?: unknown }> actor).name === 'string' &&
    (<{ name: string }> actor).name.includes('expression-evaluator-factory'));
  if (factory === undefined) {
    throw new Error('No expression evaluator factory actor in the default Comunica configuration');
  }
  return <ActorExpressionEvaluatorFactory> factory;
}

/**
 * The default Comunica expression evaluator factory, built once and cached across calls.
 * @returns the shared factory
 */
async function getExpressionEvaluatorFactory(): Promise<ActorExpressionEvaluatorFactory> {
  factoryPromise ??= buildExpressionEvaluatorFactory();
  return factoryPromise;
}

/**
 * Whether an expression is static: it reads nothing from a binding and computes the same value every time.
 * @param expression - The expression to inspect
 * @param memoize - Whether to read and write the result on `expression.metadata.isStatic`
 * @returns whether the expression may be evaluated statically
 */
export function isStaticExpression(expression: Algebra.Expression, memoize = false): boolean {
  const annotated = <MetadataExpression> expression;
  if (memoize && annotated.metadata?.isStatic !== undefined) {
    return annotated.metadata.isStatic;
  }
  let result: boolean;
  switch (expression.subType) {
    case Algebra.ExpressionTypes.TERM:
      result = termIsStaticTerm(expression.term);
      break;
    case Algebra.ExpressionTypes.OPERATOR:
      // Deterministic operator over static arguments only; a single non-static argument taints the tree.
      result = !NON_DETERMINISTIC_OPERATORS.has(expression.operator.toLowerCase()) &&
        expression.args.every(argument => isStaticExpression(argument, memoize));
      break;
    default:
      // EXISTS, aggregates, and NAMED functions read state beyond their arguments.
      result = false;
  }
  if (memoize) {
    (annotated.metadata ??= {}).isStatic = result;
  }
  return result;
}

/**
 * Prepares a function that evaluates a static expression over a fresh, shared Comunica action context.
 * @param c - The transformation context, for its data factory
 * @returns an evaluator returning the resulting term, or `undefined` when evaluation raises
 */
async function prepareStaticEvaluator(
  c: TransformContext,
): Promise<(expression: Algebra.Expression) => Promise<RDF.Term | undefined>> {
  const factory = await getExpressionEvaluatorFactory();
  const emptyBindings = new BindingsFactory(c.DF).bindings();
  const context = new ActionContext({
    [KeysInitQuery.queryTimestamp.name]: new Date(),
    [KeysInitQuery.dataFactory.name]: c.DF,
    [KeysInitQuery.functionArgumentsCache.name]: {},
  });
  return async(expression) => {
    try {
      const action = <Parameters<ActorExpressionEvaluatorFactory['run']>[0]>
        <unknown> { algExpr: expression, context };
      const evaluator = await factory.run(action, undefined);
      // The binding is empty: a static expression has no variable left to substitute.
      return await evaluator.evaluate(emptyBindings);
    } catch {
      // An error is not `false` in every context (`COALESCE(Error, false, true)`), so a raising expression
      // is left standing; falling through yields `undefined`, read by the caller as "leave it standing".
    }
  };
}

/**
 * Folds every static expression in an operation through the Comunica Expression Evaluator, replacing each
 * maximal static operator subtree with the term it evaluates to.
 * @param c - The transformation context
 * @param operation - The operation to simplify
 * @returns a copy of the operation with its static expressions folded
 */
export async function simplifyStaticExpressions<T extends Algebra.Operation>(
  c: TransformContext,
  operation: T,
): Promise<T> {
  const evaluate = await prepareStaticEvaluator(c);

  // Pass 1: memoize static-ness bottom-up and collect the maximal static operator expressions, tagging each
  // with a primitive id that survives the tree copy so pass 2 can recognise it.
  const pending = new Map<number, Algebra.Expression>();
  let nextStaticId = 0;
  const tagged = algebraUtils.mapOperation<'unsafe', T>(operation, {
    expression: { transform: (expression) => {
      if (expression.subType === Algebra.ExpressionTypes.OPERATOR && isStaticExpression(expression, true)) {
        for (const argument of expression.args) {
          const argumentId = (<MetadataExpression> argument).metadata?.staticId;
          // A static argument was queued during its own visit; only the outermost static operator folds.
          if (argumentId !== undefined) {
            pending.delete(argumentId);
          }
        }
        const id = nextStaticId++;
        ((<MetadataExpression> expression).metadata ??= {}).staticId = id;
        pending.set(id, expression);
      }
      return expression;
    } },
  });

  // Evaluate the collected expressions in parallel; a raising one yields no term and is left standing.
  const foldedTerms = new Map<number, RDF.Term>();
  await Promise.all([ ...pending ].map(async([ id, expression ]) => {
    const term = await evaluate(expression);
    if (term !== undefined) {
      foldedTerms.set(id, term);
    }
  }));

  // Pass 2: replace every tagged-and-evaluated expression with the term it evaluated to.
  return algebraUtils.mapOperation<'unsafe', T>(tagged, {
    expression: { transform: (expression) => {
      const id = (<MetadataExpression> expression).metadata?.staticId;
      const term = id === undefined ? undefined : foldedTerms.get(id);
      return term === undefined ? expression : c.AF.createTermExpression(term);
    } },
  });
}
