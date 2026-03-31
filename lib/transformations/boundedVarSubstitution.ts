import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { createFilterFalse, deleteVarExtensionsInPlace } from '../utils.js';

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

  // Variables that appear as subject/predicate/object in any triple pattern.
  // Substitution is only useful (and safe) for those.
  const varsInTriplePatterns = new Set<string>();
  algebraUtils.visitOperation(projection, {
    pattern: {
      visitor: (pattern) => {
        for (const term of [ pattern.subject, pattern.predicate, pattern.object ]) {
          if (term.termType === 'Variable') {
            varsInTriplePatterns.add((term).value);
          }
        }
      },
    },
  });

  // Determine which variables to substitute and which branches need local fixes.
  const assignments: Record<string, RDF.Term> = {};
  // Branch indices to replace entirely with FILTER(FALSE) due to a conflicting termBind.
  const branchesToWrapFF = new Set<number>();

  for (let srcIdx = 0; srcIdx < branchAnalyses.length; srcIdx++) {
    const srcAnalysis = branchAnalyses[srcIdx];
    for (const [ varName, term ] of Object.entries(srcAnalysis.termBinds)) {
      if (!varsInTriplePatterns.has(varName)) {
        continue;
      }
      if (varName in assignments) {
        // Already handled in a previous source branch; if this branch carries a
        // different term it is contradictory and must be wrapped with FILTER(FALSE).
        if (!term.equals(assignments[varName])) {
          branchesToWrapFF.add(srcIdx);
        }
        continue;
      }
      // Check other branches for conflicting simple term binds.
      for (const [ otherIdx, other ] of branchAnalyses.entries()) {
        if (otherIdx === srcIdx) {
          continue;
        }
        if (other.termBinds[varName] !== undefined &&
            !other.termBinds[varName].equals(term)) {
          // Conflicting constant assignment in another branch → that branch can
          // never satisfy the join for this variable.
          branchesToWrapFF.add(otherIdx);
        }
        // Complex binds and VALUES mismatches are handled during the transform step.
      }
      assignments[varName] = term;
    }
  }

  if (Object.keys(assignments).length === 0) {
    return projection;
  }

  // For VALUES clauses that constrain a substituted variable:
  //   • Filter their rows to those where the variable equals the assigned term.
  //   • Remove the variable from the clause.
  //   • If no rows survive (mismatch), replace the clause with FILTER(FALSE).
  //   • If all variable columns are removed and rows survive (confirmed match),
  //     replace with an empty BGP (a single empty solution row).
  const cleanupValues = (op: Algebra.Operation): Algebra.Operation =>
    algebraUtils.mapOperation<'unsafe', typeof op>(op, {
      values: {
        transform: (values) => {
          const substitutedVars = values.variables.filter(v => v.value in assignments);
          if (substitutedVars.length === 0) {
            return values;
          }
          const filteredBindings = values.bindings
            .filter(binding =>
              substitutedVars.every((v) => {
                const bindTerm = binding[v.value];
                return bindTerm !== undefined &&
                  bindTerm.equals(<RDF.NamedNode | RDF.Literal> assignments[v.value]);
              }))
            .map(binding => <Record<string, RDF.Literal | RDF.NamedNode>> Object.fromEntries(
              Object.entries(binding).filter(([ key ]) => !(key in assignments)),
            ));
          // No matching rows → the VALUES constraint can never be satisfied.
          if (filteredBindings.length === 0) {
            return createFilterFalse(c);
          }
          const newVariables = values.variables.filter(v => !(v.value in assignments));
          if (newVariables.length === 0) {
            // All columns substituted and at least one row matched → confirmed.
            return AF.createBgp([]);
          }
          return AF.createValues(newVariables, filteredBindings);
        },
      },
    });

  // Apply per-branch transformations, then clean up VALUES clauses.
  const assignedVars = Object.keys(assignments);
  join.input = join.input.map((branch, idx) => {
    if (branchesToWrapFF.has(idx)) {
      return createFilterFalse(c);
    }

    const analysis = branchAnalyses[idx];
    let transformed: Algebra.Operation = branch;

    // Convert BIND(complexExpr AS v) → FILTER(complexExpr = t) for each assigned
    // variable that has a complex bind in this branch. Do this before
    // deleteVarExtensionsInPlace so the EXTEND is replaced rather than deleted.
    for (const [ varName, term ] of Object.entries(assignments)) {
      const complexExpr = analysis.complexBinds[varName];
      if (complexExpr !== undefined) {
        transformed = replaceExtendWithFilter(c, transformed, varName, complexExpr, term);
      }
    }

    // Remove simple term BINDs and clean up VALUES clauses.
    transformed = deleteVarExtensionsInPlace(c, transformed, assignedVars);
    return cleanupValues(transformed);
  });

  return algebraUtils.mapOperation<'unsafe', typeof projection>(projection, {
    pattern: {
      transform: (pattern) => {
        pattern.subject = translateTerm(pattern.subject, assignments);
        pattern.predicate = translateTerm(pattern.predicate, assignments);
        pattern.object = translateTerm(pattern.object, assignments);
        return pattern;
      },
    },
  });
}

/**
 * Replaces a variable term with its assigned value if one exists.
 * @param term - The term to potentially replace
 * @param assignments - Map of variable names to their assigned terms
 * @returns The assigned term if the input is a bound variable, otherwise the original term
 */
function translateTerm(term: RDF.Term, assignments: Record<string, RDF.Term>): RDF.Term {
  if (term.termType === 'Variable' && assignments[term.value]) {
    return assignments[term.value];
  }
  return term;
}

/**
 * Replaces `BIND(complexExpr AS varName)` with `FILTER(complexExpr = term, input)` within
 * the top-level EXTEND chain of `op`. Used to preserve the runtime constraint expressed
 * by a complex BIND when the variable is being statically substituted with `term`.
 *
 * @param c - The transformation context
 * @param op - The operation whose EXTEND chain should be patched
 * @param varName - The variable name whose complex BIND should be replaced
 * @param complexExpr - The complex expression from the original BIND
 * @param term - The concrete term that will be substituted for the variable.
 *   By construction this is always a NamedNode or Literal: `assignments` is
 *   only populated from `termBinds`, which filters for those two term types.
 * @returns The patched operation with the BIND replaced by a FILTER
 */
function replaceExtendWithFilter(
  c: TransformContext,
  op: Algebra.Operation,
  varName: string,
  complexExpr: Algebra.Expression,
  term: RDF.Term,
): Algebra.Operation {
  const { AF } = c;
  const traverse = (current: Algebra.Operation): Algebra.Operation => {
    if (current.type !== 'extend') {
      return current;
    }
    if (current.variable.value === varName) {
      return AF.createFilter(
        traverse(current.input),
        AF.createOperatorExpression('=', [
          complexExpr,
          AF.createTermExpression(<RDF.NamedNode | RDF.Literal> term),
        ]),
      );
    }
    // Mutate in place, consistent with the rest of the algebra-patching helpers
    // (e.g. deleteVarExtensionsInPlace) that also reuse existing nodes.
    current.input = traverse(current.input);
    return current;
  };
  return traverse(op);
}
