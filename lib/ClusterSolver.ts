import type * as RDF from '@rdfjs/types';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import type { Pin, PinMeet } from './datastructures/TermClusterSet.js';
import { TermClusterSet, triplePositions } from './datastructures/TermClusterSet.js';
import { objectRange, RangeSet } from './RangeSet.js';
import type { RangedVar } from './utils/RangedVar.js';
import { DF } from './utils/rdfDatatypes.js';
import { isRdfTerm, isRdfVar } from './utils/typeGuards.js';

/**
 * A raw term that is either a concrete term (not a variable) or a ranged variable.
 */
export type RawTerm = Exclude<RDF.Term, RDF.Variable> | RangedVar;

/**
 * A basic raw term, i.e. one that is not a triple term.
 *
 * A triple term never reaches a *pin*: it is not a value the way an IRI is but a **shape**, whose three
 * positions are groups in their own right, and {@link ClusterSolver.assertTerm} takes it apart into one.
 * So the exclusion here is not the solver refusing triple terms - it is where they live, which is one
 * level up, on {@link TermClusterSet}'s lattice rather than in the leaves of it.
 */
export type RawBasicTerm = Exclude<RawTerm, RDF.BaseQuad>;

/**
 * Whether a raw term is a triple term.
 *
 * Spelt out here rather than taken from {@link isRdfQuad}, whose `RDF.Quad` narrows nothing away in the
 * *negative* branch: an `RDF.BaseQuad` - which is what `RDF.Term` holds, and what a triple term of a
 * mapping head is typed as - is not assignable to `RDF.Quad`, so excluding the latter leaves it standing.
 * @param term - The term to check
 * @returns whether the term is a triple term, narrowing to {@link RawBasicTerm} where it is not
 */
function isTripleTerm(term: RawTerm): term is RDF.BaseQuad {
  return term.termType === 'Quad';
}

/**
 * The meet of the two pins one group of the unfolding is asked to carry at once.
 *
 * Two terms are the term equality they always were. Two shapes unify position by position, which is all
 * a mapping head ever asks of a pattern that binds a triple term: `?t rdf:reifies <<( ?s ?p ?o )>>`
 * meeting a second triple term says that `?s` is its subject, not that two spellings of one value differ.
 *
 * A shape meeting a term is a contradiction outright, no term being a triple term here: a pin holds a
 * {@link RawBasicTerm}, since {@link ClusterSolver.assertTerm} decomposes a triple term into a shape
 * rather than pinning it.
 * @param left - One of the two pins
 * @param right - The other
 * @returns what the group is left with plus what the meet entailed, or `false` on a contradiction
 */
function meetSolverPins(left: Pin<RawBasicTerm>, right: Pin<RawBasicTerm>): PinMeet<RawBasicTerm> | false {
  if (left.kind === 'triple' || right.kind === 'triple') {
    return left.kind === 'triple' && right.kind === 'triple' ?
        {
          pin: left,
          entailed: triplePositions.map(position =>
            ({ kind: 'unify', left: left[position], right: right[position] })),
        } :
      false;
  }
  return left.term.equals(right.term) ? { pin: left, entailed: []} : false;
}

/**
 * Solver for determining variable equality clusters during query rewriting.
 *
 * When rewriting a triple pattern against a mapping head, variables from both
 * sides may need to be unified. The ClusterSolver tracks which variables are
 * equivalent and what concrete terms they may be bound to.
 *
 * ## Core Concepts:
 * - **Group**: A set of variables that must all have the same value
 * - **Range**: The set of valid term types for a group (narrowed as constraints are added) - like position in triple.
 * - **Term**: A concrete value that a group must equal
 * - **Template**: A computed term (IRI template, etc.) that a group must equal
 *
 * ## DAG Structure:
 * Since triple terms can contain variables, and those variables might be equated
 * to other triple terms, the structure forms a DAG: a triple term the mapping head writes is not a value
 * a group is pinned to but a **shape** whose three positions are groups in their own right
 * ({@link assertTerm}), which {@link resolvedTermOf} reads a term back off. The occurs check of
 * {@link TermClusterSet} is what keeps that DAG well founded.
 *
 * @example
 * // Given mapping head: ?t rdf:reifies <<( ?s ?p ?o )>>
 * // And triple pattern: ?x rdf:reifies <<( ?x ?y ?z )>>
 * // The solver determines: ?t = ?x = ?s, ?y = ?p, ?z = ?o
 */
export class ClusterSolver extends TermClusterSet<RangedVar, RawBasicTerm> {
  /** Maps group ID to the expression that they need to satisfy */
  public groupToExpressions: Record<number, Algebra.Expression[]>;
  /**
   * Static expression validations where no variable group is involved.
   * These occur when an expression must equal a concrete term.
   */
  protected staticExpressionValidation: { expression: Algebra.Expression; term: RawTerm }[];
  /** Counter for generating unique group IDs */

  public constructor() {
    super(variable => variable.value, meetSolverPins);
    this.clear();
  }

  /**
   * Resets the solver to its initial state.
   * Call this before processing a new triple pattern.
   */
  public override clear(): void {
    super.clear();
    this.groupToExpressions = {};
    this.staticExpressionValidation = [];
  }

  /**
   * Registers the range constraint of a variable to its group.
   * Narrows the group's range to the intersection with the variable's range.
   * @param variable - The variable whose range to register
   * @throws Error if the narrowed range conflicts with an existing term binding
   */
  protected handleVarRange(variable: RangedVar): void {
    const range = variable.range;
    const group = this.getGroup(variable);
    if (range !== undefined && group !== undefined && !this.narrowRange(group, range)) {
      const groupTerm = this.resolvedTermOf(group);
      throw new Error(`The range of the current group no longer matches the term type ${groupTerm?.termType} of term: ${JSON.stringify(groupTerm?.termType)}`);
    }
  }

  /**
   * Registers an equality constraint between two terms/templates.
   *
   * This is the main entry point for adding constraints. The behavior depends
   * on the types of `from` and `to`:
   * - Two variables: merge their groups
   * - Variable + term: bind the variable's group to the term
   * - Variable + template: add a template constraint to the group
   * - Two terms: validate they are equal (throws if not)
   * - Template + term: add to static validation list
   *
   * @param from - Term, variable, or template (typically from mapping head)
   * @param to - Term or variable (typically from triple pattern)
   * @throws Error if terms don't match or constraints conflict
   */
  public register(from: RDF.Term | Algebra.Expression, to: RDF.Term): void {
    if (isRdfTerm(from) && !isRdfVar(from) && isRdfTerm(to) && !isRdfVar(to)) {
      // Two terms, neither are vars. Two *triple* terms never reach here - the unfolding recurses into a
      // pair of them rather than registering it - so what the equality compares is a pair of values.
      if (from.equals(to)) {
        return;
      }
      throw new Error(`Cannot match Term ${JSON.stringify(from)} with term ${JSON.stringify(to)}`);
    } else if (isRdfVar(from) && isRdfVar(to)) {
      // Two vars
      this.mergeGroups(from, to);
    } else if (isRdfVar(from)) {
      // `from` is var - `to` is not
      const varGroup = this.getGroup(from);
      this.registerTermToGroup(varGroup, to);
    } else if (isRdfVar(to)) {
      // `to` is var, `from` is not
      const varGroup = this.getGroup(to);
      if (isRdfTerm(from)) {
        this.registerTermToGroup(varGroup, from);
      } else {
        // It is an expression
        this.registerExpressionToGroup(varGroup, from);
      }
    } else {
      // Neither `from` nor `to` is a var. First condition would have checked this in case `from` is a term.
      // Check term types match:
      const expression = <Exclude<typeof from, RDF.Term>> from;
      // TODO; statically check if the expression is even satisfiable.
      // if (expression.subType !== to.termType) {
      //   throw new Error(`Cannot match template of type ${template.subType} with term of type ${to.termType}.
      //   Matching ${JSON.stringify(expression)} with ${JSON.stringify(to)}`);
      // }
      this.staticExpressionValidation.push({
        expression,
        term: to,
      });
    }
  }

  protected override createEmptyGroup(): number {
    const group = super.createEmptyGroup();
    this.groupToExpressions[group] = [];
    return group;
  }

  protected override createGroup(variable: RangedVar): number {
    const group = super.createGroup(variable);
    this.groupToRange[group] = new RangeSet(variable.range ?? objectRange);
    return group;
  }

  /**
   * Gets or creates a group for a variable.
   * @param variable - The variable to get/create a group for
   * @returns The group ID
   */
  public override getGroup(variable: RangedVar): number {
    const oldNum = this.cleanNumber;
    const group = super.getGroup(variable);
    if (oldNum !== this.cleanNumber) {
      this.handleVarRange(variable);
    }
    return group;
  }

  protected registerExpressionToGroup(group: number, expression: Algebra.Expression): void {
    // TODO: is it expression satisfiable?
    // const curTerm = this.groupToTerm[group];
    // if (curTerm && curTerm.termType !== template.subType) {
    //   throw new Error(`Cannot match Template ${JSON.stringify(template)} with term ${JSON.stringify(curTerm)}`);
    // }
    // const groupRange = this.groupToRange[group];
    // Const newRange = groupRange.disjunct(new RangeSet([ template.subType ]));
    // if (newRange.size === 0) {
    //   throw new Error(`Cannot assign template ${JSON.stringify(template)}
    //   to a group with range [${[ ...groupRange.values() ].join(', ')}]`);
    // }
    // Narrow the groupRange
    // this.groupToRange[group] = newRange;

    this.groupToExpressions[group].push(expression);
  }

  /**
   * Registers a concrete term binding to a group: the throwing wrapper around {@link assertTerm} that the
   * unfolding needs, since a mapping head asking one group to be two terms at once is a broken mapping
   * rather than an ordinary contradiction.
   * @param group - The group ID
   * @param term - The term to bind, a triple term included
   * @throws Error if term conflicts with existing binding or range
   */
  protected registerTermToGroup(group: number, term: RawTerm): void {
    // Read before asserting: a failed assertion leaves the set in a state no caller may read - narrowed
    // ranges and all - so what the message reports is the state the caller handed over.
    const curTerm = this.resolvedTermOf(group);
    const curRange = this.rangeOf(group);
    if (!this.assertTerm(group, term)) {
      throw new Error(curTerm === undefined ?
        `Cannot assign Term ${JSON.stringify(term)} to a group with range [${[ ...curRange.values() ].join(', ')}]` :
        `Cannot match Term ${JSON.stringify(curTerm)} with term ${JSON.stringify(term)}`);
    }
  }

  /**
   * Asserts that every value of the group equals the term.
   *
   * A triple term is not pinned but **decomposed**: the group takes the shape of one, and each position
   * is asserted onto the group that position is. That is the same unification the rest of the mapping
   * head goes through, and it is what the head `?t rdf:reifies <<( ?s ?p ?o )>>` needs of a pattern that
   * binds a triple term - `?s` is the *subject of the value*, so whatever else reaches that position
   * reaches `?s`. Three things come with it that pinning the term whole could not do: a second triple
   * term on the group unifies with the first rather than being reported unequal (two spellings of one
   * value are not two values); every position is held to the range it can have, so a Literal subject is
   * refused where a Literal object is not; and the occurs check refuses `?y ≡ <<( … ?y )>>`.
   * @param group - The group to assert on
   * @param term - The term every value of the group equals
   * @returns `false` on a contradiction, after which the solver holds no meaningful state
   */
  private assertTerm(group: number, term: RawTerm): boolean {
    if (!isTripleTerm(term)) {
      return this.setTerm(group, term);
    }
    // A triple term states no graph, so a quad that names one is not a value any group can take.
    if (term.graph.termType !== 'DefaultGraph') {
      return false;
    }
    const children = this.assertTriplePin(group);
    if (children === false) {
      return false;
    }
    return triplePositions.every((position) => {
      const component = term[position];
      // Merging a position may merge further groups, so every step reads the ids through the set again -
      // which `unifyGroups` and `setTerm` both do for the group they are handed.
      return isRdfVar(component) ?
        this.unifyGroups(children[position], this.getGroup(component)) :
        this.assertTerm(children[position], component);
    });
  }

  /**
   * The term every value of the group equals, reading a *shape* back as the triple term it stands for.
   *
   * Every position is whatever fixes it, or else the mapping variable naming it - the same variable the
   * mapping body binds, which is what lets the `BIND(<<( ?mi_s ?mi_p ?mi_o )>> AS ?uq_o)` this feeds name
   * values the subselect really projects. A position fixed to a term is written as that term, so a head
   * triple term one of whose positions the pattern decided comes back with the decision in it.
   * @param group - The group to look up
   * @returns the term, or `undefined` when nothing fixes the group, or when a position of its shape is
   * fixed by nothing and named by nothing
   */
  public resolvedTermOf(group: number): RawTerm | undefined {
    const pin = this.pinOf(group);
    if (pin?.kind !== 'triple') {
      return pin?.term;
    }
    // Terminates on the occurs check: a group reaching itself through the pins is a contradiction, and
    // the constraint solving refuses to settle in such a state.
    const children = this.childrenOf(group)!;
    const [ subject, predicate, object ] = triplePositions.map(position =>
      this.resolvedTermOf(children[position]) ?? this.mappingVarsOf(children[position])[0]);
    if (subject === undefined || predicate === undefined || object === undefined) {
      return undefined;
    }
    // Every position was held to the range it admits while the shape was built, so this really is a
    // triple term - which the types of a data factory have no way of knowing.
    return DF.quad(<RDF.Quad_Subject> subject, <RDF.Quad_Predicate> predicate, <RDF.Quad_Object> object);
  }

  /**
   * The variables of the *mapping* in a group, as against the user query variables the rewriting binds
   * from them. Ordered by {@link sortClusters}, so the first is the one every rewrite names the group by.
   * @param group - The group to look up
   * @returns the mapping variables of the group, mapping body first
   */
  public mappingVarsOf(group: number): readonly RangedVar[] {
    return this.valuesOf(this.resolveGroup(group)).filter(value => !value.value.startsWith('uq'));
  }

  /**
   * Carries the expressions of the disappearing group over - it is no longer reachable, so the constraints
   * it holds would otherwise be lost. Ranges and terms are merged by {@link TermClusterSet} itself.
   */
  protected override migrateGroupData(oldGroup: number, newGroup: number): void {
    this.groupToExpressions[newGroup].push(...this.groupToExpressions[oldGroup]);
    delete this.groupToExpressions[oldGroup];
  }

  /**
   * A mapping head asking one group to be two terms at once is broken, rather than the ordinary
   * contradiction it is for an assertion conjunction, so the conflict {@link TermClusterSet} reports is
   * raised here.
   */
  public override mergeGroups(from: RangedVar, to: RangedVar):
    { oldGroup: number; newGroup: number; conflict: boolean } | undefined {
    const merged = super.mergeGroups(from, to);
    if (merged?.conflict === true) {
      throw new Error(`Cannot unify ${JSON.stringify(from.value)} with ${JSON.stringify(to.value)}: they are fixed to different terms`);
    }
    return merged;
  }

  /**
   * Sorts variables within each cluster for consistent output.
   * Mapping variables (starting with 'm') are sorted before user query variables ('uq').
   */
  public sortClusters(): void {
    for (const groupVars of Object.values(this.groupToValues)) {
      groupVars.sort((a, b) =>
        // Make sure 'm' (mapping) vars are before 'uq' (user query) vars
        a.value.localeCompare(b.value));
    }
  }

  /**
   * Gets the cluster information for a variable.
   * @param from - The variable to look up
   * @returns Object containing:
   *   - `term`: The concrete term bound to this cluster (if any)
   *   - `vars`: Other variables in the same cluster
   *   - `group`: The cluster's group ID
   */
  public getCluster(from: RDF.Variable): { term: RawTerm | undefined ; vars: RDF.Variable[]; group: number } {
    const varGroup = this.getGroup(from);
    return {
      term: this.resolvedTermOf(varGroup),
      vars: this.groupToValues[varGroup]
        .filter(x => !x.equals(from)),
      group: varGroup,
    };
  }

  /**
   * Gets all expressions that must equal the given variable's value.
   * @param from - The variable to look up
   * @returns Array of expressions that must equal this variable
   */
  public getExpressions(from: RDF.Variable): Algebra.Expression[] {
    const varGroup = this.getGroup(from);
    return this.groupToExpressions[varGroup];
  }

  /**
   * Gets all static expression validations (expression-to-term equality checks).
   * These are cases where an expression must equal a concrete term with no variable involved.
   * @returns Array of template-term pairs to validate
   *
   * @example
   *   UQ: ?s <p> <<(?s a "b")>>
   *   MH: <x> <p> ?y
   *   --> ?s = <x> = subject(?y) ;
   *   AND ALSO: predicate(?y) = rdf:type ; object(?y) = "b"
   */
  public getStaticExpressionValidation(): typeof this.staticExpressionValidation {
    return this.staticExpressionValidation;
  }
}
