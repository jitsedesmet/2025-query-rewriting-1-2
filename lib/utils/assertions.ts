import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import type { CPMeta } from './certainlyBoundVars.js';
import { withoutCpVars } from './certainlyBoundVars.js';
import {
  booleanConstantOf,
  conjunctionOf,
  createBooleanExpression,
  splitConjunction,
} from './expressionHelpers.js';
import { DF } from './rdfDatatypes.js';
import { termIsStaticTerm } from './typeGuards.js';

/**
 * @fileoverview The assertion (`FILTER(sameTerm(?x, c))`) toolbox: recognizing the assertions a filter
 * condition carries, building them, and substituting them into expressions and patterns.
 *
 * Used by {@link pushDownAssertions}; kept separate from the traversal so that the expression level
 * reasoning (which is where the SPARQL subtleties are) can be read and tested on its own.
 */

/**
 * A set of assertions θ: a (partial) map from variable name to the single ground term that variable is
 * fixed to. Written A⟨?x ≡ c⟩ in the design, i.e. `σ_{sameTerm(?x, c)}`.
 *
 * A variable never maps to two terms - a condition asserting one is contradictory and yields the empty
 * result instead of an entry in this map.
 */
export type Assertions = ReadonlyMap<string, RDF.Term>;

/**
 * What the top level conjunction of a filter condition says about single variables, cached on the filter
 * the way {@link CPMeta} is cached on any operation.
 *
 * This is the state the pushdown threads through the plan: the conjunction of `sameTerm` assertions that
 * still holds at the point the filter sits at, plus whatever is left of the condition it came from.
 */
export interface SameTermConjunctionMeta {
  /** The assertions (θ) the top level conjunction carries, keyed by variable name. */
  assertions: Assertions;
  /**
   * What is left of the condition once the assertions are taken out of it, with θ substituted into it
   * (FReord), or `undefined` when the assertions are all there was.
   */
  residual: Algebra.Expression | undefined;
  /**
   * Whether the conjunction contradicts itself - one variable asserted to be two distinct terms, or a
   * conjunct that folded to `false`. Such a filter is the empty operation.
   */
  contradictory: boolean;
}

/** A filter of which we know what its top level conjunction says about single variables. */
export type SameTermFilter = Algebra.Filter & {
  metadata: Partial<CPMeta> & { sameTerms: SameTermConjunctionMeta };
};

/**
 * Attaches - or reuses - the {@link SameTermConjunctionMeta} of a filter.
 *
 * Like {@link withCpVars}, this is dynamic programming rather than a computation: a filter this pass
 * created knows its own assertions already, and one it meets in the input tree is analysed once and
 * carries the result from then on.
 *
 * @param c - The transformation context
 * @param filter - The filter to analyse
 * @returns The same filter, with its `sameTerms` metadata guaranteed to be present
 */
export function withSameTermConjunction(c: TransformContext, filter: Algebra.Filter): SameTermFilter {
  const casted = <Algebra.Filter & { metadata?: Partial<SameTermFilter['metadata']> }> filter;
  const known = casted.metadata?.sameTerms;
  if (known === undefined) {
    const collected = collectAssertions(c, filter.expression);
    casted.metadata ??= {};
    casted.metadata.sameTerms = collected ?? {
      assertions: new Map(),
      residual: undefined,
      contradictory: true,
    };
  }
  return <SameTermFilter> casted;
}

/**
 * Guard recognizing the filters this pass is about: the ones whose top level conjunction fixes at least
 * one variable to one term, and the contradictory ones (which are the empty operation).
 *
 * Fails fast on anything else - a filter carrying no assertion is left where it is, and the traversal
 * simply keeps descending into it looking for the ones deeper down.
 *
 * @param c - The transformation context
 * @param op - The operation to inspect
 * @returns Whether the operation is a filter carrying assertions, narrowing it to {@link SameTermFilter}
 */
export function isSameTermFilter(c: TransformContext, op: Algebra.Operation): op is SameTermFilter {
  if (op.type !== Algebra.Types.FILTER) {
    return false;
  }
  const { sameTerms } = withSameTermConjunction(c, op).metadata;
  return sameTerms.contradictory || sameTerms.assertions.size > 0;
}

/** What the top level conjunction of a filter says in the *weak* form W⟨?x ≡ c⟩. */
export interface WeakSameTermConjunctionMeta {
  /** The weak assertions the top level conjunction carries, keyed by variable name. */
  assertions: Assertions;
  /** What is left of the condition once they are taken out of it. */
  residual: Algebra.Expression | undefined;
}

/** A filter of which we know which weak assertions its top level conjunction carries. */
export type WeakSameTermFilter = Algebra.Filter & {
  metadata: Partial<CPMeta> & { weakSameTerms: WeakSameTermConjunctionMeta };
};

/**
 * Attaches - or reuses - the {@link WeakSameTermConjunctionMeta} of a filter,
 * the weak counterpart of {@link withSameTermConjunction}.
 *
 * @param c - The transformation context
 * @param filter - The filter to analyse
 * @returns The same filter, with its `weakSameTerms` metadata guaranteed to be present
 */
export function withWeakSameTermConjunction(c: TransformContext, filter: Algebra.Filter): WeakSameTermFilter {
  const casted = <Algebra.Filter & { metadata?: Partial<WeakSameTermFilter['metadata']> }> filter;
  if (casted.metadata?.weakSameTerms === undefined) {
    const collected = collectWeakAssertions(c, filter.expression);
    casted.metadata ??= {};
    casted.metadata.weakSameTerms = collected;
  }
  return <WeakSameTermFilter> casted;
}

/**
 * Guard recognizing a filter whose top level conjunction carries at least one weak assertion
 * W⟨?x ≡ c⟩ (`!bound(?x) || sameTerm(?x, c)`).
 *
 * @param c - The transformation context
 * @param op - The operation to inspect
 * @returns Whether it is such a filter, narrowing it to {@link WeakSameTermFilter}
 */
export function isWeakSameTermFilter(c: TransformContext, op: Algebra.Operation): op is WeakSameTermFilter {
  return op.type === Algebra.Types.FILTER &&
    withWeakSameTermConjunction(c, op).metadata.weakSameTerms.assertions.size > 0;
}

/**
 * Decides whether a term can be substituted for a variable by this pass.
 *
 * Everything ground qualifies, except a blank node: a blank node label inside an expression is a
 * fresh label rather than a reference to a blank node in the data, so nothing can be concluded from
 * `sameTerm(?x, _:b)`.
 *
 * @param term - The term to check
 * @returns True when an assertion may fix a variable to this term
 */
export function isAssertableTerm(term: RDF.Term): boolean {
  return term.termType !== 'BlankNode' && termIsStaticTerm(term);
}

/**
 * Recognizes the assertion a single conjunct carries: `sameTerm(?x, c)` or `sameTerm(c, ?x)`.
 *
 * `sameTerm` - not `=` - is what makes the substitution this pass performs sound: `?x = "01"^^xsd:integer`
 * holds of the *term* `"1"^^xsd:integer`, so substituting under `=` would drop solutions. Never
 * generalise this to `=`.
 *
 * @param expression - The conjunct to inspect
 * @returns The asserted variable and term, or `undefined` when the conjunct is not an assertion
 */
export function asAssertion(expression: Algebra.Expression): { name: string; term: RDF.Term } | undefined {
  if (expression.subType !== Algebra.ExpressionTypes.OPERATOR ||
    expression.operator !== 'sameterm' ||
    expression.args.length !== 2) {
    return undefined;
  }
  const [ left, right ] = expression.args;
  if (left.subType !== Algebra.ExpressionTypes.TERM || right.subType !== Algebra.ExpressionTypes.TERM) {
    return undefined;
  }
  if (left.term.termType === 'Variable' && isAssertableTerm(right.term)) {
    return { name: left.term.value, term: right.term };
  }
  if (right.term.termType === 'Variable' && isAssertableTerm(left.term)) {
    return { name: right.term.value, term: left.term };
  }
  return undefined;
}

/**
 * Recognizes the *weak* assertion a single conjunct carries: `!bound(?x) || sameTerm(?x, c)`.
 *
 * @param expression - The conjunct to inspect
 * @returns The variable and term of the weak assertion, or `undefined` when it is not one
 */
export function asWeakAssertion(expression: Algebra.Expression): { name: string; term: RDF.Term } | undefined {
  if (expression.subType !== Algebra.ExpressionTypes.OPERATOR ||
    expression.operator !== '||' ||
    expression.args.length !== 2) {
    return undefined;
  }
  const unbound = expression.args.map(arg => variableOfNotBound(arg));
  for (const [ index, name ] of unbound.entries()) {
    if (name === undefined) {
      continue;
    }
    const assertion = asAssertion(expression.args[index === 0 ? 1 : 0]);
    if (assertion !== undefined && assertion.name === name) {
      return assertion;
    }
  }
  return undefined;
}

/** The variable of a `!bound(?x)` expression, if that is what it is. */
function variableOfNotBound(expression: Algebra.Expression): string | undefined {
  if (expression.subType !== Algebra.ExpressionTypes.OPERATOR ||
    expression.operator !== '!' ||
    expression.args.length !== 1) {
    return undefined;
  }
  const [ bound ] = expression.args;
  if (bound.subType !== Algebra.ExpressionTypes.OPERATOR ||
    bound.operator !== 'bound' ||
    bound.args.length !== 1) {
    return undefined;
  }
  const [ argument ] = bound.args;
  return argument.subType === Algebra.ExpressionTypes.TERM && argument.term.termType === 'Variable' ?
    argument.term.value :
    undefined;
}

/**
 * Splits the top level conjunction of a filter condition into the *weak* assertions it carries and what
 * is left of it. The dual of {@link collectAssertions} for W⟨?x ≡ c⟩.
 *
 * @param c - The transformation context
 * @param expression - The filter condition to split
 * @returns The weak assertions and the residual condition (`undefined` when nothing is left)
 */
export function collectWeakAssertions(
  c: TransformContext,
  expression: Algebra.Expression,
): { assertions: Assertions; residual: Algebra.Expression | undefined } {
  const assertions = new Map<string, RDF.Term>();
  const residual: Algebra.Expression[] = [];
  for (const conjunct of splitConjunction(expression)) {
    const assertion = asWeakAssertion(conjunct);
    // Two weak assertions on one variable are not contradictory: an unbound ?x satisfies both, so the
    // second one has to stay in the residual rather than replace the first.
    if (assertion === undefined || assertions.has(assertion.name)) {
      residual.push(conjunct);
    } else {
      assertions.set(assertion.name, assertion.term);
    }
  }
  return { assertions, residual: residual.length === 0 ? undefined : conjunctionOf(c, residual) };
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

/**
 * Creates the strong assertion A⟨?x ≡ c⟩: `sameTerm(?x, c)`.
 * @param c - The transformation context
 * @param name - The name of the asserted variable
 * @param term - The term the variable is fixed to
 * @returns The assertion expression
 */
export function assertionExpression(c: TransformContext, name: string, term: RDF.Term): Algebra.Expression {
  return sameTermExpression(c, c.AF.createTermExpression(DF.variable(name)), term);
}

/**
 * Creates the weak assertion W⟨?x ≡ c⟩: `!bound(?x) || sameTerm(?x, c)`.
 *
 * The weak form keeps the solutions leaving `?x` unbound, which is what makes it usable on the right
 * hand side of a MINUS (anti-monotone in that argument) and pushable through operations that may leave
 * `?x` unbound.
 *
 * @param c - The transformation context
 * @param name - The name of the asserted variable
 * @param term - The term the variable is fixed to when it is bound
 * @returns The weak assertion expression
 */
export function weakAssertionExpression(c: TransformContext, name: string, term: RDF.Term): Algebra.Expression {
  const variable = c.AF.createTermExpression(DF.variable(name));
  return c.AF.createOperatorExpression('||', [
    c.AF.createOperatorExpression('!', [ c.AF.createOperatorExpression('bound', [ variable ]) ]),
    sameTermExpression(c, variable, term),
  ]);
}

/**
 * Creates the conjunction of the strong assertions in `assertions`.
 * @param c - The transformation context
 * @param assertions - The (non-empty) assertions to build a condition for
 * @returns A single condition equivalent to all assertions holding
 */
export function assertionsExpression(c: TransformContext, assertions: Assertions): Algebra.Expression {
  return conjunctionOf(c, [ ...assertions ].map(([ name, term ]) => assertionExpression(c, name, term)));
}

/**
 * Creates the conjunction of the weak assertions in `assertions`.
 * @param c - The transformation context
 * @param assertions - The (non-empty) assertions to build a condition for
 * @returns A single condition equivalent to all weak assertions holding
 */
export function weakAssertionsExpression(c: TransformContext, assertions: Assertions): Algebra.Expression {
  return conjunctionOf(c, [ ...assertions ].map(([ name, term ]) => weakAssertionExpression(c, name, term)));
}

/**
 * Splits a filter condition into the assertions it carries and what is left of it.
 *
 * The leftovers have the assertions substituted into them, per (FReord):
 * `σ_R(A) == σ_{simplify(R[θ])}(σ_θ(A))`. Substituting can turn a leftover into an assertion of its
 * own - `sameTerm(?y, ?x)` becomes `sameTerm(?y, c)` - so this repeats until no new assertion appears,
 * making assertions propagate through equalities between variables.
 *
 * @param c - The transformation context
 * @param expression - The filter condition to split
 * @param known - Assertions already known to hold at the filter (θ), folded into the condition
 * @returns The assertions and the residual condition (`undefined` when nothing is left), or
 *   `undefined` when the condition is contradictory and the filter is therefore empty
 */
export function collectAssertions(
  c: TransformContext,
  expression: Algebra.Expression,
  known: Assertions = new Map(),
): { assertions: Assertions; residual: Algebra.Expression | undefined; contradictory: false } | undefined {
  const assertions = new Map(known);
  let conjuncts = splitConjunction(substituteInExpression(c, expression, assertions));

  for (;;) {
    const residual: Algebra.Expression[] = [];
    let learned = false;
    for (const conjunct of conjuncts) {
      const constant = booleanConstantOf(conjunct);
      if (constant === false) {
        return undefined;
      }
      if (constant === true) {
        continue;
      }
      const assertion = asAssertion(conjunct);
      if (assertion === undefined) {
        residual.push(conjunct);
        continue;
      }
      const previous = assertions.get(assertion.name);
      if (previous === undefined) {
        assertions.set(assertion.name, assertion.term);
        learned = true;
      } else if (!previous.equals(assertion.term)) {
        // One variable cannot be two distinct terms at once.
        return undefined;
      }
    }
    if (!learned) {
      return {
        assertions,
        residual: residual.length === 0 ? undefined : conjunctionOf(c, residual),
        contradictory: false,
      };
    }
    // What we just learned may collapse a leftover into an assertion, so go around once more.
    conjuncts = residual.flatMap(conjunct => splitConjunction(substituteInExpression(c, conjunct, assertions)));
  }
}

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
  const { AF } = c;
  switch (expression.subType) {
    case Algebra.ExpressionTypes.TERM: {
      const term = expression.term;
      const asserted = term.termType === 'Variable' ? assertions.get(term.value) : undefined;
      return asserted === undefined ? expression : AF.createTermExpression(asserted);
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
      return foldOperator(c, expression.operator, expression.args
        .map(arg => substituteInExpression(c, arg, assertions)));
    }
    case Algebra.ExpressionTypes.EXISTENCE:
      // EXISTS substitutes the current solution into its pattern anyway, and every solution reaching
      // this expression has ?x bound to c, so this is a propagation route rather than a repair.
      return AF.createExistenceExpression(
        expression.not,
        substituteAssertedVariables(c, expression.input, assertions),
      );
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
 * Folds an operator expression whose arguments are (partly) constant.
 *
 * Only the folds that are sound under SPARQL's error handling are applied. Notably `=` folds to `true`
 * for two identical terms - RDF term equality is the fallback for unsupported datatypes - but never to
 * `false`, since comparing terms of unsupported datatypes raises an error, and an error is not `false`
 * everywhere (`!(error)` is an error, not `true`).
 */
function foldOperator(c: TransformContext, operator: string, args: Algebra.Expression[]): Algebra.Expression {
  const constants = args.map(arg => booleanConstantOf(arg));
  switch (operator) {
    case 'sameterm': {
      const [ left, right ] = args;
      if (args.length === 2 &&
        left.subType === Algebra.ExpressionTypes.TERM && isAssertableTerm(left.term) &&
        right.subType === Algebra.ExpressionTypes.TERM && isAssertableTerm(right.term)) {
        return createBooleanExpression(c, left.term.equals(right.term));
      }
      break;
    }
    case '=': {
      const [ left, right ] = args;
      if (args.length === 2 &&
        left.subType === Algebra.ExpressionTypes.TERM && isAssertableTerm(left.term) &&
        right.subType === Algebra.ExpressionTypes.TERM && isAssertableTerm(right.term) &&
        left.term.equals(right.term)) {
        return createBooleanExpression(c, true);
      }
      break;
    }
    case '!':
      if (args.length === 1 && constants[0] !== undefined) {
        return createBooleanExpression(c, !constants[0]);
      }
      break;
    case '&&':
      // `false && error` is false, and `true && X` is X (an erroring X keeps erroring), so both the
      // absorbing and the neutral element may be folded away.
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
 * Drops the arguments of an `&&` / `||` that are its neutral element, keeping the operator only when
 * more than one argument is left.
 */
function neutralFold(
  c: TransformContext,
  args: Algebra.Expression[],
  constants: (boolean | undefined)[],
  neutral: boolean,
): Algebra.Expression {
  const remaining = args.filter((_, index) => constants[index] !== neutral);
  if (remaining.length === 0) {
    return createBooleanExpression(c, neutral);
  }
  if (remaining.length === 1) {
    return remaining[0];
  }
  return c.AF.createOperatorExpression(neutral ? '&&' : '||', remaining);
}

/**
 * Substitutes assertions into a graph pattern, the way SPARQL's `substitute()` inlines a solution
 * mapping into the pattern of an `EXISTS`.
 *
 * Only *free* occurrences are replaced: a variable the pattern assigns to itself (a BIND, a VALUES
 * column, a GROUP BY key, an aggregate target or a subquery projection) is left alone. Substituting
 * those would produce an illegal pattern, and skipping a substitution is always sound.
 *
 * @param c - The transformation context
 * @param op - The pattern to substitute into
 * @param assertions - The assertions to substitute (θ)
 * @returns The pattern with the asserted variables replaced by their terms
 */
export function substituteAssertedVariables(
  c: TransformContext,
  op: Algebra.Operation,
  assertions: Assertions,
): Algebra.Operation {
  const assigned = variablesAssignedIn(op);
  const free = new Map([ ...assertions ].filter(([ name ]) => !assigned.has(name)));
  if (free.size === 0) {
    return op;
  }
  // The substitution rewrites the pattern, so whatever `withCpVars` cached about it no longer describes
  // it - and a cached set does not survive the generic traversal below to begin with.
  const target = withoutCpVars(op);
  const { AF } = c;
  const subExpr = (expression: Algebra.Expression): Algebra.Expression =>
    substituteInExpression(c, expression, free);

  return algebraUtils.mapOperation<'unsafe', Algebra.Operation>(target, {
    [Algebra.Types.BGP]: { transform: bgp => AF.createBgp(
      // A term that cannot occupy the position it lands in leaves the pattern alone: the pattern
      // matching nothing is expressed by this pass at the operation level, not inside an EXISTS.
      bgp.patterns.map(pattern => substituteInPattern(c, pattern, free) ?? pattern),
    ) },
    [Algebra.Types.PATH]: { transform: path => AF.createPath(
      substituteInTerm(path.subject, free, 'object') ?? path.subject,
      path.predicate,
      substituteInTerm(path.object, free, 'object') ?? path.object,
      substituteInTerm(path.graph, free, 'graph') ?? path.graph,
    ) },
    [Algebra.Types.GRAPH]: { transform: (graph) => {
      const name = graph.name.termType === 'Variable' ? free.get(graph.name.value) : undefined;
      return name?.termType === 'NamedNode' ? AF.createGraph(graph.input, name) : graph;
    } },
    [Algebra.Types.SERVICE]: { transform: (service) => {
      const name = service.name.termType === 'Variable' ? free.get(service.name.value) : undefined;
      return name?.termType === 'NamedNode' ?
        AF.createService(service.input, name, service.silent) :
        service;
    } },
    [Algebra.Types.FILTER]: {
      preVisitor: () => ({ ignoreKeys: new Set([ 'expression' ]) }),
      transform: filter => AF.createFilter(filter.input, subExpr(filter.expression)),
    },
    [Algebra.Types.EXTEND]: {
      preVisitor: () => ({ ignoreKeys: new Set([ 'expression', 'variable' ]) }),
      transform: extend => AF.createExtend(extend.input, extend.variable, subExpr(extend.expression)),
    },
    [Algebra.Types.ORDER_BY]: {
      preVisitor: () => ({ ignoreKeys: new Set([ 'expressions' ]) }),
      transform: orderBy => AF.createOrderBy(orderBy.input, orderBy.expressions.map(subExpr)),
    },
    [Algebra.Types.GROUP]: {
      preVisitor: () => ({ ignoreKeys: new Set([ 'aggregates', 'variables' ]) }),
      transform: group => AF.createGroup(
        group.input,
        group.variables,
        group.aggregates.map(aggregate => ({ ...aggregate, expression: subExpr(aggregate.expression) })),
      ),
    },
  });
}

/**
 * Collects the variables an operation assigns to itself, rather than reads: BIND targets, VALUES
 * columns, GROUP BY keys, aggregate targets and projected variables.
 */
function variablesAssignedIn(op: Algebra.Operation): Set<string> {
  const names = new Set<string>();
  algebraUtils.visitOperation(op, {
    [Algebra.Types.EXTEND]: { visitor: extend => names.add(extend.variable.value) },
    [Algebra.Types.VALUES]: { visitor: (values) => {
      for (const variable of values.variables) {
        names.add(variable.value);
      }
    } },
    [Algebra.Types.PROJECT]: { visitor: (project) => {
      for (const variable of project.variables) {
        names.add(variable.value);
      }
    } },
    [Algebra.Types.GROUP]: { visitor: (group) => {
      for (const variable of group.variables) {
        names.add(variable.value);
      }
      for (const aggregate of group.aggregates) {
        names.add(aggregate.variable.value);
      }
    } },
  });
  return names;
}

/** The position a term takes in a quad pattern, which decides what kind of term may occupy it. */
type TermPosition = 'graph' | 'object' | 'predicate' | 'subject';

/**
 * Decides whether a term can occupy a position of an RDF triple at all.
 *
 * No triple has a literal or a triple term as its subject, predicate or graph name, and no triple has
 * anything but an IRI as its predicate - so substituting such a term into that position makes the
 * pattern match nothing, whatever the data is. Variables (the ones no assertion substitutes) may
 * occupy any position.
 *
 * @param term - The term that would occupy the position
 * @param position - The position within the quad pattern
 * @returns True when a triple with this term in this position can exist
 */
function canOccupy(term: RDF.Term, position: TermPosition): boolean {
  if (position === 'object' || term.termType === 'Variable') {
    return true;
  }
  if (position === 'predicate') {
    return term.termType === 'NamedNode';
  }
  return term.termType !== 'Literal' && term.termType !== 'Quad';
}

/**
 * Substitutes assertions into a term, recursing into triple terms.
 *
 * @param term - The term to substitute into
 * @param assertions - The assertions to substitute (θ)
 * @param position - The position the term occupies in its pattern
 * @returns The substituted term, or `undefined` when the substitution puts a term in a position no
 *   RDF triple can have it in
 */
export function substituteInTerm(
  term: RDF.Term,
  assertions: Assertions,
  position: TermPosition,
): RDF.Term | undefined {
  if (term.termType === 'Variable') {
    const asserted = assertions.get(term.value);
    if (asserted === undefined) {
      return term;
    }
    return canOccupy(asserted, position) ? asserted : undefined;
  }
  if (term.termType === 'Quad') {
    const subject = substituteInTerm(term.subject, assertions, 'subject');
    const predicate = substituteInTerm(term.predicate, assertions, 'predicate');
    const object = substituteInTerm(term.object, assertions, 'object');
    const graph = substituteInTerm(term.graph, assertions, 'graph');
    if (subject === undefined || predicate === undefined || object === undefined || graph === undefined) {
      return undefined;
    }
    return DF.quad(
      <RDF.Quad_Subject> subject,
      <RDF.Quad_Predicate> predicate,
      <RDF.Quad_Object> object,
      <RDF.Quad_Graph> graph,
    );
  }
  return term;
}

/**
 * Substitutes assertions into a single triple/quad pattern.
 *
 * @param c - The transformation context
 * @param pattern - The pattern to substitute into
 * @param assertions - The assertions to substitute (θ)
 * @returns The substituted pattern, or `undefined` when the pattern can no longer match any triple
 */
export function substituteInPattern(
  c: TransformContext,
  pattern: Algebra.Pattern,
  assertions: Assertions,
): Algebra.Pattern | undefined {
  const subject = substituteInTerm(pattern.subject, assertions, 'subject');
  const predicate = substituteInTerm(pattern.predicate, assertions, 'predicate');
  const object = substituteInTerm(pattern.object, assertions, 'object');
  const graph = substituteInTerm(pattern.graph, assertions, 'graph');
  if (subject === undefined || predicate === undefined || object === undefined || graph === undefined) {
    return undefined;
  }
  return c.AF.createPattern(subject, predicate, object, graph);
}
