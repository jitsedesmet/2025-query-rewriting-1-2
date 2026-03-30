import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { createFilterFalse } from '../utils.js';

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
  branch: Algebra.Operation,
  stillUsedVars: RDF.Variable[],
): BranchAnalysis {
  const result: BranchAnalysis = {
    termBinds: {},
    nestedExtendVars: new Set(),
    valuesConstraints: {},
  };

  // Walk the top-level EXTEND chain and collect simple-term bindings.
  let belowChain: Algebra.Operation = branch;
  while (belowChain.type === 'extend') {
    const ext = belowChain;
    const varName = ext.variable.value;
    if (!stillUsedVars.some(v => v.equals(ext.variable))) {
      const expr = ext.expression;
      const isTermExpr =
        expr.subType === Algebra.ExpressionTypes.TERM &&
        (expr.term.termType === 'Literal' || expr.term.termType === 'NamedNode');
      if (isTermExpr) {
        result.termBinds[varName] = (expr).term;
      }
    }
    belowChain = ext.input;
  }

  // Scan everything below the top-level chain for:
  //   - Any EXTEND (nested / computed value) → blocks substitution for that var
  //   - VALUES clauses → provide a candidate set for that var
  algebraUtils.visitOperation(belowChain, {
    extend: {
      visitor: (ext) => {
        if (!stillUsedVars.some(v => v.equals(ext.variable))) {
          result.nestedExtendVars.add(ext.variable.value);
        }
      },
    },
    values: {
      visitor: (values) => {
        for (const variable of values.variables) {
          const terms: (RDF.Literal | RDF.NamedNode)[] = [];
          for (const binding of values.bindings) {
            const term = binding[variable.value];
            if (term !== undefined) {
              terms.push(term);
            }
          }
          result.valuesConstraints[variable.value] = terms;
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

  let join: Algebra.Join | undefined;
  const stillUsedVars: RDF.Variable[] = [ ...projection.variables ];
  if (projection.input.type === 'join') {
    join = projection.input;
  } else if (projection.input.type === 'extend') {
    const iter = (op: Algebra.Operation): void => {
      if (op.type === 'join') {
        join = op;
      } else if (op.type === 'extend') {
        stillUsedVars.push(op.variable);
        iter(op.input);
      }
    };
    iter(projection.input);
    if (!join) {
      return projection;
    }
  } else {
    return projection;
  }

  const branchAnalyses = join.input.map(branch => analyzeBranch(branch, stillUsedVars));

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

  // Remove BIND(t AS v) from the top-level EXTEND chain of each branch.
  const unwrapExtendChain = (op: Algebra.Operation): Algebra.Operation => {
    if (op.type !== 'extend') {
      return op;
    }
    const ext = op;
    if (ext.variable.value in assignments) {
      return unwrapExtendChain(ext.input);
    }
    ext.input = unwrapExtendChain(ext.input);
    return ext;
  };

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
            .map((binding) => {
              const newBinding: Record<string, RDF.Literal | RDF.NamedNode> = {};
              for (const [ key, value ] of Object.entries(binding)) {
                if (!(key in assignments)) {
                  newBinding[key] = value;
                }
              }
              return newBinding;
            });
          const newVariables = values.variables.filter(v => !(v.value in assignments));
          if (newVariables.length === 0) {
            return AF.createBgp([]);
          }
          return AF.createValues(newVariables, filteredBindings);
        },
      },
    });

  join.input = join.input.map(branch => cleanupValues(unwrapExtendChain(branch)));

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
