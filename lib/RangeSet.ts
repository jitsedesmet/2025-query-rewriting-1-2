import type * as RDF from '@rdfjs/types';

/**
 * An RDF variable that additionally carries an optional {@link RangeSet} describing
 * the term types this variable is allowed to be bound to in its positional context
 * (subject, predicate, or object of a triple pattern).
 */
export type RangedVar = RDF.Variable & { range?: RangeSet };

/**
 * A set of RDF term types ({@link RDF.Term.termType} values) that defines the range of
 * acceptable term types for a variable or group within the cluster solver.
 *
 * The set inherits standard {@link Set} semantics and adds the {@link disjunct} helper
 * for computing the intersection of two range sets.
 */
export class RangeSet extends Set<RDF.Term['termType']> {
  /**
   * Returns a new {@link RangeSet} that contains only the term types present in **both**
   * `this` and `other` (i.e. the set-theoretic intersection / conjunction of the two ranges).
   *
   * @param other - The range set to intersect with.
   * @returns A new range set containing the shared term types.
   */
  public disjunct(other: RangeSet): RangeSet {
    return new RangeSet([ ...other.values() ].filter(x => this.has(x)));
  }
}

/**
 * The allowed term-type range for the **subject** position of an RDF triple.
 * SPARQL 1.2 / RDF 1.2 allow blank nodes and named nodes in subject position.
 */
export const subjectRange = new RangeSet([ 'BlankNode', 'NamedNode' ]);

/**
 * The allowed term-type range for the **predicate** position of an RDF triple.
 * Only named nodes are valid predicates.
 */
export const predicateRange = new RangeSet([ 'NamedNode' ]);

/**
 * The allowed term-type range for the **object** position of an RDF triple.
 * SPARQL 1.2 / RDF 1.2 allow quoted triples (Quad), named nodes, blank nodes, and literals.
 */
export const objectRange = new RangeSet([ 'Quad', 'NamedNode', 'BlankNode', 'Literal' ]);
