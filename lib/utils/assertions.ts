import type * as RDF from '@rdfjs/types';
import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { termVars } from './certainlyBoundVars.js';
import { DF } from './rdfDatatypes.js';

/**
 * @fileoverview The assertion (`FILTER(sameTerm(?x, c))`) toolbox: recognizing the assertions a filter
 * condition carries, building them, and substituting them into expressions and patterns.
 *
 * A condition is read for all of the forms at once, into the single {@link AssertionConjunction} the
 * pushdown moves around.
 */

/**
 * A set of assertions θ: variable name to the single term it is fixed to, i.e. `σ_{sameTerm(?x, c)}`.
 *
 * This is the *substitutable* form - the map every `substituteIn...` helper takes - which is why the
 * weak, unbound and bound assertions of an {@link AssertionConjunction} are kept out of it, see
 * {@link AssertionConjunction.expressionSubstitution}. The term may be a *variable*: that is what a
 * unification substitutes, replacing every member of a clique by the representative of it.
 */
export type Assertions = ReadonlyMap<string, RDF.Term>;

/** The position a component takes in a triple term, which is also the accessor that reads it. */
export type TriplePosition = 'object' | 'predicate' | 'subject';

/**
 * A variable read through a chain of accessors: `?x`, `subject(?x)`, `object(subject(?x))`.
 *
 * An assertion is about one of these rather than about a variable, which is the whole of what triple
 * terms add: `sameTerm(subject(?o), ?s)` says something about a *part* of what `?o` is bound to, and the
 * conjunction has to be able to hold that without inventing a variable to name that part.
 */
export interface Access {
  name: string;
  positions: readonly TriplePosition[];
}

/** The identity of an access, for comparing and for ordering them deterministically. */
export function accessId(access: Access): string {
  return [ access.name, ...access.positions ].join('.');
}

/** The access that reads a variable itself. */
export function rootAccess(name: string): Access {
  return { name, positions: []};
}

/** The access that reads one position of what `access` reads. */
export function nestedAccess(access: Access, position: TriplePosition): Access {
  return { name: access.name, positions: [ ...access.positions, position ]};
}

/** Whether two accesses read the same thing in the same way. */
export function sameAccess(left: Access, right: Access): boolean {
  return accessId(left) === accessId(right);
}

/**
 * What an access is asserted to be equal to: another access (of which a bare variable is the
 * zero-length case), a term, or - the degenerate shape - a triple term of no particular structure.
 */
export type AssertionValue =
  | { kind: 'access'; access: Access }
  | { kind: 'term'; term: RDF.Term }
  | { kind: 'triple' };

export function accessValue(access: Access): AssertionValue {
  return { kind: 'access', access };
}
export function termValue(term: RDF.Term): AssertionValue {
  return { kind: 'term', term };
}
export const tripleValue: AssertionValue = { kind: 'triple' };

/** Reads a term as the value it stands for, normalising a variable to the access that reads it. */
export function valueOfTerm(term: RDF.Term): AssertionValue {
  return term.termType === 'Variable' ? accessValue(rootAccess(term.value)) : termValue(term);
}

/** The variable an assertion value is rooted at, if it is about one. */
export function valueRoot(value: AssertionValue): string | undefined {
  return value.kind === 'access' ? value.access.name : undefined;
}

/**
 * One assertion about one access, in one of the four forms this pass moves around.
 *
 * - `strong` is A⟨?x ≡ c⟩ ≔ `sameTerm(?x, c)`, which implies `bound(?x)`. Its value may be an access, in
 *   which case it is A⟨?x ≡ ?y⟩ - one edge of the clique an {@link AssertionConjunction} holds - or the
 *   degenerate shape T⟨?x⟩ ≔ `isTRIPLE(?x)`, which says only that the term is a triple term.
 * - `weak` is W⟨?x ≡ c⟩ ≔ `!bound(?x) || sameTerm(?x, c)`, which does not - it is what survives a move
 *   into a place that may leave the variable unbound (the RHS of a MINUS, the unlicensed operand of a join).
 * - `unbound` is U⟨?x⟩ ≔ `!bound(?x)`.
 * - `bound` is B⟨?x⟩ ≔ `bound(?x)`, which fixes the variable to no term at all.
 *
 * The third form is what the conjunction of two *different* weak assertions about one variable comes to:
 * `(¬b ∨ ?x ≡ c) ∧ (¬b ∨ ?x ≡ d)` distributes to `¬b ∨ (?x ≡ c ∧ ?x ≡ d)`, which for `c ≠ d` is `¬b`.
 * Without it {@link AssertionConjunction.assert} would have nowhere to put that fact - it has no term -
 * and would have to leave the conjunct behind as a residual. It is also SPARQL's negation idiom
 * (`OPTIONAL { … } FILTER(!bound(?x))`), so it is the form assertions most often *start* in.
 *
 * The fourth is the negation of the third, and the term-less half of the strong form: it says only that
 * the variable *is* bound, which is what SPARQL writes as `FILTER(bound(?x))`. It carries no term, so it
 * never substitutes into anything, but it decides the same emptiness rule the strong form does
 * ((FBndII): `?x ∉ pVars(A) ⟹ σ_{bound(?x)}(A) ≡ ∅`) and it *completes* a weak assertion into a strong
 * one - `b ∧ (¬b ∨ ?x ≡ c) ≡ ?x ≡ c` - which is where it earns its keep.
 *
 * `bound` and `unbound` are the two that stay restricted to an access of length zero: `BOUND` takes a
 * `Var` by grammar, and a position of a triple term is bound whenever the term itself is.
 *
 * Only the strong form may be substituted into a pattern: `weak` and `unbound` say what the variable is
 * *not* bound to rather than that it is bound, and `bound` says nothing about which term it is.
 */
interface BaseAssertion {
  type: 'assertion';
  subType: string;
}
export interface StrongAssertion extends BaseAssertion {
  subType: 'strong';
  value: AssertionValue;
}
export interface WeakAssertion extends BaseAssertion {
  subType: 'weak';
  value: AssertionValue;
}
export interface UnboundAssertion extends BaseAssertion {
  subType: 'unbound';
}
export interface BoundAssertion extends BaseAssertion {
  subType: 'bound';
}
export type Assertion = StrongAssertion | WeakAssertion | BoundAssertion | UnboundAssertion;

/** The value an assertion is written with, taking a term for the value it stands for. */
function asValue(value: AssertionValue | RDF.Term): AssertionValue {
  return 'kind' in value ? value : valueOfTerm(value);
}

export function assertStrong(value: AssertionValue | RDF.Term): StrongAssertion {
  return {
    type: 'assertion',
    subType: 'strong',
    value: asValue(value),
  };
}
export function assertWeak(value: AssertionValue | RDF.Term): WeakAssertion {
  return {
    type: 'assertion',
    subType: 'weak',
    value: asValue(value),
  };
}

export function assertBound(): BoundAssertion {
  return {
    type: 'assertion',
    subType: 'bound',
  };
}
export function assertUnbound(): UnboundAssertion {
  return {
    type: 'assertion',
    subType: 'unbound',
  };
}

/**
 * Whether the assertion implies `bound(?x)`, which is what the emptiness rule (FBndII) and every licence
 * that moves an assertion into a single operand are read off - the strong form and the bound form alike.
 *
 * T⟨?x⟩ is one of them: a triple term is a term, so a variable known to hold one is bound. That is what
 * lets a structural assertion collapse an OPTIONAL into a join.
 */
export function impliesBound(assertion: Assertion): assertion is BoundAssertion | StrongAssertion {
  return assertion.subType === 'strong' || assertion.subType === 'bound';
}

/**
 * Whether an assertion may fix a variable to this *ground* term, i.e. whether it may be substituted
 * anywhere the variable stands.
 *
 * A triple term is admitted exactly when it is ground, which is what makes it a term at all rather than a
 * *shape* - `<<( ?a ?b ?c )>>` says which triple the variable is the term of only once its components are
 * known, and until then it is the business of the pin lattice ({@link TermClusterSet}) instead.
 *
 * This is the same call the EXTEND case of {@link withCpVars} (`certainlyBoundVars.ts`) makes from the
 * other side, and the two agree: a ground triple term cannot raise an evaluation error, so
 * `BIND(<<( :a :b :c )>> AS ?t)` binds `?t` certainly, and an assertion on `?t` may be discharged as soon
 * as its term is decided - `BIND(e AS ?t)` under A⟨?t ≡ c⟩ becomes `Extend(σ_{sameTerm(e,c)}(A), ?t, c)`,
 * which for a decided `e` folds away without a row where `?t` was left unbound to worry about.
 */
export function isAssertableTerm(term: RDF.Term): boolean {
  // Ground *is* variable-free, so the two cases - a variable, and a triple term holding one - are the one
  // question {@link termVars} already answers, and the one `isStaticExpression` asks of a term expression.
  // Blank nodes need no exclusion here: by the time this pass runs, the ones in a WHERE clause have
  // already been converted to variables, so no assertion can ever carry one.
  return termVars(term).size === 0;
}

/** The accessor an operator expression reads a position with. */
const positionOfOperator: Record<string, TriplePosition> = {
  subject: 'subject',
  predicate: 'predicate',
  object: 'object',
};

/**
 * The access an expression reads: `?x`, `subject(?x)`, `object(subject(?x))` - or `undefined` when it
 * reads something else entirely.
 */
export function accessOf(expression: Algebra.Expression): Access | undefined {
  if (expression.subType === Algebra.ExpressionTypes.TERM) {
    return expression.term.termType === 'Variable' ? rootAccess(expression.term.value) : undefined;
  }
  if (expression.subType === Algebra.ExpressionTypes.OPERATOR && expression.args.length === 1) {
    const position = positionOfOperator[expression.operator];
    if (position !== undefined) {
      const inner = accessOf(expression.args[0]);
      return inner === undefined ? undefined : nestedAccess(inner, position);
    }
  }
  return undefined;
}

/**
 * Recognizes the strong assertion a single conjunct carries: `sameTerm(?x, c)`, `sameTerm(c, ?x)`, the
 * unification `sameTerm(?x, ?y)` - which is A⟨?x ≡ ?y⟩, a strong assertion whose value is an access - and
 * their structural versions, `sameTerm(subject(?o), ?s)` and `isTRIPLE(?o)`.
 *
 * `sameTerm(?o, <<( ?a ?b ?c )>>)` is read as well, and is the one form that does not round-trip
 * verbatim: it is written back as the structure it decomposes into, `sameTerm(subject(?o), ?a)` and so
 * on. The two differ only in what they do to a bound non-triple `?o` - the first is `false`, the second
 * an error - which as *conjuncts of a FILTER* is the same thing, since a filter drops the row either way.
 *
 * Never generalise this to `=`: `?x = "01"^^xsd:integer` holds of the *term* `"1"^^xsd:integer`, so
 * substituting under `=` would drop solutions. An `=` against an IRI is the one place the two coincide,
 * and {@link constantFoldOperator} has already rewritten that into the `sameTerm` read here.
 */
export function asStrongAssertion(expression: Algebra.Expression):
    { access: Access; assertion: StrongAssertion } | undefined {
  if (expression.subType !== Algebra.ExpressionTypes.OPERATOR) {
    return undefined;
  }
  // `isTRIPLE(?o)` is the degenerate shape: a triple term, nothing known about its parts.
  if (expression.operator === 'istriple' && expression.args.length === 1) {
    const access = accessOf(expression.args[0]);
    return access === undefined ? undefined : { access, assertion: assertStrong(tripleValue) };
  }
  if (expression.operator === 'sameterm' && expression.args.length === 2) {
    const [ left, right ] = expression.args;
    // Which side is read as the subject of the assertion does not matter for two accesses, since the
    // conjunction unifies them and picks the representative of the resulting group itself.
    const leftAccess = accessOf(left);
    if (leftAccess !== undefined) {
      const value = valueOfExpression(right);
      if (value !== undefined) {
        return { access: leftAccess, assertion: assertStrong(value) };
      }
    }
    const rightAccess = accessOf(right);
    if (rightAccess !== undefined) {
      const value = valueOfExpression(left);
      if (value !== undefined) {
        return { access: rightAccess, assertion: assertStrong(value) };
      }
    }
  }
  return undefined;
}

/**
 * The value an expression states, for the side of a `sameTerm` that is not the access being asserted.
 *
 * A triple term holding variables is admitted here although {@link isAssertableTerm} refuses it: it is
 * not a term the assertion can substitute, but it is a *shape* the conjunction can decompose, which is
 * what makes `sameTerm(?o, <<( ?a ?b ?c )>>)` say something at all.
 */
function valueOfExpression(expression: Algebra.Expression): AssertionValue | undefined {
  const access = accessOf(expression);
  if (access !== undefined) {
    return accessValue(access);
  }
  if (expression.subType === Algebra.ExpressionTypes.TERM && expression.term.termType !== 'Variable') {
    return termValue(expression.term);
  }
  return undefined;
}

/**
 * Recognizes the *weak* assertion a single conjunct carries: `!bound(?x) || sameTerm(?x, c)`, and its
 * structural versions `!bound(?o) || sameTerm(subject(?o), :a)` and `!bound(?o) || isTRIPLE(?o)`.
 *
 * Only a conjunct about the *one* variable the `!bound` is about has a weak form. `sameTerm(?x, ?y)` is
 * a clique edge, and reading `!bound(?x) || sameTerm(?x, ?y)` back as a weak unification would be the
 * unsound merge that form does not exist to avoid (see {@link AssertionConjunction}); the same argument
 * rules out `!bound(?o) || sameTerm(subject(?o), ?s)`. Those stay residual conditions instead.
 */
export function asWeakAssertion(expression: Algebra.Expression):
    { access: Access; assertion: WeakAssertion } | undefined {
  if (expression.subType === Algebra.ExpressionTypes.OPERATOR &&
    expression.operator === '||' && expression.args.length === 2) {
    for (const [ index, arg ] of expression.args.entries()) {
      const bound = variableOfNotBound(arg);
      if (bound !== undefined) {
        const strong = asStrongAssertion(expression.args[index === 0 ? 1 : 0]);
        if (strong !== undefined && strong.access.name === bound &&
          assertionVars(strong.access, strong.assertion.value).length === 1) {
          return { access: strong.access, assertion: assertWeak(strong.assertion.value) };
        }
      }
    }
  }
  return undefined;
}

/** The variables an assertion about `access` with this value mentions - two iff it is a clique edge. */
export function assertionVars(access: Access, value?: AssertionValue): string[] {
  const other = value === undefined ? undefined : valueRoot(value);
  const nested = value?.kind === 'term' ? termVariables(value.term) : [];
  return [ ...new Set([ access.name, ...other === undefined ? [] : [ other ], ...nested ]) ];
}

/** The variables a term holds, which for anything but a triple term is none. */
function termVariables(term: RDF.Term): string[] {
  if (term.termType === 'Variable') {
    return [ term.value ];
  }
  if (term.termType === 'Quad') {
    return [ term.subject, term.predicate, term.object ].flatMap(component => termVariables(component));
  }
  return [];
}

/** Recognizes the assertion a single conjunct carries, in whichever of the four forms it is written. */
export function assertionOf(expression: Algebra.Expression):
    { access: Access; assertion: Assertion } | undefined {
  const strong = asStrongAssertion(expression);
  if (strong !== undefined) {
    return strong;
  }
  const weak = asWeakAssertion(expression);
  if (weak !== undefined) {
    return weak;
  }
  const unbound = variableOfNotBound(expression);
  if (unbound !== undefined) {
    return { access: rootAccess(unbound), assertion: assertUnbound() };
  }
  const bound = variableOfBound(expression);
  return bound === undefined ? undefined : { access: rootAccess(bound), assertion: assertBound() };
}

/** The variable of a `bound(?x)` expression, if that is what it is. */
function variableOfBound(expression: Algebra.Expression): string | undefined {
  if (expression.subType === Algebra.ExpressionTypes.OPERATOR && expression.operator === 'bound' &&
    expression.args.length === 1) {
    const [ argument ] = expression.args;
    if (argument.subType === Algebra.ExpressionTypes.TERM && argument.term.termType === 'Variable') {
      return argument.term.value;
    }
  }
  return undefined;
}

/** The variable of a `!bound(?x)` expression, if that is what it is. */
function variableOfNotBound(expression: Algebra.Expression): string | undefined {
  if (expression.subType === Algebra.ExpressionTypes.OPERATOR && expression.operator === '!' &&
    expression.args.length === 1) {
    return variableOfBound(expression.args[0]);
  }
  return undefined;
}

/** The expression that reads an access: the variable, under one operator per position it goes through. */
export function accessExpression(c: TransformContext, access: Access): Algebra.Expression {
  return access.positions.reduce<Algebra.Expression>(
    (inner, position) => c.AF.createOperatorExpression(position, [ inner ]),
    c.AF.createTermExpression(DF.variable(access.name)),
  );
}

/**
 * Creates the strong assertion A⟨?x ≡ c⟩: `sameTerm(?x, c)` - or, for the degenerate shape, `isTRIPLE(?x)`.
 *
 * A shape is never written as `sameTerm(?o, <<( … )>>)`, which is what {@link AssertionConjunction}
 * decomposes it into instead: the components would have to be named by variables that are unbound
 * wherever the filter sits, so the condition would error and drop every row.
 */
export function assertionExpression(c: TransformContext, access: Access, value: AssertionValue):
Algebra.Expression {
  const read = accessExpression(c, access);
  if (value.kind === 'triple') {
    return c.AF.createOperatorExpression('istriple', [ read ]);
  }
  return c.AF.createOperatorExpression('sameterm', [
    read,
    value.kind === 'term' ? c.AF.createTermExpression(value.term) : accessExpression(c, value.access),
  ]);
}

/**
 * Creates the weak assertion W⟨?x ≡ c⟩: `!bound(?x) || sameTerm(?x, c)`.
 *
 * Keeping the solutions that leave `?x` unbound is what makes it usable on the RHS of a MINUS
 * (anti-monotone in that argument) and pushable through operations that may leave `?x` unbound. The
 * disjunct is about the *root* of the access: where `?o` is unbound, `subject(?o)` errors, and it is the
 * error the `!bound(?o)` has to rule out.
 */
export function weakAssertionExpression(c: TransformContext, access: Access, value: AssertionValue):
Algebra.Expression {
  return c.AF.createOperatorExpression('||', [
    unboundAssertionExpression(c, access.name),
    assertionExpression(c, access, value),
  ]);
}

/** Creates the bound assertion B⟨?x⟩: `bound(?x)`. */
export function boundAssertionExpression(c: TransformContext, name: string): Algebra.Expression {
  return c.AF.createOperatorExpression('bound', [ c.AF.createTermExpression(DF.variable(name)) ]);
}

/** Creates the unbound assertion U⟨?x⟩: `!bound(?x)`. */
export function unboundAssertionExpression(c: TransformContext, name: string): Algebra.Expression {
  return c.AF.createOperatorExpression('!', [ boundAssertionExpression(c, name) ]);
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
