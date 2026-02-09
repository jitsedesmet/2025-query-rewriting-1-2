import type * as RDF from '@rdfjs/types';

export type RangedVar = RDF.Variable & { range?: RangeSet };

export class RangeSet extends Set<RDF.Term['termType']> {
  public disjunct(other: RangeSet): RangeSet {
    return new RangeSet([ ...other.values() ].filter(x => this.has(x)));
  }
}

export const subjectRange = new RangeSet([ 'BlankNode', 'NamedNode' ]);
export const predicateRange = new RangeSet([ 'NamedNode' ]);
export const objectRange = new RangeSet([ 'Quad', 'NamedNode', 'BlankNode', 'Literal' ]);
