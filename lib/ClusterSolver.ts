import type * as RDF from '@rdfjs/types';
import type { RangedVar } from './RangeSet.js';
import { objectRange, RangeSet } from './RangeSet.js';
import type { Template } from './types.js';
import { isRdfTerm, isRdfVar, templateToStr } from './utils.js';

export type RawTerm = Exclude<RDF.Term, RDF.Variable> | RangedVar;
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
  private groupToVars: Record<number, RangedVar[]>;
  // Templates also narrow the RangeSet
  private groupToRange: Record<number, RangeSet>;
  // A single group can have many template equalities. This means all mHeadVars being equal are rewritten into one.
  // And afterward you get a filter for each template equality.
  private groupToTemplates: Record<number, Template[]>;
  private groupToTerm: Record<number, RawBasicTerm | undefined>;
  private varToGroup: Record<string, number | undefined>;
  // In case a mapping head templates need to equal a static term,
  // it needs to be validated, but it is not bound to a var so no group is created.
  // This list tracks all such conditions that should be checked.
  private staticTemplateValidation: { template: Template; term: RawBasicTerm }[];
  private cleanNumber: number;

  public constructor() {
    this.clear();
  }

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
   * 'from' var is now linked to 'to' var. Meaning They share a group.
   *  They cannot both be quads.
   *  From is head, to is TP.
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
      this.staticTemplateValidation.push({
        template: <Exclude<typeof from, RDF.Term>> from,
        term: to,
      });
    }
  }

  /**
   * Get an existing group for a var, or make a new one
   * @param variable
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

  private registerTemplateToGroup(group: number, template: Template): void {
    const curTerm = this.groupToTerm[group];
    if (curTerm && curTerm.termType !== template.subType) {
      throw new Error(`Cannot match Template ${templateToStr(template)} with term ${JSON.stringify(curTerm)}`);
    }
    const groupRange = this.groupToRange[group];
    const newRange = groupRange.disjunct(new RangeSet([ template.subType ]));
    if (newRange.size === 0) {
      throw new Error(`Cannot assign template ${templateToStr(template)} to a group with range [${[ ...groupRange.values() ].join(', ')}]`);
    }
    // Narrow the groupRange
    this.groupToRange[group] = newRange;

    this.groupToTemplates[group].push(template);
  }

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

  public sortClusters(): void {
    for (const groupVars of Object.values(this.groupToVars)) {
      groupVars.sort((a, b) =>
        // Make sure 'm' (mapping) vars are before 'uq' (user query) vars
        b.value.localeCompare(a.value));
    }
  }

  /**
   * Returns order list of bounded.
   * First the terms - when matching term you have a binding, unless you match multiple terms, then you have conflict.
   * Then the blank nodes: if you match a blank node,   - We can just prune blanknodes here...
   *   all variables matching that blankNode should be converted into a single var
   * Then the vars, if you match a var, you should align yourself to that var.
   * @param from
   */
  public getCluster(from: RDF.Variable): { term: RawBasicTerm | undefined ; vars: RDF.Variable[] } {
    const varGroup = this.varToGroup[from.value];
    return {
      term: this.groupToTerm[varGroup!],
      vars: this.groupToVars[varGroup!]
        .filter(x => !x.equals(from)),
    };
  }

  public getTemplates(from: RDF.Variable): Template[] {
    const varGroup = this.varToGroup[from.value];
    return this.groupToTemplates[varGroup!];
  }

  public getStaticTemplateValidation(): typeof this.staticTemplateValidation {
    return this.staticTemplateValidation;
  }
}
