import type * as RDF from '@rdfjs/types';
import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import type { CPMeta } from './certainlyBoundVars.js';
import { booleanConstantOf, conjunctionOf, sameTermExpression, splitConjunction } from './expressionHelpers.js';
import { substituteInExpression } from './partialExpressionEvaluation.js';
import { DF } from './rdfDatatypes.js';

/**
 * @fileoverview The assertion (`FILTER(sameTerm(?x, c))`) toolbox: recognizing the assertions a filter
 * condition carries, building them, and substituting them into expressions and patterns.
 *
 * Both forms live here - the strong A⟨?x ≡ c⟩ and the weak W⟨?x ≡ c⟩ ≔ `!bound(?x) || sameTerm(?x, c)`
 * - and a filter condition is read for both at once, into the single {@link AssertionConjunction} the
 * pushdown moves around.
 */

/**
 * A set of assertions θ: a (partial) map from variable name to the single ground term that variable is
 * fixed to. Written A⟨?x ≡ c⟩ in the design, i.e. `σ_{sameTerm(?x, c)}`.
 *
 * A variable never maps to two terms - a condition asserting one is contradictory and yields the empty
 * result instead of an entry in this map.
 *
 * This is the *substitutable* form: the map every `substituteIn...` helper takes, and the reason the
 * weak assertions of an {@link AssertionConjunction} are kept out of it. See {@link strongTermsOf}.
 */
export type Assertions = ReadonlyMap<string, RDF.Term>;

/**
 * One assertion about one variable, in one of the three forms this pass moves around.
 *
 * - `strong` is A⟨?x ≡ c⟩ ≔ `sameTerm(?x, c)`, which implies `bound(?x)`.
 * - `weak` is W⟨?x ≡ c⟩ ≔ `!bound(?x) || sameTerm(?x, c)`, which does not - it is what survives a move
 *   into a place that may leave the variable unbound (the right hand side of a MINUS, the unlicensed
 *   operand of a join).
 * - `unbound` is U⟨?x⟩ ≔ `!bound(?x)`, which says the variable is bound to nothing at all.
 *
 * The third one is not a stylistic addition: it is what the conjunction of two *different* weak
 * assertions about one variable is. `(¬b ∨ ?x ≡ c) ∧ (¬b ∨ ?x ≡ d)` distributes to
 * `¬b ∨ (?x ≡ c ∧ ?x ≡ d)`, and for `c ≠ d` the right disjunct is false, leaving exactly `¬b`. Without
 * this form {@link mergeAssertion} would have nowhere to put that - the fact has no term - and the
 * second conjunct would have to be left behind as a residual, taking its emptiness rule with it. It
 * happens to be the SPARQL negation idiom (`OPTIONAL { … } FILTER(!bound(?x))`) as well, so it is the
 * form assertions most often *start* in.
 *
 * Only the strong form may be substituted into a pattern: the other two do not say the variable is
 * bound to the term, only what it is not bound to.
 */
interface BaseAssertion {
  type: 'assertion';
  subType: string;
}
export interface StrongAssertion<T extends RDF.Term = RDF.Term> extends BaseAssertion {
  subType: 'strong';
  term: T;
}
export interface WeakAssertion<T extends RDF.Term = RDF.Term> extends BaseAssertion {
  subType: 'weak';
  term: T;
}
export interface UnboundAssertion extends BaseAssertion {
  subType: 'unbound';
}
export type Assertion = StrongAssertion | WeakAssertion | UnboundAssertion;

export function assertStrong<T extends RDF.Term>(term: T): StrongAssertion<T> {
  return {
    type: 'assertion',
    subType: 'strong',
    term,
  };
}
export function assertWeak<T extends RDF.Term>(term: T): WeakAssertion<T> {
  return {
    type: 'assertion',
    subType: 'weak',
    term,
  };
}
export function assertUnbound(): UnboundAssertion {
  return {
    type: 'assertion',
    subType: 'unbound',
  };
}

/**
 * The conjunction of assertions that travels through the plan: one entry per variable. A variable never
 * has two entries - {@link mergeAssertion} merges a second assertion about it into the first, and with
 * `unbound` available it can always do so.
 */
export type AssertionConjunction = ReadonlyMap<string, Assertion>;

/**
 * The strong assertions of a conjunction, in the form the substitution helpers take.
 *
 * Dropping the other two is the whole point: substituting `c` for `?x` under W⟨?x ≡ c⟩ would claim
 * `?x` is bound, and folding `bound(?x)` to `true` under it would be plainly wrong.
 *
 * @param assertions - The conjunction to take the strong part of
 * @returns The variable to term map of its strong assertions
 */
export function strongTermsOf(assertions: AssertionConjunction): Assertions {
  return new Map([ ...assertions ]
    .filter(([ , assertion ]) => assertion.subType === 'strong')
    .map(([ name, assertion ]) => [ name, (<{ term: RDF.Term }> assertion).term ]));
}

/**
 * What the top level conjunction of a filter condition says about single variables, cached on the filter
 * the way {@link CPMeta} is cached on any operation.
 *
 * This is the state the pushdown threads through the plan: the conjunction of assertions that still
 * holds at the point the filter sits at, plus whatever is left of the condition it came from.
 */
export interface AssertionConjunctionMeta {
  /** The assertions (θ) the top level conjunction carries, keyed by variable name. */
  assertions: AssertionConjunction;
  /**
   * What is left of the condition once the assertions are taken out of it, with the strong ones
   * substituted into it (FReord), or `undefined` when the assertions are all there was.
   */
  residual: Algebra.Expression | undefined;
  /**
   * Whether the conjunction contradicts itself - one variable asserted to be two distinct terms, or a
   * conjunct that folded to `false`. Such a filter is the empty operation.
   */
  contradictory: boolean;
}

/** A filter of which we know what its top level conjunction says about single variables. */
export type AssertionFilter = Algebra.Filter & {
  metadata: Partial<CPMeta> & { assertions: AssertionConjunctionMeta };
};

/**
 * Attaches - or reuses - the {@link AssertionConjunctionMeta} of a filter.
 *
 * Like {@link withCpVars}, this is dynamic programming rather than a computation: a filter this pass
 * created knows its own assertions already, and one it meets in the input tree is analysed once and
 * carries the result from then on.
 *
 * @param c - The transformation context
 * @param filter - The filter to analyse
 * @returns The same filter, with its `assertions` metadata guaranteed to be present
 */
export function withAssertionConjunction(c: TransformContext, filter: Algebra.Filter): AssertionFilter {
  const casted = <Algebra.Filter & { metadata?: Partial<AssertionFilter['metadata']> }> filter;
  const known = casted.metadata?.assertions;
  if (known === undefined) {
    const collected = collectAssertions(c, filter.expression);
    casted.metadata ??= {};
    casted.metadata.assertions = collected ?? {
      assertions: new Map(),
      residual: undefined,
      contradictory: true,
    };
  }
  return <AssertionFilter> casted;
}

/**
 * Guard recognizing the filters this pass is about: the ones whose top level conjunction fixes at least
 * one variable to one term - strongly or weakly - and the contradictory ones (which are the empty
 * operation).
 *
 * Fails fast on anything else - a filter carrying no assertion is left where it is, and the traversal
 * simply keeps descending into it looking for the ones deeper down.
 *
 * @param c - The transformation context
 * @param op - The operation to inspect
 * @returns Whether the operation is a filter carrying assertions, narrowing it to {@link AssertionFilter}
 */
export function isAssertionFilter(c: TransformContext, op: Algebra.Operation): op is AssertionFilter {
  if (op.type !== Algebra.Types.FILTER) {
    return false;
  }
  const { assertions } = withAssertionConjunction(c, op).metadata;
  return assertions.contradictory || assertions.assertions.size > 0;
}

/**
 * Decides whether a term can be substituted for a variable by this pass.
 * @returns True when an assertion may fix a variable to this term
 */
export function isAssertableTerm(term: RDF.Term): boolean {
  // Blank nodes need no exclusion here: by the time this pass runs, the ones in a WHERE clause have
  // already been converted to variables, so no assertion can ever carry one.
  // Simply check whether a variable appears in a quad.
  if (term.termType === 'Quad') {
    return [ term.subject, term.predicate, term.object, term.graph ].every(x => isAssertableTerm(x));
  }
  return term.termType !== 'Variable';
}

/**
 * Recognizes the assertion a single conjunct carries: `sameTerm(?x, c)` or `sameTerm(c, ?x)`.
 *
 * `sameTerm` - not `=` - is what makes the substitution this pass performs sound: `?x = "01"^^xsd:integer`
 * holds of the *term* `"1"^^xsd:integer`, so substituting under `=` would drop solutions. Never
 * generalise this to `=`. An `=` against an IRI is not such a generalisation - the two functions
 * coincide there - and {@link constantFoldOperator} has already rewritten it into the `sameTerm` this reads.
 *
 * @param expression - The conjunct to inspect
 * @returns The asserted variable and term, or `undefined` when the conjunct is not an assertion
 */
export function asStrongAssertion(expression: Algebra.Expression):
    { name: string; assertion: StrongAssertion } | undefined {
  if (expression.subType === Algebra.ExpressionTypes.OPERATOR &&
    expression.operator === 'sameterm' &&
    expression.args.length === 2) {
    const [ left, right ] = expression.args;
    if (left.subType === 'term' && right.subType === 'term') {
      if (left.term.termType === 'Variable' && isAssertableTerm(right.term)) {
        return { name: left.term.value, assertion: assertStrong(right.term) };
      }
      if (right.term.termType === 'Variable' && isAssertableTerm(left.term)) {
        return { name: right.term.value, assertion: assertStrong(left.term) };
      }
    }
  }
  return undefined;
}

/**
 * Recognizes the *weak* assertion a single conjunct carries: `!bound(?x) || sameTerm(?x, c)`.
 *
 * @param expression - The conjunct to inspect
 * @returns The variable and term of the weak assertion, or `undefined` when it is not one
 */
export function asWeakAssertion(expression: Algebra.Expression):
    { name: string; assertion: WeakAssertion } | undefined {
  if (expression.subType === Algebra.ExpressionTypes.OPERATOR &&
    expression.operator === '||' && expression.args.length === 2) {
    for (const [ index, arg ] of expression.args.entries()) {
      const bound = variableOfNotBound(arg);
      if (bound !== undefined) {
        const assertion = asStrongAssertion(expression.args[index === 0 ? 1 : 0]);
        if (assertion !== undefined && assertion.name === bound) {
          return { name: bound, assertion: assertWeak(assertion.assertion.term) };
        }
      }
    }
  }
  return undefined;
}

/**
 * Recognizes the assertion a single conjunct carries, in whichever of the three forms it is written.
 *
 * @param expression - The conjunct to inspect
 * @returns The variable it is about and what it says, or `undefined` when it is not an assertion
 */
export function assertionOf(expression: Algebra.Expression): { name: string; assertion: Assertion } | undefined {
  const strong = asStrongAssertion(expression);
  if (strong !== undefined) {
    return strong;
  }
  const weak = asWeakAssertion(expression);
  if (weak !== undefined) {
    return weak;
  }
  const unbound = variableOfNotBound(expression);
  return unbound === undefined ? undefined : { name: unbound, assertion: assertUnbound() };
}

/** The variable of a `!bound(?x)` expression, if that is what it is. */
function variableOfNotBound(expression: Algebra.Expression): string | undefined {
  if (expression.subType === Algebra.ExpressionTypes.OPERATOR && expression.operator === '!' &&
    expression.args.length === 1) {
    const [ bound ] = expression.args;
    if (bound.subType === Algebra.ExpressionTypes.OPERATOR && bound.operator === 'bound' && bound.args.length === 1) {
      const [ argument ] = bound.args;
      if (argument.subType === Algebra.ExpressionTypes.TERM && argument.term.termType === 'Variable') {
        return argument.term.value;
      }
    }
  }
  return undefined;
}

/**
 * Merges a newly met assertion about a variable into what is already known about it.
 *
 * With all three forms available this is total:
 * every conjunction of assertions about one variable is again an assertion about that variable, or it is unsatisfiable.
 *
 * - Same term: `A ∧ W ≡ A`, so meeting the weak form of something known strongly changes nothing,
 *      and meeting the strong form of something known weakly *promotes* it.
 * - Different terms, one of them strong: a contradiction - `?x` cannot be `c` and also be either unbound or `d`.
 * - Different terms, both weak: `U⟨?x⟩`. This is the case the third form exists for.
 * - Anything against `U⟨?x⟩`: it absorbs the weak form (`¬b ∧ (¬b ∨ …) ≡ ¬b`)
 *     and contradicts the strong one, which implies `bound(?x)`.
 *
 * @param previous - What is already known about the variable, if anything
 * @param next - The assertion just met
 * @returns The merged assertion, or undefined when nothing satisfies both
 */
export function mergeAssertion(
  previous: Assertion | undefined,
  next: Assertion,
): Assertion | undefined {
  if (previous === undefined) {
    return next;
  }
  if (previous.subType === 'unbound' || next.subType === 'unbound') {
    // Cannot be both asserted unbound and strongly asserted
    return previous.subType === 'strong' || next.subType === 'strong' ? undefined : assertUnbound();
  }
  if (previous.term.equals(next.term)) {
    return previous.subType === 'strong' || next.subType === 'strong' ?
      assertStrong(previous.term) :
      previous;
  }
  return previous.subType === 'strong' || next.subType === 'strong' ? undefined : assertUnbound();
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
 * Creates the unbound assertion U⟨?x⟩: `!bound(?x)`.
 * @param c - The transformation context
 * @param name - The name of the variable that is bound to nothing
 * @returns The unbound assertion expression
 */
export function unboundAssertionExpression(c: TransformContext, name: string): Algebra.Expression {
  return c.AF.createOperatorExpression('!', [
    c.AF.createOperatorExpression('bound', [ c.AF.createTermExpression(DF.variable(name)) ]),
  ]);
}

/**
 * Creates the conjunction the assertions stand for, each in the form it carries.
 * @param c - The transformation context
 * @param assertions - The (non-empty) assertions to build a condition for
 * @returns A single condition equivalent to all assertions holding
 */
export function assertionsExpression(c: TransformContext, assertions: AssertionConjunction): Algebra.Expression {
  return conjunctionOf(c, [ ...assertions ].map(([ name, assertion ]) => {
    if (assertion.subType === 'unbound') {
      return unboundAssertionExpression(c, name);
    }
    return assertion.subType === 'strong' ?
      assertionExpression(c, name, assertion.term) :
      weakAssertionExpression(c, name, assertion.term);
  }));
}

/**
 * Splits a filter condition into the assertions it carries - in either form - and what is left of it.
 *
 * The leftovers have the *strong* assertions substituted into them, per (FReord):
 * `σ_R(A) == σ_{simplify(R[θ])}(σ_θ(A))`. Substituting can turn a leftover into an assertion of its
 * own - `sameTerm(?y, ?x)` becomes `sameTerm(?y, c)` - so this repeats until no new assertion appears,
 * making assertions propagate through equalities between variables.
 * We do this both here and in Extend push up since,
 * doing it here ensures we do all we can in one pass and do not need many passes, including generating filter-false.
 *
 * Meeting an assertion already known is what merges a travelling conjunction with the filters it
 * passes, and what makes the pass idempotent: re-running it re-derives the same conjunction and
 * absorbs it rather than stacking a second copy. See {@link mergeAssertion}.
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
  known: AssertionConjunction = new Map(),
): AssertionConjunctionMeta | undefined {
  // Make copy and perform substitution
  const assertions = new Map(known);
  let conjuncts = splitConjunction(substituteInExpression(c, expression, strongTermsOf(assertions)));

  let learned = true;
  let residual: Algebra.Expression[] = [];
  while (learned) {
    residual = [];
    learned = false;

    for (const conjunct of conjuncts) {
      const constant = booleanConstantOf(conjunct);
      if (constant === false) {
        // Filter is filter false
        return undefined;
      }
      if (constant === true) {
        // Conjunct does not add anything
        continue;
      }
      // Each form has its own top level operator, so at most one of these recognizes a conjunct.
      const met = assertionOf(conjunct);
      if (met === undefined) {
        residual.push(conjunct);
        continue;
      }
      // Check what we already know about this var.
      const previous = assertions.get(met.name);
      const merged = mergeAssertion(previous, met.assertion);
      // Shortcut contradictions
      if (merged === undefined) {
        return undefined;
      }
      assertions.set(met.name, merged);
      // Only a strong assertion we did not have yet changes what can be substituted below.
      learned ||= merged.subType === 'strong' && previous?.subType !== 'strong';
    }

    if (learned) {
      // What we just learned may collapse a leftover into an assertion, so go around once more.
      const strongTerms = strongTermsOf(assertions);
      conjuncts = residual.flatMap(conjunct => splitConjunction(substituteInExpression(c, conjunct, strongTerms)));
    }
  }
  return {
    assertions,
    residual: residual.length === 0 ? undefined : conjunctionOf(c, residual),
    contradictory: false,
  };
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
