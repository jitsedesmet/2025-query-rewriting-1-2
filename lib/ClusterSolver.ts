import type * as RDF from '@rdfjs/types';

export class RangeSet extends Set<RDF.Term['termType']> {
  public disjunct(other: RangeSet): RangeSet {
    return new RangeSet([ ...other.values() ].filter(x => this.has(x)));
  }
}
export type RangedVar = RDF.Variable & { range?: RangeSet };
export type Term = Exclude<RDF.Term, RDF.Variable> | RangedVar;
export type BasicTerm = Exclude<Term, RDF.Quad>;

export function isVar(term: RDF.Term): term is RangedVar {
  return term.termType === 'Variable';
}

export const subjectRange = new RangeSet([ 'BlankNode', 'NamedNode' ]);
export const predicateRange = new RangeSet([ 'NamedNode' ]);
export const objectRange = new RangeSet([ 'Quad', 'NamedNode', 'BlankNode', 'Literal' ]);

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
  private groupToRange: Record<number, RangeSet>;
  private groupToTerm: Record<number, BasicTerm | undefined>;
  private varToGroup: Record<string, number | undefined>;
  private cleanNumber: number;

  public constructor() {
    this.clear();
  }

  public clear(): void {
    this.groupToVars = {};
    this.groupToRange = {};
    this.groupToTerm = {};
    this.varToGroup = {};
    this.cleanNumber = 1;
  }

  /**
   * Register the range of the variable to the group it is contained in, if any.
   */
  public handleVarRange(variable: RangedVar): void {
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
   */
  public register(from: Term, to: BasicTerm): void {
    // When two terms, check if equal, either throw or return
    if (!isVar(from) && !isVar(to)) {
      if (from.equals(to)) {
        return;
      }
      throw new Error(`Cannot match Term ${JSON.stringify(from)} with term ${JSON.stringify(to)}`);
    }
    // At least one is a var.
    if (isVar(from) && isVar(to)) {
      // Two vars
      this.mergeVars(from, to);
    } else {
      const [ variable, term ] = isVar(from) ? [ from, to ] : [ <RDF.Variable> to, from ];
      const varGroup = this.getGroup(variable);
      this.registerTermToGroup(varGroup, term);
    }
  }

  public getGroup(variable: RangedVar): number {
    let group = this.varToGroup[variable.value];
    if (group !== undefined) {
      this.handleVarRange(variable);
      return group;
    }
    group = this.cleanNumber;
    this.cleanNumber++;
    this.groupToVars[group] = [ variable ];
    this.groupToTerm[group] = undefined;
    this.groupToRange[group] = new RangeSet(variable.range ?? objectRange);
    this.varToGroup[variable.value] = group;
    return group;
  }

  public registerTermToGroup(group: number, term: BasicTerm): void {
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
  public getCluster(from: RDF.Variable): { term: BasicTerm | undefined ; vars: RDF.Variable[] } {
    const varGroup = this.varToGroup[from.value];
    return {
      term: this.groupToTerm[varGroup!],
      vars: this.groupToVars[varGroup!]
        .filter(x => !x.equals(from)),
    };
  }
}
