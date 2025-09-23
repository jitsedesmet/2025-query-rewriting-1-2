import type * as RDF from '@rdfjs/types';

type BasicTerm = Exclude<RDF.Term, RDF.Quad | RDF.DefaultGraph>;

function isVar(term: RDF.Term): term is RDF.Variable {
  return term.termType === 'Variable';
}

/**
 * Solver that can solve what variables are equal to each-other and potentially what terms they are equal to.
 * When two mapping head vars are equal to each-other,
 * query rewriting needs to happen on the mapping to ensure they are equal.
 */
export class ClusterSolver {
  private groupToVars: Record<number, RDF.Variable[]> = {};
  private groupToTerm: Record<number, BasicTerm | undefined> = {};
  private varToGroup: Record<string, number | undefined> = {};
  private cleanNumber = 1;

  public constructor() {}

  public clear(): void {
    this.groupToVars = {};
    this.groupToTerm = {};
    this.varToGroup = {};
    this.cleanNumber = 1;
  }

  /**
   * 'from' var is now linked to 'to' var. Meaning They share a group.
   */
  public register(from: BasicTerm, to: BasicTerm): void {
    // When to terms, check if equal, either throw or return
    if (!isVar(from) && !isVar(to)) {
      if (from.equals(to)) {
        return;
      }
      throw new Error(`Cannot match Term ${JSON.stringify(from)} with term ${JSON.stringify(to)}`);
    }
    // At least one is a var.
    if (isVar(from) && isVar(to)) {
      this.mergeVars(from, to);
    } else {
      const [ variable, term ] = isVar(from) ? [ from, to ] : [ <RDF.Variable> to, from ];
      let varGroup = this.varToGroup[variable.value];
      if (!varGroup) {
        varGroup = this.varToNewGroup(variable);
      }
      this.registerTermToGroup(varGroup, term);
    }
  }

  public varToNewGroup(term: RDF.Variable): number {
    const group = this.cleanNumber;
    this.cleanNumber++;
    this.groupToVars[group] = [ term ];
    this.groupToTerm[group] = undefined;
    this.varToGroup[term.value] = group;
    return group;
  }

  public registerVarToGroup(group: number, ...vars: RDF.Variable[]): void {
    this.groupToVars[group].push(...vars);
    for (const variable of vars) {
      this.varToGroup[variable.value] = group;
    }
  }

  public registerTermToGroup(group: number, term: BasicTerm): void {
    const curTerm = this.groupToTerm[group];
    if (curTerm && !curTerm.equals(term)) {
      throw new Error(`Cannot match Term ${JSON.stringify(term)} with term ${JSON.stringify(term)}`);
    }
    this.groupToTerm[group] = curTerm ?? term;
  }

  public mergeVars(from: RDF.Variable, to: RDF.Variable): void {
    const fromGroup = this.varToGroup[from.value];
    const toGroup = this.varToGroup[to.value];
    if (fromGroup && toGroup) {
      if (fromGroup === toGroup) {
        return;
      }
      // Merge groups into the lowest number
      const [ newGroup, oldGroup ] = fromGroup < toGroup ? [ fromGroup, toGroup ] : [ toGroup, fromGroup ];
      // Merge term
      const oldTerm = this.groupToTerm[oldGroup];
      if (oldTerm) {
        this.registerTermToGroup(newGroup, oldTerm);
      }
      // Merge vars:
      const oldVars = this.groupToVars[oldGroup];
      delete this.groupToVars[oldGroup];
      this.registerVarToGroup(newGroup, ...oldVars);
    } else if (!fromGroup && !toGroup) {
      // Create new group for both
      const newGroup = this.varToNewGroup(from);
      this.registerVarToGroup(newGroup, to);
    } else if (fromGroup) {
      this.registerVarToGroup(fromGroup, to);
    } else {
      this.registerVarToGroup(toGroup!, from);
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
