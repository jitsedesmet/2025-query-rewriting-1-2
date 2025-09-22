import type * as RDF from '@rdfjs/types';

type BasicTerm = Exclude<RDF.Term, RDF.Quad | RDF.DefaultGraph>;

/**
 * Solver that can solve what variables are equal to each-other and potentially what terms they are equal to.
 * When two mapping head vars are equal to each-other,
 * query rewriting needs to happen on the mapping to ensure they are equal.
 */
export class BoundSolver {
  private binds: Record<string, BasicTerm[]> = {};

  public constructor() {}

  public clear(): void {
    this.binds = {};
  }

  /**
   * 'from' var is now linked to 'to' var.
   */
  public register(from: BasicTerm, to: BasicTerm): void {
    if (from.termType !== 'Variable' && to.termType !== 'Variable' && !from.equals(to)) {
      throw new Error(`Cannot match Term ${JSON.stringify(from)} with term ${JSON.stringify(to)}`);
    }
    for (const [ fromIter, toIter ] of [[ from, to ], [ to, from ]]) {
      // Only on vars
      if (fromIter.termType === 'Variable') {
        // Register var if not exists
        if (!this.binds[fromIter.value]) {
          this.binds[fromIter.value] = [];
        }
        if (!this.binds[fromIter.value].some(x => x.equals(toIter))) {
          this.binds[fromIter.value].push(toIter);
        }
      }
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
  public getConnected(from: RDF.Variable): BasicTerm[] {
    let found: BasicTerm[] = [];
    this.registerConnected(from, found);

    found = found
      .filter(x => !x.equals(from))
      .sort((a, b) => {
        // Variables last
        if (a.termType === 'Variable') {
          return 1;
        }
        if (b.termType === 'Variable') {
          return -1;
        }
        return a.value.localeCompare(b.value);
      });

    return found;
  }

  /**
   * Find all vars and terms that are connected with this one.
   * @param from
   * @param found
   * @private
   */
  private registerConnected(from: BasicTerm, found: BasicTerm[]): void {
    // You already found, return
    if (found.some(x => from.equals(x))) {
      return;
    }
    // Register yourself
    found.push(from);

    if (from.termType === 'Variable') {
      for (const other of this.binds[from.value]) {
        this.registerConnected(other, found);
      }
    }
  }
}
