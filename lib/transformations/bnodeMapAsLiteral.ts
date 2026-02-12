import type * as RDF from '@rdfjs/types';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';

export function internalBnodeAsSpecialLiteral<T extends Algebra.Operation>(c: TransformContext, op: T): T {
  const { AF, DF } = c;
  return algebraUtils.mapOperationSub<'unsafe', typeof op>(
    op,
    {},
    { expression: { named: {
      transform: (expression) => {
        if (expression.name.value !== 'internal://blank') {
          return expression;
        }
        // The contents of this expression is a bunch of vars:
        //  <internal://blank> ( ?m0_s , ?m0_p )
        // rewrite to:
        // STRDT( ?m0_s, ?m0p,  <internal://bnodetype>)
        // STRDT( CONCAT ( STR (?s), STR(?p) ), <internal://bnodetype> )
        // Assume STR(bnode()) is able to evaluate:
        // STRDT( CONCAT (  )

        function mapVariables(variable: RDF.Variable): Algebra.Expression {
          function escapedTypeAndVal(type: string, val: Algebra.Expression): Algebra.Expression {
            return AF.createOperatorExpression('concat', [
              AF.createTermExpression(DF.literal(`,${type},`)),
              AF.createOperatorExpression('replace', [
                val,
                AF.createTermExpression(DF.literal(',')),
                AF.createTermExpression(DF.literal('\\,')),
              ]),
            ]);
          }

          const termAsExpr = AF.createTermExpression(variable);
          return AF.createOperatorExpression('if', [
            AF.createOperatorExpression('isblank', [ termAsExpr ]),
            escapedTypeAndVal('blank', AF.createOperatorExpression('str', [ termAsExpr ])),
            AF.createOperatorExpression('if', [
              AF.createOperatorExpression('isiri', [ termAsExpr ]),
              escapedTypeAndVal('iri', AF.createOperatorExpression('str', [ termAsExpr ])),
              AF.createOperatorExpression('if', [
                // It is a literal
                AF.createOperatorExpression('haslang', [ termAsExpr ]),
                escapedTypeAndVal('literal', AF.createOperatorExpression('concat', [
                  // Do some more stuff to get the langdir....
                  AF.createOperatorExpression('str', [ termAsExpr ]),
                  AF.createTermExpression(DF.literal('@')),
                ])),
                escapedTypeAndVal('literal', AF.createOperatorExpression('concat', [
                  // Do some more stuff to get the langdir....
                  AF.createOperatorExpression('str', [ termAsExpr ]),
                  AF.createTermExpression(DF.literal('@')),
                ])),
              ]),
            ]),
          ]);
        }

        const concated = AF.createOperatorExpression('concat', expression.args.map((expression) => {
          const casted = <Algebra.TermExpression> expression;
          return mapVariables(<RDF.Variable>casted.term);
        }));

        return AF.createOperatorExpression('strdt', [
          concated,
          AF.createTermExpression(DF.namedNode('internal://bnodetype')),
        ]);
      },
    }}},
  );
  // Now also write conditions
}
