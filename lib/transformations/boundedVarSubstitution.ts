import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { createFilterFalse } from '../utils.js';
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
  /**
   * EXTEND operations at the top of the chain whose expression is NOT a simple term.
   * For each substituted variable in this set,
   * the BIND is replaced with a FILTER that checks whether the complex expression equals the substituted term.
   * TODO: I doubt there is any reason to collect this info?
   */
  complexBinds: Record<string, Algebra.Expression>;
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
    complexBinds: {},
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
        result.varSets[belowChain.variable.value] = new VariableSet(expr.term);
      } else {
        result.complexBinds[belowChain.variable.value] = expr;
      }
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
  //    2.1 the expression is complex: replace with a filter that checks whether the complex expression is equal
  //        to the term we want to substitute with.
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
  join.input = join.input.map(branch => applySubstitutions(c, branch, maybeSubstitutions));
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

function substituteInExpr(
  c: TransformContext,
  expr: Algebra.Expression,
  subs: Record<string, RDF.Term>,
): Algebra.Expression {
  const { AF } = c;
  switch (expr.subType) {
    case Algebra.ExpressionTypes.TERM: {
      const { term } = expr;
      if (term.termType === 'Variable' && subs[term.value] !== undefined) {
        return AF.createTermExpression(subs[term.value]);
      }
      return expr;
    }
    case Algebra.ExpressionTypes.OPERATOR:
      return AF.createOperatorExpression(expr.operator, expr.args.map(a => substituteInExpr(c, a, subs)));
    case Algebra.ExpressionTypes.NAMED:
      return AF.createNamedExpression(expr.name, expr.args.map(a => substituteInExpr(c, a, subs)));
    case Algebra.ExpressionTypes.EXISTENCE:
      return AF.createExistenceExpression(expr.not, applySubstitutions(c, expr.input, subs));
    case Algebra.ExpressionTypes.AGGREGATE:
      expr.expression = substituteInExpr(c, expr.expression, subs);
      return expr;
    default:
      return expr;
  }
}

/**
 * Traverses a filter-expression tree, applying substitutions only inside
 * EXISTS / NOT EXISTS sub-patterns (which are data-matching patterns, not
 * boolean conditions).  The boolean conditions themselves — comparisons,
 * function calls, literal tests — are left untouched.
 */
function applySubstitutionsInExistencePatterns(
  c: TransformContext,
  expr: Algebra.Expression,
  subs: Record<string, RDF.Term>,
): Algebra.Expression {
  const { AF } = c;
  switch (expr.subType) {
    case Algebra.ExpressionTypes.EXISTENCE:
      return AF.createExistenceExpression(expr.not, applySubstitutions(c, expr.input, subs));
    case Algebra.ExpressionTypes.OPERATOR:
      return AF.createOperatorExpression(
        expr.operator,
        expr.args.map(a => applySubstitutionsInExistencePatterns(c, a, subs)),
      );
    case Algebra.ExpressionTypes.NAMED:
      return AF.createNamedExpression(expr.name, expr.args.map(a => applySubstitutionsInExistencePatterns(c, a, subs)));
    default:
      return expr;
  }
}

/**
 * Filters a VALUES operation to keep only rows compatible with the given substitutions,
 * removes substituted variables from the column list, and collapses degenerate cases:
 * - zero remaining rows → FILTER(FALSE)
 * - zero remaining columns → empty BGP (identity for JOIN)
 */
function cleanupValues(
  c: TransformContext,
  values: Algebra.Values,
  subs: Record<string, RDF.Term>,
): Algebra.Operation {
  const { AF } = c;

  const affectedVars = values.variables.filter(v => subs[v.value] !== undefined);
  if (affectedVars.length === 0) {
    return values;
  }

  let { bindings } = values;
  for (const v of affectedVars) {
    const term = subs[v.value];
    bindings = bindings.filter((binding) => {
      const bindingTerm = binding[v.value];
      return bindingTerm !== undefined && bindingTerm.equals(term);
    });
  }

  if (bindings.length === 0) {
    return createFilterFalse(c);
  }

  const remainingVars = values.variables.filter(v => subs[v.value] === undefined);
  if (remainingVars.length === 0) {
    return AF.createBgp([]);
  }

  const remainingBindings = bindings.map(binding =>
    <Record<string, RDF.Literal | RDF.NamedNode>> Object.fromEntries(
      Object.entries(binding).filter(([ key ]) => subs[key] === undefined),
    ));

  return AF.createValues(remainingVars, remainingBindings);
}

/**
 * Recursively applies a term-substitution map to an operation sub-tree.
 *
 * - BGP / PATH: substitutes variable references in subjects, predicates and objects.
 * - EXTEND whose variable is being substituted:
 *     same term   → unwrap (case 2.2)
 *     term differ → FILTER(FALSE)
 *     complex     → FILTER(expr = term) (case 2.1)
 * - VALUES: delegated to cleanupValues.
 * - PROJECT: left unchanged; each PROJECT is handled by the outer mapOperation traversal.
 * - FILTER: only recurses into its input (triple patterns), never rewrites the filter expression
 *   itself, because the expression is a constraint on existing bindings, not a data pattern.
 * - All other single/multi-input operations: recurses into children; substitutes in embedded
 *   BIND expressions (EXTEND whose variable is NOT substituted) but not in FILTER expressions.
 */
function applySubstitutions(
  c: TransformContext,
  op: Algebra.Operation,
  subs: Record<string, RDF.Term>,
): Algebra.Operation {
  const { AF } = c;
  const subExpr = (e: Algebra.Expression): Algebra.Expression => substituteInExpr(c, e, subs);
  const subTerm = (t: RDF.Term): RDF.Term =>
    (t.termType === 'Variable' && subs[t.value] !== undefined) ? subs[t.value] : t;

  switch (op.type) {
    case Algebra.Types.BGP:
      op.patterns = op.patterns.map(p =>
        AF.createPattern(subTerm(p.subject), subTerm(p.predicate), subTerm(p.object), p.graph));
      return op;

    case Algebra.Types.PATH:
      op.subject = subTerm(op.subject);
      op.object = subTerm(op.object);
      return op;

    case Algebra.Types.EXTEND: {
      const varSub = subs[op.variable.value];
      if (varSub !== undefined) {
        const { expression: expr } = op;
        if (expr.subType === Algebra.ExpressionTypes.TERM && expr.term.termType !== 'Variable') {
          if (expr.term.equals(varSub)) {
            return applySubstitutions(c, op.input, subs);
          }
          return createFilterFalse(c, applySubstitutions(c, op.input, subs));
        }
        return AF.createFilter(
          applySubstitutions(c, op.input, subs),
          AF.createOperatorExpression('=', [ subExpr(op.expression), AF.createTermExpression(varSub) ]),
        );
      }
      op.expression = subExpr(op.expression);
      op.input = applySubstitutions(c, op.input, subs);
      return op;
    }

    case Algebra.Types.VALUES:
      return cleanupValues(c, op, subs);

    // Each PROJECT is handled by the outer mapOperation traversal; do not recurse here.
    case Algebra.Types.PROJECT:
      return op;

    // Only recurse into the input (data patterns); leave the filter expression untouched.
    // FILTER is a constraint on existing bindings, not a data pattern.
    // Exception: EXISTS/NOT EXISTS sub-patterns inside the expression ARE data patterns
    // and must have substitutions applied to them.
    case Algebra.Types.FILTER:
      op.expression = applySubstitutionsInExistencePatterns(c, op.expression, subs);
      op.input = applySubstitutions(c, op.input, subs);
      return op;

    case Algebra.Types.LEFT_JOIN:
      op.input = [ applySubstitutions(c, op.input[0], subs), applySubstitutions(c, op.input[1], subs) ];
      return op;

    case Algebra.Types.JOIN:
    case Algebra.Types.UNION:
    case Algebra.Types.MINUS:
      op.input = op.input.map(x => applySubstitutions(c, x, subs));
      return op;

    case Algebra.Types.GRAPH:
      op.name = <RDF.Variable | RDF.NamedNode> subTerm(op.name);
      op.input = applySubstitutions(c, op.input, subs);
      return op;

    default:
      if ('input' in op && op.input !== undefined) {
        if (Array.isArray(op.input)) {
          (<Algebra.Multi> op).input = (<Algebra.Multi> op).input.map(x => applySubstitutions(c, x, subs));
        } else {
          (<Algebra.Single> op).input = applySubstitutions(c, (<Algebra.Single> op).input, subs);
        }
      }
      return op;
  }
}
