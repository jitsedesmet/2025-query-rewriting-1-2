import type * as RDF from '@rdfjs/types';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { createFilterFalse, deleteVarExtensionsInPlace, directExtensions } from '../utils.js';

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
 * Per-branch static analysis result:
 *
 * - `termBinds`: top-level EXTEND chains that bind a variable to a simple term.
 *   These are candidates for substitution.
 * - `nestedExtendVars`: variables that have *any* EXTEND binding below the
 *   top-level chain (i.e., a computed value that cannot be determined statically).
 *   Their presence in another branch blocks substitution.
 * - `valuesConstraints`: variables constrained by a VALUES clause anywhere in
 *   this branch, mapped to the concrete terms they may take.  When a candidate
 *   `BIND(t AS v)` from another branch is checked, `t` must appear in this set.
 */
interface BranchAnalysis {
  termBinds: Record<string, RDF.Term>;
  nestedExtendVars: Set<string>;
  valuesConstraints: Record<string, (RDF.Literal | RDF.NamedNode)[]>;
}

/**
 * Analyses a single join branch to determine what static information it carries
 * about variable bindings.
 */
function analyzeBranch(
  c: TransformContext,
  branch: Algebra.Operation,
  stillUsedVarNames: Set<string>,
): BranchAnalysis {
  const result: BranchAnalysis = {
    termBinds: {},
    nestedExtendVars: new Set(),
    valuesConstraints: {},
  };

  // Collect top-level EXTEND term bindings, skipping still-used variables.
  for (const [ varName, term ] of Object.entries(directExtensions(c, branch))) {
    if (!stillUsedVarNames.has(varName)) {
      result.termBinds[varName] = term;
    }
  }

  // Walk past the top-level EXTEND chain to reach the content below.
  let belowChain: Algebra.Operation = branch;
  while (belowChain.type === 'extend') {
    belowChain = belowChain.input;
  }

  // Scan everything below the top-level chain for:
  //   - Any EXTEND (nested / computed value) → blocks substitution for that var
  //   - VALUES clauses → provide a candidate set for that var
  algebraUtils.visitOperation(belowChain, {
    extend: {
      visitor: (ext) => {
        if (!stillUsedVarNames.has(ext.variable.value)) {
          result.nestedExtendVars.add(ext.variable.value);
        }
      },
    },
    values: {
      visitor: (values) => {
        for (const variable of values.variables) {
          result.valuesConstraints[variable.value] = values.bindings
            .map(binding => binding[variable.value])
            .filter((term): term is RDF.Literal | RDF.NamedNode => term !== undefined);
        }
      },
    },
  });

  return result;
}

/**
 * Processes a projection to find and apply variable substitutions.
 *
 * A variable `v` is eligible for substitution with term `t` when, across all
 * branches of the immediate join:
 *  - Exactly one branch has a top-level `BIND(t AS v)`.
 *  - `v` appears as a subject/predicate/object in at least one triple pattern
 *    (otherwise there is nothing to substitute into).
 *  - No other branch has any EXTEND that binds `v` (a computed value whose
 *    equality with `t` cannot be verified statically).
 *  - Every branch with a VALUES clause for `v` includes `t` in its term set.
 *
 * When eligible, the BIND is removed, the matching VALUES rows are filtered
 * (and the variable removed from the VALUES), and triple patterns are rewritten.
 *
 * Only perform this operation when the variables go out of scope due to the projection.
 */
function substituteAndUnwrapExtends(c: TransformContext, projection: Algebra.Project): Algebra.Project {
  const { AF } = c;

  const stillUsedVarNames = new Set<string>(projection.variables.map(v => v.value));

  let join: Algebra.Join | undefined;
  if (projection.input.type === 'join') {
    join = projection.input;
  } else if (projection.input.type === 'extend') {
    let cursor: Algebra.Operation = projection.input;
    while (cursor.type === 'extend') {
      stillUsedVarNames.add(cursor.variable.value);
      cursor = cursor.input;
    }
    if (cursor.type !== 'join') {
      return projection;
    }
    join = cursor;
  } else {
    return projection;
  }

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

  // Determine which variables can be safely substituted.
  const assignments: Record<string, RDF.Term> = {};

  for (let srcIdx = 0; srcIdx < branchAnalyses.length; srcIdx++) {
    const srcAnalysis = branchAnalyses[srcIdx];
    for (const [ varName, term ] of Object.entries(srcAnalysis.termBinds)) {
      if (!varsInTriplePatterns.has(varName)) {
        continue;
      }
      let substitutable = true;
      for (const [ otherIdx, other ] of branchAnalyses.entries()) {
        if (otherIdx === srcIdx) {
          continue;
        }
        // Conflict: another branch also term-binds this variable.
        if (other.termBinds[varName] !== undefined) {
          substitutable = false;
          break;
        }
        // Blocker: another branch has a nested (computed) EXTEND for this variable.
        if (other.nestedExtendVars.has(varName)) {
          substitutable = false;
          break;
        }
        // Compatibility: if another branch constrains v via VALUES,
        // the candidate term must be present in the allowed set.
        // If it is NOT, BIND(t AS v) and VALUES v {t1,...} can never both be
        // satisfied simultaneously → the whole projection is always empty.
        const valuesTerms = other.valuesConstraints[varName];
        if (valuesTerms !== undefined) {
          const termInValues = valuesTerms.some(v =>
            v.equals(<RDF.NamedNode | RDF.Literal> term));
          if (!termInValues) {
            return AF.createProject(createFilterFalse(c), projection.variables);
          }
        }
      }
      if (substitutable) {
        assignments[varName] = term;
      }
    }
  }

  if (Object.keys(assignments).length === 0) {
    return projection;
  }

  // For VALUES clauses that constrain a substituted variable:
  //   • Filter their rows to those where the variable equals the assigned term.
  //   • Remove the variable from the clause.
  //   • If no variables remain, replace the entire clause with an empty BGP
  //     (semantically a single empty row — the term was confirmed to be in the set).
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
          const newVariables = values.variables.filter(v => !(v.value in assignments));
          if (newVariables.length === 0) {
            return AF.createBgp([]);
          }
          return AF.createValues(newVariables, filteredBindings);
        },
      },
    });

  // Remove BIND(t AS v) from the top-level EXTEND chain of each branch,
  // then clean up VALUES clauses.
  const assignedVars = Object.keys(assignments);
  join.input = join.input.map(branch => cleanupValues(deleteVarExtensionsInPlace(c, branch, assignedVars)));

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
