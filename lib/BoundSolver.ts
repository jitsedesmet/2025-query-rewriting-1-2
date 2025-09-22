import type * as RDF from '@rdfjs/types';

export class BoundSolver {
  private readonly binds: Record<string, RDF.Term[]> = {};

  public constructor() {}

  public register(from: RDF.Variable, to: RDF.Term): void {
    this.registerOne(from, to);
    if (to.termType === 'Variable') {
      this.registerOne(to, from);
    }
  }

  private registerOne(from: RDF.Variable, to: RDF.Term): void {
    if (!this.binds[from.value]) {
      this.binds[from.value] = [];
    }
    this.binds[from.value].push(to);
  }

  /**
   * Returns order list of bounded.
   * First the terms - when matching term you have a binding, unless you match multiple terms, then you have conflict.
   * Then the blank nodes: if you match a blank node,   - We can just prune blanknodes here...
   *   all variables matching that blankNode should be converted into a single var
   * Then the vars, if you match a var, you should align yourself to that var.
   * @param from
   */
  public getConnected(from: RDF.Variable): RDF.Term[] {
    const found: RDF.Term[] = [];
    this.registerConnected(from, found);

    found
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

  private registerConnected(from: RDF.Variable, found: RDF.Term[]): void {
    if (found.some(x => x.equals(from))) {
      return;
    }

    // You also found the connection this is connected to:
    const newFound = (this.binds[from.value] ?? [])
      .filter(newly => !found.some(registered => newly.equals(registered)));

    found.push(...newFound);
    for (const newly of newFound) {
      if (newly.termType === 'Variable') {
        this.registerConnected(newly, found);
      }
    }
  }
}
