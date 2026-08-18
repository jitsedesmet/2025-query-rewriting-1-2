import type * as RDF from '@rdfjs/types';
import { Algebra } from '@traqula/algebra-transformations-1-2';
import { meetPinsOf, pinPositions, TermClusterSet } from '../datastructures/TermClusterSet.js';
import { RangeSet } from '../RangeSet.js';
import type { TransformContext } from '../transformContext.js';
import type { Access, Assertion, AssertionValue, Assertions, TriplePosition } from './assertions.js';
import {
  accessId,
  accessValue,
  assertBound,
  assertionExpression,
  assertionOf,
  assertionVars,
  assertStrong,
  assertUnbound,
  assertWeak,
  boundAssertionExpression,
  nestedAccess,
  rootAccess,
  sameAccess,
  termValue,
  tripleValue,
  unboundAssertionExpression,
  weakAssertionExpression,
} from './assertions.js';
import type { CPMeta } from './certainlyBoundVars.js';
import { withCpVars } from './certainlyBoundVars.js';
import { booleanConstantOf, conjunctionOf, splitConjunction } from './expressionHelpers.js';
import type { ExpressionSubstitution } from './partialExpressionEvaluation.js';
import { substituteInExpression } from './partialExpressionEvaluation.js';
import { DF } from './rdfDatatypes.js';

/**
 * @fileoverview The conjunction of assertions (Θ) the pushdown moves around, and how a filter condition
 * is read into one.
 *
 * `FILTER(sameTerm(?x, ?y))` constrains *two* variables at once, and a chain of such filters makes
 * a clique of variables that all have to be equal. `FILTER(sameTerm(subject(?o), ?s))` constrains a
 * *part* of what one of them is bound to. So the carrier is a union-find ({@link TermClusterSet}) whose
 * groups may be pinned to a term or to a triple shape whose three positions are groups of their own,
 * plus the two term-less forms (`bound` / `!bound`) which stay per variable.
 *
 * The dividing line, and the reason everything else stays simple:
 * a group **pinned to a term** still decomposes into independent single-variable conjuncts.
 * A group **without one** - a clique, or a shape a second variable also has - has to be reasoned about
 * as a whole, because its conjuncts mention two variables each.
 *
 * **Nothing is ever serialised as `sameTerm(?o, <<( … )>>)`**. The positions of a shape are written as
 * the accessors they were read from - `sameTerm(subject(?o), :a)`, `isTRIPLE(?o)` - because the
 * variables that would name the positions are unbound wherever the filter sits, so such a condition
 * would error and drop every row. Writing them back in the form they were read in is also what keeps the
 * pass idempotent.
 */

/**
 * A set of assertions Θ, in the five states an assertion about a variable can be in:
 *
 * | state                                  | means                             |
 * |----------------------------------------|-----------------------------------|
 * | strong member of a pinned group        | `sameTerm(?x, c)`                 |
 * | weak member of a pinned group          | `!bound(?x) \|\| sameTerm(?x, c)` |
 * | member of an anchorless group (clique) | `sameTerm(?x, ?rep)`              |
 * | unbound                                | `!bound(?x)`                      |
 * | bound                                  | `bound(?x)`, no term              |
 *
 * where "pinned" now covers a shape as well as a term: a group pinned to a triple states one conjunct
 * per position it knows something about, all of them rooted at the *anchor* of the group.
 *
 * **Weak ⇔ pinned group.** Every member of an anchorless group is strong, because there is no usable weak
 * form of a clique: cluster-level weak ("all bound members pairwise `sameTerm`") does not distribute over
 * a join - `μ₁={?x↦a}` and `μ₂={?y↦b}` each satisfy it and their merge does not - and merging two
 * independent weak edges is unsound (`W⟨{x,y}⟩ ∧ W⟨{y,z}⟩ ⊭ W⟨{x,y,z}⟩`, take `?y` unbound). A pin is
 * what makes the weak form work: an anchor both sides of a join already agree on. So {@link weakened}
 * drops anchorless groups rather than inventing a weak form for them, exactly as it drops B⟨?x⟩.
 *
 * The same argument, read one conjunct at a time, is the rule for shapes: **a conjunct has a weak form
 * iff it mentions exactly one variable**. `!bound(?o) || sameTerm(subject(?o), :a)` is fine;
 * `sameTerm(subject(?o), ?s)` is an edge between two variables and travels as T⟨?o⟩ where it cannot go.
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
  /** Variable to its group; a group may be pinned to the shape all of its members have. */
  private clusters: TermClusterSet<string, RDF.Term>;
  /**
   * Strength only applies to variables in groups. If you are not in a group, you are a stale leftover.
   */
  private strength: Map<string, 'strong' | 'weak'>;
  /** U⟨?x⟩ */
  private unbound: Set<string>;
  /** B⟨?x⟩ */
  private bound: Set<string>;
  /**
   * The variables in the order they were first mentioned, used to keep a pass idempotent.
   */
  private order: Set<string>;

  public constructor() {
    this.clusters = new TermClusterSet<string, RDF.Term>(
      name => name,
      meetPinsOf((a, b) => a.equals(b)),
      term => new RangeSet([ term.termType ]),
    );
    this.strength = new Map();
    this.unbound = new Set();
    this.bound = new Set();
    this.order = new Set();
  }

  /** The conjunction of the assertions of `conjuncts`, which never contradict when they come from one Θ. */
  public static of(conjuncts: Iterable<AssertionConjunct>): AssertionConjunction {
    const result = new AssertionConjunction();
    for (const { access, assertion } of conjuncts) {
      // A subset of a satisfiable conjunction is satisfiable, so this cannot fail for such a subset.
      result.assert(access, assertion);
    }
    return result;
  }

  /** A copy that shares no state with this one, so that either may be asserted into on its own. */
  public clone(): AssertionConjunction {
    const copy = new AssertionConjunction();
    copy.adopt(this);
    return copy;
  }

  /** Takes over the state of another conjunction, which is how a trial assertion is accepted. */
  private adopt(other: AssertionConjunction): void {
    this.clusters = other.clusters.clone();
    this.strength = new Map(other.strength);
    this.unbound = new Set(other.unbound);
    this.bound = new Set(other.bound);
    this.order = new Set(other.order);
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
   * What the conjunction says about the *value* of one variable - the view a rule that reasons about
   * terms takes, as against {@link conjuncts}, which is the whole of what it says.
   *
   * For a clique, the strong assertion to the representative is made; for the representative of one, and
   * for a variable only known to hold a triple term of no decided structure, `bound` and T⟨?x⟩
   * respectively. A shape every position of which is decided *is* a term, and reads as one.
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
    const weak = this.strength.get(name) === 'weak';
    const term = this.groundTermOf(group);
    if (term !== undefined) {
      return weak ? assertWeak(term) : assertStrong(term);
    }
    const representative = this.representativeOf(group);
    if (representative !== undefined && representative !== name) {
      // Another variable of the group is the anchor, so what this one is, is that one.
      return assertStrong(accessValue(rootAccess(representative)));
    }
    if (this.clusters.childrenOf(group) !== undefined) {
      // The anchor itself, of a group whose shape is not decided: all that is left to say of it is that
      // it holds a triple term - which the positions of the shape only make more precise.
      return weak ? assertWeak(tripleValue) : assertStrong(tripleValue);
    }
    return assertBound();
  }

  /**
   * The independent conjuncts Θ decomposes into: one per variable for everything but a clique, and for a
   * clique the edges of a spanning tree - the star from its representative - and for a shape one
   * conjunct per position it knows something about.
   *
   * Splitting a clique means splitting its *edges*, never its variables: a clique is transitively closed,
   * so any spanning tree of it is equivalent to the whole, and what a caller pushes plus what it keeps has
   * to span it. Dropping the representative's own (empty) conjunct is what makes that work out: the edges
   * of the star already entail B⟨?rep⟩.
   *
   * A shape is stated **once per group**, rooted at the anchor of that group, so that two positions that
   * turned out to be the same group are written the same way wherever they are read. What a position is
   * equal to is the anchor of *its* group in turn, which is how `sameTerm(subject(?o), ?s)` comes back
   * out as itself, and how a position nothing else reaches states itself with its own accessor.
   */
  public conjuncts(): AssertionConjunct[] {
    const anchors = this.anchors();
    const result: AssertionConjunct[] = [];
    for (const name of this.names()) {
      if (this.unbound.has(name)) {
        result.push({ access: rootAccess(name), assertion: assertUnbound() });
        continue;
      }
      if (this.bound.has(name)) {
        result.push({ access: rootAccess(name), assertion: assertBound() });
        continue;
      }
      const group = <number> this.clusters.groupOf(name);
      const anchor = anchors.get(group);
      const weak = this.strength.get(name) === 'weak';
      const access = rootAccess(name);
      if (anchor !== undefined && anchor.kind === 'access' && sameAccess(anchor.access, access)) {
        // `name` is the anchor of its group, so it is the one that states the shape - and a clique needs
        // no conjunct for its representative, the star of its edges already entailing B⟨?rep⟩.
        const shape = this.shapeConjuncts(group, access, anchors, weak, false);
        if (shape.length === 0 && this.namedMembers(group).length < 2 &&
          !this.clusters.isComponent(group)) {
          // Nothing left but the fact that it is bound, which a group of one still says - unless it is a
          // *position* of another group, which is stated by the conjunct naming that position instead.
          result.push({ access, assertion: assertBound() });
        }
        result.push(...shape);
        continue;
      }
      const stated = anchor === undefined ? undefined : this.conjunctOf(access, anchorValue(anchor), weak);
      if (stated !== undefined) {
        result.push(stated);
      } else if (weak) {
        // A weak member cannot be stated against another variable - the two together mention two of them,
        // and only what mentions one has a weak form. What of the shape is *decided* still travels with
        // it, rooted at this member rather than at the anchor.
        result.push(...this.shapeConjuncts(group, access, anchors, true, true));
      }
    }
    return result;
  }

  /**
   * The cliques of Θ - the groups no term decides, and that more than one variable is in - each as its
   * members in lexicographic order, so that the first of them is the representative.
   *
   * These are the conjuncts of {@link conjuncts} that a rule cannot take one at a time: a rule that
   * decides per variable would split a clique into pieces that no longer say it, so it decides per clique
   * and splits the *edges* instead. A group pinned to a *shape* is one of them: its members are equal to
   * each other, and the shape they share is stated separately, once, rooted at the representative.
   */
  public cliques(): string[][] {
    const result: string[][] = [];
    for (const [ group ] of this.clusters.groupEntries()) {
      const members = this.namedMembers(group);
      if (members.length > 1 && this.groundTermOf(group) === undefined) {
        result.push(members);
      }
    }
    return result;
  }

  /**
   * Splits Θ in two along `predicate` callback:
   * when all variables in an {@link AssertionConjunct} match the predicate, they are in 'inside'.
   * The two are equivalent to the whole, since together they hold every conjunct (under simple conjunct-UNION).
   *
   * `admits` is the second half of the same question, for a rule that can only take *some shapes* of
   * conjunct however welcome their variables are.
   */
  public split(
    predicate: (name: string) => boolean,
    admits: (conjunct: AssertionConjunct) => boolean = () => true,
  ): { inside: AssertionConjunction; outside: AssertionConjunction } {
    const inside: AssertionConjunct[] = [];
    const outside: AssertionConjunct[] = [];
    for (const conjunct of this.conjuncts()) {
      (conjunctVars(conjunct).every(predicate) && admits(conjunct) ? inside : outside).push(conjunct);
    }
    return { inside: AssertionConjunction.of(inside), outside: AssertionConjunction.of(outside) };
  }

  /**
   * Θ with every conjunct in the strongest form that survives a move somewhere its variables may be
   * unbound: a conjunct about one variable becomes weak, and the ones that have no weak form at all -
   * B⟨?x⟩ and everything mentioning two variables - are dropped.
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
   * form decides - the OPTIONAL → JOIN collapse above all - even where the edge itself cannot travel. So
   * is every variable a shape is asserted of, and every variable naming one of its positions: a triple
   * term is a term, and so is each of its components.
   */
  public boundImpliedBy(): Set<string> {
    const result = new Set<string>(this.bound);
    for (const name of this.names()) {
      if (this.strength.get(name) === 'strong' && this.clusters.groupOf(name) !== undefined) {
        result.add(name);
      }
    }
    return result;
  }

  /**
   * The substitution the strong assertions stand for, in the form the `substituteIn…` helpers take: a
   * member of a group with a decided value maps to that term, and a member of any other group to the
   * anchor of it.
   *
   * Only *decided* values, which is what keeps an open shape out of an expression: the variables that
   * would name its positions are unbound wherever the expression is evaluated. {@link patternSubstitution}
   * is the one that may materialise them, because a pattern is what binds them.
   *
   * Dropping the other forms is the point: substituting `c` for `?x` under W⟨?x ≡ c⟩ would claim `?x` is
   * bound, and B⟨?x⟩ and U⟨?x⟩ have no term to substitute.
   */
  public expressionSubstitution(): Assertions {
    const result = new Map<string, RDF.Term>();
    for (const name of this.names()) {
      const group = this.clusters.groupOf(name);
      if (this.strength.get(name) !== 'strong' || group === undefined) {
        continue;
      }
      const term = this.groundTermOf(group);
      if (term === undefined) {
        const representative = this.representativeOf(group);
        if (representative !== undefined && representative !== name) {
          result.set(name, DF.variable(representative));
        }
      } else {
        result.set(name, term);
      }
    }
    return result;
  }

  /**
   * What is left of Θ once a substitution has been written into the operation below it.
   *
   * Substituting is how an assertion is *discharged*: `?x ≡ :c` needs no filter once every `?x` in the
   * pattern is a `:c`, and neither does `?x ≡ ?rep` once both are the same variable. A shape written into
   * a pattern discharges the conjuncts about its positions the same way - `subject(?o) ≡ ?s` holds by
   * construction once `?o` stands for `<<( ?s ?o_p ?o_o )>>` - which is what makes the rendering of a
   * group have to be the same wherever it is written.
   *
   * So a conjunct is discharged when every access it reads lands in a group the substitution *rendered*:
   * the group of a variable it replaces, or a position of one, at any depth. Everything else stays above,
   * which is what keeps a conjunction no substitution can express from being quietly dropped - and the
   * weak forms with it, since only what is strong is substituted at all.
   */
  public undischargedBy(substitution: Assertions): AssertionConjunction {
    const rendered = new Set<number>();
    const queue = [ ...substitution.keys() ]
      .map(name => this.clusters.groupOf(name))
      .filter(group => group !== undefined);
    while (queue.length > 0) {
      const group = <number> queue.pop();
      if (!rendered.has(group)) {
        rendered.add(group);
        queue.push(...this.clusters.childrenOf(group) ?? []);
      }
    }
    const isRendered = (access: Access): boolean => {
      const group = this.groupOfAccess(access);
      return group !== undefined && rendered.has(group);
    };
    return AssertionConjunction.of(this.conjuncts().filter(({ access, assertion }) =>
      !(assertion.subType === 'strong' && isRendered(access) &&
        (assertion.value.kind !== 'access' || isRendered(assertion.value.access)))));
  }

  /**
   * What Θ decides about the accesses an expression reads, which is what a residual is folded against.
   *
   * The accessor folds are what keep the pass idempotent: without them the very condition an assertion
   * was read from never folds to `true`, and re-running the pass stacks a second copy of it.
   */
  public expressionView(): ExpressionSubstitution {
    const substitution = this.expressionSubstitution();
    return {
      resolve: access => this.resolveAccess(access, substitution),
      isTriple: (access) => {
        const group = this.groupOfAccess(access);
        return group !== undefined && this.rootIsStrong(access) &&
          this.clusters.childrenOf(group) !== undefined;
      },
      bound: this.boundImpliedBy(),
    };
  }

  /**
   * Reads Θ in terms of what an operation binds - `undefined` when it makes that operation empty.
   *
   * Where `?x` is certainly bound, `!bound(?x)` is unsatisfiable, so W *is* A, B is `true` and U is empty;
   * where `?x` can never be bound, A and B are empty ((FBndII)) and W and U are simply `true`.
   *
   * The ranges decide the same two things one level finer, which is why every rule below reads them
   * rather than the scope:
   *
   * - A variable whose range is *empty* is never bound, exactly as one out of scope is never bound -
   *   {@link VRanges.neverBinds} is the single fact both are - so A and B empty the operation by (FBndII)
   *   while W and U are carried by their `!bound(?x)` disjunct and prune away.
   * - A variable pinned to a term outside a range that is *not* empty - `?g ≡ "1"` under a `GRAPH ?g`,
   *   `?p ≡ _:b` in a predicate position - cannot be bound to it, which is the same fact for one term
   *   rather than for all of them. **Strong** is then unsatisfiable, since it implies `bnd(?x)`; **weak**
   *   loses its right disjunct and becomes exactly U⟨?x⟩. Which is why the rewrites downstream need no
   *   term-type checks of their own.
   *
   * Per member of a group, not per group: a group whose members disagree about being in `cVars` is
   * perfectly ordinary. Taking a member out may leave its group with a single variable and nothing for it
   * to equal, which {@link TermClusterSet.remove} then drops.
   *
   * Reading a clique per member is not an approximation of a per-clique rule. Every member of one carries
   * A⟨?x ≡ ?rep⟩, which entails `bnd(?x)` of that member alone, and both rules are about exactly that: a
   * member out of scope empties the operation by (FBndII) - which is the clique's own emptiness check,
   * since the clique entails `bnd` of each of them - and `cVars` has nothing to promote an edge into,
   * there being no form of one weaker than itself.
   *
   * The ranges are the third reading, and the only one that is about the *value* rather than about
   * whether there is one: what a strong member can be bound to here narrows what its group can hold, so
   * `?s ?p ?o FILTER(sameTerm(?s, "lit"))` is empty here rather than at the pattern it would have reached,
   * and a shape only ever nests down the object chain. A *weak* member narrows nothing - it may simply be
   * unbound - which is the conservative direction.
   *
   * Coverage - whether something below binds enough of a clique to be handed its edges - is not decided
   * here. This reads the conjunction against the single operation the filter sits on, before the swap;
   * the swap is what splits the edges over the branches it has licences for.
   */
  public normalisedFor({ cVars, vRanges }: CPMeta): AssertionConjunction | undefined {
    const result = this.clone();
    for (const name of this.names()) {
      if (this.unbound.has(name)) {
        if (cVars.has(name)) {
          // Contradiction
          return undefined;
        }
        if (vRanges.neverBinds(name)) {
          // `!bound(?x)` holds of every solution here, so nothing is left to assert.
          result.unbound.delete(name);
        }
      } else if (this.bound.has(name)) {
        // Contradiction -- (FBndII), which both of the forms implying `bound(?x)` trigger.
        if (vRanges.neverBinds(name)) {
          return undefined;
        }
        if (cVars.has(name)) {
          result.bound.delete(name);
        }
      } else {
        const isStrong = this.strength.get(name) === 'strong';
        if (vRanges.neverBinds(name)) {
          if (isStrong) {
            return undefined;
          }
          // Never bound and weak -> the `!bound(?x)` disjunct carries it, so nothing to assert.
          result.removeMember(name);
        } else if (cVars.has(name)) {
          // B⟨?x⟩ holds of every solution here, and completes a weak member into a strong one.
          result.strength.set(name, 'strong');
        }
        // A member pinned to a value whose term type is decided, where the variable can never take one -
        // the same rule as (FBndII) one level down the lattice, the variable being in scope here and no
        // solution binding it to *this* kind of term. Read off `result`, so a promotion just above counts.
        // A clique member is pinned to an *access*, which says nothing statically, so it is skipped.
        const pinned = result.get(name);
        const pinnedType = pinned === undefined ? undefined : decidedTypeOf(pinned);
        if ((pinned?.subType === 'strong' || pinned?.subType === 'weak') &&
          pinnedType !== undefined && !vRanges.rangeOf(name).has(pinnedType)) {
          if (pinned.subType === 'strong') {
            // A⟨?x ≡ c⟩ implies `bnd(?x)` and there is no value left for it to take.
            return undefined;
          }
          // W⟨?x ≡ c⟩ is `¬bnd(?x) ∨ ?x ≡ c`, and the right disjunct is false wherever `?x` is bound. So
          // the weak form *is* U⟨?x⟩ here - which is worth doing rather than leaving it: a weak member
          // says almost nothing, where `!bound(?x)` is a constraint the rest of the pass acts on.
          // Cannot fail: `?x` is neither `bound` nor a strong member, the two states it rejects.
          result.assertUnbound(name);
        }
      }
    }
    for (const name of result.names()) {
      const group = result.clusters.groupOf(name);
      if (group !== undefined && result.strength.get(name) === 'strong' &&
        !result.clusters.narrowRange(group, vRanges.rangeOf(name))) {
        // Nothing this operation can bind the variable to is what its group holds.
        return undefined;
      }
    }
    return result;
  }

  /**
   * Θ with `name` taken out of it and whatever it was equal *to* restated against `replacement` -
   * the term that carries its value where the result is going, which the caller is responsible for
   * establishing.
   *
   * For a BIND, that is its expression: below `BIND(?z AS ?t)` it is `?z` that holds what `?t` holds above,
   * and below `BIND(:c AS ?t)` it is `:c`. It is one rule read against the two kinds of thing `name`
   * could have been equal to and the two kinds of thing that can now carry it - a group pinned to a term,
   * to a shape, or to nothing at all, met by a variable that takes `name`'s place in it or by a term that
   * has to be what the group holds. A ground comparison either holds or makes the whole thing empty.
   *
   * Taking the variable out one member at a time, rather than dropping every conjunct that mentions it,
   * is what keeps the rest of its clique intact when it happens to be the representative all of the edges
   * point at - and what keeps the shape of its group, which the replacement now has. Only what it was
   * equal to travels: B⟨?x⟩ and U⟨?x⟩ on `name` are simply removed, and stay where the caller put them.
   */
  public transferred(name: string, replacement: RDF.Term): AssertionConjunction | undefined {
    const result = this.clone();
    const group = result.clusters.groupOf(name);
    const strong = this.strength.get(name) === 'strong';
    result.bound.delete(name);
    result.unbound.delete(name);
    if (group === undefined) {
      // Nothing was equal to it, so there is nothing to restate.
      return result;
    }
    // The replacement takes its place *before* it leaves, so that a group whose only content was the
    // equality between the two of them does not disappear in between.
    if (replacement.termType === 'Variable') {
      result.remember(replacement.value);
      const other = result.clusters.getGroup(replacement.value);
      result.markStrong(replacement.value);
      if (!strong) {
        result.strength.set(replacement.value, 'weak');
      }
      if (other !== group && result.clusters.mergeGroupIds(group, other)?.conflict === true) {
        return undefined;
      }
    } else if (!result.pinTerm(group, replacement)) {
      // The term it now has to be is not the one the group holds.
      return undefined;
    }
    result.removeMember(name);
    return result;
  }

  /** Conjoins everything `other` says with what this conjunction already says. */
  public absorb(other: AssertionConjunction): boolean {
    return other.conjuncts().every(({ access, assertion }) => this.assert(access, assertion));
  }

  /**
   * Conjoins one assertion about one access, in whichever of the five states it is.
   *
   * The inverse of {@link conjuncts}: a strong assertion whose value is an access is the view of an edge
   * between two groups, and reading it back unifies the two.
   */
  public assert(access: Access, assertion: Assertion): boolean {
    switch (assertion.subType) {
      case 'unbound': {
        return this.assertUnbound(access.name);
      }
      case 'bound': {
        return this.assertBound(access.name);
      }
      case 'strong': {
        return this.assertValue(access, assertion.value, true);
      }
      case 'weak': {
        return this.assertValue(access, assertion.value, false);
      }
    }
  }

  /**
   * Conjoins A⟨?x ≡ c⟩ (`strong`) or W⟨?x ≡ c⟩ (`weak`), pinning the group of `?x` to `c`.
   *
   * Pinning is per *group*: a term meeting a clique fixes every member of it, which is how an assertion
   * met above a unification travels onto all of the variables it unified.
   * @returns `false` when the assertion contradicts what is already known.
   */
  public assertTerm(name: string, term: RDF.Term, strong: boolean): boolean {
    return this.assertValue(rootAccess(name), termValue(term), strong);
  }

  /**
   * Conjoins A⟨?x ≡ ?y⟩: `sameTerm(?x, ?y)`, merging the two cliques into one.
   *
   * The edge implies both endpoints are bound, which is not an extra rule but the reason U contradicts it
   * and a weak member meeting it is promoted - so it is asserted as such, before the merge.
   */
  public assertUnify(name: string, other: string): boolean {
    return this.assertValue(rootAccess(name), accessValue(rootAccess(other)), true);
  }

  /** Conjoins B⟨?x⟩: `bound(?x)`. */
  public assertBound(name: string): boolean {
    this.remember(name);
    if (this.unbound.has(name)) {
      // Contradiction
      return false;
    }
    const group = this.clusters.groupOf(name);
    if (group !== undefined) {
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
      // Contradiction
      return false;
    }
    const group = this.clusters.groupOf(name);
    if (group !== undefined) {
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
    return conjunctionOf(c, this.conjuncts().map(({ access, assertion }) => {
      switch (assertion.subType) {
        case 'unbound': {
          return unboundAssertionExpression(c, access.name);
        }
        case 'bound': {
          return boundAssertionExpression(c, access.name);
        }
        case 'strong': {
          return assertionExpression(c, access, assertion.value);
        }
        case 'weak': {
          return weakAssertionExpression(c, access, assertion.value);
        }
      }
    }));
  }

  /**
   * Conjoins one assertion about one access, in the strong or the weak form.
   *
   * The strong form implies `bnd` of every variable it mentions - the root of the access, since reading a
   * position of an unbound term errors, and every variable naming a position, since the components of a
   * triple term are bound whenever it is. So it is asserted as such, before anything else happens, which
   * is what promotes a weak member and contradicts U.
   *
   * The weak form says all of that only *if* the variable is bound, so it may not assert any of it. What
   * it can do is find out whether the strong form would hold at all: where it would not, `?x` cannot be
   * bound here, and the weak form comes to U⟨?x⟩ - which is the general form of the rule that two
   * different weak terms about one variable make it unbound.
   */
  private assertValue(access: Access, value: AssertionValue, strong: boolean): boolean {
    for (const name of assertionVars(access, value)) {
      this.remember(name);
    }
    if (value.kind === 'access' && sameAccess(access, value.access) && access.positions.length === 0) {
      // `sameTerm(?x, ?x)` says only that `?x` is bound - and nothing at all in the weak form.
      return !strong || this.assertBound(access.name);
    }
    if (strong) {
      return this.assertStrongValue(access, value);
    }
    const root = access.name;
    if (this.unbound.has(root)) {
      // `¬b ∧ (¬b ∨ φ) ≡ ¬b`: U absorbs the weak form outright.
      return true;
    }
    const group = this.clusters.groupOf(root);
    if (this.bound.delete(root) || this.strength.get(root) === 'strong' ||
      (group !== undefined && this.clusters.pinOf(group) === undefined)) {
      // B rules the `¬b` disjunct out, and so does a strong member or membership of a clique, both of
      // which imply `bnd(?x)`: `b ∧ (¬b ∨ ?x ≡ c) ≡ ?x ≡ c`.
      return this.assertStrongValue(access, value);
    }
    const probe = this.clone();
    if (!probe.assertStrongValue(access, value)) {
      // What the weak form would say cannot hold, so its `¬b` disjunct is all that is left of it.
      return this.assertUnbound(root);
    }
    // It can hold, and holds of this variable only where it is bound.
    probe.strength.set(root, 'weak');
    this.adopt(probe);
    return true;
  }

  /** Conjoins the strong form, which is where all of the structure is actually built. */
  private assertStrongValue(access: Access, value: AssertionValue): boolean {
    // The whole conjunct implies `bnd` of every variable it mentions, and a group member is not in `bound`.
    for (const name of assertionVars(access, value)) {
      if (!this.assertBound(name)) {
        return false;
      }
    }
    const group = this.openGroup(access);
    if (group === false) {
      return false;
    }
    this.markStrong(access.name);
    switch (value.kind) {
      case 'triple': {
        return this.clusters.setTriple(group) !== false;
      }
      case 'term': {
        return this.pinTerm(group, value.term);
      }
      case 'access': {
        const other = this.openGroup(value.access);
        if (other === false) {
          return false;
        }
        this.markStrong(value.access.name);
        return group === other || this.clusters.mergeGroupIds(group, other)?.conflict !== true;
      }
    }
  }

  /**
   * Pins a group to a term, decomposing a triple term into the shape it is.
   *
   * That decomposition is what makes `sameTerm(?o, <<( ?a ?b ?c )>>)` say something - it is not a term
   * until its components are decided - and what makes a *ground* triple term unify with a shape instead
   * of contradicting it, since both sides are then triple pins over decided children.
   */
  private pinTerm(group: number, term: RDF.Term): boolean {
    if (term.termType !== 'Quad') {
      return this.clusters.setTerm(group, term);
    }
    if (this.clusters.setTriple(group) === false) {
      return false;
    }
    const components = [ term.subject, term.predicate, term.object ];
    for (const [ index, component ] of components.entries()) {
      // Re-read every time: a merge below may have moved the children of this very group.
      const children = this.clusters.childrenOf(group);
      if (children === undefined) {
        return false;
      }
      if (component.termType === 'Variable') {
        this.remember(component.value);
        const other = this.clusters.getGroup(component.value);
        this.markStrong(component.value);
        if (children[index] !== other && this.clusters.mergeGroupIds(children[index], other)?.conflict === true) {
          return false;
        }
      } else if (!this.pinTerm(children[index], component)) {
        return false;
      }
    }
    return true;
  }

  /**
   * The group an access reads, creating the shapes it goes through.
   * @returns `false` when a position of it cannot hold a triple term at all.
   */
  private openGroup(access: Access): number | false {
    let group = this.clusters.getGroup(access.name);
    for (const position of access.positions) {
      const children = this.clusters.setTriple(group);
      if (children === false) {
        return false;
      }
      group = children[positionIndex(position)];
    }
    return group;
  }

  /** The group an access reads, without creating anything - `undefined` when nothing is known about it. */
  private groupOfAccess(access: Access): number | undefined {
    let group = this.clusters.groupOf(access.name);
    for (const position of access.positions) {
      if (group === undefined) {
        return undefined;
      }
      group = this.clusters.childrenOf(group)?.[positionIndex(position)];
    }
    return group;
  }

  /** Whether the variable an access is rooted at is bound wherever the access is read. */
  private rootIsStrong(access: Access): boolean {
    return this.strength.get(access.name) === 'strong' && this.clusters.groupOf(access.name) !== undefined;
  }

  /** The term an access is decided to be, for substituting it into an expression. */
  private resolveAccess(access: Access, substitution: Assertions): RDF.Term | undefined {
    if (access.positions.length === 0) {
      return substitution.get(access.name);
    }
    if (!this.rootIsStrong(access)) {
      // Reading a position of a variable that may be unbound decides nothing: it errors instead.
      return undefined;
    }
    const group = this.groupOfAccess(access);
    if (group === undefined) {
      return undefined;
    }
    const ground = this.groundTermOf(group);
    if (ground !== undefined) {
      return ground;
    }
    // A variable naming the position carries its value, and is bound wherever the root is.
    const representative = this.representativeOf(group);
    return representative === undefined ? undefined : DF.variable(representative);
  }

  /** The named members of a group, in lexicographic order - the first of them its representative. */
  private namedMembers(group: number): string[] {
    return [ ...this.clusters.valuesOf(group) ].sort((left, right) => left.localeCompare(right));
  }

  /** The representative of a group: its lexicographically first member, so that the pass stays idempotent. */
  private representativeOf(group: number): string | undefined {
    return this.namedMembers(group)[0];
  }

  /**
   * The term a group is decided to be: its term pin, or the triple term a shape every position of which
   * is decided in turn amounts to. `undefined` for everything a variable is still needed to name.
   */
  private groundTermOf(group: number): RDF.Term | undefined {
    const term = this.clusters.termOf(group);
    if (term !== undefined) {
      return term;
    }
    const children = this.clusters.childrenOf(group);
    if (children === undefined) {
      return undefined;
    }
    const components = children.map(child => this.groundTermOf(child));
    if (components.includes(undefined)) {
      return undefined;
    }
    const [ subject, predicate, object ] = <RDF.Term[]> components;
    return DF.quad(
      <RDF.Quad_Subject> subject,
      <RDF.Quad_Predicate> predicate,
      <RDF.Quad_Object> object,
    );
  }

  /**
   * The canonical way of naming every group: its term, else the lexicographically first variable in it,
   * else the lexicographically first access path that reaches it from a group a variable names.
   *
   * One anchor per group, used for *everything* - the accessor a condition is written with, the
   * representative a clique substitutes to, the name a materialised position gets - so that a group two
   * paths reach is written the same way wherever it is read, and both operands of a join keep joining on
   * the position they were substituted into.
   */
  private anchors(): Map<number, Anchor> {
    const result = new Map<number, Anchor>();
    const queue: number[] = [];
    for (const [ group ] of this.clusters.groupEntries()) {
      const term = this.clusters.termOf(group);
      const named = this.representativeOf(group);
      if (term !== undefined) {
        result.set(group, { kind: 'term', term });
      } else if (named !== undefined) {
        result.set(group, { kind: 'access', access: rootAccess(named) });
      }
      queue.push(group);
    }
    // The rest is reachability: a position of an anchored group is anchored by the accessor that reads
    // it, and the lexicographically first of the paths that reach it wins. The shapes are acyclic (the
    // occurs check sees to that), and every step only ever *lowers* an anchor, so this settles.
    while (queue.length > 0) {
      const group = <number> queue.shift();
      const anchor = result.get(group);
      const children = this.clusters.childrenOf(group);
      if (anchor === undefined || anchor.kind !== 'access' || children === undefined) {
        continue;
      }
      for (const [ index, child ] of children.entries()) {
        const candidate = nestedAccess(anchor.access, pinPositions[index]);
        const known = result.get(child);
        if (known === undefined ||
          (known.kind === 'access' && accessId(candidate) < accessId(known.access) &&
            this.namedMembers(child).length === 0)) {
          result.set(child, { kind: 'access', access: candidate });
          queue.push(child);
        }
      }
    }
    return result;
  }

  /**
   * The conjuncts stating the shape of a group, rooted at one access of it: one per position, saying
   * what that position is anchored to.
   *
   * A position whose own anchor is the accessor being written states *itself* instead, one level down -
   * which is how a chain of positions comes out as a chain of accessors, and how a position nothing is
   * known about contributes nothing at all. Where no position contributes anything, the shape is written
   * as the degenerate `isTRIPLE(?o)`; where one does, it already entails that.
   *
   * `groundOnly` is the form a weak member takes: it keeps only what is decided without naming another
   * variable, since only a conjunct about one variable has a weak form at all.
   */
  private shapeConjuncts(
    group: number,
    access: Access,
    anchors: Map<number, Anchor>,
    weak: boolean,
    groundOnly: boolean,
  ): AssertionConjunct[] {
    const children = this.clusters.childrenOf(group);
    if (children === undefined) {
      return [];
    }
    const result: AssertionConjunct[] = [];
    for (const [ index, child ] of children.entries()) {
      const position = nestedAccess(access, pinPositions[index]);
      const anchor = anchors.get(child);
      if (anchor === undefined) {
        continue;
      }
      if (anchor.kind === 'access' && (sameAccess(anchor.access, position) || groundOnly)) {
        result.push(...this.shapeConjuncts(child, position, anchors, weak, groundOnly));
        continue;
      }
      const stated = this.conjunctOf(position, anchorValue(anchor), weak);
      if (stated !== undefined) {
        result.push(stated);
      }
    }
    if (result.length === 0) {
      const degenerate = this.conjunctOf(access, tripleValue, weak);
      if (degenerate !== undefined) {
        result.push(degenerate);
      }
    }
    return result;
  }

  /**
   * One conjunct in the form its variables admit, or nothing where they admit none.
   *
   * A conjunct mentioning one variable has a weak form and a strong one; one mentioning two has only the
   * strong form, which claims *both* of them are bound - so a weak member may not appear in one at all.
   */
  private conjunctOf(access: Access, value: AssertionValue, weak: boolean): AssertionConjunct | undefined {
    const vars = assertionVars(access, value);
    if (weak) {
      return vars.length === 1 ? { access, assertion: assertWeak(value) } : undefined;
    }
    return vars.every(name => this.strength.get(name) !== 'weak') ?
        { access, assertion: assertStrong(value) } :
      undefined;
  }

  /** Records that a variable is a member of a group, which is disjoint from B⟨?x⟩. */
  private markStrong(name: string): void {
    this.bound.delete(name);
    this.strength.set(name, 'strong');
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

/** The canonical way of naming a group: what everything about it is written against. */
type Anchor = { kind: 'access'; access: Access } | { kind: 'term'; term: RDF.Term };

/** The value an anchor states, which is the anchor itself read as the right hand side of an assertion. */
function anchorValue(anchor: Anchor): AssertionValue {
  return anchor.kind === 'term' ? termValue(anchor.term) : accessValue(anchor.access);
}

/**
 * The term type an assertion decides for what it is about, or `undefined` when it decides none.
 *
 * A term says its own type, and a shape says `Quad` however little it knows about the positions - which
 * is exactly what makes T⟨?x⟩ worth reading against a range. An *access* says nothing statically: it is a
 * clique edge, and what the other side holds is a matter for the group the two share.
 */
function decidedTypeOf(assertion: Assertion): RDF.Term['termType'] | undefined {
  if (assertion.subType !== 'strong' && assertion.subType !== 'weak') {
    return undefined;
  }
  if (assertion.value.kind === 'triple') {
    return 'Quad';
  }
  return assertion.value.kind === 'term' ? assertion.value.term.termType : undefined;
}

/** The child a position is held in, in the order {@link pinPositions} fixes. */
function positionIndex(position: TriplePosition): number {
  return pinPositions.indexOf(position);
}

/** One conjunct of a {@link AssertionConjunction}: what it says about one access, or one clique edge. */
export interface AssertionConjunct {
  access: Access;
  assertion: Assertion;
}

/** The variables a conjunct mentions - two iff it is an edge between two of them. */
export function conjunctVars(conjunct: AssertionConjunct): string[] {
  const { assertion } = conjunct;
  return assertionVars(
    conjunct.access,
    assertion.subType === 'strong' || assertion.subType === 'weak' ? assertion.value : undefined,
  );
}

/**
 * The same conjunct, in the strongest form that survives a move somewhere its variables may be unbound:
 * A⟨?x ≡ c⟩ becomes W⟨?x ≡ c⟩, and W and U are already that weak.
 *
 * B⟨?x⟩ has no such form - weakening it means allowing the unbound case, and `¬b ∨ b` is `true` - and
 * neither has a conjunct about two variables, for the reasons in {@link AssertionConjunction}. Both are
 * `undefined`: they do not travel at all, and have to stay where they are.
 */
export function weakenedConjunct(conjunct: AssertionConjunct): AssertionConjunct | undefined {
  const { access, assertion } = conjunct;
  if (assertion.subType === 'bound') {
    return undefined;
  }
  if (assertion.subType !== 'strong') {
    return conjunct;
  }
  return conjunctVars(conjunct).length === 1 ? { access, assertion: assertWeak(assertion.value) } : undefined;
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
      // If the collection returns `undefined`, it is a sign of a contradiction.
      contradictory: true,
    };
  }
  return <AssertionFilter> casted;
}

/**
 * Guard recognizing the filters this pass is about: the ones whose top level conjunction says something
 * about at least one variable - fixing it to a term, unifying it with another, saying what one of its
 * positions is, or only deciding whether it is bound - and the contradictory ones (which are the empty
 * operation). Anything else is left where it is, and the traversal keeps descending into it looking for
 * the filters deeper down.
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
 * `sameTerm(?y, ?x)` becomes `sameTerm(?y, c)` - so this repeats until Θ stops growing. A merge of two
 * groups counts as growth even though neither gained a term: it may hand a clique a representative that
 * is lexicographically before the one its members were substituted to.
 *
 * Merging into the known assertions is also what makes the pass idempotent: re-running it re-derives the
 * same conjunction and absorbs it rather than stacking a second copy - the residual `sameTerm(?o, ?o)` a
 * re-derived edge leaves behind folds away, since a clique member is bound, and so does the
 * `sameTerm(?s, ?s)` a re-derived accessor leaves behind.
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
  let signature = signatureOf(assertions);
  let conjuncts = splitConjunction(substituteInExpression(c, expression, assertions.expressionView(), cVars));

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
        // Not an assertion we recognize, so goes into the residuals
        residual.push(conjunct);
        continue;
      }
      // Shortcut contradictions
      if (!assertions.assert(met.access, met.assertion)) {
        return undefined;
      }
    }

    const grown = signatureOf(assertions);
    // Only a change to what Θ decides can collapse a leftover into an assertion.
    if (grown !== signature) {
      learned = true;
      signature = grown;
      const view = assertions.expressionView();
      conjuncts = residual.flatMap(conjunct =>
        splitConjunction(substituteInExpression(c, conjunct, view, cVars)));
    }
  }
  return {
    assertions,
    residual: residual.length === 0 ? undefined : conjunctionOf(c, residual),
    contradictory: false,
  };
}

/** Everything a conjunction says, as a string, so that "did it grow" is a comparison. */
function signatureOf(assertions: AssertionConjunction): string {
  return assertions.conjuncts()
    .map(({ access, assertion }) => `${accessId(access)}${assertion.subType}${valueId(assertion)}`)
    .join('&');
}

/** The value half of a conjunct's signature. */
function valueId(assertion: Assertion): string {
  if (![ 'strong', 'weak' ].includes(assertion.subType)) {
    return '';
  }
  const value = (<{ value?: AssertionValue }> assertion).value;
  if (value === undefined) {
    return '';
  }
  switch (value.kind) {
    case 'triple': {
      return 'triple';
    }
    case 'access': {
      return accessId(value.access);
    }
    case 'term': {
      return `${value.term.termType}:${value.term.value}`;
    }
  }
}
