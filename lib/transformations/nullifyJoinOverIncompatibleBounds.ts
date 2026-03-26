import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { createFilterFalse, directExtensions, termIsStaticTerm } from '../utils.js';

/**
 * A variable value set that tracks the possible concrete RDF terms a variable may equal.
 *
 * - When `isNoFixed` is `true` the set represents "unknown / unbounded" – any term is possible.
 *   Under union semantics this is the absorbing element: a union with an unbounded variable
 *   remains unbounded.
 * - When `isNoFixed` is `false` the `values` array lists the exact terms the variable may equal.
 *   Under join semantics only the intersection of two sets is possible.
 */
class VariableSet {
  /** When `true`, the set is unbounded – the variable may equal any term. */
  public isNoFixed: boolean;
  /** The concrete RDF terms the variable may equal (only meaningful when `isNoFixed` is `false`). */
  public values: RDF.Term[];

  public constructor(...values: RDF.Term[]) {
    this.isNoFixed = false;
    this.values = values;
  }

  public static createNoFixed(): VariableSet {
    const res = new VariableSet();
    res.isNoFixed = true;
    return res;
  }

  /**
   * Returns a new `VariableSet` that represents the union of `this` and `other`.
   *
   * If either operand is unbounded (`isNoFixed`), the result is unbounded (absorbing).
   * Otherwise the result is the deduplicated concatenation of both value lists.
   *
   * @param other - The set to union with.
   */
  public union(other: VariableSet): VariableSet {
    if (this.isNoFixed || other.isNoFixed) {
      return VariableSet.createNoFixed();
    }
    return new VariableSet(
      ...this.values,
      ...other.values.filter(otherVal => !this.values.some(x => x.equals(otherVal))),
    );
  }

  /**
   * Returns a new `VariableSet` that represents the intersection (join) of `this` and `other`.
   *
   * If both operands are unbounded, the result is unbounded.  If only one is unbounded,
   * the bounded set is returned unchanged.  Otherwise the result contains only the
   * values present in both sets.
   *
   * @param other - The set to intersect with.
   */
  public disjunct(other: VariableSet): VariableSet {
    if (this.isNoFixed && other.isNoFixed) {
      return VariableSet.createNoFixed();
    }
    if (this.isNoFixed) {
      return new VariableSet(...other.values);
    }
    if (other.isNoFixed) {
      return new VariableSet(...this.values);
    }
    return new VariableSet(
      ...this.values.filter(value => other.values.some(x => x.equals(value))),
    );
  }

  /**
   * Returns `true` when `term` is compatible with this set.
   *
   * A term is compatible when the set is unbounded, when `term` is a variable (its concrete
   * value is unknown at rewrite time), or when `term` is explicitly in `values`.
   *
   * @param term - The RDF term to check for compatibility.
   */
  public termIsCompatible(term: RDF.Term): boolean {
    return this.isNoFixed || term.termType === 'Variable' || this.values.some(x => x.equals(term));
  }
}

/**
 * Example 1:
 * JOIN [
 *   UNION [ ?s = 'a', ?s = 'b' ],
 *   ?s = 'c'
 * ]
 *  -> { FILTER(false) }
 *
 * Example 2:
 * JOIN [
 *   UNION [ ?s = 'a', ?s = 'b' ],
 *   ?s = 'a'
 * ]
 *  -> JOIN [ ?s = 'a', ?s = 'a'] -> Do not perform subquery resulting in ?s = 'b'
 *
 *  Each user query variable for a certain pattern gets bound after the subquery,
 *  either to a var of the subquery, or a term.
 * @param c
 * @param op
 */
export function nullifyJoinOverIncompatibleBounds<T extends Algebra.Operation>(
  c: TransformContext,
  op: T,
): T {
  return algebraUtils.mapOperation<'unsafe', typeof op>(
    op,
    { join: {
      transform: (join) => {
        // Find for each member of the join whether variables are bound to known terms
        const varSets = variableExtensionsOverJoin(c, join);

        // We optimize: iterate extends and unions. An extend who's term does not match is replaced by filterFalse.
        // Finding an extend where the var is bound to another var, you can bind both vars to the new static value,
        // or you can write a filter to an includes in the subquery.
        restrictOperations(c, join, varSets);

        return join;
      },
    }},
  );
}

/**
 * Applies the known variable constraints (`varSets`) across all members of the join
 * by recursively walking each member's algebra tree.
 *
 * For each `Extend` node encountered:
 * - If the variable is bound to a mapping variable (prefix `m` or `r`) the scope of
 *   that mapping variable is narrowed by injecting `VALUES` into the subselect.
 * - If the bound term is incompatible with the known constraint the `Extend` is
 *   replaced by `FILTER(false)` (together with its outer extend chain).
 *
 * For each `Union` node, all members are recursed into.
 * For each `Project` node, a `VALUES` clause is injected for any mapping variables
 * whose concrete value set is known (see {@link restrictProjectUsingValues}).
 *
 * @param c       - The transformation context.
 * @param join    - The join whose members are to be restricted (mutated in place).
 * @param varSets - Map from variable name to its known value set across the join.
 */
function restrictOperations(c: TransformContext, join: Algebra.Join, varSets: Record<string, VariableSet>): void {
  const { AF } = c;
  const mappingVarsToScope: Record<string, VariableSet> = {};
  const recurse = (op: Algebra.Operation): Algebra.Operation => {
    if (op.type === Algebra.Types.EXTEND) {
      if (op.expression.subType === Algebra.ExpressionTypes.TERM && varSets[op.variable.value]) {
        const varSet = varSets[op.variable.value];
        const exprTerm = op.expression.term;
        // Only in case the var is bound to a mapping var (we know how they are constructed)
        if (!varSet.isNoFixed && exprTerm.termType === 'Variable' && /^[mr]/u.test(exprTerm.value)) {
          // The mapping var can be made specific
          mappingVarsToScope[exprTerm.value] = varSet;
          // If the mapping var gets bound, you may aso bind the userQuery var
          if (varSet.values.length === 1) {
            op.expression = AF.createTermExpression(varSet.values[0]);
          }
          op.input = recurse(op.input);
          delete mappingVarsToScope[exprTerm.value];
          return op;
        }
        // Can nullify
        if (!varSet.termIsCompatible(exprTerm)) {
          return createFilterFalse(c, op);
        }
      }
      op.input = recurse(op.input);
    } else if (op.type === Algebra.Types.UNION) {
      op.input = op.input.map(x => recurse(x));
    } else if (op.type === Algebra.Types.PROJECT) {
      return restrictProjectUsingValues(c, op, mappingVarsToScope);
    }
    return op;
  };
  join.input = join.input.map(x => recurse(x));
}

/**
 * Injects `VALUES` clauses into a `Project` node to restrict the mapping variables
 * whose concrete value sets are known from the outer join context.
 *
 * This is the preferred implementation strategy because `VALUES` clauses are
 * efficiently handled by SPARQL engines and do not require additional `FILTER`
 * expressions that would need to be evaluated for every solution.
 *
 * @param c                  - The transformation context.
 * @param project            - The subselect `Project` to restrict.
 * @param mappingVarsToScope - Map from mapping variable name to its known value set.
 * @returns The (possibly restructured) algebra operation.
 */
function restrictProjectUsingValues(
  c: TransformContext,
  project: Algebra.Project,
  mappingVarsToScope: Record<string, VariableSet>,
): Algebra.Operation {
  if (Object.keys(mappingVarsToScope).length === 0) {
    return project;
  }
  const { AF, DF } = c;
  let join: Algebra.Join;
  // The first thing in the project should become a join that joins the various variables together
  if (project.input.type === Algebra.Types.JOIN) {
    join = project.input;
  } else {
    join = AF.createJoin([ project.input ], false);
    project.input = join;
  }
  for (const [ var_, varSet ] of Object.entries(mappingVarsToScope)) {
    join.input.unshift(AF.createValues(
      [ DF.variable(var_) ],
      varSet.values.map(value => ({ [var_]: <RDF.NamedNode | RDF.Literal> value })),
    ));
  }
  return project;
}

function _restrictProjectUsingBindOrFilter(
  c: TransformContext,
  op: Algebra.Project,
  mappingVarsToScope: Record<string, VariableSet>,
): Algebra.Operation {
  const { AF, DF } = c;
  // For the vars that are filtered to a single term, you can also introduce an extension + join.
  const staticallyBound = Object.entries(mappingVarsToScope)
    .filter(([ _, set ]) => !set.isNoFixed && set.values.length === 1);
  const nonStaticallyBound = Object.fromEntries(Object.entries(mappingVarsToScope)
    .filter(([ var_ ]) => !staticallyBound.some(([ x ]) => x === var_)));
  if (staticallyBound.length > 0) {
    const isExtendBlock = (op: Algebra.Operation): boolean => {
      if (op.type === Algebra.Types.EXTEND) {
        return isExtendBlock(op.input);
      }
      if (op.type === Algebra.Types.BGP && op.patterns.length === 0) {
        return true;
      }
      return false;
    };
    let toExtendAround: Algebra.Operation;
    if (op.input.type === Algebra.Types.JOIN) {
      if (isExtendBlock(op.input.input[0])) {
        toExtendAround = op.input.input[0];
      } else {
        toExtendAround = AF.createBgp([]);
        op.input.input.unshift(toExtendAround);
      }
    } else {
      // Introduce join
      toExtendAround = AF.createBgp([]);
      op.input = AF.createJoin([ toExtendAround, op.input ]);
    }
    for (const [ var_, varSet ] of staticallyBound) {
      toExtendAround = AF.createExtend(
        toExtendAround,
        DF.variable(var_),
        AF.createTermExpression(varSet.values[0]),
      );
    }
    op.input.input[0] = toExtendAround;
  }
  op.input = createFilterBound(c, op.input, nonStaticallyBound);
  // The variables that are statically bounded do no longer need to be projected since
  // they have also been bound to the static term in the extend rewriting that added the var to `mappingVarsToScope`
  op.variables = op.variables.filter(var_ => !staticallyBound.some(([ x ]) => x === var_.value));
  return op;
}

function createFilterBound(
  c: TransformContext,
  input: Algebra.Operation,
  mappingVarsToScope: Record<string, VariableSet>,
): Algebra.Filter | Algebra.Operation {
  const { AF, DF } = c;

  function equality(var_: RDF.Variable, term: RDF.Term): Algebra.OperatorExpression {
    return AF.createOperatorExpression('=', [ AF.createTermExpression(var_), AF.createTermExpression(term) ]);
  }
  function orOfEquals(var_: RDF.Variable, varSet: VariableSet): Algebra.OperatorExpression {
    let res = equality(var_, varSet.values[0]);
    for (const term of varSet.values.slice(1)) {
      res = AF.createOperatorExpression('||', [ res, equality(var_, term) ]);
    }
    return res;
  }
  function andOfVars(list: readonly [RDF.Variable, VariableSet][]): Algebra.OperatorExpression {
    let res = orOfEquals(list[0][0], list[0][1]);
    for (const [ var_, varSet ] of list.slice(1)) {
      res = AF.createOperatorExpression('&&', [ res, orOfEquals(var_, varSet) ]);
    }
    return res;
  }

  const entries = Object.entries(mappingVarsToScope);
  if (entries.length === 0) {
    return input;
  }

  const mappedEntries = Object.entries(mappingVarsToScope)
    .map(([ var_, varSet ]): [RDF.Variable, VariableSet] => ([ DF.variable(var_), varSet ]));
  return AF.createFilter(input, andOfVars(mappedEntries));
}

/**
 * Computes the intersection of the variable-to-value-set maps produced by each member
 * of `join`.
 *
 * Each member is analysed by {@link directExtensionOverUnionsAndMore}.  When a variable
 * appears in multiple join members its value sets are intersected (joined) across all of
 * them, because in a join every member must agree on the variable's value.
 *
 * @param c    - The transformation context.
 * @param join - The join to analyse.
 * @returns A map from variable name to the intersection of its value sets across all members.
 */
function variableExtensionsOverJoin(c: TransformContext, join: Algebra.Join): Record<string, VariableSet> {
  const head = join.input[0];
  // Not knowing the variable makes it be noFixed, and that is identity of disjuntion
  const varSets: Record<string, VariableSet> = directExtensionOverUnionsAndMore(c, head);

  for (const op of join.input.slice(1)) {
    for (const [ var_, varSet ] of Object.entries(directExtensionOverUnionsAndMore(c, op))) {
      if (varSets[var_]) {
        varSets[var_] = varSets[var_].disjunct(varSet);
      } else {
        varSets[var_] = varSet;
      }
    }
  }

  return varSets;
}

/**
 * Traverses a single algebra operation (which may contain `Extend` chains and
 * nested `Union` nodes) and returns a map from variable name to its possible value set.
 *
 * - **`Extend`** nodes with static term expressions contribute a singleton set.
 * - **`Union`** nodes are handled by {@link directExtensionOverUnions} which merges
 *   the value sets from all union branches.
 * - Any other node type is ignored (the operation may still bind variables deeper,
 *   but those are not tracked here).
 *
 * @param c  - The transformation context.
 * @param op - The algebra operation to analyse.
 * @returns A map from variable name to its known value set.
 */
function directExtensionOverUnionsAndMore(c: TransformContext, op: Algebra.Operation): Record<string, VariableSet> {
  const varSets: Record<string, VariableSet> = {};
  const traverse = (op: Algebra.Operation): void => {
    if (op.type === Algebra.Types.EXTEND) {
      if (op.expression.subType === Algebra.ExpressionTypes.TERM && termIsStaticTerm(op.expression.term)) {
        varSets[op.variable.value] = new VariableSet(op.expression.term);
      }
      traverse(op.input);
    } else if (op.type === Algebra.Types.UNION) {
      Object.assign(varSets, directExtensionOverUnions(c, op));
    }
  };

  traverse(op);
  return varSets;
}

/**
 * Computes the union of the variable-to-value-set maps produced by each branch of a `Union`.
 *
 * A variable that appears in all branches contributes the union of its value sets.
 * A variable that is absent from some branch becomes unbounded (`isNoFixed = true`)
 * because the engine might choose any branch at evaluation time.
 *
 * @param c     - The transformation context.
 * @param union - The union operation to analyse.
 * @returns A map from variable name to its unified value set across all branches.
 */
function directExtensionOverUnions(c: TransformContext, union: Algebra.Union): Record<string, VariableSet> {
  const head = union.input[0];
  // Not knowing the variable makes it be noFixed, which is absorbing element under union
  const varSets: Record<string, VariableSet> = Object.fromEntries(Object.entries(directExtensions(c, head))
    .map(([ var_, term ]) => [ var_, new VariableSet((term)) ]));
  for (const op of union.input.slice(1)) {
    let trackedVars = Object.keys(varSets);
    for (const [ var_, term ] of Object.entries(directExtensions(c, op))) {
      // Register you saw this var
      trackedVars = trackedVars.filter(x => x !== var_);
      if (varSets[var_]) {
        varSets[var_] = varSets[var_].union(new VariableSet(term));
      } else {
        varSets[var_] = VariableSet.createNoFixed();
      }
    }
    // All vars not visited are noFixed:
    for (const var_ of trackedVars) {
      varSets[var_] = VariableSet.createNoFixed();
    }
  }
  return varSets;
}
