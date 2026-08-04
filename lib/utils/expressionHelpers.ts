import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { termVars } from './certainlyBoundVars.js';
import { termFalse, termTrue } from './operationhelpers.js';

/**
 * Splits a filter expression on top level logical conjunctions (`&&`), implementing (SDecompI):
 * `FILTER_{R1 && R2}(A) == FILTER_R1(FILTER_R2(A))`.
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
 */
export function conjunctionOf(c: TransformContext, expressions: Algebra.Expression[]): Algebra.Expression {
  return expressions.reduce((acc, expr) => c.AF.createOperatorExpression('&&', [ acc, expr ]));
}

/**
 * Recognizes an expression that is the constant `true` or `false`.
 * @param expression - The expression to inspect
 * @returns The boolean the expression is a constant for, or `undefined` when it is not a constant
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
 * Creates the constant `true` or `false` expression.
 * @param c - The transformation context
 * @param value - The boolean to create an expression for
 * @returns The `xsd:boolean` term expression
 */
export function createBooleanExpression(c: TransformContext, value: boolean): Algebra.Expression {
  return c.AF.createTermExpression(value ? termTrue : termFalse);
}

export function isStaticExpression(c: TransformContext, expression: Algebra.Expression[]): boolean {
  // TODO: when you have operations like `&&` or `||` you could shortcut potentially on if one branch is static.
  let isStatic = true;
  const neverStatic = { preVisitor: () => {
    isStatic = false;
    return { shortcut: true };
  } };
  algebraUtils.visitOperationSub(expression, {}, { expression: {
    term: { preVisitor: (term) => {
      if (termVars(term.term).size > 0) {
        isStatic = false;
        return { shortcut: true };
      }
      return {};
    } },
    operator: { preVisitor: (operator) => {
      // True recursion we can still find variables, but if the operator is not stable, we reject also.
      if ([ 'bnode', 'rand', 'now', 'uuid', 'struuid' ].includes(operator.operator)) {
        isStatic = false;
        return { shortcut: true };
      }
      return {};
    } },
    named: neverStatic,
    existence: neverStatic,
    aggregate: neverStatic,
    wildcard: neverStatic,
  }});
  return isStatic;
}

/** Whether an expression is an IRI spelled out as a term. */
export function isIriExpression(expression: Algebra.Expression):
    expression is Algebra.Expression & { term: { termType: 'NamedNode' }} {
  return expression.subType === Algebra.ExpressionTypes.TERM && expression.term.termType === 'NamedNode';
}

/**
 * Creates `sameTerm(expression, term)`.
 * @param c - The transformation context
 * @param expression - The expression that has to evaluate to `term`
 * @param term - The term to compare against
 * @returns The `sameTerm` operator expression
 */
export function sameTermExpression(
  c: TransformContext,
  expression: Algebra.Expression,
  term: RDF.Term,
): Algebra.Expression {
  return c.AF.createOperatorExpression('sameterm', [ expression, c.AF.createTermExpression(term) ]);
}
