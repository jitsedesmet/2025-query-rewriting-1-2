import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import type { Assertions } from './assertions.js';
import { isAssertableTerm } from './assertions.js';
import { booleanConstantOf, createBooleanExpression, isIriExpression } from './expressionHelpers.js';

/**
 * Substitutes assertions into an expression and folds what becomes constant: `simplify(R[θ])`.
 *
 * Substitution is *not* uniform textual replacement. `BOUND` is the only SPARQL built-in whose grammar
 * takes a bare `Var` instead of an `Expression`, so replacing the variable by a term would produce the
 * ungrammatical `BOUND(<ex://p>)` - which an internal algebra tolerates until the plan is serialised
 * back to SPARQL. Since an assertion implies the variable is bound, `bound(?x)` becomes `true`.
 *
 * @param c - The transformation context
 * @param expression - The expression to substitute into
 * @param assertions - The assertions to substitute (θ)
 * @returns The substituted and folded expression
 */
export function substituteInExpression(
  c: TransformContext,
  expression: Algebra.Expression,
  assertions: Assertions,
): Algebra.Expression {
  // TODO(other PR):
  //  part of future works includes evaluating the functions statically using the Comunica Expression Evaluator
  const { AF } = c;
  switch (expression.subType) {
    case Algebra.ExpressionTypes.TERM: {
      const term = expression.term;
      const assertedValue = term.termType === 'Variable' ? assertions.get(term.value) : undefined;
      return assertedValue === undefined ? expression : AF.createTermExpression(assertedValue);
    }
    case Algebra.ExpressionTypes.OPERATOR: {
      // MANDATORY, not cosmetic: the grammar of BOUND takes a Var, so the term may not be substituted.
      if (expression.operator === 'bound' &&
        expression.args.length === 1 &&
        expression.args[0].subType === Algebra.ExpressionTypes.TERM &&
        expression.args[0].term.termType === 'Variable' &&
        assertions.has(expression.args[0].term.value)) {
        return createBooleanExpression(c, true);
      }
      return constantFoldOperator(c, expression.operator, expression.args
        .map(arg => substituteInExpression(c, arg, assertions)));
    }
    case Algebra.ExpressionTypes.EXISTENCE:
      // TODO: work out how to propagate an assertion into the pattern of an EXISTS.
      return expression;
    case Algebra.ExpressionTypes.NAMED:
      return AF.createNamedExpression(
        expression.name,
        expression.args.map(arg => substituteInExpression(c, arg, assertions)),
      );
    case Algebra.ExpressionTypes.AGGREGATE:
      return {
        ...expression,
        expression: substituteInExpression(c, expression.expression, assertions),
      };
    default:
      return expression;
  }
}

/**
 * Constant-folds an operator expression whose arguments are (partly) constant.
 *
 * Only operators that are deterministic and side-effect free may be folded here. Notably absent are
 * `rand`, `uuid`, `struuid`, `bnode` and `now`, which must survive to evaluation; anything not listed
 * below is rebuilt unchanged.
 *
 * Only the folds that are sound under SPARQL's error handling are applied.
 * Notably `=` folds to `true` for two identical terms - RDF term equality is the fallback for unsupported datatypes -
 * but never to `false`, since comparing terms of unsupported datatypes raises an error, and an error is not `false`
 * in every context: COALESCE(Error, false, true) ≡ false.
 */
export function constantFoldOperator(
  c: TransformContext,
  operator: string,
  args: Algebra.Expression[],
): Algebra.Expression {
  const constants = args.map(arg => booleanConstantOf(arg));
  switch (operator) {
    case 'sameterm': {
      // Evaluate sameTerm if LHS and RHS are static terms
      const [ left, right ] = args;
      if (args.length === 2 &&
                left.subType === Algebra.ExpressionTypes.TERM && isAssertableTerm(left.term) &&
                right.subType === Algebra.ExpressionTypes.TERM && isAssertableTerm(right.term)) {
        return createBooleanExpression(c, left.term.equals(right.term));
      }
      break;
    }
    case '=': {
      if (args.length !== 2) {
        break;
      }
      const [ left, right ] = args;
      // `=` is, worst case RDFterm-equal/ sameValue -- which raises a type error when *both* of its arguments
      // are literals, and of different types. But, for IRIs, if not sameTerm, then false.
      if (isIriExpression(left) || isIriExpression(right)) {
        return constantFoldOperator(c, 'sameterm', args);
      }
      // Everywhere else only the *positive* answer of `sameTerm` carries over: identical terms are
      // equal, but distinct ones may be equal by value, or raise the type error `sameTerm` never does.
      const identical = constantFoldOperator(c, 'sameterm', args);
      if (booleanConstantOf(identical) === true) {
        return identical;
      }
      break;
    }
    case '!':
      if (args.length === 1 && constants[0] !== undefined) {
        return createBooleanExpression(c, !constants[0]);
      }
      break;
    case '&&':
      // `false && error` is false, and `true && X` is X (an erroring X keeps erroring),
      // so both the absorbing and the neutral element may be folded away.
      if (constants.includes(false)) {
        return createBooleanExpression(c, false);
      }
      return neutralFold(c, args, constants, true);
    case '||':
      // Mirrors `&&`: `true || error` is true, and `false || X` is X.
      if (constants.includes(true)) {
        return createBooleanExpression(c, true);
      }
      return neutralFold(c, args, constants, false);
    default:
      break;
  }
  return c.AF.createOperatorExpression(operator, args);
}

/**
 * Drops the arguments of an `&&` / `||` that are its neutral element,
 * keeping the operator only when more than one argument is left.
 */
function neutralFold(
  c: TransformContext,
  args: Algebra.Expression[],
  constants: (boolean | undefined)[],
  neutral: boolean,
): Algebra.Expression {
  const remaining = args.filter((_, index) => constants[index] !== neutral);
  if (remaining.length === 0) {
    // Under `&&` you removed all 'true', non left -> true
    // under '||' you removed all 'false', non left -> false.
    return createBooleanExpression(c, neutral);
  }
  if (remaining.length === 1) {
    return remaining[0];
  }
  return c.AF.createOperatorExpression(neutral ? '&&' : '||', remaining);
}
