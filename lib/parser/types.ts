import type { Node } from '@traqula/core';
import type * as T12 from '@traqula/rules-sparql-1-2';

/** A single HEAD/BODY pair in a VIEW definition */
export type ViewPair = {
  head: T12.PatternBgp;
  body: T12.PatternGroup;
};

/** A VIEW definition node in the query prologue */
export type ViewDefinition = Node & {
  type: 'contextDef';
  subType: 'view';
  /** IRI of this view */
  name: T12.TermIri;
  /** Whether the MONOTONE keyword was present */
  monotone: boolean;
  /** One or more HEAD/BODY pairs */
  pairs: ViewPair[];
};

/** An OVER query pattern node */
export type PatternOver = T12.PatternBase & {
  subType: 'over';
  /** IRI of the view to expand */
  name: T12.TermIri;
  /** The graph pattern whose BGP triples are matched against the VIEW HEAD */
  pattern: T12.PatternGroup;
};
