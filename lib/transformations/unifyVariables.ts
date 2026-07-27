import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { renameVariables } from '../utils.js';

/**
 * @fileoverview Variable unification transformer.
 *
 * When a user triple pattern forces two (or more) mapping-head variables to be
 * equal — e.g. reusing the same variable in subject and predicate position
 * (`?x ?x ?o`) — those variables must be collapsed onto a single representative.
 *
 * A naive rename is unsound: in the mapping body a head variable may be produced
 * by a `BIND`/`EXTEND`, a triple pattern (`BGP`), a `GRAPH` graph variable, a
 * `VALUES` clause, etc. Renaming two such producers to the same name would make
 * that name be *assigned twice*. When one of the producers is an `EXTEND`, that
 * yields `BIND(expr AS ?u)` for a variable `?u` that is already in scope, which
 * is illegal SPARQL and silently drops the intended equality. The correct
 * rewrite keeps the existing producer as the binder and turns the redundant
 * `EXTEND` into `FILTER(sameTerm(?u, expr))`, so the equality of the merged
 * variables is asserted rather than lost.
 *
 * `sameTerm` (RDF term identity) is used rather than `=` (value equality)
 * because unifying two variable positions must mean the *same RDF term*, exactly
 * as a repeated variable in a BGP does — `=` would spuriously merge e.g.
 * `"1"^^xsd:integer` and `"1.0"^^xsd:decimal`.
 *
 * "Already in scope" is decided with the algebra library's `inScopeVariables`,
 * which reports every variable that *may* be bound by the input — covering
 * `BGP`/`PATTERN`, `PATH`, `GRAPH`, `VALUES`, `EXTEND`, `GROUP`, `SERVICE` and
 * aggregates. This deliberately includes variables that are only *optionally*
 * bound (e.g. inside an `OPTIONAL`/`UNION`). See the note on possibly-unbound
 * variables below.
 *
 * ## Possibly-unbound (optional) members
 *
 * If a member variable is only optionally bound, the `EXTEND`→`FILTER` rewrite
 * still applies, and `FILTER(sameTerm(?u, expr))` has the following behaviour
 * per solution:
 * - `?u` bound   → the row survives iff `?u` is the same term as `expr`;
 * - `?u` unbound → `sameTerm(?u, expr)` raises an evaluation error, so the row
 *   is dropped.
 *
 * For this rewriter that is exactly the intended semantics: the representative
 * is placed into an outer triple-pattern position, so it must denote a concrete,
 * bound term to match anything, and a solution in which the head variable is
 * unbound would not have produced the corresponding triple in the original
 * CONSTRUCT mapping. Hence excluding those solutions is correct.
 *
 * (For a hypothetical general-purpose unification where the representative is
 * allowed to remain unbound, this would instead require join semantics:
 * `BIND(COALESCE(?u, expr) AS ?fresh)` together with
 * `FILTER(!bound(?u) || sameTerm(?u, expr))`. That is intentionally *not* done here
 * because it would leave the representative possibly-unbound, which cannot occur
 * in a triple position.)
 */

/**
 * Unifies groups of variables onto a single fresh representative variable.
 *
 * `remap` maps every member variable name to the fresh representative that
 * should stand for its whole equivalence class. The representative name is
 * coined by the caller (e.g. `rm_s_AND_p`) so it can also be referenced from the
 * surrounding rewrite.
 *
 * The transformer:
 * 1. replaces *every* occurrence of a member variable by its representative
 *    (triple patterns, expressions, projections, `VALUES` keys, ...); when the
 *    members are only pattern variables this alone already enforces equality
 *    through the natural join on the shared representative;
 * 2. repairs every `EXTEND` that, after step 1, assigns a representative which is
 *    already in scope in its input (bound by a `BGP`, `GRAPH`, `VALUES`, another
 *    `EXTEND`, ...): the redundant `BIND(expr AS ?u)` becomes
 *    `FILTER(sameTerm(?u, expr))`. Processing is bottom-up, so the deepest
 *    producer of `?u` stays the binder and every shallower assignment collapses
 *    to an equality filter.
 *
 * @param c - Transform context
 * @param op - The operation to rewrite (typically a mapping body)
 * @param remap - Map from each member variable name to its fresh representative
 * @returns The operation with the variables unified
 */
export function unifyVariables(
  c: TransformContext,
  op: Algebra.Operation,
  remap: Record<string, RDF.Variable>,
): Algebra.Operation {
  if (Object.keys(remap).length === 0) {
    return op;
  }
  const renamed = renameVariables(c, op, remap);
  return algebraUtils.mapOperation<'unsafe', Algebra.Operation>(renamed, {
    [Algebra.Types.EXTEND]: { transform: (node): Algebra.Operation => {
      // A variable may only be introduced by an EXTEND if it is not already in
      // scope. If unification made it already-bound below, the assignment is
      // redundant and must be expressed as an equality constraint instead.
      const boundBelow = new Set(algebraUtils.inScopeVariables(node.input).map(v => v.value));
      if (boundBelow.has(node.variable.value)) {
        return c.AF.createFilter(
          node.input,
          c.AF.createOperatorExpression('sameterm', [ c.AF.createTermExpression(node.variable), node.expression ]),
        );
      }
      return node;
    } },
  });
}
