import type * as RDF from '@rdfjs/types';
import { Algebra } from '@traqula/algebra-transformations-1-2';
import { TermClusterSet } from '../datastructures/TermClusterSet.js';
import type { TransformContext } from '../transformContext.js';
import type { Assertion, Assertions } from './assertions.js';
import {
  assertBound,
  assertionExpression,
  assertionOf,
  assertStrong,
  assertUnbound,
  assertWeak,
  boundAssertionExpression,
  impliesBound,
  unboundAssertionExpression,
  weakAssertionExpression,
} from './assertions.js';
import type { CPMeta } from './certainlyBoundVars.js';
import { withCpVars } from './certainlyBoundVars.js';
import { booleanConstantOf, conjunctionOf, splitConjunction } from './expressionHelpers.js';
import { substituteInExpression } from './partialExpressionEvaluation.js';
import { DF } from './rdfDatatypes.js';

/**
 * @fileoverview The conjunction of assertions (Θ) the pushdown moves around, and how a filter condition
 * is read into one.
 *
 * Θ is no longer a map from variable to constraint: `FILTER(sameTerm(?x, ?y))` constrains *two* variables
 * at once, and a chain of such filters makes a clique of variables that all have to be equal. So the
 * carrier is a union-find ({@link TermClusterSet}) whose groups may be pinned to a term, plus the two
 * term-less forms (`bound` / `!bound`) which stay per variable.
 *
 * The dividing line, and the reason everything else stays as simple as it was: a group **pinned to a
 * term** still decomposes into independent single-variable conjuncts, and behaves exactly like today's
 * per-variable assertions. A group **without a term** - a clique - has to be reasoned about as a whole,
 * because its conjuncts mention two variables each.
 */

/**
 * A set of assertions Θ, in the five states an assertion about a variable can be in:
 *
 * | state                                  | means                             | serialised as                     |
 * |----------------------------------------|-----------------------------------|-----------------------------------|
 * | strong member of a pinned group        | `sameTerm(?x, c)`                 | `SAMETERM(?x, c)`                 |
 * | weak member of a pinned group          | `!bound(?x) \|\| sameTerm(?x, c)` | `!BOUND(?x) \|\| SAMETERM(?x, c)` |
 * | member of an anchorless group (clique) | `sameTerm(?x, ?rep)`              | `SAMETERM(?x, ?rep)`              |
 * | unbound                                | `!bound(?x)`                      | `!BOUND(?x)`                      |
 * | bound                                  | `bound(?x)`, no term              | `BOUND(?x)`                       |
 *
 * Nothing new is serialised: every row but the third is the form the previous per-variable conjunction
 * already used, and the third is the plain `sameTerm` between two variables the parser reads straight back
 * into a unification.
 *
 * **Weak ⇔ pinned group.** Every member of an anchorless group is strong, because there is no usable weak
 * form of a clique: cluster-level weak ("all bound members pairwise `sameTerm`") does not distribute over
 * a join - `μ₁={?x↦a}` and `μ₂={?y↦b}` each satisfy it and their merge does not - and merging two
 * independent weak edges is unsound (`W⟨{x,y}⟩ ∧ W⟨{y,z}⟩ ⊭ W⟨{x,y,z}⟩`, take `?y` unbound). A term is
 * what makes the weak form work: an anchor both sides of a join already agree on. So {@link weakened}
 * drops anchorless groups rather than inventing a weak form for them, exactly as it drops B⟨?x⟩.
 *
 * **`unbound` and `bound` are disjoint from the groups**, as a consequence of the rules rather than by
 * construction: U⟨?x⟩ takes `?x` out of its group ({@link assertUnbound}) and B⟨?x⟩ is absorbed by a
 * membership that already implies it ({@link assertBound}).
 *
 * The `assert…` methods report a contradiction by returning `false` rather than raising: one variable
 * asserted to be two terms at once is an ordinary outcome, which the pass turns into the empty operation.
 * A conjunction they returned `false` for holds no meaningful state and has to be discarded.
 */
export class AssertionConjunction {
  /** Variable to its group; a group may be pinned to the term all of its members equal. */
  private clusters: TermClusterSet<string, RDF.Term>;
  /**
   * Per *variable*, not per group: {@link normalisedFor} promotes each member against `cVars`/`pVars`
   * separately, so one member of a pinned group may be strong while another is weak. Entries for
   * variables that are in no group are stale leftovers, and are ignored.
   */
  private strength: Map<string, 'strong' | 'weak'>;
  /** U⟨?x⟩ */
  private unbound: Set<string>;
  /** B⟨?x⟩ */
  private bound: Set<string>;
  /**
   * The variables in the order they were first mentioned, which is the order everything here iterates in.
   * Reading a conjunction back out of the condition it serialised to re-mentions them in that same order,
   * which is what keeps the pass idempotent.
   */
  private order: Set<string>;

  public constructor() {
    this.clusters = new TermClusterSet<string, RDF.Term>(name => name, (a, b) => a.equals(b));
    this.strength = new Map();
    this.unbound = new Set();
    this.bound = new Set();
    this.order = new Set();
  }

  /** The conjunction of the assertions of `conjuncts`, which never contradict when they come from one Θ. */
  public static of(conjuncts: Iterable<AssertionConjunct>): AssertionConjunction {
    const result = new AssertionConjunction();
    for (const { name, assertion } of conjuncts) {
      // A subset of a satisfiable conjunction is satisfiable, so this cannot fail for such a subset.
      result.assert(name, assertion);
    }
    return result;
  }

  /** A copy that shares no state with this one, so that either may be asserted into on its own. */
  public clone(): AssertionConjunction {
    const copy = new AssertionConjunction();
    copy.clusters = this.clusters.clone();
    copy.strength = new Map(this.strength);
    copy.unbound = new Set(this.unbound);
    copy.bound = new Set(this.bound);
    copy.order = new Set(this.order);
    return copy;
  }

  /** The variables the conjunction says something about, in the order it first met them. */
  private names(): string[] {
    return [ ...this.order ].filter(name => this.get(name) !== undefined);
  }

  /** How many variables the conjunction says something about. */
  public get size(): number {
    return this.names().length;
  }

  /**
   * What the conjunction says about one variable, in the per-variable form the licences of the pushdown
   * are read off.
   *
   * A clique is *not* per-variable, so this is a faithful view of it rather than the thing itself: each
   * member but the representative reads as A⟨?x ≡ ?rep⟩ - a strong assertion whose term happens to be a
   * variable - and the representative reads as B⟨?rep⟩, which is what the clique entails about it and all
   * that is left once the others are stated against it. Conjoining the views of every member gives the
   * clique back, so {@link impliesBound} and every licence built on it answer truthfully.
   */
  public get(name: string): Assertion | undefined {
    if (this.unbound.has(name)) {
      return assertUnbound();
    }
    if (this.bound.has(name)) {
      return assertBound();
    }
    const group = this.clusters.groupOf(name);
    if (group === undefined) {
      return undefined;
    }
    const term = this.clusters.termOf(group);
    if (term !== undefined) {
      return this.strength.get(name) === 'strong' ? assertStrong(term) : assertWeak(term);
    }
    const representative = this.representativeOf(group);
    return representative === name ? assertBound() : assertStrong(DF.variable(representative));
  }

  /**
   * The independent conjuncts Θ decomposes into: one per variable for everything but a clique, and for a
   * clique the edges of a spanning tree - the star from its representative.
   *
   * Splitting a clique means splitting its *edges*, never its variables: a clique is transitively closed,
   * so any spanning tree of it is equivalent to the whole, and what a caller pushes plus what it keeps has
   * to span it. Dropping the representative's own (empty) conjunct is what makes that work out: the edges
   * of the star already entail B⟨?rep⟩.
   */
  public conjuncts(): AssertionConjunct[] {
    const result: AssertionConjunct[] = [];
    for (const name of this.names()) {
      const group = this.clusters.groupOf(name);
      if (group !== undefined && this.clusters.termOf(group) === undefined &&
        this.representativeOf(group) === name) {
        continue;
      }
      result.push({ name, assertion: <Assertion> this.get(name) });
    }
    return result;
  }

  /**
   * The cliques of Θ - its anchorless groups - each as its members in lexicographic order, so that the
   * first of them is the representative.
   *
   * These are the conjuncts of {@link conjuncts} that a rule cannot take one at a time: a rule that
   * decides per variable would split a clique into pieces that no longer say it, so it decides per clique
   * and splits the *edges* instead.
   */
  public cliques(): string[][] {
    const result: string[][] = [];
    for (const [ group, members ] of this.clusters.groupEntries()) {
      if (this.clusters.termOf(group) === undefined && members.length > 1) {
        result.push([ ...members ].sort((left, right) => left.localeCompare(right)));
      }
    }
    return result;
  }

  /**
   * Splits Θ in two along `predicate`: the conjuncts mentioning only variables that satisfy it, and the
   * rest. The two are equivalent to the whole, since together they hold every conjunct.
   */
  public split(predicate: (name: string) => boolean): { inside: AssertionConjunction; outside: AssertionConjunction } {
    const inside: AssertionConjunct[] = [];
    const outside: AssertionConjunct[] = [];
    for (const conjunct of this.conjuncts()) {
      (conjunctVars(conjunct).every(name => predicate(name)) ? inside : outside).push(conjunct);
    }
    return { inside: AssertionConjunction.of(inside), outside: AssertionConjunction.of(outside) };
  }

  /**
   * Θ with every conjunct in the strongest form that survives a move somewhere its variables may be
   * unbound: a pinned member becomes weak, and the forms that have no weak form at all - B⟨?x⟩ and the
   * cliques - are dropped.
   */
  public weakened(): AssertionConjunction {
    return AssertionConjunction.of(this.conjuncts()
      .map(conjunct => weakenedConjunct(conjunct))
      .filter(conjunct => conjunct !== undefined));
  }

  /**
   * The variables Θ entails `bound(?x)` of.
   *
   * Every member of a clique is one of them, which is what lets a unification decide the rules the strong
   * form decides - the OPTIONAL → JOIN collapse above all - even where the edge itself cannot travel.
   */
  public boundImpliedBy(): Set<string> {
    const result = new Set<string>();
    for (const name of this.names()) {
      const assertion = this.get(name);
      if (assertion !== undefined && impliesBound(assertion)) {
        result.add(name);
      }
    }
    return result;
  }

  /**
   * The substitution the strong assertions stand for, in the form the `substituteIn…` helpers take: a
   * pinned member maps to its term, and a clique member to the representative of its clique.
   *
   * Dropping the other forms is the point: substituting `c` for `?x` under W⟨?x ≡ c⟩ would claim `?x` is
   * bound, and B⟨?x⟩ and U⟨?x⟩ have no term to substitute.
   */
  public strongSubstitution(): Assertions {
    const result = new Map<string, RDF.Term>();
    for (const name of this.names()) {
      const group = this.clusters.groupOf(name);
      if (group === undefined || this.strength.get(name) !== 'strong') {
        continue;
      }
      const term = this.clusters.termOf(group);
      if (term !== undefined) {
        result.set(name, term);
        continue;
      }
      const representative = this.representativeOf(group);
      if (representative !== name) {
        result.set(name, DF.variable(representative));
      }
    }
    return result;
  }

  /**
   * Reads Θ in terms of what an operation binds - `undefined` when it makes that operation empty.
   *
   * Where `?x` is certainly bound, `!bound(?x)` is unsatisfiable, so W *is* A, B is `true` and U is empty;
   * where `?x` can never be bound, A and B are empty ((FBndII)) and W and U are simply `true`.
   *
   * Per member of a group, not per group: a group whose members disagree about being in `cVars` is
   * perfectly ordinary. Taking a member out may leave its group with a single variable and nothing for it
   * to equal, which {@link TermClusterSet.remove} then drops.
   */
  public normalisedFor(cVars: CPMeta['cVars'], pVars: CPMeta['pVars']): AssertionConjunction | undefined {
    const result = this.clone();
    for (const name of this.names()) {
      if (this.unbound.has(name)) {
        if (cVars.has(name)) {
          return undefined;
        }
        if (!pVars.has(name)) {
          result.unbound.delete(name);
        }
        continue;
      }
      if (this.bound.has(name)) {
        // (FBndII), which both of the forms implying `bound(?x)` trigger.
        if (!pVars.has(name)) {
          return undefined;
        }
        if (cVars.has(name)) {
          result.bound.delete(name);
        }
        continue;
      }
      const strong = this.strength.get(name) === 'strong';
      if (!pVars.has(name)) {
        if (strong) {
          return undefined;
        }
        // Not in pVars and weak -> nothing to assert.
        result.removeMember(name);
      } else if (cVars.has(name)) {
        // B⟨?x⟩ holds of every solution here, and completes a weak member into a strong one.
        result.strength.set(name, 'strong');
      }
    }
    return result;
  }

  /**
   * Θ with `name` taken out of it and whatever it was equal *to* restated against `replacement` - the term
   * that carries its value where the result is going, which the caller is responsible for establishing.
   *
   * For a BIND, that is its expression: below `BIND(?z AS ?t)` it is `?z` that holds what `?t` holds above,
   * and below `BIND(:c AS ?t)` it is `:c`. Four cases, which are the same rule read against the two kinds
   * of thing `name` could have been equal to:
   *
   * - a group pinned to `d`, replaced by a variable: that variable is now the one that has to be `d`;
   * - a group pinned to `d`, replaced by a term: `?x ≡ d` has become the ground comparison `c ≡ d`, which
   *   either holds or makes the whole thing empty;
   * - a clique, replaced by a variable: it takes `name`'s place in the clique;
   * - a clique, replaced by a term: every variable left in the clique now has to equal that term.
   *
   * Taking the variable out one member at a time, rather than dropping every conjunct that mentions it,
   * is what keeps the rest of its clique intact when it happens to be the representative all of the edges
   * point at. Only what it was equal to travels: B⟨?x⟩ and U⟨?x⟩ on `name` are simply removed, and stay
   * where the caller put them.
   */
  public transferred(name: string, replacement: RDF.Term): AssertionConjunction | undefined {
    const result = this.clone();
    const group = this.clusters.groupOf(name);
    const term = group === undefined ? undefined : this.clusters.termOf(group);
    const strong = this.strength.get(name) === 'strong';
    const others = group === undefined ?
        [] :
      this.clusters.valuesOf(group).filter(member => member !== name);
    result.removeMember(name);
    result.bound.delete(name);
    result.unbound.delete(name);
    if (replacement.termType === 'Variable') {
      return (term === undefined ?
        // Anchorless: `name` was a member of the clique, so `replacement` takes its place in it.
        others.length === 0 || result.assertUnify(replacement.value, others[0]) :
        result.assertTerm(replacement.value, term, strong)) ?
        result :
        undefined;
    }
    if (term !== undefined) {
      // Two ground terms, so what `name` had to be is decided here rather than pushed anywhere.
      return term.equals(replacement) ? result : undefined;
    }
    // The clique meets a term: it pins the group, which is every variable that was equal to `name`.
    return others.length === 0 || result.assertTerm(others[0], replacement, true) ? result : undefined;
  }

  /** Conjoins everything `other` says with what this conjunction already says. */
  public absorb(other: AssertionConjunction): boolean {
    return other.conjuncts().every(({ name, assertion }) => this.assert(name, assertion));
  }

  /**
   * Conjoins one assertion about one variable, in whichever of the five states it is.
   *
   * The inverse of {@link get}: a strong assertion whose term is a variable is the view of a clique edge,
   * and reading it back unifies the two.
   */
  public assert(name: string, assertion: Assertion): boolean {
    switch (assertion.subType) {
      case 'unbound': {
        return this.assertUnbound(name);
      }
      case 'bound': {
        return this.assertBound(name);
      }
      case 'strong': {
        return assertion.term.termType === 'Variable' ?
          this.assertUnify(name, assertion.term.value) :
          this.assertTerm(name, assertion.term, true);
      }
      case 'weak': {
        // A weak *unification* is not a state this can be in (weak ⇔ pinned group), and the recognizers
        // never produce one, so the term of a weak assertion is always a ground one.
        return this.assertTerm(name, assertion.term, false);
      }
    }
  }

  /**
   * Conjoins A⟨?x ≡ c⟩ (`strong`) or W⟨?x ≡ c⟩ (`weak`), pinning the group of `?x` to `c`.
   *
   * Pinning is per *group*: a term meeting a clique fixes every member of it, which is how an assertion
   * met above a unification travels onto all of the variables it unified.
   */
  public assertTerm(name: string, term: RDF.Term, strong: boolean): boolean {
    this.remember(name);
    if (strong) {
      // The strong form implies `bnd(?x)`, so it contradicts U and absorbs B.
      if (this.unbound.has(name)) {
        return false;
      }
      this.bound.delete(name);
      return this.pin(name, term, 'strong');
    }
    // `¬b ∧ (¬b ∨ φ) ≡ ¬b`: U absorbs the weak form outright.
    if (this.unbound.has(name)) {
      return true;
    }
    // `b ∧ (¬b ∨ ?x ≡ c) ≡ ?x ≡ c`: B rules the `¬b` disjunct out and promotes it.
    if (this.bound.delete(name)) {
      return this.pin(name, term, 'strong');
    }
    const group = this.clusters.groupOf(name);
    if (group === undefined) {
      return this.pin(name, term, 'weak');
    }
    const pinned = this.clusters.termOf(group);
    if (pinned === undefined) {
      // Membership of a clique implies `bnd(?x)`, so the weak form promotes and pins the whole clique.
      return this.pin(name, term, 'strong');
    }
    if (pinned.equals(term)) {
      // `A ∧ W ≡ A`, and a second weak copy of what is already known changes nothing either.
      return true;
    }
    // Two distinct terms: a strong member cannot be either, and two weak ones come to `!bound(?x)`.
    return this.strength.get(name) === 'strong' ? false : this.assertUnbound(name);
  }

  /**
   * Conjoins A⟨?x ≡ ?y⟩: `sameTerm(?x, ?y)`, merging the two cliques into one.
   *
   * The edge implies both endpoints are bound, which is not an extra rule but the reason U contradicts it
   * and a weak member meeting it is promoted - so it is asserted as such, before the merge.
   */
  public assertUnify(name: string, other: string): boolean {
    this.remember(name);
    this.remember(other);
    // `sameTerm(?x, ?x)` says only that `?x` is bound.
    if (name === other) {
      return this.assertBound(name);
    }
    if (!this.assertBound(name) || !this.assertBound(other)) {
      return false;
    }
    // Both are about to be group members, and B⟨?x⟩ is disjoint from those.
    this.bound.delete(name);
    this.bound.delete(other);
    const merged = this.clusters.mergeGroups(name, other);
    if (merged?.conflict === true) {
      // The two groups were pinned to different terms.
      return false;
    }
    this.strength.set(name, 'strong');
    this.strength.set(other, 'strong');
    return true;
  }

  /** Conjoins B⟨?x⟩: `bound(?x)`. */
  public assertBound(name: string): boolean {
    this.remember(name);
    if (this.unbound.has(name)) {
      return false;
    }
    if (this.clusters.groupOf(name) !== undefined) {
      // Absorbed by a strong member, and completes a weak one - `b ∧ (¬b ∨ ?x ≡ c) ≡ ?x ≡ c`.
      this.strength.set(name, 'strong');
      return true;
    }
    this.bound.add(name);
    return true;
  }

  /** Conjoins U⟨?x⟩: `!bound(?x)`. */
  public assertUnbound(name: string): boolean {
    this.remember(name);
    if (this.bound.has(name)) {
      return false;
    }
    if (this.clusters.groupOf(name) !== undefined) {
      // A strong member implies `bnd(?x)`; a weak one is absorbed (`¬b ∧ (¬b ∨ φ) ≡ ¬b`) and leaves the
      // group. U never propagates to the other members - it is about this variable only.
      if (this.strength.get(name) === 'strong') {
        return false;
      }
      this.removeMember(name);
    }
    this.unbound.add(name);
    return true;
  }

  /** The single condition the (non-empty) conjunction stands for, each conjunct in the form it carries. */
  public toExpression(c: TransformContext): Algebra.Expression {
    // eslint-disable-next-line array-callback-return
    return conjunctionOf(c, this.conjuncts().map(({ name, assertion }) => {
      switch (assertion.subType) {
        case 'unbound': {
          return unboundAssertionExpression(c, name);
        }
        case 'bound': {
          return boundAssertionExpression(c, name);
        }
        case 'strong': {
          return assertionExpression(c, name, assertion.term);
        }
        case 'weak': {
          return weakAssertionExpression(c, name, assertion.term);
        }
      }
    }));
  }

  /** The representative of a group: its lexicographically first member, so that the pass stays idempotent. */
  private representativeOf(group: number): string {
    return [ ...this.clusters.valuesOf(group) ].sort((left, right) => left.localeCompare(right))[0];
  }

  /** Pins the group of `name` to `term`, `false` when that group already equals another one. */
  private pin(name: string, term: RDF.Term, strength: 'strong' | 'weak'): boolean {
    if (!this.clusters.setTerm(this.clusters.getGroup(name), term)) {
      return false;
    }
    this.strength.set(name, strength);
    return true;
  }

  /** Takes a variable out of its group, dropping the group when nothing is left to be equal to. */
  private removeMember(name: string): void {
    this.clusters.remove(name);
    this.strength.delete(name);
  }

  private remember(name: string): void {
    this.order.add(name);
  }
}

/** One conjunct of a {@link AssertionConjunction}: what it says about one variable, or one clique edge. */
export interface AssertionConjunct {
  name: string;
  assertion: Assertion;
}

/** The variables a conjunct mentions - two of them when it is a clique edge. */
export function conjunctVars(conjunct: AssertionConjunct): string[] {
  const { assertion } = conjunct;
  return (assertion.subType === 'strong' || assertion.subType === 'weak') &&
    assertion.term.termType === 'Variable' ?
      [ conjunct.name, assertion.term.value ] :
      [ conjunct.name ];
}

/**
 * The same conjunct, in the strongest form that survives a move somewhere its variables may be unbound:
 * A⟨?x ≡ c⟩ becomes W⟨?x ≡ c⟩, and W and U are already that weak.
 *
 * B⟨?x⟩ has no such form - weakening it means allowing the unbound case, and `¬b ∨ b` is `true` - and
 * neither has a clique edge, for the reasons in {@link AssertionConjunction}. Both are `undefined`: they
 * do not travel at all, and have to stay where they are.
 */
export function weakenedConjunct(conjunct: AssertionConjunct): AssertionConjunct | undefined {
  const { name, assertion } = conjunct;
  if (assertion.subType === 'bound') {
    return undefined;
  }
  if (assertion.subType !== 'strong') {
    return conjunct;
  }
  return assertion.term.termType === 'Variable' ? undefined : { name, assertion: assertWeak(assertion.term) };
}

/**
 * What the top level conjunction of a filter condition says about the variables, cached on the filter
 * the way {@link CPMeta} is cached on any operation.
 */
export interface AssertionConjunctionMeta {
  /** The assertions (Θ) the top level conjunction carries. */
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

/** A filter of which we know what its top level conjunction says about the variables. */
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
    // The condition is evaluated over the solutions of the input, so those are the variables bound in it.
    const collected = collectAssertions(c, filter.expression, undefined, withCpVars(filter.input).metadata.cVars);
    casted.metadata ??= {};
    casted.metadata.assertions = collected ?? {
      assertions: new AssertionConjunction(),
      residual: undefined,
      contradictory: true,
    };
  }
  return <AssertionFilter> casted;
}

/**
 * Guard recognizing the filters this pass is about: the ones whose top level conjunction says something
 * about at least one variable - fixing it to a term, unifying it with another, or only deciding whether it
 * is bound - and the contradictory ones (which are the empty operation). Anything else is left where it
 * is, and the traversal keeps descending into it looking for the filters deeper down.
 */
export function isAssertionFilter(c: TransformContext, op: Algebra.Operation): op is AssertionFilter {
  if (op.type !== Algebra.Types.FILTER) {
    return false;
  }
  const { assertions } = withAssertionConjunction(c, op).metadata;
  return assertions.contradictory || assertions.assertions.size > 0;
}

/**
 * Splits a filter condition into the assertions it carries and what is left of it, folding in the
 * assertions `known` to already hold there (Θ). Returns `undefined` when the condition is contradictory,
 * making the filter empty.
 *
 * The leftovers have the *strong* assertions substituted into them, per (FReord):
 * `σ_R(A) == σ_{simplify(R[θ])}(σ_θ(A))`. That can turn a leftover into an assertion of its own -
 * `sameTerm(?y, ?x)` becomes `sameTerm(?y, c)` - so this repeats until the substitution stops changing.
 * Merging two groups counts as a change even though neither gained a term: it may hand a clique a
 * representative that is lexicographically before the one its members were substituted to.
 *
 * Merging into the known assertions is also what makes the pass idempotent: re-running it re-derives the
 * same conjunction and absorbs it rather than stacking a second copy - the residual `sameTerm(?o, ?o)` a
 * re-derived edge leaves behind folds away, since a clique member is bound.
 *
 * `cVars` are the variables the operation the condition filters certainly binds, which is what the
 * substitution folds `sameTerm(?x, ?x)` against. Leaving it empty only means fewer residuals fold.
 */
export function collectAssertions(
  c: TransformContext,
  expression: Algebra.Expression,
  known: AssertionConjunction = new AssertionConjunction(),
  cVars: ReadonlySet<string> = new Set(),
): AssertionConjunctionMeta | undefined {
  // Make copy and perform substitution
  const assertions = known.clone();
  let substitution = assertions.strongSubstitution();
  let conjuncts = splitConjunction(substituteInExpression(c, expression, substitution, cVars));

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
      // Each form has its own top level shape, so at most one of these recognizes a conjunct.
      const met = assertionOf(conjunct);
      if (met === undefined) {
        residual.push(conjunct);
        continue;
      }
      // Shortcut contradictions
      if (!assertions.assert(met.name, met.assertion)) {
        return undefined;
      }
    }

    const grown = assertions.strongSubstitution();
    // Only a change to what can be substituted below can collapse a leftover into an assertion.
    if (!sameSubstitution(substitution, grown)) {
      learned = true;
      substitution = grown;
      conjuncts = residual.flatMap(conjunct =>
        splitConjunction(substituteInExpression(c, conjunct, substitution, cVars)));
    }
  }
  return {
    assertions,
    residual: residual.length === 0 ? undefined : conjunctionOf(c, residual),
    contradictory: false,
  };
}

/** Whether two substitutions replace the same variables by the same terms. */
function sameSubstitution(left: Assertions, right: Assertions): boolean {
  return left.size === right.size &&
    [ ...left ].every(([ name, term ]) => right.get(name)?.equals(term) === true);
}
