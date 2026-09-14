import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import { VAR_PREFIX_USER_QUERY } from '../consts.js';
import type { TransformationContext } from '../transformContext.js';
import type { Mapping, QueryTransformation } from '../types.js';
import { collectVariableNames, renameVariables } from '../utils.js';
import { rewriteSinglePattern } from './rewriteSinglePattern.js';

/**
 * @fileoverview The unfolding itself: every triple pattern of the user query replaced by the mapping body
 * that produces the triples it could match.
 *
 * This is the one pass that needs something besides the query, namely the mapping, and the only reason
 * {@link unfoldingTransformation} is a factory taking an argument where every other one takes `()`. The
 * mapping travels in the closure rather than in the {@link TransformationContext}, so that two rewriters
 * over two mappings cannot read each other's.
 */

/**
 * Rewrites a single triple pattern and namespaces every internal (non user-query) variable it introduces, so
 * that sibling patterns in the same BGP cannot collide.
 *
 * {@link rewriteSinglePattern} always produces the same internal variable names for a given mapping, and
 * some of them are projected out of the pattern's subselect and so visible at the JOIN level - where they
 * would be unified across patterns, yielding incorrect (usually empty) results. Only the `uq_` variables
 * are meant to be shared between patterns, being the natural join keys.
 * @param c - The transformation context
 * @param mapping - The mapping to unfold within the pattern
 * @param pattern - The pattern to rewrite
 * @param patternIndex - The index that namespaces this pattern's internal variables
 * @returns the rewritten pattern
 */
function rewritePatternWithUniqueScope(
  c: TransformationContext,
  mapping: Mapping,
  pattern: Algebra.Pattern,
  patternIndex: number,
): Algebra.Operation {
  const rewritten = rewriteSinglePattern(c, pattern, mapping);
  const renames: Record<string, RDF.Variable> = {};
  for (const name of collectVariableNames(c.astTransformer, rewritten)) {
    if (!name.startsWith(VAR_PREFIX_USER_QUERY)) {
      renames[name] = c.DF.variable(`p${patternIndex}_${name}`);
    }
  }
  return renameVariables(c, rewritten, renames);
}

/**
 * Rewrites every BGP of an operation into a join of its patterns unfolded against the mapping.
 * @param c - The transformation context
 * @param mapping - The mapping to unfold
 * @param input - The operation to rewrite
 * @returns the rewritten operation
 */
export function unfoldTriplePatternsAgainstMapping(
  c: TransformationContext,
  mapping: Mapping,
  input: Algebra.Operation,
): Algebra.Operation {
  // Counter shared across every BGP of the query so that the internal variables of
  // distinct pattern rewrites never collide — not even across sibling BGPs that are
  // later combined by a JOIN/LEFT JOIN (e.g. a pattern and an OPTIONAL block).
  let patternCounter = 0;
  return algebraUtils.mapOperation<'unsafe', typeof input>(
    input,
    { [Algebra.Types.BGP]: { transform: input =>
      c.AF.createJoin(
        input.patterns.map(pattern => rewritePatternWithUniqueScope(c, mapping, pattern, patternCounter++)),
        true,
      ),
    }},
  );
}

/**
 * The pipeline step replacing every triple pattern of the user query by the mapping body producing the
 * triples it could match.
 * @param mapping - The mapping to unfold, from {@link mapping!mappingFromConstructQueries}
 * @returns the transformation
 */
export function unfoldingTransformation(mapping: Mapping): QueryTransformation {
  return (context, operation) => unfoldTriplePatternsAgainstMapping(context, mapping, operation);
}
