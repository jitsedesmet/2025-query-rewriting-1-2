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
 * A condition is read for all three forms at once, into the single {@link AssertionConjunction} the
 * pushdown moves around.
 */

/**
 * A set of assertions θ: variable name to the single ground term it is fixed to, i.e. `σ_{sameTerm(?x, c)}`.
 *
 * This is the *substitutable* form - the map every `substituteIn...` helper takes - which is why the
 * weak and unbound assertions of an {@link AssertionConjunction} are kept out of it, see
 * {@link strongTermsOf}.
 */
export type Assertions = ReadonlyMap<string, RDF.Term>;

/**
 * One assertion about one variable, in one of the three forms this pass moves around.
 *
 * - `strong` is A⟨?x ≡ c⟩ ≔ `sameTerm(?x, c)`, which implies `bound(?x)`.
 * - `weak` is W⟨?x ≡ c⟩ ≔ `!bound(?x) || sameTerm(?x, c)`, which does not - it is what survives a move
 *   into a place that may leave the variable unbound (the RHS of a MINUS, the unlicensed operand of a join).
 * - `unbound` is U⟨?x⟩ ≔ `!bound(?x)`.
 *
 * The third form is what the conjunction of two *different* weak assertions about one variable comes to:
 * `(¬b ∨ ?x ≡ c) ∧ (¬b ∨ ?x ≡ d)` distributes to `¬b ∨ (?x ≡ c ∧ ?x ≡ d)`, which for `c ≠ d` is `¬b`.
 * Without it {@link mergeAssertion} would have nowhere to put that fact - it has no term - and would have
 * to leave the conjunct behind as a residual. It is also SPARQL's negation idiom
 * (`OPTIONAL { … } FILTER(!bound(?x))`), so it is the form assertions most often *start* in.
 *
 * Only the strong form may be substituted into a pattern: the other two say what the variable is *not*
 * bound to, not that it is bound.
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
 * The conjunction of assertions that travels through the plan: one entry per variable, since
 * {@link mergeAssertion} merges a second assertion about a variable into the first.
 */
export type AssertionConjunction = ReadonlyMap<string, Assertion>;

/**
 * The strong assertions of a conjunction, in the form the substitution helpers take.
 *
 * Dropping the other two is the point: substituting `c` for `?x` under W⟨?x ≡ c⟩ would claim `?x` is
 * bound, and folding `bound(?x)` to `true` under it would be wrong.
 */
export function strongTermsOf(assertions: AssertionConjunction): Assertions {
  return new Map([ ...assertions ]
    .filter(([ , assertion ]) => assertion.subType === 'strong')
    .map(([ name, assertion ]) => [ name, (<{ term: RDF.Term }> assertion).term ]));
}

/**
 * What the top level conjunction of a filter condition says about single variables, cached on the filter
 * the way {@link CPMeta} is cached on any operation.
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
 * Like {@link withCpVars}, this is dynamic programming: a filter this pass created already knows its own
 * assertions, and one met in the input tree is analysed once and carries the result from then on.
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
 * one variable to one term, and the contradictory ones (which are the empty operation). Anything else is
 * left where it is, and the traversal keeps descending into it looking for the filters deeper down.
 */
export function isAssertionFilter(c: TransformContext, op: Algebra.Operation): op is AssertionFilter {
  if (op.type !== Algebra.Types.FILTER) {
    return false;
  }
  const { assertions } = withAssertionConjunction(c, op).metadata;
  return assertions.contradictory || assertions.assertions.size > 0;
}

/** Whether an assertion may fix a variable to this term, i.e. whether this pass may substitute it. */
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
 * Recognizes the strong assertion a single conjunct carries: `sameTerm(?x, c)` or `sameTerm(c, ?x)`.
 *
 * Never generalise this to `=`: `?x = "01"^^xsd:integer` holds of the *term* `"1"^^xsd:integer`, so
 * substituting under `=` would drop solutions. An `=` against an IRI is the one place the two coincide,
 * and {@link constantFoldOperator} has already rewritten that into the `sameTerm` read here.
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

/** Recognizes the *weak* assertion a single conjunct carries: `!bound(?x) || sameTerm(?x, c)`. */
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

/** Recognizes the assertion a single conjunct carries, in whichever of the three forms it is written. */
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
 * Merges a newly met assertion about a variable into what is already known about it,
 * or returns `undefined` when nothing satisfies both.
 *
 * With all three forms available this is total: a conjunction of assertions about one variable is again
 * an assertion about it, or unsatisfiable.
 *
 * - Same term: `A ∧ W ≡ A`, so the weak form of something known strongly changes nothing, and the strong
 *      form of something known weakly *promotes* it.
 * - Different terms, one of them strong: contradiction - `?x` cannot be `c` and also unbound or `d`.
 * - Different terms, both weak: `U⟨?x⟩`, the case the third form exists for.
 * - Anything against `U⟨?x⟩`: it absorbs the weak form (`¬b ∧ (¬b ∨ …) ≡ ¬b`) and contradicts the strong
 *      one, which implies `bound(?x)`.
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

/** Creates the strong assertion A⟨?x ≡ c⟩: `sameTerm(?x, c)`. */
export function assertionExpression(c: TransformContext, name: string, term: RDF.Term): Algebra.Expression {
  return sameTermExpression(c, c.AF.createTermExpression(DF.variable(name)), term);
}

/**
 * Creates the weak assertion W⟨?x ≡ c⟩: `!bound(?x) || sameTerm(?x, c)`.
 *
 * Keeping the solutions that leave `?x` unbound is what makes it usable on the RHS of a MINUS
 * (anti-monotone in that argument) and pushable through operations that may leave `?x` unbound.
 */
export function weakAssertionExpression(c: TransformContext, name: string, term: RDF.Term): Algebra.Expression {
  const variable = c.AF.createTermExpression(DF.variable(name));
  return c.AF.createOperatorExpression('||', [
    c.AF.createOperatorExpression('!', [ c.AF.createOperatorExpression('bound', [ variable ]) ]),
    sameTermExpression(c, variable, term),
  ]);
}

/** Creates the unbound assertion U⟨?x⟩: `!bound(?x)`. */
export function unboundAssertionExpression(c: TransformContext, name: string): Algebra.Expression {
  return c.AF.createOperatorExpression('!', [
    c.AF.createOperatorExpression('bound', [ c.AF.createTermExpression(DF.variable(name)) ]),
  ]);
}

/** Creates the single condition the (non-empty) assertions stand for, each in the form it carries. */
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
 * Splits a filter condition into the assertions it carries and what is left of it, folding in the
 * assertions `known` to already hold there (θ). Returns `undefined` when the condition is contradictory,
 * making the filter empty.
 *
 * The leftovers have the *strong* assertions substituted into them, per (FReord):
 * `σ_R(A) == σ_{simplify(R[θ])}(σ_θ(A))`. That can turn a leftover into an assertion of its own -
 * `sameTerm(?y, ?x)` becomes `sameTerm(?y, c)` - so this repeats until no new assertion appears, making
 * assertions propagate through equalities between variables. Doing it here rather than leaving it to
 * Extend push up keeps the pass single-traversal, filter-false generation included.
 *
 * Merging into the known assertions ({@link mergeAssertion}) is also what makes the pass idempotent:
 * re-running it re-derives the same conjunction and absorbs it rather than stacking a second copy.
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
 * Whether a triple with this term in this position can exist at all.
 *
 * No triple has a literal or a triple term as its subject, predicate or graph name, and none has
 * anything but an IRI as its predicate - so substituting such a term there makes the pattern match
 * nothing, whatever the data is. Variables may occupy any position.
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
 * Substitutes assertions (θ) into a term, recursing into triple terms. `undefined` when the result lands
 * a term in a position no RDF triple can have it in.
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
 * Substitutes assertions (θ) into a single triple/quad pattern, or `undefined` when the result can no
 * longer match any triple.
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
