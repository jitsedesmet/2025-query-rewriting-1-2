import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { isVariableCertainlyBound } from '../utils/certainlyBoundVars.js';
import { conjunctionOf, splitConjunction } from '../utils/operationhelpers.js';
import type { TermSubstitutions } from '../utils/termSubstitution.js';
import { substituteTerms, substituteTermsInExpression } from '../utils/termSubstitution.js';
import { collectVariableNames } from '../utils.js';

/**
 * A top level filter conjunct that pins a variable to a single concrete term.
 */
interface StaticBind {
  /** The conjunct the bind was recognised in - it is consumed when the bind is applied */
  conjunct: Algebra.Expression;
  /** The variable that is pinned */
  variable: RDF.Variable;
  /** The term the variable is pinned to */
  term: RDF.NamedNode | RDF.Literal;
}

/**
 * Turns a filter that pins a variable to a concrete term into a substitution plus a BIND:
 *
 * ```
 * Filter(sameTerm(?v, <a>), P)   ->   Extend(P[?v := <a>], ?v, <a>)
 * ```
 *
 * Both `sameTerm(?v, term)` and `<iri> = ?v` are recognised as pinning conjuncts. For IRIs the two
 * are equivalent: `RDFterm-equal` on two IRIs is term identity
 * ([SPARQL 1.2, operator mapping](https://www.w3.org/TR/sparql12-query/#OperatorMapping)), while for
 * literals `=` is *value* equality (`"1"^^xsd:integer = "01"^^xsd:integer` holds, but the terms
 * differ), so `=` is only accepted for IRIs.
 *
 * The rewrite is what makes the constant reach the places where it prunes work: after substitution
 * the term sits inside the triple patterns, VALUES rows and expressions of the operand instead of
 * being checked afterwards. Re-binding `?v` with the `Extend` keeps the rewrite value-preserving -
 * the solution mappings of the result are exactly the ones of the original filter - so no proof that
 * `?v` is unused above is required. Dead binds left behind by the rewrite are removed by
 * {@link removeDeadExtends}, and binds that end up in every branch of a UNION are hoisted out of it
 * by {@link pushUpBoundedFromUnion}:
 *
 * ```
 * Union(Extend(A, ?x, a), Extend(B, ?x, a))   ->   Extend(Union(A, B), ?x, a)
 * ```
 *
 * Like (SJPush) of Schmidt et al. (https://arxiv.org/pdf/0812.3788) the conjunct may first be pushed
 * onto a single JOIN operand: when the filter sits on a JOIN, the bind is applied to the first
 * operand that admits it, leaving the other operands - which keep joining on `?v` - untouched. This
 * complements the (already filter-pushing) {@link pushDownRestrictors} pass, which sinks filters
 * through UNIONs and JOINs but never eliminates a variable.
 *
 * A bind is only applied to an operand that {@link allowsSubstitution}, which is where the soundness
 * of the rewrite is decided.
 *
 * @param c - The transformation context
 * @param op - The operation to transform
 * @returns The transformed operation
 *
 * @example
 * // Before:
 * // SELECT * { ?s <ex://p> ?o FILTER(sameTerm(?o, <ex://a>)) }
 * // After:
 * // SELECT * { ?s <ex://p> <ex://a> BIND(<ex://a> AS ?o) }
 */
export function transformFilterToStaticBind<T extends Algebra.Operation>(c: TransformContext, op: T): T {
  return algebraUtils.mapOperation<'unsafe', typeof op>(op, {
    [Algebra.Types.FILTER]: {
      transform: filter => applyStaticBinds(c, filter),
    },
  });
}

/**
 * Applies every applicable static bind of a filter, returning the rewritten operation.
 *
 * Conjuncts that are not consumed - either because they are no static bind, or because no operand
 * admits their substitution - are kept in a residual filter on top of the result. Since the emitted
 * `Extend` guarantees `?v` is bound to the term above the rewrite, those residual conjuncts are
 * substituted as well: a second, contradicting bind such as `sameTerm(?v, <b>)` therefore collapses
 * into the constant `sameTerm(<a>, <b>)`, which {@link transformFilterFalse} can prune.
 *
 * @param c - The transformation context
 * @param filter - The filter to rewrite
 * @returns The rewritten operation, or the unmodified filter when no bind applies
 */
function applyStaticBinds(c: TransformContext, filter: Algebra.Filter): Algebra.Operation {
  const conjuncts = splitConjunction(filter.expression);
  const binds = conjuncts.map(conjunct => asStaticBind(conjunct)).filter(bind => bind !== undefined);
  if (binds.length === 0) {
    return filter;
  }

  // A filter on a JOIN may pin a variable in a single operand (SJPush); anything else is handled as
  // a single operand, so both cases share the code below.
  const join = filter.input.type === Algebra.Types.JOIN ? filter.input : undefined;
  const operands: Algebra.Operation[] = join === undefined ? [ filter.input ] : [ ...join.input ];

  const perOperand = new Map<number, TermSubstitutions>();
  const substitutions: TermSubstitutions = {};
  const consumed = new Set<Algebra.Expression>();
  for (const bind of binds) {
    const pinned = substitutions[bind.variable.value];
    if (pinned !== undefined) {
      // A variable is pinned at most once: a repeat asserting the same term is subsumed, while a
      // contradicting one stays in the residual filter - where it collapses into a constant.
      if (pinned.equals(bind.term)) {
        consumed.add(bind.conjunct);
      }
      continue;
    }
    const index = operands.findIndex(operand => allowsSubstitution(c, operand, bind));
    if (index === -1) {
      continue;
    }
    perOperand.set(index, { ...perOperand.get(index), [bind.variable.value]: bind.term });
    substitutions[bind.variable.value] = bind.term;
    consumed.add(bind.conjunct);
  }

  if (consumed.size === 0) {
    return filter;
  }

  const rewritten = operands.map((operand, index) => {
    const operandSubs = perOperand.get(index);
    return operandSubs === undefined ? operand : bindTerms(c, substituteTerms(c, operand, operandSubs), operandSubs);
  });
  let result: Algebra.Operation;
  if (join === undefined) {
    result = rewritten[0];
  } else {
    join.input = rewritten;
    result = join;
  }

  const residual = conjuncts
    .filter(conjunct => !consumed.has(conjunct))
    .map(conjunct => substituteTermsInExpression(c, conjunct, substitutions));
  return residual.length === 0 ? result : c.AF.createFilter(result, conjunctionOf(c, residual));
}

/**
 * Recognises a conjunct that pins a variable to a concrete term.
 *
 * @param expression - The conjunct to inspect
 * @returns The recognised bind, or undefined when the conjunct pins nothing
 */
function asStaticBind(expression: Algebra.Expression): StaticBind | undefined {
  if (expression.subType !== Algebra.ExpressionTypes.OPERATOR || expression.args.length !== 2) {
    return undefined;
  }
  // Operators are lower cased when a query is parsed, but not when the algebra is built by hand.
  const operator = expression.operator.toLowerCase();
  if (operator !== 'sameterm' && operator !== '=') {
    return undefined;
  }
  const [ left, right ] = expression.args;
  if (left.subType !== Algebra.ExpressionTypes.TERM || right.subType !== Algebra.ExpressionTypes.TERM) {
    return undefined;
  }
  const [ variable, term ] = left.term.termType === 'Variable' ? [ left.term, right.term ] : [ right.term, left.term ];
  if (variable.termType !== 'Variable' || (term.termType !== 'NamedNode' && term.termType !== 'Literal')) {
    return undefined;
  }
  // `=` is value equality: only on IRIs does it coincide with term equality.
  if (operator === '=' && term.termType !== 'NamedNode') {
    return undefined;
  }
  return { conjunct: expression, variable, term };
}

/**
 * Wraps an operation in an `Extend` for every substituted variable, restoring the bindings the
 * substitution removed and thereby making the rewrite value-preserving.
 */
function bindTerms(c: TransformContext, op: Algebra.Operation, subs: TermSubstitutions): Algebra.Operation {
  return Object.entries(subs).reduce<Algebra.Operation>(
    (acc, [ variable, term ]) => c.AF.createExtend(acc, c.DF.variable(variable), c.AF.createTermExpression(term)),
    op,
  );
}

/**
 * Decides whether `Filter(sameTerm(?v, t), op)` may be rewritten into `Extend(op[?v := t], ?v, t)`.
 *
 * Two things have to hold. First `?v` has to be *certainly bound* by `op`: `sameTerm` errors - and
 * so the filter rejects the solution - when `?v` is unbound, while the rewrite would happily bind it
 * through the `Extend`. Second, every occurrence of `?v` has to be substitutable, which
 * {@link isSubstitutionSafe} decides.
 *
 * @param c - The transformation context
 * @param op - The candidate operand
 * @param bind - The bind to apply
 * @returns True when the rewrite preserves the solution mappings of the filter
 */
function allowsSubstitution(c: TransformContext, op: Algebra.Operation, bind: StaticBind): boolean {
  return isVariableCertainlyBound(op, bind.variable, { extendBinds: true }) && isSubstitutionSafe(c, op, bind);
}

/**
 * Decides whether every occurrence of the pinned variable within `op` may be replaced by the term.
 *
 * Replacing a variable by a term restricts a sub-pattern to the solutions that bind the variable to
 * that term *and* drops the variable from their domain. Both are unobservable exactly when the
 * variable is certainly bound wherever it occurs, which is what this check enforces node by node.
 * That rules out for instance an occurrence below an OPTIONAL: substituting there also lets the
 * solutions in which the OPTIONAL does not match through, and those solutions do not bind the
 * variable at all - the original filter rejects them.
 *
 * On top of that node-local rule a few operations need extra care:
 * - **PROJECT**: a subquery that does not project the variable *scopes* it, so an occurrence inside
 *   is a different variable. Since {@link substituteTerms} does descend into subqueries, such an
 *   occurrence is rejected rather than substituted.
 * - **MINUS**: dropping the variable from the domain of the right operand may make the two domains
 *   disjoint, in which case MINUS keeps solutions it used to remove
 *   ([SPARQL 1.2, MINUS](https://www.w3.org/TR/sparql12-query/#defn_algMinus)). Occurrences in the
 *   right operand are therefore rejected.
 * - **SLICE**: substituting is pushing the filter through `LIMIT`/`OFFSET`, which changes which
 *   solutions the slice retains.
 * - **GROUP**: the variable is dropped from the group keys, which is only invisible while other keys
 *   remain: an implicit grouping still produces a row for an input without solutions.
 * - **SERVICE** and anything else not listed: rejected, since it either evaluates remotely or is not
 *   understood by {@link substituteTerms}.
 * - **BGP / PATH**: a literal is only well formed in the object position, so pinning a variable that
 *   also occurs as a subject, predicate or graph to a literal is rejected.
 * - **GRAPH**: an active graph is named by an IRI, so pinning its variable to a literal is rejected.
 *
 * @param c - The transformation context
 * @param op - The operation the variable would be substituted in
 * @param bind - The bind to apply
 * @returns True when the substitution is sound for this subtree
 */
function isSubstitutionSafe(c: TransformContext, op: Algebra.Operation, bind: StaticBind): boolean {
  const { variable, term } = bind;
  if (!occurs(c, op, variable)) {
    return true;
  }
  if (op.type === Algebra.Types.PROJECT && !op.variables.some(projected => projected.equals(variable))) {
    // The variable is scoped by this subquery, so the occurrences below are a different variable.
    return false;
  }
  if (!isVariableCertainlyBound(op, variable, { extendBinds: true })) {
    return false;
  }
  switch (op.type) {
    case Algebra.Types.BGP:
      return op.patterns.every(pattern => patternAllowsTerm(pattern, variable, term));
    case Algebra.Types.PATH:
      return termAllowsSubstitution(op.subject, variable, term, false) &&
        termAllowsSubstitution(op.object, variable, term, true) &&
        termAllowsSubstitution(op.graph, variable, term, false);
    case Algebra.Types.VALUES:
      // Rows binding the variable to another term are dropped, the column is removed.
      return true;
    case Algebra.Types.JOIN:
    case Algebra.Types.UNION:
    case Algebra.Types.LEFT_JOIN:
      return op.input.every(input => isSubstitutionSafe(c, input, bind));
    case Algebra.Types.MINUS:
      return isSubstitutionSafe(c, op.input[0], bind) && !occurs(c, op.input[1], variable);
    case Algebra.Types.GRAPH:
      return (term.termType === 'NamedNode' || !op.name.equals(variable)) && isSubstitutionSafe(c, op.input, bind);
    case Algebra.Types.GROUP:
      // The variable is a group key here (nothing else survives a grouping certainly bound), and
      // dropping the last key makes the grouping implicit - which yields a single aggregate row even
      // when the input has no solutions at all.
      return op.variables.length > 1 && isSubstitutionSafe(c, op.input, bind);
    case Algebra.Types.PROJECT:
    case Algebra.Types.FILTER:
    case Algebra.Types.EXTEND:
    case Algebra.Types.ORDER_BY:
    case Algebra.Types.DISTINCT:
    case Algebra.Types.REDUCED:
    case Algebra.Types.FROM:
      return isSubstitutionSafe(c, op.input, bind);
    default:
      return false;
  }
}

/**
 * Tests whether a triple pattern keeps its term positions well formed when the variable is replaced.
 */
function patternAllowsTerm(pattern: Algebra.Pattern, variable: RDF.Variable, term: RDF.Term): boolean {
  return termAllowsSubstitution(pattern.subject, variable, term, false) &&
    termAllowsSubstitution(pattern.predicate, variable, term, false) &&
    termAllowsSubstitution(pattern.object, variable, term, true) &&
    termAllowsSubstitution(pattern.graph, variable, term, false);
}

/**
 * Tests whether the variable may be replaced by the term within a single (possibly quoted triple)
 * term position. Only the object position - of the pattern itself and of any triple term within it -
 * accepts a literal.
 */
function termAllowsSubstitution(
  position: RDF.Term,
  variable: RDF.Variable,
  term: RDF.Term,
  isObjectPosition: boolean,
): boolean {
  if (term.termType !== 'Literal') {
    return true;
  }
  if (position.termType === 'Variable') {
    return isObjectPosition || !position.equals(variable);
  }
  if (position.termType === 'Quad') {
    return termAllowsSubstitution(position.subject, variable, term, false) &&
      termAllowsSubstitution(position.predicate, variable, term, false) &&
      termAllowsSubstitution(position.object, variable, term, isObjectPosition);
  }
  return true;
}

/**
 * Tests whether a variable occurs anywhere within an operation - including within the expressions
 * and the subqueries it contains, exactly like {@link substituteTerms} traverses it.
 */
function occurs(c: TransformContext, op: Algebra.Operation, variable: RDF.Variable): boolean {
  return collectVariableNames(c.astTransformer, op).has(variable.value);
}
