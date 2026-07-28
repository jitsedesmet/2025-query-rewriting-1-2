import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { createFilterFalse } from '../utils/operationhelpers.js';
import { substituteTerms } from '../utils/termSubstitution.js';
import { VariableSet } from './variableSet.js';

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
 * Per-branch static analysis result (top-level EXTEND chain only — no deep traversal)
 */
interface BranchAnalysis {
  /**
   * For every variable that is explicitly constrained by this branch —
   * either via a simple `BIND(term AS ?v)` (single-element set) or a `VALUES ?v { ... }`
   * clause directly at or below the EXTEND chain — the set of concrete terms it may take.
   * Variables that are not mentioned by the branch are treated as unconstrained (noFixed),
   * and should be represented as identity when intersecting across branches.
   */
  varSets: Record<string, VariableSet>;
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
    varSets: {},
  };

  // Walk the top-level EXTEND chain, collecting simple term binds.
  let belowChain: Algebra.Operation = branch;
  while (belowChain.type === Algebra.Types.EXTEND) {
    if (!stillUsedVarNames.has(belowChain.variable.value)) {
      const expr = belowChain.expression;
      if (expr.subType === Algebra.ExpressionTypes.TERM &&
          // Only Literals and NamedNodes are substitutable:
          // blank nodes cannot appear in bind, and TT is maybe not simple term (may contain vars).
          (expr.term.termType === 'Literal' || expr.term.termType === 'NamedNode')) {
        result.varSets[belowChain.variable.value] = new VariableSet(expr.term);
      }
      // Complex-expression binds are not added to varSets; substituteTerms handles them
      // in the EXTEND case by emitting FILTER(sameTerm(expr, term)) when the variable is substituted.
    }
    belowChain = belowChain.input;
  }

  // If the content directly below the EXTEND chain is a VALUES clause, collect its
  // variable constraints as a VariableSet. No further traversal is needed.
  if (belowChain.type === Algebra.Types.VALUES) {
    for (const variable of belowChain.variables) {
      const terms = belowChain.bindings
        .map(binding => binding[variable.value])
        .filter((term): term is RDF.Literal | RDF.NamedNode => term !== undefined);
      result.varSets[variable.value] = new VariableSet(...terms);
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
 *    with `FILTER(sameTerm(complexExpr, t))` to preserve the runtime constraint.
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
      // Also mark any variable used in the expression as still-used so it is not substituted away
      // (the outer EXTEND chain still references it after the JOIN is processed).
      const exprCursor = cursor;
      if (exprCursor.expression.subType === Algebra.ExpressionTypes.TERM &&
          exprCursor.expression.term.termType === 'Variable') {
        stillUsedVarNames.add(exprCursor.expression.term.value);
      }
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
  // During that substitution, the substitution can happen flawlessly, except in a few cases:
  // 1. The variable is present in a VALUES clause:
  //    filter all entries in the values clause where the variable is not assigned to the correct term.
  //    In case the VALUES is empty, it becomes filter false, in case the VALUES become a simple `?subVar { term }`,
  //    it can be replaced with an empty BGP.
  // 2. The variable is assigned to in a BIND clause:
  //    2.1 the expression is complex: replace with a filter that checks whether the complex expression is the
  //        same term as the term we want to substitute with.
  //    2.2 the expression is the simple assignment between the term and the variable - Simply unpack the EXTEND

  const maybeSubstitutions = computeToSubstitute(stillUsedVarNames, branchAnalyses);
  if (maybeSubstitutions === null) {
    return AF.createProject(createFilterFalse(c), projection.variables);
  }
  if (Object.keys(maybeSubstitutions).length === 0) {
    // No none need to be manipulated
    return projection;
  }

  // Phase 2: apply substitutions to every branch of the join
  join.input = join.input.map(branch => substituteTerms(c, branch, maybeSubstitutions));
  return projection;
}

/**
 * Computes substitutions by intersecting VariableSets across all branches using `disjunct`.
 * If any variable's intersection is empty (contradiction), returns null to signal the whole
 * join is unsatisfiable (caller should emit FILTER(FALSE)).
 * Otherwise, returns a map from variable name to its unique substitution term.
 */
function computeToSubstitute(
  stillUsedVarNames: Set<string>,
  branchAnalyses: BranchAnalysis[],
): Record<string, RDF.Term> | null {
  const substitutions: Record<string, RDF.Term> = {};
  const variables: Record<string, VariableSet> = {};

  const noFix: VariableSet = VariableSet.createNoFixed();
  for (const analysis of branchAnalyses) {
    for (const [ variable, set ] of Object.entries(analysis.varSets)) {
      if (!stillUsedVarNames.has(variable)) {
        const newVarSet = (variables[variable] ?? noFix).disjunct(set);
        if (newVarSet.values.length === 0) {
          return null;
        }
        variables[variable] = newVarSet;
      }
    }
  }

  for (const [ variable, set ] of Object.entries(variables)) {
    // Length 0 handled above.
    if (set.values.length === 1) {
      substitutions[variable] = set.values[0];
    }
  }

  return substitutions;
}
