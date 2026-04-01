import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';

/**
 * Optimization transformation that substitutes variables with their known bound values.
 *
 * After query rewriting, some variables in subselects are known to be bound to specific
 * terms (via EXTEND operations). This transformation finds those assignments and
 * substitutes the concrete terms directly into triple patterns, which can enable
 * more efficient query execution.
 *
 * @param c - The transformation context
 * @param op - The operation to transform
 * @returns The transformed operation with variable substitutions applied
 *
 * @example
 * // Before:
 * // SELECT ?m0_o WHERE { BIND(<ex:a> AS ?m0_s) . ?m0_s ?m0_p ?m0_o }
 * // After:
 * // SELECT ?m0_o WHERE { <ex:a> ?m0_p ?m0_o }
 */
export function substituteVarsThatArePreBoundToTerms<T extends Algebra.Operation>(c: TransformContext, op: T): T {
  return algebraUtils.mapOperation<'unsafe', typeof op>(
    op,
    { project: {
      transform: projection => substituteAndUnwrapExtends(c, projection),
    }},
  );
}

/**
 * Per-branch static analysis result (top-level EXTEND chain only — no deep traversal):
 *
 * - `termBinds`: EXTEND operations at the top of the branch chain that bind a variable
 *   to a simple term (Literal or NamedNode). Candidates for direct substitution.
 * - `complexBinds`: EXTEND operations at the top of the chain whose expression is NOT a
 *   simple term. For each substituted variable in this set, the BIND is replaced with a
 *   FILTER that checks whether the complex expression equals the substituted term.
 * - `valuesConstraints`: variables constrained by a VALUES clause that is directly at (or
 *   directly below) the EXTEND chain of this branch. Mapped to the concrete terms they
 *   may take.
 */
interface BranchAnalysis {
  termBinds: Record<string, RDF.Term>;
  complexBinds: Record<string, Algebra.Expression>;
  valuesConstraints: Record<string, (RDF.Literal | RDF.NamedNode)[]>;
}

/**
 * Analyses a single join branch to determine what static information it carries
 * about variable bindings. Only the top-level EXTEND chain is examined; no deep
 * traversal into nested operations is performed.
 */
function analyzeBranch(
  c: TransformContext,
  branch: Algebra.Operation,
  stillUsedVarNames: Set<string>,
): BranchAnalysis {
  const result: BranchAnalysis = {
    termBinds: {},
    complexBinds: {},
    valuesConstraints: {},
  };

  // Walk the top-level EXTEND chain, collecting simple term binds and complex binds.
  let belowChain: Algebra.Operation = branch;
  while (belowChain.type === Algebra.Types.EXTEND) {
    if (!stillUsedVarNames.has(belowChain.variable.value)) {
      const expr = belowChain.expression;
      if (expr.subType === Algebra.ExpressionTypes.TERM &&
          // Only Literals and NamedNodes are substitutable:
          // blank nodes cannot appear in bind, and TT is maybe not simple term (may contain vars).
          (expr.term.termType === 'Literal' || expr.term.termType === 'NamedNode')) {
        result.termBinds[belowChain.variable.value] = expr.term;
      } else {
        result.complexBinds[belowChain.variable.value] = expr;
      }
    }
    belowChain = belowChain.input;
  }

  // If the content directly below the EXTEND chain is a VALUES clause, collect its
  // variable constraints. No further traversal is needed.
  if (belowChain.type === Algebra.Types.VALUES) {
    for (const variable of belowChain.variables) {
      result.valuesConstraints[variable.value] = belowChain.bindings
        .map(binding => binding[variable.value])
        .filter((term): term is RDF.Literal | RDF.NamedNode => term !== undefined);
    }
  }

  return result;
}

/**
 * Processes a projection to find and apply variable substitutions.
 *
 * A variable `v` with a top-level `BIND(t AS v)` in one branch of the join is
 * substituted into triple patterns with the concrete term `t`. Conflicts in other
 * branches are resolved locally rather than blocking the substitution:
 *
 *  - Another branch with `BIND(t' AS v)` where `t' ≠ t`: that branch is replaced
 *    with `FILTER(FALSE)` since the two constant assignments can never unify.
 *  - Another branch with `BIND(complexExpr AS v)`: the complex BIND is replaced
 *    with `FILTER(complexExpr = t)` to preserve the runtime constraint.
 *  - Another branch with a VALUES clause for `v`: the VALUES is cleaned up by
 *    `cleanupValues` — rows not matching `t` are removed, and if no rows remain
 *    the VALUES is replaced with `FILTER(FALSE)`.
 *
 * Only perform this operation when the variables go out of scope due to the projection.
 */
function substituteAndUnwrapExtends(c: TransformContext, projection: Algebra.Project): Algebra.Project {
  const { AF } = c;

  const stillUsedVarNames = new Set<string>(projection.variables.map(v => v.value));

  // Find the top level join in the project, only unwrapping outer extends
  let join: Algebra.Join | undefined;
  if (projection.input.type === Algebra.Types.JOIN) {
    join = projection.input;
  } else if (projection.input.type === Algebra.Types.EXTEND) {
    let cursor: Algebra.Operation = projection.input;
    while (cursor.type === Algebra.Types.EXTEND) {
      stillUsedVarNames.add(cursor.variable.value);
      cursor = cursor.input;
    }
    if (cursor.type !== Algebra.Types.JOIN) {
      return projection;
    }
    join = cursor;
  } else {
    return projection;
  }

  // Flatten the join. Has more joins, inline them into one.
  const joinInput: typeof join.input = [];
  function flattenJoin(join: Algebra.Join): void {
    for (const item of join.input) {
      if (item.type === Algebra.Types.JOIN) {
        flattenJoin(item);
      } else {
        joinInput.push(item);
      }
    }
  }
  flattenJoin(join);
  join.input = joinInput;

  const branchAnalyses = join.input.map(branch => analyzeBranch(c, branch, stillUsedVarNames));

  // Now that the branches are analyzed, we simply need to decide what variables should be substituted by what term.
  // (This can be because of a VALUES call with a single entry, or a simple BIND).
  // In case we notice a var should be bound to two distinct terms, the whole thing becomes filterFalse.
  // In every other case, we traverse the different branches substituting the variable with the term.
  // During that substitution, the subsitution can happen flawlessly, except in a few cases:
  // 1. The variable is present in a VALUES clause:
  //    filter all entries in the values clause where the variable is not assigned to the correct term.
  //    In case the VALUES is empty, it becomes filter false, in case the VALUES become a simple `?subVar { term }`,
  //    it can be replaced with an empty BGP.
  // 2. The variable is assigned to in a BIND clause:
  //    2.1 the expression is complex: replace with a filter that checks whether the complex expression is equal
  //        to the term we want to subsitute with.
  //    2.2 the expression is the simple assignment between the term and the variable - Simply unpack the EXTEND
}
