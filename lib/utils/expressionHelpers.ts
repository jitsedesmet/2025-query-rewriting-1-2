import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import { EXTENSION_FUNCTION_BNODE } from '../consts.js';
import type { TransformContext } from '../transformContext.js';
import { termFalse, termTrue } from './operationhelpers.js';

/**
 * Splits a filter expression on top level logical conjunctions (`&&`), implementing (SDecompI):
 * `FILTER_{R1 && R2}(A) == FILTER_R1(FILTER_R2(A))`.
 * @param expression - The condition to split
 * @param accumulator - The conjuncts collected so far, filled in by the recursion
 * @returns the conjuncts
 */
export function splitConjunction(
  expression: Algebra.Expression,
  accumulator: Algebra.Expression[] = [],
): Algebra.Expression[] {
  if (expression.subType === Algebra.ExpressionTypes.OPERATOR && expression.operator === '&&') {
    for (const agg of expression.args) {
      splitConjunction(agg, accumulator);
    }
  } else {
    accumulator.push(expression);
  }
  return accumulator;
}

/**
 * Combines a non-empty list of expressions into a single conjunction (`&&`).
 * @param c - The transformation context
 * @param expressions - The conjuncts to combine
 * @returns the conjunction
 */
export function conjunctionOf(c: TransformContext, expressions: Algebra.Expression[]): Algebra.Expression {
  return expressions.reduce((acc, expr) => c.AF.createOperatorExpression('&&', [ acc, expr ]));
}

/**
 * The boolean an expression is the constant for.
 * @param expression - The expression to read
 * @returns the boolean, or `undefined` when it is not a boolean constant
 */
export function booleanConstantOf(expression: Algebra.Expression): boolean | undefined {
  if (expression.subType !== Algebra.ExpressionTypes.TERM) {
    return undefined;
  }
  if (expression.term.equals(termTrue)) {
    return true;
  }
  return expression.term.equals(termFalse) ? false : undefined;
}

/**
 * Creates the constant `true` or `false` expression, as an `xsd:boolean` term.
 * @param c - The transformation context
 * @param value - The boolean to write
 * @returns the term expression
 */
export function createBooleanExpression(c: TransformContext, value: boolean): Algebra.Expression {
  return c.AF.createTermExpression(value ? termTrue : termFalse);
}

/**
 * The operators whose value is not a function of the solution mapping they are evaluated on, so that two
 * evaluations of one expression may disagree.
 *
 * `NOW` is deliberately absent: "all calls to [it] in any one query execution must return the same value"
 * (SPARQL 1.1 §17.4.5.1), which is exactly what stability asks for. `BNODE` is present because §17.4.2.14
 * fixes a blank node per solution mapping *and* argument, so a row a join copies gets one node below the
 * join and several above it.
 */
const unstableOperators = new Set([ 'bnode', 'rand', 'uuid', 'struuid' ]);

/**
 * The extension functions declared stable, which is what lets a `BIND` over one of them move.
 *
 * `EXTENSION_FUNCTION_BNODE` is the internal form of the `bnodeConsistent` function the README documents,
 * and "same inputs = same identity" is stability spelled out. Every other `named` expression is opaque:
 * nothing in the algebra says what it computes, so nothing says it computes it twice the same way.
 */
const stableNamedFunctions = new Set<string>([ EXTENSION_FUNCTION_BNODE ]);

/**
 * Whether an expression is a pure function of the variables it reads: asked twice about the same values, it
 * gives the same answer.
 *
 * This is what a rewrite moving an expression to another point in the plan needs, and it is strictly weaker
 * than "the same value in every solution" - a stable expression may read variables, and the rules of the
 * pull-up carry their own side conditions about those. For the older, stronger reading, ask for both:
 * `isStableExpression(c, e) && collectVariableNames(c.astTransformer, e).size === 0`.
 * @param c - The transformation context
 * @param expression - The expression to check
 * @returns whether it is stable
 */
export function isStableExpression(c: TransformContext, expression: Algebra.Expression): boolean {
  let isStable = true;
  const neverStable = { preVisitor: () => {
    isStable = false;
    return { shortcut: true };
  } };
  algebraUtils.visitOperationSub(expression, {}, { expression: {
    operator: { preVisitor: (operator) => {
      if (unstableOperators.has(operator.operator)) {
        isStable = false;
        return { shortcut: true };
      }
      return {};
    } },
    named: { preVisitor: (named) => {
      if (!stableNamedFunctions.has(named.name.value)) {
        isStable = false;
        return { shortcut: true };
      }
      return {};
    } },
    // An EXISTS is stable per solution, but it reads `vars(P)` of a nested pattern rather than anything
    // visible in the expression tree, and it is evaluated against the active graph. Nothing holding one
    // moves until that is worked out - the pushdown carries the same TODO.
    // TODO(phase 4): give EXISTENCE a reads-set and let it be stable where the active graph does not change.
    existence: neverStable,
    // Neither can occur in a BIND, and neither is a function of one solution mapping.
    aggregate: neverStable,
    wildcard: neverStable,
  }});
  return isStable;
}

/**
 * Whether two expressions are the same expression, structurally.
 *
 * The algebra ships no such helper - `Canonicalizer` only renames blank nodes - and the merge and `UNION`
 * rules of the pull-up need one: "every branch carries *this* bind" is a question about the expression
 * itself, not about what it evaluates to. Generate-and-compare would answer a different question, two
 * expressions printing the same being neither necessary nor sufficient for the trees to agree.
 *
 * An `existence` is never equal to anything, this one deliberately not walking into a nested pattern: what
 * would have to be compared there is operation equality, which is a bigger promise than any caller needs.
 * @param left - One expression
 * @param right - The other
 * @returns whether they are structurally equal
 */
export function expressionsEqual(left: Algebra.Expression, right: Algebra.Expression): boolean {
  if (left.subType !== right.subType) {
    return false;
  }
  switch (left.subType) {
    case Algebra.ExpressionTypes.TERM:
      return left.term.equals((<Algebra.TermExpression> right).term);
    case Algebra.ExpressionTypes.OPERATOR: {
      const other = <Algebra.OperatorExpression> right;
      return left.operator === other.operator && argumentsEqual(left.args, other.args);
    }
    case Algebra.ExpressionTypes.NAMED: {
      const other = <Algebra.NamedExpression> right;
      return left.name.equals(other.name) && argumentsEqual(left.args, other.args);
    }
    case Algebra.ExpressionTypes.AGGREGATE: {
      const other = <Algebra.AggregateExpression> right;
      return left.aggregator === other.aggregator && left.distinct === other.distinct &&
        left.separator === other.separator && expressionsEqual(left.expression, other.expression);
    }
    case Algebra.ExpressionTypes.WILDCARD:
      return true;
    default:
      return false;
  }
}

/**
 * Whether two argument lists hold the same expressions, pairwise and in order.
 * @param left - One argument list
 * @param right - The other
 * @returns whether they are equal
 */
function argumentsEqual(left: readonly Algebra.Expression[], right: readonly Algebra.Expression[]): boolean {
  return left.length === right.length && left.every((arg, index) => expressionsEqual(arg, right[index]));
}

/**
 * Whether an expression holds an `EXISTS` or a `NOT EXISTS` anywhere inside it.
 *
 * The one sub-expression nothing may be substituted into: a solution mapping is written into the nested
 * *pattern*, where an expression cannot go and an unbound variable stays a variable matching anything
 * rather than becoming the one term it would be replaced by.
 * @param expression - The expression to read
 * @returns whether it holds one
 */
export function containsExistenceExpression(expression: Algebra.Expression): boolean {
  let found = false;
  algebraUtils.visitOperationSub(expression, {}, { expression: {
    existence: { preVisitor: () => {
      found = true;
      return { shortcut: true };
    } },
  }});
  return found;
}

/**
 * Whether an expression asks `bound(?name)` anywhere inside it.
 *
 * `BOUND` is the only SPARQL built-in whose grammar takes a bare `Var` rather than an `Expression`, so it
 * is the one reader a term may not simply be written into: `bound(<ex://a>)` is not a query. It folds to
 * a constant instead, and only where the variable is proven bound or proven unbound.
 * @param expression - The expression to read
 * @param name - The variable to look for
 * @returns whether it is asked about
 */
export function asksBoundOfVariable(expression: Algebra.Expression, name: string): boolean {
  let found = false;
  algebraUtils.visitOperationSub(expression, {}, { expression: {
    operator: { preVisitor: (operator) => {
      if (operator.operator === 'bound' && operator.args.some(argument =>
        argument.subType === Algebra.ExpressionTypes.TERM &&
        argument.term.termType === 'Variable' &&
        argument.term.value === name)) {
        found = true;
      }
      return {};
    } },
  }});
  return found;
}

/**
 * Whether an expression is an IRI spelled out as a term.
 * @param expression - The expression to check
 * @returns whether it is a term expression holding a NamedNode
 */
export function isIriExpression(expression: Algebra.Expression):
    expression is Algebra.Expression & { term: { termType: 'NamedNode' }} {
  return expression.subType === Algebra.ExpressionTypes.TERM && expression.term.termType === 'NamedNode';
}

/**
 * Creates `sameTerm(expression, term)`.
 * @param c - The transformation context
 * @param expression - One side of the equality
 * @param term - The other
 * @returns the condition
 */
export function sameTermExpression(
  c: TransformContext,
  expression: Algebra.Expression,
  term: RDF.Term,
): Algebra.Expression {
  return c.AF.createOperatorExpression('sameterm', [ expression, c.AF.createTermExpression(term) ]);
}
