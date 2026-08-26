/**
 * @fileoverview Transformation module exports for SPARQL query rewriting.
 *
 * Optimization and transformation passes applied in sequence after the core BGP rewriting:
 *
 * - **transformFilterFalse**: removes FILTER(FALSE) patterns and the structures containing them (UNION
 *   identity, JOIN absorbing element).
 * - **nullifyJoinOverIncompatibleBounds**: detects joins whose branches bind a variable to incompatible
 *   terms and replaces them with FILTER(FALSE).
 * - **nullifyUnbindableVars**: the same one level up, for incompatible term *types* rather than terms.
 * - **pushUpBoundedFromUnion**: hoists common variable bindings out of UNION branches.
 * - **rewriteSinglePattern**: rewrites a single triple pattern against a mapping definition.
 * - **removeProjections**: removes all PROJECT operations, anonymizing every non-projected variable to a
 *   fresh one to preserve scoping.
 * - **pushDownAssertions**: pushes assertion filters (`FILTER(sameTerm(?x, c))`) as deep into the plan as
 *   possible, substituting into BGPs, pruning VALUES rows and UNION branches, and turning an OPTIONAL over
 *   an asserted variable into a plain join.
 * - **transformJoinValuesToFilter**: rewrites a JOIN with a VALUES clause into an equality FILTER over the
 *   remaining operands, enabling further push-down.
 * @module transformations
 */
export { transformFilterFalse } from './filterFalse.js';
export { nullifyJoinOverIncompatibleBounds } from './nullifyJoinOverIncompatibleBounds.js';
export { nullifyUnbindableVars } from './nullifyUnbindableVars.js';
export { pushUpBoundedFromUnion } from './pushUpBoundedFromUnion.js';
export { rewriteSinglePattern } from './rewriteSinglePattern.js';
export { removeProjections } from './removeProjections.js';
export { pushDownAssertions } from './pushDownAssertions.js';
export { transformJoinValuesToFilter } from './joinValuesToFilter.js';
