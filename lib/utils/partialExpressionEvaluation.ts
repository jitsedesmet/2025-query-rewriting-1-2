import type * as RDF from '@rdfjs/types';
import { Algebra } from '@traqula/algebra-transformations-1-2';
import { predicateRange, subjectRange } from '../RangeSet.js';
import type { TransformContext } from '../transformContext.js';
import type { Access, Assertions } from './assertions.js';
import { accessOf, isAssertableTerm, rootAccess } from './assertions.js';
import { booleanConstantOf, createBooleanExpression, isIriExpression } from './expressionHelpers.js';
import { DF } from './rdfDatatypes.js';
import { unionSets } from './setUtils.js';

/**
 * What a conjunction decides about the things an expression reads, which is what `simplify(R[θ])` folds
 * against.
 *
 * A *view* rather than a map, because what is decided is not decided per variable: `subject(?o)` may be
 * a known term while `?o` itself is only known to be a triple term of some shape, and the shape itself
 * may never be written into an expression - the variables that would name its positions are unbound
 * wherever the expression is evaluated.
 */
export interface ExpressionSubstitution {
  /** The term an access is decided to be, if it is decided. */
  resolve: (access: Access) => RDF.Term | undefined;
  /** Whether an access is known to read a triple term. */
  isTriple: (access: Access) => boolean;
  /** The variables the substitution proves bound, whatever the operation below it binds. */
  bound: ReadonlySet<string>;
}

/**
 * The view a plain substitution is: it decides the variables it replaces, and nothing structural.
 *
 * Both ends of every replacement are bound: only a strong assertion substitutes, so the variable being
 * replaced is certainly bound wherever the substitution applies, and so is the variable it is replaced
 * *by* - the representative of a clique, of which membership implies `bnd(?x)`. The latter is what lets
 * the residual `sameTerm(?o, ?o)` a unification leaves behind fold away.
 */
export function substitutionOf(assertions: Assertions): ExpressionSubstitution {
  const bound = new Set<string>();
  for (const [ name, term ] of assertions) {
    bound.add(name);
    if (term.termType === 'Variable') {
      bound.add(term.value);
    }
  }
  return {
    resolve: access => access.positions.length === 0 ? assertions.get(access.name) : undefined,
    isTriple: () => false,
    bound,
  };
}

/**
 * Substitutes assertions (θ) into an expression and folds what becomes constant: `simplify(R[θ])`.
 *
 * Substitution is *not* uniform textual replacement. `BOUND` is the only SPARQL built-in whose grammar
 * takes a bare `Var` instead of an `Expression`, so replacing the variable by a term would produce the
 * ungrammatical `BOUND(<ex://p>)` once the plan is serialised back to SPARQL. Since an assertion implies
 * the variable is bound, `bound(?x)` becomes `true` instead.
 *
 * The accessor folds are what make the pass idempotent. `sameTerm(subject(?o), ?s)` is read into Θ and
 * written back out of it; met a second time, `subject(?o)` folds to what Θ says it is and the whole
 * conjunct folds to `true`, instead of being kept as a residual next to the copy Θ already carries.
 *
 * `cVars` are the variables certainly bound where the expression is evaluated - the ones of the operation
 * it sits on. They are the only thing that decides `sameTerm(?x, ?x)`, and the substitution proves a few
 * more of them by itself.
 */
export function substituteInExpression(
  c: TransformContext,
  expression: Algebra.Expression,
  substitution: ExpressionSubstitution,
  cVars: ReadonlySet<string>,
): Algebra.Expression {
  return substitute(c, expression, substitution, unionSets([ cVars, substitution.bound ]));
}

function substitute(
  c: TransformContext,
  expression: Algebra.Expression,
  substitution: ExpressionSubstitution,
  boundVariables: ReadonlySet<string>,
): Algebra.Expression {
  // TODO(other PR):
  //  part of future works includes evaluating the functions statically using the Comunica Expression Evaluator
  const { AF } = c;
  switch (expression.subType) {
    case Algebra.ExpressionTypes.TERM: {
      const term = expression.term;
      const assertedValue = term.termType === 'Variable' ?
        substitution.resolve(rootAccess(term.value)) :
        undefined;
      return assertedValue === undefined ? expression : AF.createTermExpression(assertedValue);
    }
    case Algebra.ExpressionTypes.OPERATOR: {
      // MANDATORY, not cosmetic: the grammar of BOUND takes a Var, so the term may not be substituted.
      //
      // Against what the *substitution* proves, not against what the operation below binds: `bound(?x)`
      // of a variable this only knows to be certainly bound is an assertion in its own right, and the
      // pushdown is what decides it - folding it away here would leave the filter unrecognised.
      if (expression.operator === 'bound' &&
        expression.args.length === 1 &&
        expression.args[0].subType === Algebra.ExpressionTypes.TERM &&
        expression.args[0].term.termType === 'Variable' &&
        substitution.bound.has(expression.args[0].term.value)) {
        return createBooleanExpression(c, true);
      }
      // What the whole accessor chain reads may be decided although its argument is not: Θ holds
      // `subject(?o)` as a thing of its own, not as something to be computed from what `?o` is.
      const access = accessOf(expression);
      if (access !== undefined) {
        const resolved = substitution.resolve(access);
        if (resolved !== undefined) {
          return AF.createTermExpression(resolved);
        }
      }
      if (expression.operator === 'istriple' && expression.args.length === 1) {
        const argument = accessOf(expression.args[0]);
        if (argument !== undefined && substitution.isTriple(argument)) {
          return createBooleanExpression(c, true);
        }
      }
      return constantFoldOperator(c, expression.operator, expression.args
        .map(arg => substitute(c, arg, substitution, boundVariables)), boundVariables);
    }
    case Algebra.ExpressionTypes.EXISTENCE:
      // TODO: work out how to propagate an assertion into the pattern of an EXISTS.
      return expression;
    case Algebra.ExpressionTypes.NAMED:
      return AF.createNamedExpression(
        expression.name,
        expression.args.map(arg => substitute(c, arg, substitution, boundVariables)),
      );
    case Algebra.ExpressionTypes.AGGREGATE:
      return {
        ...expression,
        expression: substitute(c, expression.expression, substitution, boundVariables),
      };
    default:
      return expression;
  }
}

/** The term an expression *is*, when it is one and it is decided. */
function decidedTerm(expression: Algebra.Expression): RDF.Term | undefined {
  return expression.subType === Algebra.ExpressionTypes.TERM && isAssertableTerm(expression.term) ?
    expression.term :
    undefined;
}

/**
 * Constant-folds an operator expression whose arguments are (partly) constant.
 *
 * Only deterministic, side-effect free operators may be folded: `rand`, `uuid`, `struuid`, `bnode` and
 * `now` must survive to evaluation, and anything not listed below is rebuilt unchanged.
 *
 * Only the folds sound under SPARQL's error handling are applied. Notably `=` folds to `true` for two
 * identical terms - RDF term equality is the fallback for unsupported datatypes - but never to `false`,
 * since comparing unsupported datatypes raises an error, and an error is not `false` in every context:
 * `COALESCE(Error, false, true) ≡ false`.
 *
 * `boundVariables` are the variables known to be bound here, which is the only thing that makes
 * `sameTerm(?x, ?x)` decidable: it is `true` of a bound `?x` and an *error* of an unbound one. Where `?x`
 * is not known to be bound there is nothing to rewrite it into either, since no expression has that
 * true-or-error semantics: `bound(?x)` answers `false` where `sameTerm(?x, ?x)` errors, and the two are
 * told apart by `COALESCE`.
 */
export function constantFoldOperator(
  c: TransformContext,
  operator: string,
  args: Algebra.Expression[],
  boundVariables: ReadonlySet<string> = new Set(),
): Algebra.Expression {
  const constants = args.map(arg => booleanConstantOf(arg));
  switch (operator) {
    case 'sameterm': {
      // Evaluate sameTerm if LHS and RHS are static terms
      const [ left, right ] = args;
      if (args.length === 2) {
        const decidedLeft = decidedTerm(left);
        const decidedRight = decidedTerm(right);
        if (decidedLeft !== undefined && decidedRight !== undefined) {
          return createBooleanExpression(c, decidedLeft.equals(decidedRight));
        }
        // The residual a unification leaves behind: substituting `?s ↦ ?o` turns `sameTerm(?s, ?o)` into
        // `sameTerm(?o, ?o)`. Only decidable for a variable certainly bound here - an unbound `?a` makes
        // `sameTerm(?a, ?a)` an error rather than `true`.
        if (left.subType === Algebra.ExpressionTypes.TERM && left.term.termType === 'Variable' &&
          right.subType === Algebra.ExpressionTypes.TERM && right.term.equals(left.term) &&
          boundVariables.has(left.term.value)) {
          return createBooleanExpression(c, true);
        }
      }
      break;
    }
    case 'subject':
    case 'predicate':
    case 'object': {
      // The one place a triple term is taken apart rather than put together: reading a position of a
      // term that is decided decides the position. An accessor on anything else errors, which a FILTER
      // reads as `false` - but not every context does, so nothing is folded there.
      const [ argument ] = args;
      const term = args.length === 1 ? decidedTerm(argument) : undefined;
      if (term?.termType === 'Quad') {
        return c.AF.createTermExpression(term[operator]);
      }
      break;
    }
    case 'istriple': {
      const [ argument ] = args;
      const term = args.length === 1 ? decidedTerm(argument) : undefined;
      if (term !== undefined) {
        return createBooleanExpression(c, term.termType === 'Quad');
      }
      break;
    }
    case 'triple': {
      // A construction over three decided components is the term it constructs - unless it is one no
      // triple can be, in which case it raises an evaluation error rather than yielding a term, and
      // there is nothing to fold it to.
      const [ subject, predicate, object ] = args.map(arg => decidedTerm(arg));
      if (args.length === 3 && subject !== undefined && predicate !== undefined && object !== undefined &&
        subjectRange.has(subject.termType) && predicateRange.has(predicate.termType)) {
        return c.AF.createTermExpression(DF.quad(
          <RDF.Quad_Subject> subject,
          <RDF.Quad_Predicate> predicate,
          <RDF.Quad_Object> object,
        ));
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
        return constantFoldOperator(c, 'sameterm', args, boundVariables);
      }
      // Everywhere else only the *positive* answer of `sameTerm` carries over: identical terms are
      // equal, but distinct ones may be equal by value, or raise the type error `sameTerm` never does.
      const identical = constantFoldOperator(c, 'sameterm', args, boundVariables);
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
