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
import { isStaticExpression } from './expressionHelpers.js';

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

/** The IRI the default Comunica configuration gives its runner. */
const RUNNER_IRI = 'urn:comunica:default:Runner';

/** An expression carrying the metadata this pass memoizes on it: static-ness and a collected-subtree id. */
type TaggedExpression = Algebra.Expression & { metadata?: { isStatic?: boolean; staticId?: number }};

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
 * Whether an expression reads `NOW()` anywhere within it.
 * @param expression - The expression to inspect
 * @returns whether the current time is read
 */
function readsCurrentTime(expression: Algebra.Expression): boolean {
  let readsNow = false;
  algebraUtils.visitOperationSub(expression, {}, { expression: { operator: { preVisitor: (operator) => {
    if (operator.operator === 'now') {
      readsNow = true;
      return { shortcut: true };
    }
    return {};
  } }}});
  return readsNow;
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

/** Removes this pass's bookkeeping from an expression, dropping the metadata object once it is empty. */
function clearPassMetadata(expression: TaggedExpression): void {
  const { metadata } = expression;
  if (metadata === undefined) {
    return;
  }
  delete metadata.isStatic;
  delete metadata.staticId;
  if (Object.keys(metadata).length === 0) {
    delete expression.metadata;
  }
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

  // Pass 1: memoize static-ness bottom-up (so each operator only reads its arguments' cached flag) and
  // collect the maximal static operator expressions, tagging each with a primitive id that survives the
  // tree copy so pass 2 can recognise it.
  const pending = new Map<number, Algebra.Expression>();
  let nextStaticId = 0;
  const tagged = algebraUtils.mapOperation<'unsafe', T>(operation, {
    expression: { transform: (expression) => {
      if (expression.subType === Algebra.ExpressionTypes.OPERATOR && isStaticExpression(expression, true)) {
        for (const argument of expression.args) {
          const argumentId = (<TaggedExpression> argument).metadata?.staticId;
          // A static argument was tagged during its own visit; only the outermost static operator folds.
          if (argumentId !== undefined) {
            pending.delete(argumentId);
          }
        }
        const id = nextStaticId++;
        ((<TaggedExpression> expression).metadata ??= {}).staticId = id;
        pending.set(id, expression);
      }
      return expression;
    } },
  });

  // Evaluate the collected expressions in parallel. `NOW()` is static but its value is only known at
  // execution time, so a subtree reading it is left standing, as is one that raises.
  const foldedTerms = new Map<number, RDF.Term>();
  await Promise.all([ ...pending ].map(async([ id, expression ]) => {
    if (readsCurrentTime(expression)) {
      return;
    }
    const term = await evaluate(expression);
    if (term !== undefined) {
      foldedTerms.set(id, term);
    }
  }));

  // Pass 2: replace every tagged-and-evaluated expression with its term, and strip the bookkeeping left on
  // the expressions that stayed.
  return algebraUtils.mapOperation<'unsafe', T>(tagged, {
    expression: { transform: (expression) => {
      const annotated = <TaggedExpression> expression;
      const id = annotated.metadata?.staticId;
      const term = id === undefined ? undefined : foldedTerms.get(id);
      if (term !== undefined) {
        return c.AF.createTermExpression(term);
      }
      clearPassMetadata(annotated);
      return expression;
    } },
  });
}
