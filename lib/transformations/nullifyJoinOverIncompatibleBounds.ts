import type * as RDF from '@rdfjs/types';
import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { directExtensions, termIsStaticTerm } from '../utils.js';

class VariableSet {
  public isNoFixed: boolean;
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

  public union(other: VariableSet): VariableSet {
    if (this.isNoFixed || other.isNoFixed) {
      return VariableSet.createNoFixed();
    }
    return new VariableSet(
      ...this.values,
      ...other.values.filter(otherVal => !this.values.some(x => x.equals(otherVal))),
    );
  }

  public disjunct(other: VariableSet): VariableSet {
    if (this.isNoFixed && other.isNoFixed) {
      return VariableSet.createNoFixed();
    }
    return new VariableSet(
      ...this.values.filter(otherVal => otherVal.equals(otherVal)),
    );
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
  op: Algebra.Operation,
): T {
  return c.algebraTransformer.transformNode<'unsafe'>(
    op,
    { join: {
      transform: (join) => {
        // Find for each member of the join whether variables are bound to known terms
        const _varSets = variableExtensionsOverJoin(c, join);

        // We optimize: iterate extends and unions. An extend who's term does not match is replaced by filterFalse.
        // Finding an extend where the var is bound to another var, you can bind both vars to the new static value,
        // or you can write a filter to an includes in the subquery.

        return join;
      },
    }},
  );
}

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

function directExtensionOverUnionsAndMore(c: TransformContext, op: Algebra.Operation): Record<string, VariableSet> {
  const varSets: Record<string, VariableSet> = {};
  const traverse = (op: Algebra.Operation): void => {
    if (op.type === Algebra.Types.EXTEND) {
      if (op.expression.expressionType === Algebra.ExpressionTypes.TERM && termIsStaticTerm(op.expression.term)) {
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
