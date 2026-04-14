import type * as RDF from '@rdfjs/types';
import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';

export function transformExtendsToValues(c: TransformContext, op: Algebra.Operation): Algebra.Operation {
  const { AF } = c;
  function transformExtend(op: Algebra.Extend): Algebra.Extend | Algebra.Values {
    if (op.input.type === Algebra.Types.BGP && op.input.patterns.length === 0 &&
     op.expression.subType === Algebra.ExpressionTypes.TERM
    ) {
      return AF.createValues([ op.variable ], [{
        [op.variable.value]: <RDF.Literal | RDF.NamedNode> op.expression.term,
      }]);
    }
    if (op.input.type === Algebra.Types.VALUES && op.expression.subType === Algebra.ExpressionTypes.TERM) {
      const termExpr = <RDF.Literal | RDF.NamedNode> op.expression.term;
      return AF.createValues([ ...op.input.variables, op.variable ], op.input.bindings.map(x => ({
        ...x,
        [op.variable.value]: termExpr,
      })));
    }
    return op;
  }
  return algebraUtils.mapOperation<'unsafe', typeof op>(
    op,
    {
      [Algebra.Types.EXTEND]: { transform: transformExtend },
    },
  );
}
