import type * as RDF from '@rdfjs/types';
import type { RangedVar } from './RangeSet.js';
import { objectRange, RangeSet } from './RangeSet.js';
import type { Template } from './types.js';
import { isRdfTerm, isRdfVar } from './utils.js';

export type RawTerm = Exclude<RDF.Term, RDF.Variable> | RangedVar;
/** A non-quad {@link RawTerm} – blank nodes, named nodes, literals, and default graph. */
export type RawBasicTerm = Exclude<RawTerm, RDF.Quad>;

/**
 * Solver that can solve what variables are equal to each-other and potentially what terms they are equal to.
 * When two mapping head vars are equal to each-other,
 * query rewriting needs to happen on the mapping to ensure they are equal.
 *
 * Since the term a group is assigned to can be a triple term containing vars, we get a DAG.
 * We are sure it is a DAG because a triple term cannot be targeted as a variable, while that variable is reused.
 * (Since you can only target it as a variable within the other term
 * (so the triple pattern can match a triple term in the mapping head and vice versa).
 * The variable cannot be used in any other position of the triple pattern/ mapping head though,
 * since that would cause an incompatible range.
 * -> triple terms need to be bounded last
 */
export class ClusterSolver {
  /** Map from group identifier to the set of variables that belong to that group. */
  private groupToVars: Record<number, RangedVar[]>;
  // Templates also narrow the RangeSet
  /** Map from group identifier to the union of term-type ranges that the group is allowed to produce. */
  private groupToRange: Record<number, RangeSet>;
  // A single group can have many template equalities. This means all mHeadVars being equal are rewritten into one.
  // And afterward you get a filter for each template equality.
  /** Map from group identifier to the template equality constraints associated with that group. */
  private groupToTemplates: Record<number, Template[]>;
  /** Map from group identifier to the concrete term the group is bound to, if any. */
  private groupToTerm: Record<number, RawBasicTerm | undefined>;
  /** Map from variable name to its group identifier. */
  private varToGroup: Record<string, number | undefined>;
  // In case a mapping head templates need to equal a static term,
  // it needs to be validated, but it is not bound to a var so no group is created.
  // This list tracks all such conditions that should be checked.
  /** Template-to-static-term equality checks that do not involve any variable group. */
  private staticTemplateValidation: { template: Template; term: RawBasicTerm }[];
  /** Counter used to assign fresh group identifiers. */
  private cleanNumber: number;

  public constructor() {
    this.clear();
  }

  /**
   * Resets all internal state so the solver can be reused for the next triple pattern.
   * Must be called before processing each new pattern/mapping pair.
   */
  public clear(): void {
    this.groupToVars = {};
    this.groupToTemplates = {};
    this.groupToRange = {};
    this.groupToTerm = {};
    this.varToGroup = {};
    this.staticTemplateValidation = [];
    this.cleanNumber = 1;
  }

  /**
   * Register the range of the variable to the group it is contained in, if any.
   */
  private handleVarRange(variable: RangedVar): void {
    const range = variable.range;
    const group = this.varToGroup[variable.value];
    if (range !== undefined && group !== undefined) {
      const groupRange = this.groupToRange[group].disjunct(range);
      this.groupToRange[group] = groupRange;
      const groupTerm = this.groupToTerm[group];
      if (groupTerm && !groupRange.has(groupTerm.termType)) {
        throw new Error(`The range of the current group no longer matches the term type ${groupTerm.termType} of term: ${JSON.stringify(groupTerm.termType)}`);
      }
    }
  }

  /**
   * Registers the equality between `from` (a mapping-head term or template) and
   * `to` (a user-query triple-pattern term).
   *
   * The method handles all combinations:
   * - **two static terms** – they must be equal, otherwise an error is thrown.
   * - **two variables** – they are merged into the same group via {@link mergeVars}.
   * - **`from` is a variable, `to` is a static term** – the static term is registered
   *   to the `from`-variable's group.
   * - **`to` is a variable, `from` is a template or static term** – the template/term
   *   is registered to the `to`-variable's group.
   * - **neither is a variable** – `from` must be a template; a static validation entry
   *   is recorded to check that `to` satisfies the template at evaluation time.
   *
   * @param from - A term or template from the mapping head.
   * @param to   - A term from the user-query triple pattern.
   * @throws When two incompatible static terms are matched.
   */
  public register(from: RDF.Term | Template, to: RDF.Term): void {
    if (isRdfTerm(from) && !isRdfVar(from) && isRdfTerm(to) && !isRdfVar(to)) {
      // Two terms, neither are vars
      if (from.equals(to)) {
        return;
      }
      throw new Error(`Cannot match Term ${JSON.stringify(from)} with term ${JSON.stringify(to)}`);
    } else if (isRdfVar(from) && isRdfVar(to)) {
      // Two vars
      this.mergeVars(from, to);
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
        // It is a template
        this.registerTemplateToGroup(varGroup, from);
      }
    } else {
      // Neither `from` nor `to` is a var. First condition would have checked this in case `from` is a term.
      // Check term types match:
      const template = <Exclude<typeof from, RDF.Term>> from;
      if (template.subType !== to.termType) {
        throw new Error(`Cannot match template of type ${template.subType} with term of type ${to.termType}. Matching
${JSON.stringify(template)}
with
${JSON.stringify(to)}`);
      }
      this.staticTemplateValidation.push({
        template,
        term: to,
      });
    }
  }

  /**
   * Returns the existing group for `variable`, creating a fresh one if none exists yet.
   *
   * When the variable already belongs to a group its positional range (if any) is
   * intersected with the group's current range via {@link handleVarRange}.  A new group
   * is initialised with the variable's own range, falling back to {@link objectRange}
   * when no range is set.
   *
   * @param variable - The variable whose group should be retrieved or created.
   * @returns The numeric group identifier.
   */
  private getGroup(variable: RangedVar): number {
    let group = this.varToGroup[variable.value];
    if (group !== undefined) {
      this.handleVarRange(variable);
      return group;
    }
    group = this.cleanNumber;
    this.cleanNumber++;
    this.groupToVars[group] = [ variable ];
    this.groupToTemplates[group] = [];
    this.groupToTerm[group] = undefined;
    this.groupToRange[group] = new RangeSet(variable.range ?? objectRange);
    this.varToGroup[variable.value] = group;
    return group;
  }

  /**
   * Associates a {@link Template} equality constraint with the given group.
   *
   * The group's range is narrowed to the intersection with the template's `subType`.
   * If the intersection becomes empty, the template is incompatible with the group
   * and an error is thrown.
   *
   * @param group    - The group identifier to associate the template with.
   * @param template - The template that this group's variable must satisfy.
   * @throws When the template's term type is incompatible with the group's current range or bound term.
   */
  private registerTemplateToGroup(group: number, template: Template): void {
    const curTerm = this.groupToTerm[group];
    if (curTerm && curTerm.termType !== template.subType) {
      throw new Error(`Cannot match Template ${JSON.stringify(template)} with term ${JSON.stringify(curTerm)}`);
    }
    const groupRange = this.groupToRange[group];
    const newRange = groupRange.disjunct(new RangeSet([ template.subType ]));
    if (newRange.size === 0) {
      throw new Error(`Cannot assign template ${JSON.stringify(template)} to a group with range [${[ ...groupRange.values() ].join(', ')}]`);
    }
    // Narrow the groupRange
    this.groupToRange[group] = newRange;

    this.groupToTemplates[group].push(template);
  }

  /**
   * Binds the given group to a concrete RDF term.
   *
   * If the group is already bound to a different term an error is thrown (conflicting
   * bindings).  If the term's type falls outside the group's current range an error
   * is also thrown.
   *
   * @param group - The group identifier to bind.
   * @param term  - The concrete term to bind the group to.
   * @throws When the group is already bound to a different term, or when the term type
   *         is outside the group's allowed range.
   */
  private registerTermToGroup(group: number, term: RawBasicTerm): void {
    const curTerm = this.groupToTerm[group];
    // TODO: validate in the case of triple term by also registering that some variables present might be the same.
    if (curTerm && !curTerm.equals(term)) {
      throw new Error(`Cannot match Term ${JSON.stringify(term)} with term ${JSON.stringify(term)}`);
    }
    const groupRange = this.groupToRange[group];
    if (!groupRange.has(term.termType)) {
      throw new Error(`Cannot assign Term ${JSON.stringify(term)} to a group with range [${[ ...groupRange.values() ].join(', ')}]`);
    }
    this.groupToTerm[group] = curTerm ?? term;
  }

  /**
   * Merges the groups of two variables so they share a single cluster.
   *
   * If both variables are already in the same group this is a no-op.  Otherwise the
   * two groups are unified: the group with the lower numeric identifier is kept as
   * the canonical group, and the range, bound term, templates, and variable list of
   * the discarded group are merged into it.
   *
   * @param from - A variable from the mapping head.
   * @param to   - A variable from the user-query triple pattern.
   */
  public mergeVars(from: RangedVar, to: RangedVar): void {
    const fromGroup = this.getGroup(from);
    const toGroup = this.getGroup(to);
    if (fromGroup === toGroup) {
      return;
    }
    // Merge groups into the lowest number
    const [ newGroup, oldGroup ] = fromGroup < toGroup ? [ fromGroup, toGroup ] : [ toGroup, fromGroup ];
    this.groupToRange[newGroup] = this.groupToRange[newGroup].disjunct(this.groupToRange[oldGroup]);
    // Merge term
    const oldTerm = this.groupToTerm[oldGroup];
    if (oldTerm) {
      this.registerTermToGroup(newGroup, oldTerm);
    }
    // Merge vars:
    const oldVars = this.groupToVars[oldGroup];
    delete this.groupToVars[oldGroup];
    this.groupToVars[newGroup].push(...oldVars);
    for (const variable of oldVars) {
      this.varToGroup[variable.value] = newGroup;
    }
  }

  /**
   * Sorts the variable list of every group so that mapping variables (prefix `m`)
   * come before user-query variables (prefix `uq`).
   *
   * Deterministic ordering ensures that subsequent steps always pick the same
   * canonical variable when multiple mapping variables are grouped together.
   */
  public sortClusters(): void {
    for (const groupVars of Object.values(this.groupToVars)) {
      groupVars.sort((a, b) =>
        // Make sure 'm' (mapping) vars are before 'uq' (user query) vars
        b.value.localeCompare(a.value));
    }
  }

  /**
   * Returns the cluster information for the group that `from` belongs to.
   *
   * The returned object contains:
   * - `term`  – the static RDF term the group is bound to, or `undefined`.
   * - `vars`  – all other variables in the same group (excluding `from` itself).
   * - `group` – the numeric group identifier.
   *
   * @param from - The variable whose cluster should be looked up.
   */
  public getCluster(from: RDF.Variable): { term: RawBasicTerm | undefined ; vars: RDF.Variable[]; group: number } {
    const varGroup = this.varToGroup[from.value];
    return {
      term: this.groupToTerm[varGroup!],
      vars: this.groupToVars[varGroup!]
        .filter(x => !x.equals(from)),
      group: varGroup!,
    };
  }

  /**
   * Returns all template equality constraints associated with the group of `from`.
   *
   * @param from - The variable whose template constraints should be retrieved.
   */
  public getTemplates(from: RDF.Variable): Template[] {
    const varGroup = this.varToGroup[from.value];
    return this.groupToTemplates[varGroup!];
  }

  /**
   * Returns all template-to-static-term validation entries that were recorded via
   * {@link register} for cases where neither side was a variable.
   *
   * These must be emitted as `FILTER` expressions in the generated query so that the
   * engine can verify them at evaluation time.
   */
  public getStaticTemplateValidation(): typeof this.staticTemplateValidation {
    return this.staticTemplateValidation;
  }
}
