/* eslint-disable import/no-nodejs-modules -- Components.js is bootstrapped from Node's module resolution */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { ActorExpressionEvaluatorFactory } from '@comunica/bus-expression-evaluator-factory';
import { KeysInitQuery } from '@comunica/context-entries';
import { ActionContext } from '@comunica/core';
import { BindingsFactory } from '@comunica/utils-bindings-factory';
import type * as RDF from '@rdfjs/types';
import { Algebra } from '@traqula/algebra-transformations-1-2';
import { ComponentsManager } from 'componentsjs';
import type { TransformContext } from '../transformContext.js';

/**
 * @fileoverview Static expression evaluation through the Comunica Expression Evaluator.
 *
 * Where {@link utils/partialExpressionEvaluation!constantFoldOperator} hand-folds the handful of operators
 * the pushdown depends on, this pass hands *any* fully static operator expression - `1 + 2`,
 * `CONCAT("a", "b")`, `STRLEN("abc")` - straight to Comunica's reference implementation and writes back the
 * term it evaluates to. `@comunica/utils-algebra` builds its algebra directly on
 * `@traqula/algebra-transformations-1-2`, so the expressions this project already carries can be fed to the
 * evaluator without any conversion.
 *
 * The evaluator is asynchronous, so this is a standalone pass over the algebra rather than a fold inside the
 * synchronous substitution: it may be run over the result of a transformation to collapse the constants it
 * left behind.
 */

/**
 * Operators whose value is not a pure function of their arguments, so they may never be folded away: they
 * must survive to evaluation. Mirrors the contract of {@link constantFoldOperator}.
 */
const NON_DETERMINISTIC = new Set([ 'rand', 'uuid', 'struuid', 'bnode', 'now' ]);

/** The IRI the default Comunica configuration gives its runner. */
const RUNNER_IRI = 'urn:comunica:default:Runner';

let factoryPromise: Promise<ActorExpressionEvaluatorFactory> | undefined;

/**
 * Builds the default Comunica expression evaluator factory, wired with every function actor.
 *
 * The whole runner is instantiated - rather than the factory alone - because the function actors register
 * themselves on their bus as a side effect of being constructed, and the factory reads that bus through a
 * mediator. `@comunica/query-sparql-file` is the module that has all of them installed, so it is used as the
 * root Components.js resolves component descriptions against.
 * @returns the factory, able to build an evaluator for a single expression
 */
async function buildExpressionEvaluatorFactory(): Promise<ActorExpressionEvaluatorFactory> {
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
 * The default Comunica expression evaluator factory, built once and cached.
 * @returns the shared factory
 */
async function getExpressionEvaluatorFactory(): Promise<ActorExpressionEvaluatorFactory> {
  factoryPromise ??= buildExpressionEvaluatorFactory();
  return factoryPromise;
}

/**
 * Whether a term holds no variable anywhere, a triple term being ground only when all of its components are.
 * @param term - The term to inspect
 * @returns whether it is ground
 */
function isGroundTerm(term: RDF.Term): boolean {
  if (term.termType === 'Variable') {
    return false;
  }
  if (term.termType === 'Quad') {
    return isGroundTerm(term.subject) && isGroundTerm(term.predicate) &&
      isGroundTerm(term.object) && isGroundTerm(term.graph);
  }
  return true;
}

/**
 * Whether an expression is a static operator tree the evaluator can fold on its own.
 *
 * Static means it reads nothing from a binding and computes the same value every time: ground terms under
 * deterministic operators only. Everything else - a variable, an `EXISTS`, an aggregate, a custom `NAMED`
 * function, or a non-deterministic operator anywhere in the tree - makes the whole tree non-static, though a
 * static subtree of it may still fold when the walk reaches it.
 * @param expression - The expression to inspect
 * @returns whether it may be evaluated statically
 */
function isStaticEvaluable(expression: Algebra.Expression): boolean {
  switch (expression.subType) {
    case Algebra.ExpressionTypes.TERM:
      return isGroundTerm(expression.term);
    case Algebra.ExpressionTypes.OPERATOR:
      return !NON_DETERMINISTIC.has(expression.operator.toLowerCase()) &&
        expression.args.every(arg => isStaticEvaluable(arg));
    default:
      return false;
  }
}

/**
 * A view of the Comunica expression evaluator factory over a single evaluation context.
 */
interface StaticEvaluator {
  /** Evaluates a static expression, or `undefined` when doing so raises. */
  evaluate: (expression: Algebra.Expression) => Promise<RDF.Term | undefined>;
}

/**
 * Prepares an evaluator over a fresh Comunica action context.
 *
 * Every evaluation shares one query timestamp, so `NOW()` - were it not excluded as non-deterministic -
 * would at least be stable within a pass.
 * @param c - The transformation context, for its data factory
 * @returns an evaluator of static expressions
 */
async function prepareStaticEvaluator(c: TransformContext): Promise<StaticEvaluator> {
  const factory = await getExpressionEvaluatorFactory();
  const bindingsFactory = new BindingsFactory(c.DF);
  const emptyBindings = bindingsFactory.bindings();
  const context = new ActionContext({
    [KeysInitQuery.queryTimestamp.name]: new Date(),
    [KeysInitQuery.dataFactory.name]: c.DF,
    [KeysInitQuery.functionArgumentsCache.name]: {},
  });
  return {
    evaluate: async(expression) => {
      try {
        const action = <Parameters<ActorExpressionEvaluatorFactory['run']>[0]>
          <unknown> { algExpr: expression, context };
        const evaluator = await factory.run(action, undefined);
        // An empty binding: every variable is already substituted out of a static expression.
        return await evaluator.evaluate(emptyBindings);
      } catch {
        // An error is not `false` in every context (`COALESCE(Error, false, true)`), so a raising
        // expression is left standing rather than folded - exactly as {@link constantFoldOperator} does.
        // Falling through yields `undefined`, which the caller reads as "leave this expression standing".
      }
    },
  };
}

/**
 * Folds an expression, replacing each maximal static operator subtree with the term it evaluates to.
 * @param evaluator - The static evaluator
 * @param c - The transformation context
 * @param expression - The expression to fold
 * @returns the folded expression
 */
async function foldExpression(
  evaluator: StaticEvaluator,
  c: TransformContext,
  expression: Algebra.Expression,
): Promise<Algebra.Expression> {
  if (expression.subType === Algebra.ExpressionTypes.OPERATOR && isStaticEvaluable(expression)) {
    const term = await evaluator.evaluate(expression);
    if (term !== undefined) {
      return c.AF.createTermExpression(term);
    }
  }
  // Not (wholly) foldable: descend, so a static subtree of a non-static expression still folds, and the
  // pattern of an EXISTS is walked for constants of its own.
  await walkChildren(evaluator, c, expression);
  return expression;
}

/**
 * Recurses into the child nodes of an algebra node, folding every expression it reaches.
 *
 * Deliberately structural rather than type-directed: it mutates whichever fields hold nested nodes, so an
 * expression is folded wherever the algebra carries one - a `FILTER`, an `EXTEND`, an `ORDER BY` key, the
 * argument of an operator - without enumerating the operations that hold them.
 * @param evaluator - The static evaluator
 * @param c - The transformation context
 * @param node - The node whose children to fold
 */
async function walkChildren(evaluator: StaticEvaluator, c: TransformContext, node: object): Promise<void> {
  for (const [ key, value ] of Object.entries(node)) {
    (<Record<string, unknown>> node)[key] = await walkNode(evaluator, c, value);
  }
}

/**
 * Folds every static expression reachable from an arbitrary algebra value.
 * @param evaluator - The static evaluator
 * @param c - The transformation context
 * @param node - The value to fold within
 * @returns the folded value
 */
async function walkNode(evaluator: StaticEvaluator, c: TransformContext, node: unknown): Promise<unknown> {
  if (node === null || typeof node !== 'object') {
    return node;
  }
  // An RDF term or quad is a leaf, never an algebra node to descend into.
  if ('termType' in node) {
    return node;
  }
  if (Array.isArray(node)) {
    return Promise.all(node.map(element => walkNode(evaluator, c, element)));
  }
  if ((<{ type?: unknown }> node).type === Algebra.Types.EXPRESSION) {
    return foldExpression(evaluator, c, <Algebra.Expression> node);
  }
  await walkChildren(evaluator, c, node);
  return node;
}

/**
 * Evaluates every static expression in an operation through the Comunica Expression Evaluator, replacing it
 * with the term it evaluates to.
 *
 * This is the asynchronous counterpart to {@link constantFoldOperator}: run it over a rewritten operation to
 * collapse the constant expressions the rewriting produced - `1 + 2` into `3`, `CONCAT("a", "b")` into
 * `"ab"`. Expressions that read a binding, contain an `EXISTS` or a non-deterministic operator, or raise
 * when evaluated are left untouched, so the result is equivalent to the input under SPARQL's semantics.
 *
 * The operation is folded in place and also returned.
 * @param c - The transformation context
 * @param operation - The operation to simplify
 * @returns the operation with its static expressions folded
 */
export async function simplifyStaticExpressions<T extends Algebra.Operation>(
  c: TransformContext,
  operation: T,
): Promise<T> {
  const evaluator = await prepareStaticEvaluator(c);
  return <T> await walkNode(evaluator, c, operation);
}
