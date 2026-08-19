import type * as RDF from '@rdfjs/types';
import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TriplePosition } from '../datastructures/TermClusterSet.js';
import { triplePositions } from '../datastructures/TermClusterSet.js';
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
 * {@link AssertionConjunction.strongSubstitution}. The term may be a *variable*: that is what a
 * unification substitutes, replacing every member of a clique by the representative of it.
 */
export type Assertions = ReadonlyMap<string, RDF.Term>;

/**
 * A variable read through a chain of accessors: `?x`, `SUBJECT(?x)`, `OBJECT(SUBJECT(?x))`.
 *
 * An assertion is about an *access* rather than about a variable, because a triple term is constrained
 * one position at a time: `sameTerm(SUBJECT(?o), ?s)` says nothing about `?o` as a whole and everything
 * about one of its three components. The zero-length access is the variable itself, which is what every
 * form this pass had before this is now spelled as.
 *
 * The chain reads left to right from the root: `{ name: 'o', positions: [ 'subject', 'object' ]}` is
 * `OBJECT(SUBJECT(?o))`.
 */
export interface Access {
  name: string;
  positions: readonly TriplePosition[];
}

/** The access `?name`, read through `positions`. */
export function access(name: string, ...positions: TriplePosition[]): Access {
  return { name, positions };
}

/**
 * The key two accesses are the same one under - `.` separates, and no SPARQL variable name may hold one,
 * so no access collides with another.
 */
export function accessId(access: Access): string {
  return [ access.name, ...access.positions ].join('.');
}

/** Whether the two accesses read the same variable through the same chain. */
export function sameAccessAs(left: Access, right: Access): boolean {
  return accessId(left) === accessId(right);
}

/** Whether the access is the variable itself, which is the only thing `BOUND` and a group member can be. */
export function isBareAccess(access: Access): boolean {
  return access.positions.length === 0;
}

/** What an assertion fixes an access to: another access, or a ground term. */
export type AssertionTarget = Access | RDF.Term;

/** Whether the target is an access rather than a term - the two are told apart by their shape. */
export function isAccessTarget(target: AssertionTarget): target is Access {
  return 'positions' in target;
}

/** The root variables a target mentions: one for an access, none for a term. */
export function targetVars(target: AssertionTarget): string[] {
  return isAccessTarget(target) ? [ target.name ] : [];
}

/**
 * One assertion about one *access*, in one of the five forms this pass moves around.
 *
 * - `strong` is A⟨a ≡ c⟩ ≔ `sameTerm(a, c)`, which implies `bound(?x)` of the root of `a`. Its target may
 *   be another access, in which case it is A⟨a ≡ b⟩ - one edge of the clique an
 *   {@link AssertionConjunction} holds, and, when either side reads through an accessor, one edge of the
 *   *shape* it holds.
 * - `weak` is W⟨a ≡ c⟩ ≔ `!bound(?x) || sameTerm(a, c)`, which does not - it is what survives a move into
 *   a place that may leave the variable unbound (the RHS of a MINUS, the unlicensed operand of a join).
 * - `triple` is T⟨?x⟩ ≔ `isTRIPLE(?x)`, the degenerate shape: a triple term, nothing known about its
 *   parts. Like the strong form it implies `bound(?x)`, and like it it has a weak form
 *   (`!bound(?x) || isTRIPLE(?x)`), which is what `weak` records.
 * - `unbound` is U⟨?x⟩ ≔ `!bound(?x)`.
 * - `bound` is B⟨?x⟩ ≔ `bound(?x)`, which fixes the variable to no term at all.
 *
 * The `weak` form is what the conjunction of two *different* weak assertions about one variable comes to:
 * `(¬b ∨ ?x ≡ c) ∧ (¬b ∨ ?x ≡ d)` distributes to `¬b ∨ (?x ≡ c ∧ ?x ≡ d)`, which for `c ≠ d` is `¬b`.
 * Without it {@link AssertionConjunction.assertTerm} would have nowhere to put that fact - it has no term
 * - and would have to leave the conjunct behind as a residual. It is also SPARQL's negation idiom
 * (`OPTIONAL { … } FILTER(!bound(?x))`), so it is the form assertions most often *start* in.
 *
 * B⟨?x⟩ is the negation of U⟨?x⟩, and the term-less half of the strong form: it says only that the
 * variable *is* bound, which is what SPARQL writes as `FILTER(bound(?x))`. It carries no term, so it never
 * substitutes into anything, but it decides the same emptiness rule the strong form does ((FBndII):
 * `?x ∉ pVars(A) ⟹ σ_{bound(?x)}(A) ≡ ∅`) and it *completes* a weak assertion into a strong one -
 * `b ∧ (¬b ∨ ?x ≡ c) ≡ ?x ≡ c` - which is where it earns its keep.
 *
 * `bound`, `unbound` and `triple` are restricted to a *bare* access: `BOUND` takes a `Var` by the grammar,
 * and every position of a triple term is bound as soon as the triple term is, so `isTRIPLE(SUBJECT(?o))`
 * is about the group `SUBJECT(?o)` names rather than about `?o`.
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
  term: AssertionTarget;
}
export interface WeakAssertion extends BaseAssertion {
  subType: 'weak';
  term: AssertionTarget;
}
/** T⟨?x⟩, and - when `weak` - `!bound(?x) || isTRIPLE(?x)`. */
export interface TripleAssertion extends BaseAssertion {
  subType: 'triple';
  weak: boolean;
}
export interface UnboundAssertion extends BaseAssertion {
  subType: 'unbound';
}
export interface BoundAssertion extends BaseAssertion {
  subType: 'bound';
}
export type Assertion =
  BoundAssertion | StrongAssertion | TripleAssertion | UnboundAssertion | WeakAssertion;

export function assertStrong(term: AssertionTarget): StrongAssertion {
  return {
    type: 'assertion',
    subType: 'strong',
    term: normalisedTarget(term),
  };
}
export function assertWeak(term: AssertionTarget): WeakAssertion {
  return {
    type: 'assertion',
    subType: 'weak',
    term: normalisedTarget(term),
  };
}

/**
 * A variable on the right hand side is the zero-length access reading it, so that a target has one
 * spelling only - everything downstream tells the two apart by asking whether it is an access, and a
 * variable spelled as a term would answer no while being exactly one.
 */
function normalisedTarget(target: AssertionTarget): AssertionTarget {
  return !isAccessTarget(target) && target.termType === 'Variable' ? access(target.value) : target;
}

/** Creates T⟨?x⟩, or its weak form `!bound(?x) || isTRIPLE(?x)`. */
export function assertTriple(weak = false): TripleAssertion {
  return {
    type: 'assertion',
    subType: 'triple',
    weak,
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

/** Whether the assertion carries a target, which is the pair the strong and weak forms are. */
export function hasTarget(assertion: Assertion): assertion is StrongAssertion | WeakAssertion {
  return assertion.subType === 'strong' || assertion.subType === 'weak';
}

/**
 * Whether the assertion implies `bound(?x)`, which is what the emptiness rule (FBndII) and every licence
 * that moves an assertion into a single operand are read off - the strong form, the bound form, and the
 * shape alike, a triple term being a term like any other.
 */
export function impliesBound(assertion: Assertion): boolean {
  return assertion.subType === 'strong' || assertion.subType === 'bound' ||
    (assertion.subType === 'triple' && !assertion.weak);
}

/**
 * Whether an assertion may fix a variable to this *ground* term, i.e. whether it pins a group to it.
 *
 * A triple term is admitted exactly when it is ground, which is what makes it a term at all rather than a
 * *shape* - `<<( ?a ?b ?c )>>` says which triple the variable is the term of only once its components are
 * known, and until then it is the business of the pin lattice ({@link TermClusterSet}) instead.
 *
 * This is the same call the EXTEND case of {@link withCpVars} (`certainlyBoundVars.ts`) makes from the
 * other side, and the two now agree: a ground triple term cannot raise an evaluation error, so
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

/**
 * The access an expression reads, when that is all it does: a variable, or a chain of `SUBJECT` /
 * `PREDICATE` / `OBJECT` around one.
 *
 * `OBJECT(SUBJECT(?o))` is `{ name: 'o', positions: [ 'subject', 'object' ]}` - the chain is unwrapped
 * from the outside in, so the positions come out in the order they are applied.
 */
export function accessOf(expression: Algebra.Expression): Access | undefined {
  if (expression.subType === Algebra.ExpressionTypes.TERM) {
    return expression.term.termType === 'Variable' ? access(expression.term.value) : undefined;
  }
  if (expression.subType !== Algebra.ExpressionTypes.OPERATOR || expression.args.length !== 1) {
    return undefined;
  }
  if (!triplePositions.includes(<TriplePosition> expression.operator)) {
    return undefined;
  }
  const position = <TriplePosition> expression.operator;
  const inner = accessOf(expression.args[0]);
  return inner === undefined ? undefined : { name: inner.name, positions: [ ...inner.positions, position ]};
}

/** The target one side of a `sameTerm` stands for: the access it reads, or the ground term it is. */
function targetOf(expression: Algebra.Expression): AssertionTarget | undefined {
  const read = accessOf(expression);
  if (read !== undefined) {
    return read;
  }
  return expression.subType === Algebra.ExpressionTypes.TERM && isAssertableTerm(expression.term) ?
    expression.term :
    undefined;
}

/**
 * Recognizes the conjuncts a `sameTerm` carries: `sameTerm(a, c)`, `sameTerm(c, a)`, the unification
 * `sameTerm(a, b)` - A⟨a ≡ b⟩, a strong assertion whose target is an access - and the *construction*
 * `sameTerm(?o, <<( ?a ?b ?c )>>)`, which decomposes into one conjunct per position.
 *
 * The construction is not written back as itself, and that is sound rather than sloppy: as *conjuncts of
 * a FILTER*, `sameTerm(?o, TRIPLE(?a,?b,?c))` and `sameTerm(SUBJECT(?o), ?a) && …` agree. They differ only
 * where one is `false` and the other an error - `?o` not a triple term, a component unbound, the
 * construction ill-typed - and a FILTER discards the row either way.
 *
 * Never generalise this to `=`: `?x = "01"^^xsd:integer` holds of the *term* `"1"^^xsd:integer`, so
 * substituting under `=` would drop solutions. An `=` against an IRI is the one place the two coincide,
 * and {@link constantFoldOperator} has already rewritten that into the `sameTerm` read here.
 */
export function asStrongAssertion(expression: Algebra.Expression): AssertionConjunct[] | undefined {
  if (expression.subType !== Algebra.ExpressionTypes.OPERATOR || expression.operator !== 'sameterm' ||
    expression.args.length !== 2) {
    return undefined;
  }
  const [ left, right ] = expression.args;
  const decomposed = asConstruction(left, right) ?? asConstruction(right, left);
  if (decomposed !== undefined) {
    return decomposed;
  }
  // Which side is read as the subject of the assertion does not matter for an access on both: the
  // conjunction unifies the two groups and picks the anchor of the result itself.
  const leftAccess = accessOf(left);
  if (leftAccess !== undefined) {
    const target = targetOf(right);
    return target === undefined ? undefined : [{ access: leftAccess, assertion: assertStrong(target) }];
  }
  const rightAccess = accessOf(right);
  if (rightAccess !== undefined && left.subType === Algebra.ExpressionTypes.TERM &&
    isAssertableTerm(left.term)) {
    return [{ access: rightAccess, assertion: assertStrong(left.term) }];
  }
  return undefined;
}

/** `sameTerm(a, <<( x y z )>>)` read as one conjunct per position of the shape `a` has to have. */
function asConstruction(read: Algebra.Expression, built: Algebra.Expression): AssertionConjunct[] | undefined {
  const root = accessOf(read);
  if (root === undefined || built.subType !== Algebra.ExpressionTypes.OPERATOR ||
    built.operator !== 'triple' || built.args.length !== 3) {
    return undefined;
  }
  const targets = built.args.map(arg => targetOf(arg));
  if (targets.includes(undefined)) {
    // One position this cannot name is one conjunct that would be lost, and a conjunction that no longer
    // says what the condition said - so the whole condition stays a residual instead.
    return undefined;
  }
  return triplePositions.map((position, index) => ({
    access: { name: root.name, positions: [ ...root.positions, position ]},
    assertion: assertStrong(targets[index]!),
  }));
}

/** Recognizes T⟨?x⟩: `isTRIPLE(a)`, which says that `a` is a triple term and nothing about its parts. */
export function asTripleAssertion(expression: Algebra.Expression): AssertionConjunct | undefined {
  if (expression.subType !== Algebra.ExpressionTypes.OPERATOR || expression.operator !== 'istriple' ||
    expression.args.length !== 1) {
    return undefined;
  }
  const read = accessOf(expression.args[0]);
  return read === undefined ? undefined : { access: read, assertion: assertTriple() };
}

/**
 * Recognizes the *weak* conjuncts a condition carries: `!bound(?x) || φ`, where `φ` is a strong assertion
 * about `?x` and about nothing else.
 *
 * The single-variable restriction is what makes the weak form exist at all (S4): `!bound(?o) ||
 * sameTerm(SUBJECT(?o), :a)` is one conjunct about one variable, where `sameTerm(SUBJECT(?o), ?s)` is an
 * edge between two of them and has no weak form (see {@link AssertionConjunction}). Reading such an edge
 * back as one would be exactly the unsound merge that form does not exist to avoid, so it stays a
 * residual condition instead.
 *
 * The target has to be a ground *term* for the same reason: `!bound(?o) || sameTerm(SUBJECT(?o),
 * OBJECT(?o))` does mention one variable only, but weakening a whole shape one edge at a time is not
 * something the conjunction can carry, so it too is left where it is.
 */
export function asWeakAssertion(expression: Algebra.Expression): AssertionConjunct[] | undefined {
  if (expression.subType !== Algebra.ExpressionTypes.OPERATOR || expression.operator !== '||' ||
    expression.args.length !== 2) {
    return undefined;
  }
  for (const [ index, arg ] of expression.args.entries()) {
    const unbound = variableOfNotBound(arg);
    if (unbound === undefined) {
      continue;
    }
    const other = expression.args[index === 0 ? 1 : 0];
    const shaped = asTripleAssertion(other);
    if (shaped !== undefined && shaped.access.name === unbound && isBareAccess(shaped.access)) {
      return [{ access: shaped.access, assertion: assertTriple(true) }];
    }
    const strong = asStrongAssertion(other);
    if (strong?.length === 1) {
      const [{ access: read, assertion }] = strong;
      if (assertion.subType === 'strong' && read.name === unbound && !isAccessTarget(assertion.term)) {
        return [{ access: read, assertion: assertWeak(assertion.term) }];
      }
    }
  }
  return undefined;
}

/** Recognizes the conjuncts a single condition carries, in whichever of the forms they are written. */
export function assertionOf(expression: Algebra.Expression): AssertionConjunct[] | undefined {
  const strong = asStrongAssertion(expression);
  if (strong !== undefined) {
    return strong;
  }
  const weak = asWeakAssertion(expression);
  if (weak !== undefined) {
    return weak;
  }
  const shaped = asTripleAssertion(expression);
  if (shaped !== undefined) {
    return [ shaped ];
  }
  const unbound = variableOfNotBound(expression);
  if (unbound !== undefined) {
    return [{ access: access(unbound), assertion: assertUnbound() }];
  }
  const bound = variableOfBound(expression);
  return bound === undefined ? undefined : [{ access: access(bound), assertion: assertBound() }];
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

/** The expression reading an access: the variable, wrapped in one accessor per position it reads. */
export function accessExpression(c: TransformContext, read: Access): Algebra.Expression {
  return read.positions.reduce<Algebra.Expression>(
    (inner, position) => c.AF.createOperatorExpression(position, [ inner ]),
    c.AF.createTermExpression(DF.variable(read.name)),
  );
}

/** The expression one side of an assertion stands for. */
function targetExpression(c: TransformContext, target: AssertionTarget): Algebra.Expression {
  if (isAccessTarget(target)) {
    return accessExpression(c, target);
  }
  return c.AF.createTermExpression(target);
}

/** Creates the strong assertion A⟨a ≡ c⟩: `sameTerm(a, c)`. */
export function assertionExpression(c: TransformContext, read: Access, target: AssertionTarget):
Algebra.Expression {
  return c.AF.createOperatorExpression('sameterm', [
    accessExpression(c, read),
    targetExpression(c, target),
  ]);
}

/** Creates T⟨?x⟩: `isTRIPLE(a)`. */
export function tripleAssertionExpression(c: TransformContext, read: Access): Algebra.Expression {
  return c.AF.createOperatorExpression('istriple', [ accessExpression(c, read) ]);
}

/**
 * Creates the weak form of a condition about `?x`: `!bound(?x) || φ`.
 *
 * Keeping the solutions that leave `?x` unbound is what makes it usable on the RHS of a MINUS
 * (anti-monotone in that argument) and pushable through operations that may leave `?x` unbound.
 *
 * `φ` may read `?x` through an accessor, and an accessor of an unbound `?x` is an *error* rather than
 * `false`. That is exactly why this may only ever be placed as a filter condition (S1): a FILTER
 * identifies error with `false`, and `false || error` is still an error, so the row is dropped either
 * way - which is what the left disjunct then rescues.
 */
export function weakenedExpression(c: TransformContext, name: string, strong: Algebra.Expression):
Algebra.Expression {
  return c.AF.createOperatorExpression('||', [ unboundAssertionExpression(c, name), strong ]);
}

/** Creates the weak assertion W⟨a ≡ c⟩: `!bound(?x) || sameTerm(a, c)`. */
export function weakAssertionExpression(c: TransformContext, read: Access, target: AssertionTarget):
Algebra.Expression {
  return weakenedExpression(c, read.name, assertionExpression(c, read, target));
}

/** Creates the bound assertion B⟨?x⟩: `bound(?x)`. */
export function boundAssertionExpression(c: TransformContext, name: string): Algebra.Expression {
  return c.AF.createOperatorExpression('bound', [ c.AF.createTermExpression(DF.variable(name)) ]);
}

/** Creates the unbound assertion U⟨?x⟩: `!bound(?x)`. */
export function unboundAssertionExpression(c: TransformContext, name: string): Algebra.Expression {
  return c.AF.createOperatorExpression('!', [ boundAssertionExpression(c, name) ]);
}

/**
 * One conjunct of an {@link AssertionConjunction}: what it says about one access, or one edge between two.
 */
export interface AssertionConjunct {
  access: Access;
  assertion: Assertion;
}

/**
 * The *root* variables a conjunct mentions - two iff it is an edge between two of them.
 *
 * Everything that places a conjunct reads only this: (FJPush)'s side condition is quantified over
 * `vars(R)`, and the variables an accessor conjunct is about are the ones it reads *through*. An edge
 * between two accesses of the same variable mentions that one variable, so it travels wherever a
 * single-variable conjunct does.
 */
export function conjunctVars(conjunct: AssertionConjunct): string[] {
  const roots = [ conjunct.access.name ];
  if (hasTarget(conjunct.assertion)) {
    for (const name of targetVars(conjunct.assertion.term)) {
      if (!roots.includes(name)) {
        roots.push(name);
      }
    }
  }
  return roots;
}

/**
 * The same conjunct, in the strongest form that survives a move somewhere its variables may be unbound:
 * A⟨a ≡ c⟩ becomes W⟨a ≡ c⟩, T⟨?x⟩ becomes its weak self, and W and U are already that weak.
 *
 * B⟨?x⟩ has no such form - weakening it means allowing the unbound case, and `¬b ∨ b` is `true` - and
 * neither has an edge between two accesses, for the reasons in {@link asWeakAssertion}. Both are
 * `undefined`: they do not travel at all, and have to stay where they are.
 */
export function weakenedConjunct(conjunct: AssertionConjunct): AssertionConjunct | undefined {
  const { access: read, assertion } = conjunct;
  switch (assertion.subType) {
    case 'bound': {
      return undefined;
    }
    case 'triple': {
      return assertion.weak ? conjunct : { access: read, assertion: assertTriple(true) };
    }
    case 'strong': {
      return isAccessTarget(assertion.term) ? undefined : { access: read, assertion: assertWeak(assertion.term) };
    }
    default: {
      return conjunct;
    }
  }
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
